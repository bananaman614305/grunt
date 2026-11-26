import { expect, it } from 'vitest';
import { decode } from './api.js';
import { JsonToolBridge } from './json-tool-bridge.js';
import { taskTurns, userTurns } from './harness.js';

// A user turn must never sit between an assistant's tool calls and their results, or every tool bridge
// (JsonToolBridge) rejects the conversation. Claude Code and Codex add reminders beside tool results.
const roles = (messages: { role: string }[]) => messages.map(m => m.role).join(',');
const read = { name: 'read', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
const call = (id: string) => ({ type: 'tool_use', id, name: 'read', input: { path: id } });
const result = (id: string, content = 'ok') => ({ type: 'tool_result', tool_use_id: id, content });
const reminder = { type: 'text', text: '<system-reminder>The file a was edited by the user.</system-reminder>' };
const queued = { type: 'text', text: 'also check the tests' };

it('puts Anthropic tool results before text blocks in the same user message', () => {
  for (const blocks of [[result('c1'), reminder], [reminder, result('c1')], [reminder, result('c1'), queued]]) {
    const request = decode({ model: 'grunt', tools: [read], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [call('c1')] }, { role: 'user', content: blocks }] }, 'messages', '/tmp');
    expect(roles(request.messages).startsWith('user,assistant,tool')).toBe(true);
    expect(request.messages.slice(0, 3).map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(request.messages[2]).toEqual({ role: 'tool', content: 'ok', tool_call_id: 'c1' });
    expect(() => new JsonToolBridge(request)).not.toThrow();
  }
});

it('keeps parallel Anthropic results in tool_result order, then the user text', () => {
  const request = decode({ model: 'grunt', tools: [read], messages: [{ role: 'user', content: 'go' },
    { role: 'assistant', content: [call('a'), call('b')] },
    { role: 'user', content: [reminder, result('b', 'B'), queued, result('a', 'A')] }] }, 'messages', '/tmp');
  expect(request.messages.slice(2).map(m => [m.role, m.tool_call_id ?? userTurns({ ...request, userMessages: undefined, messages: [m] })[0]])).toEqual([['tool', 'b'], ['tool', 'a'], ['user', 'also check the tests']]);
  expect(() => new JsonToolBridge(request)).not.toThrow();
});

it('still keys the task on the person text when results and reminders share a message', () => {
  const body = { model: 'grunt', tools: [read], messages: [{ role: 'user', content: 'build the game' },
    { role: 'assistant', content: [call('c1')] },
    { role: 'user', content: [result('c1'), reminder] },
    { role: 'assistant', content: [call('c2')] },
    { role: 'user', content: [result('c2'), reminder, queued] }] };
  const request = decode(body, 'messages', '/tmp');
  expect(userTurns(request)).toEqual(['build the game', 'also check the tests']);
  expect(taskTurns(request)).toEqual(['build the game', 'also check the tests']);
  const plain = decode({ ...body, messages: body.messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.filter(b => b.type !== 'text' || b === queued) : m.content })) }, 'messages', '/tmp');
  expect(taskTurns(plain)).toEqual(taskTurns(request));
  expect(() => new JsonToolBridge(request)).not.toThrow();
});

it('keeps text-only and tool_result-only user messages unchanged', () => {
  const request = decode({ model: 'grunt', tools: [read], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reading' }, call('c1')] }, { role: 'user', content: [result('c1')] }] }, 'messages', '/tmp');
  expect(roles(request.messages)).toBe('user,assistant,tool');
  expect(request.messages[1]).toMatchObject({ role: 'assistant', content: 'reading', tool_calls: [{ id: 'c1' }] });
});

const fn = (id: string) => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{"path":"x"}' });
const out = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'ok' });
const msg = (role: string, text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const responsesTools = [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

it('groups parallel Responses function_call items and keeps their outputs adjacent', () => {
  const request = decode({ model: 'grunt', tools: responsesTools, input: [msg('user', 'go'), fn('a'), fn('b'), out('a'), out('b'), msg('user', 'thanks')] }, 'responses', '/tmp');
  expect(roles(request.messages)).toBe('user,assistant,tool,tool,user');
  expect(request.messages[1]!.tool_calls!.map(c => c.id)).toEqual(['a', 'b']);
  expect(() => new JsonToolBridge(request)).not.toThrow();
});

it('holds Responses message items that arrive between a call and its output', () => {
  const request = decode({ model: 'grunt', tools: responsesTools, input: [msg('user', 'go'), fn('a'), msg('developer', 'note'), msg('user', 'queued'), out('a')] }, 'responses', '/tmp');
  expect(roles(request.messages)).toBe('user,assistant,tool,developer,user');
  expect(() => new JsonToolBridge(request)).not.toThrow();
  expect(userTurns(request)).toEqual(['go', 'queued']);
});

it('leaves chat completions tool messages in order', () => {
  const request = decode({ model: 'grunt', tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'A' }, { role: 'tool', tool_call_id: 'b', content: 'B' }, { role: 'user', content: 'next' }] }, 'chat', '/tmp');
  expect(roles(request.messages)).toBe('user,assistant,tool,tool,user');
  expect(() => new JsonToolBridge(request)).not.toThrow();
});
