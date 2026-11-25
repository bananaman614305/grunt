import { afterEach, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { tmpdir } from 'node:os';
import { createLocalApp, encode, events } from './api.js';
import { Sources } from './source.js';
import type { Completion } from './source.js';

interface ChatUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
interface ChatFrame {
  id: string;
  object: string;
  choices: { index: number; delta: Record<string, unknown>; finish_reason: string | null }[];
  usage?: ChatUsage | null;
}
const servers: ReturnType<typeof serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function localRequest(completion: Completion, body: Record<string, unknown> = {}, endpoint = 'chat/completions') {
  const complete = vi.fn(async () => completion);
  let port = 0;
  const sources = new Sources([{ id: 'usage-fixture', supportsFunctionTools: true, available: async () => true, complete }]);
  const app = createLocalApp(sources, { cwd: tmpdir(), get port() { return port; } });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'usage-fixture', messages: [{ role: 'user', content: 'synthetic usage diagnostic' }], input: 'synthetic usage diagnostic', stream: true, ...body })
  });
  expect(response.status).toBe(200);
  return { response, complete };
}

async function chatFrames(response: Response) {
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const wire = await response.text();
  const data = wire.split(/\r?\n\r?\n/).flatMap(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()));
  expect(data.at(-1)).toBe('[DONE]');
  return data.slice(0, -1).map(value => JSON.parse(value) as ChatFrame);
}

it('delivers measured usage once in the final requested HTTP SSE chunk, before DONE', async () => {
  const { response, complete } = await localRequest({ text: 'hello', inputTokens: 128000, outputTokens: 200 }, { stream_options: { include_usage: true } });
  const frames = await chatFrames(response), terminal = frames.at(-1)!;
  expect(terminal).toMatchObject({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 128000, completion_tokens: 200, total_tokens: 128200 } });
  expect(frames.slice(0, -1).every(frame => frame.usage === null && frame.choices.length === 1)).toBe(true);
  expect(frames.at(-2)?.choices[0]?.finish_reason).toBe('stop');
  expect(new Set(frames.map(frame => frame.id)).size).toBe(1);
  expect(frames.filter(frame => frame.usage)).toHaveLength(1);
  expect(complete).toHaveBeenCalledTimes(1);
});

it('preserves native tool-call deltas and reports their usage without another model call', async () => {
  const calls = [{ id: 'call_usage', type: 'function' as const, function: { name: 'diagnostic_echo', arguments: '{"nonce":"test"}' } }];
  const { response, complete } = await localRequest({ text: '', calls, inputTokens: 48, outputTokens: 12 }, { stream_options: { include_usage: true } });
  const frames = await chatFrames(response);
  expect(frames.flatMap(frame => frame.choices.flatMap(choice => choice.delta.tool_calls ?? []))).toEqual([{ ...calls[0], index: 0 }]);
  expect(frames.at(-2)?.choices[0]?.finish_reason).toBe('tool_calls');
  expect(frames.at(-1)?.usage).toEqual({ prompt_tokens: 48, completion_tokens: 12, total_tokens: 60 });
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each([undefined, false, 'true', 1])('does not change legacy chat streams without explicit include_usage:true (%j)', async include => {
  const { response } = await localRequest({ text: 'hello', inputTokens: 40, outputTokens: 2 }, include === undefined ? {} : { stream_options: { include_usage: include } });
  const frames = await chatFrames(response);
  expect(frames.every(frame => !Object.hasOwn(frame, 'usage') && frame.choices.length === 1)).toBe(true);
  expect(frames.at(-1)?.choices[0]?.finish_reason).toBe('stop');
});

it.each([
  {}, { inputTokens: 12 }, { outputTokens: 4 }, { inputTokens: -1, outputTokens: 4 },
  { inputTokens: Number.NaN, outputTokens: 4 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }
])('keeps unknown or invalid stream usage unknown rather than inventing counts (%j)', async usage => {
  const { response } = await localRequest({ text: 'hello', ...usage }, { stream_options: { include_usage: true } });
  const frames = await chatFrames(response);
  expect(frames.at(-1)).toMatchObject({ choices: [], usage: null });
  expect(frames.some(frame => frame.usage)).toBe(false);
});

it('distinguishes measured zero usage from missing usage for an empty completion', async () => {
  const { response } = await localRequest({ text: '', inputTokens: 0, outputTokens: 0 }, { stream_options: { include_usage: true } });
  const frames = await chatFrames(response);
  expect(frames.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  expect(frames.filter(frame => frame.usage)).toHaveLength(1);
});

it('keeps nonstreaming chat JSON backwards compatible when usage is missing', async () => {
  const { response } = await localRequest({ text: 'hello' }, { stream: false, stream_options: { include_usage: true } });
  const body = await response.json();
  expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  expect(Object.keys(body).sort()).toEqual(['choices', 'created', 'id', 'model', 'object', 'usage']);
});

it.each(['messages', 'responses'])('preserves existing %s streaming usage contracts', async api => {
  const { response } = await localRequest({ text: 'hello', inputTokens: 40, outputTokens: 2 }, { stream_options: { include_usage: true } }, api);
  const wire = await response.text();
  const frames = wire.split(/\r?\n\r?\n/).flatMap(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())));
  if (api === 'messages') {
    expect(frames[0].message.usage).toEqual({ input_tokens: 40, output_tokens: 0 });
    expect(frames.find(frame => frame.type === 'message_delta').usage).toEqual({ output_tokens: 2 });
    expect(frames.at(-1).type).toBe('message_stop');
  } else {
    expect(frames.at(-1)).toMatchObject({ type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 } } });
  }
  expect(frames.some(frame => Object.hasOwn(frame, 'choices'))).toBe(false);
});

it('retains unknown-usage knowledge through the encode/events helpers without adding wire metadata', () => {
  const value = encode({ text: 'hello' }, 'grunt', 'chat');
  const frames = events(value, 'chat', { includeUsage: true }).filter(frame => frame.data !== '[DONE]').map(frame => JSON.parse(frame.data));
  expect(frames.at(-1)).toMatchObject({ choices: [], usage: null });
  expect(JSON.parse(JSON.stringify(value)).usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

it('reports the provider cutoff in Messages and Responses terminal events', async () => {
  const reply: Completion = { text: 'partial', finishReason: 'length' };
  const messages = await localRequest(reply, {}, 'messages');
  expect(await messages.response.text()).toContain('"stop_reason":"max_tokens"');
  const responses = await localRequest(reply, {}, 'responses');
  const wire = await responses.response.text();
  expect(wire).toContain('event: response.incomplete');
  expect(wire).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
  expect(wire).not.toContain('event: response.completed');
});
