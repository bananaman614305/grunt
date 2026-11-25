import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { createLocalApp, decode } from './api.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { FreebuffTools } from './freebuff-tools.js';
import { Kilo, KILO_ORIGIN, KILO_PARTICLE } from './kilo.js';
import { StickyRouter } from './routing.js';
import { RequestError, SourceError, Sources, requestRefusal } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

// A reply cut off by its output limit reached the client as a complete tool call, the client stored it with a
// string for `input`, and every later request of that conversation was then refused by the tool bridge.
let directory: string;
const kilos: Kilo[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-poisoned-')); await recordDataSharingConsent(directory, ['kilo']); });
afterEach(async () => { await Promise.all(kilos.splice(0).map(source => source.close())); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

const truncated = '{"file_path":"/work/a.txt","content":"first line\\nsecond li';
const history = (input: unknown, extra: unknown[] = []) => ({
  model: 'grunt', max_tokens: 1000, stream: false,
  tools: [{ name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: {}, additionalProperties: true } }],
  messages: [
    { role: 'user', content: 'Make the file' },
    { role: 'assistant', content: [{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'call_poisoned', name: 'Write', ...(input === undefined ? {} : { input }) }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_poisoned', is_error: true, content: 'InputValidationError: required parameter missing' }] },
    ...extra
  ]
});
const post = (app: ReturnType<typeof createLocalApp>, path: string, body: unknown) =>
  app.request(`http://localhost:8788${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function kilo(sent: { body?: Record<string, unknown> }) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === `${KILO_ORIGIN}/models`) return Response.json({ data: [{ id: KILO_PARTICLE, isFree: true, pricing: { prompt: '0', completion: '0' }, context_length: 1048576, supported_parameters: ['tools', 'max_tokens'] }] });
    sent.body = JSON.parse(String(init?.body));
    return Response.json({ model: KILO_PARTICLE, choices: [{ message: { role: 'assistant', content: 'Continuing.' } }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0, cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } } });
  });
  const source = new Kilo({ directory, fetcher }); kilos.push(source);
  return { source, posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST') };
}

// Reproduction: the same history through the Messages route and the real Kilo adapter (reflection-beam is the same class).
it.each([
  ['truncated JSON string', truncated], ['empty string', ''], ['missing input', undefined], ['null input', null], ['array input', ['x']], ['number input', 5]
])('recovers a saved conversation whose historical tool call has a %s input', async (_name, input) => {
  const sent: { body?: Record<string, unknown> } = {}, f = kilo(sent);
  const response = await post(createLocalApp(new Sources([f.source])), '/v1/messages', history(input));
  expect(response.status).toBe(200);
  expect(f.posts()).toHaveLength(1);
  const messages = sent.body!.messages as { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[];
  // The call keeps its id and name and its result; only the unusable arguments are replaced.
  expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'call_poisoned', type: 'function', function: { name: 'Write', arguments: '{}' } }] });
  expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_poisoned', content: 'InputValidationError: required parameter missing' });
});

it('shows why the bridge refused: only the non-object arguments, not the other conversation shapes', () => {
  const refused = (body: unknown) => { try { new FreebuffTools(decode(body as Record<string, unknown>, 'messages', '/tmp')); return false; } catch { return true; } };
  // Control: valid arguments are accepted, and extra interleaving that Claude Code produces is tolerated.
  expect(refused(history({ file_path: '/a', content: 'x' }))).toBe(false);
  expect(refused(history({}, [{ role: 'user', content: [{ type: 'text', text: 'reminder' }] }]))).toBe(false);
  // Excluded causes stay refused: orphan result, duplicate pending id, a user message between call and result.
  const orphan = history({}); (orphan.messages[2]!.content as { tool_use_id: string }[])[0]!.tool_use_id = 'other';
  expect(refused(orphan)).toBe(true);
  const twice = history({}); (twice.messages[1]!.content as unknown[]).push({ type: 'tool_use', id: 'call_poisoned', name: 'Write', input: {} });
  expect(refused(twice)).toBe(true);
  const between = history({}); between.messages.splice(2, 0, { role: 'user', content: 'wait' });
  expect(refused(between)).toBe(true);
});

it('keeps valid historical arguments byte for byte and the translation deterministic', () => {
  const exact = '{ "file_path" : "/a",   "content":"x" }';
  const body = { model: 'grunt', messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'Write', arguments: exact } }, { id: 'b', type: 'function', function: { name: 'Write', arguments: truncated } }] },
    { role: 'tool', content: 'ra', tool_call_id: 'a' }, { role: 'tool', content: 'rb', tool_call_id: 'b' }
  ] };
  const first = decode(body, 'chat', '/tmp'), second = decode(JSON.parse(JSON.stringify(body)), 'chat', '/tmp');
  expect(first.messages).toEqual(second.messages);
  expect(first.messages[1]!.tool_calls).toEqual([
    { id: 'a', type: 'function', function: { name: 'Write', arguments: exact } },
    { id: 'b', type: 'function', function: { name: 'Write', arguments: '{}' } }
  ]);
  expect(first.messages[2]).toMatchObject({ tool_call_id: 'a', content: 'ra' });
  new FreebuffTools(first);
});

it('normalises historical arguments on the Chat and Responses routes too', () => {
  const chat = decode({ model: 'grunt', messages: [{ role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'Write', arguments: '' } }, { id: 'o', type: 'function', function: { name: 'Write', arguments: { k: 1 } } }] },
    { role: 'tool', content: 'ra', tool_call_id: 'a' }, { role: 'tool', content: 'ro', tool_call_id: 'o' }] }, 'chat', '/tmp');
  expect(chat.messages[1]!.tool_calls!.map(call => call.function.arguments)).toEqual(['{}', '{"k":1}']);
  new FreebuffTools(chat);
  const responses = decode({ model: 'grunt', input: [{ role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'a', name: 'Write', arguments: truncated }, { type: 'function_call', call_id: 'n', name: 'Write' },
    { type: 'function_call_output', call_id: 'a', output: 'ra' }, { type: 'function_call_output', call_id: 'n', output: 'rn' }] }, 'responses', '/tmp');
  expect(responses.messages[1]!.tool_calls!.map(call => call.function.arguments)).toEqual(['{}', '{}']);
  new FreebuffTools(responses);
});

// The gate for new calls: nothing unparseable is returned as complete, on any route or source.
const calls = (args: string) => [{ id: 'call_new', type: 'function' as const, function: { name: 'Write', arguments: args } }];
const sourceReturning = (id: string, completion: Completion): Source => ({ id, supportsFunctionTools: true, available: async () => true, complete: vi.fn(async () => completion) });
const toolBody = (api: 'messages' | 'chat' | 'responses', extra: Record<string, unknown> = {}) => api === 'messages'
  ? { model: 'grunt', stream: false, max_tokens: 8000, messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'Write', input_schema: { type: 'object' } }], ...extra }
  : api === 'chat'
    ? { model: 'grunt', stream: false, messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }], ...extra }
    : { model: 'grunt', stream: false, input: 'go', tools: [{ type: 'function', name: 'Write', parameters: { type: 'object' } }], ...extra };
const route = { messages: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' } as const;

it.each(['messages', 'chat', 'responses'] as const)('never returns unparseable arguments as complete: another source answers (%s)', async api => {
  const bad = sourceReturning('first', { text: '', calls: calls(truncated), finishReason: 'stop', outputTokens: 4096 });
  const good = sourceReturning('second', { text: '', calls: calls('{"file_path":"/a","content":"x"}') });
  const response = await post(createLocalApp(new Sources([bad, good])), route[api], toolBody(api));
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('second');
  expect(JSON.stringify(await response.json())).not.toContain('second li');
});

it.each(['messages', 'chat', 'responses'] as const)('reports a length limit instead of a stored partial call when the budget was reached (%s)', async api => {
  for (const completion of [{ finishReason: 'length' as const }, { finishReason: 'tool_calls' as const, outputTokens: 4096 }]) {
    const only = sourceReturning('only', { text: 'Partial text', calls: calls(truncated), ...completion });
    const body = await (await post(createLocalApp(new Sources([only])), route[api], toolBody(api, api === 'messages' ? { max_tokens: 4096 } : api === 'chat' ? { max_tokens: 4096 } : { max_output_tokens: 4096 }))).json() as { stop_reason?: string; content?: unknown; status?: string; output: { type: string }[]; choices: { finish_reason: string; message: { tool_calls?: unknown } }[] };
    if (api === 'messages') { expect(body.stop_reason).toBe('max_tokens'); expect(body.content).toEqual([{ type: 'text', text: 'Partial text' }]); }
    else if (api === 'chat') { expect(body.choices[0].finish_reason).toBe('length'); expect(body.choices[0].message.tool_calls).toBeUndefined(); }
    else { expect(body.status).toBe('incomplete'); expect(body.output.some(item => item.type === 'function_call')).toBe(false); }
  }
});

it('answers every unparseable or non-object new call with an invalid-sample error, and blank arguments with an empty object', async () => {
  for (const args of [truncated, '[1]', 'null', '"text"', '5']) {
    const only = sourceReturning('only', { text: '', calls: calls(args) });
    await expect(new Sources([only]).complete({ model: 'grunt', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Write', parameters: {} } }], cwd: '/tmp', stream: false }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools', httpStatus: 200 } });
  }
  const blank = sourceReturning('only', { text: '', calls: calls('') });
  const result = await new Sources([blank]).complete({ model: 'grunt', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Write', parameters: {} } }], cwd: '/tmp', stream: false }, AbortSignal.timeout(1000));
  expect(result.calls![0]!.function.arguments).toBe('{}');
});

it('routes past an invalid sample through the sticky router with only a short bench', async () => {
  const bad = sourceReturning('kilo', { text: '', calls: calls(truncated) }), good = sourceReturning('livekit', { text: '', calls: calls('{"a":1}') });
  const sources = new Sources([bad, good], { registry: () => ({ ...bundledRegistry, adapters: [bad, good].map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }), random: () => 0 });
  const result = await sources.complete({ model: 'grunt', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Write', parameters: {} } }], cwd: '/tmp', stream: false }, AbortSignal.timeout(1000));
  expect(result.calls![0]!.function.arguments).toBe('{"a":1}');
  await sources.close();
});

// The error when nothing can serve a request must not call a local refusal a quota wait.
const input: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'read', parameters: {} } }], cwd: '/tmp', stream: false };
function router(ids: string[], complete: (id: string) => Promise<Completion>) {
  const items = ids.map((id): Source => ({ id, supportsFunctionTools: true, available: async () => true, complete: () => complete(id) }));
  return new StickyRouter(items, { registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }), random: () => 0 });
}
it('answers a request every adapter refused locally as an invalid request, not quota', async () => {
  const r = router(['kilo', 'reflection-beam'], async () => { throw requestRefusal('refused'); });
  const error = await r.complete(input, AbortSignal.timeout(1000)).catch(e => e);
  await r.close();
  expect(error).toBeInstanceOf(RequestError);
  expect(error.message).toMatch(/2 adapters refused this conversation's tool definitions or tool history locally, before any provider was contacted/);
  expect(error.message).not.toMatch(/quota/);
});
it('keeps quota for the cooling adapters but says that others refused the request locally', async () => {
  const r = router(['kilo', 'runcrate'], async id => { throw id === 'kilo' ? requestRefusal('refused') : new SourceError('upstream', 'down', 120, undefined, { httpStatus: 502 }); });
  const error = await r.complete(input, AbortSignal.timeout(1000)).catch(e => e);
  await r.close();
  expect(error).toBeInstanceOf(SourceError); expect(error).not.toBeInstanceOf(RequestError);
  expect(error).toMatchObject({ code: 'quota' }); expect(error.retryAfter).toBeGreaterThan(0);
  expect(error.message).toMatch(/1 adapter refused this conversation's tool definitions or tool history locally/);
});
