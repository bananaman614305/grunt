import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent, DATA_SHARING_POLICIES } from './data-sharing.js';
import { Ifm, ifmDuration, ifmRetryAfter, IFM_MODEL } from './ifm.js';
import { bundledRegistry, localOptInAdapters } from '../registry.js';
import { providerQuotaPolicy } from './quota-policy.js';
import type { ModelRequest } from './source.js';
import { decode } from './api.js';
import { localRequestRefusal } from './routing-history.js';
import { ifmSchema } from './ifm.js';

let directory: string;
const grant = { base_url: 'https://api.ifm.ai', token: 'synthetic-key' };
const ask = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'ifm', cwd: directory, stream: false, messages: [{ role: 'user', content: 'Synthetic hello.' }], tools: [], ...extra });
const tool = { type: 'function' as const, function: { name: 'scout_probe', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } };
const catalog = { object: 'list', data: [{ id: IFM_MODEL, owned_by: 'MBZUAI', context_length: 524288, max_model_len: 524288 }] };
const reply = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ model: IFM_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 17, completion_tokens: 9 }, ...extra });
function api(chat: () => Response | Promise<Response>, models: unknown = catalog) {
  return vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/models') ? Response.json(models) : chat());
}
const source = (fetcher: typeof fetch, now?: () => number) => new Ifm({ directory, fetcher, loadGrant: async () => grant, ...(now ? { now } : {}) });
const approved = () => recordDataSharingConsent(directory, ['ifm']);
const posts = (fetcher: ReturnType<typeof api>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'));
const bodyOf = (fetcher: ReturnType<typeof api>, index = 0) => JSON.parse(String(posts(fetcher)[index]![1]!.body));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ifm-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('stays off and sends nothing without its own data-sharing receipt', async () => {
  const fetcher = api(() => Response.json(reply({ content: 'hi' })));
  expect(await source(fetcher).available()).toBe(false);
  await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not inherit another source’s consent', async () => {
  await recordDataSharingConsent(directory, ['millionseek', 'kilo', 'crowllm']);
  expect(await source(api(() => Response.json(reply({ content: 'hi' })))).available()).toBe(false);
});

it('answers a hello, strips the template newline, pins the model and passes the documented sampling', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: '\nHello', reasoning: 'thinking' })));
  await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).resolves.toEqual({ text: 'Hello', inputTokens: 17, outputTokens: 9 });
  expect(String(posts(fetcher)[0]![0])).toBe('https://api.ifm.ai/v1/chat/completions');
  expect(bodyOf(fetcher)).toMatchObject({ model: IFM_MODEL, temperature: 1, top_p: 0.95 });
  expect(bodyOf(fetcher)).not.toHaveProperty('max_tokens');
});

it('honours the caller output budget and adds no cap of its own', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'ok' })));
  await source(fetcher).complete(ask({ maxTokens: 9000 }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher).max_tokens).toBe(9000);
});

it.each([
  ['a different model in the body', () => Response.json(reply({ content: 'x' }, { model: 'other/model' }))],
  ['a different served-model header', () => Response.json(reply({ content: 'x' }), { headers: { 'ifm-served-model': 'other/model' } })],
  ['a reported charge', () => Response.json(reply({ content: 'x' }, { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }))],
  ['an empty answer', () => Response.json(reply({ content: '\n' }))]
])('rejects %s', async (_name, chat) => {
  await approved();
  await expect(source(api(chat)).complete(ask(), AbortSignal.timeout(5000))).rejects.toBeInstanceOf(Error);
});

it('refuses a catalog that lacks the exact model or its documented context', async () => {
  await approved();
  for (const models of [{ data: [] }, { data: [{ ...catalog.data[0], context_length: 131072 }] }, { data: [{ ...catalog.data[0], owned_by: 'someone' }] }]) {
    const fetcher = api(() => Response.json(reply({ content: 'x' })), models);
    expect(await source(fetcher).available()).toBe(false);
    await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
    expect(posts(fetcher)).toHaveLength(0);
  }
});

it('rejects a grant for any other host', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'x' })));
  const other = new Ifm({ directory, fetcher, loadGrant: async () => ({ base_url: 'https://example.com', token: 'synthetic' }) });
  expect(await other.available()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('returns a validated native tool call and refuses one that breaks its schema', async () => {
  await approved();
  const call = (args: string) => ({ content: '\n', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'scout_probe', arguments: args } }] });
  const good = api(() => Response.json(reply(call('{"value": 7}'), {})));
  await expect(source(good).complete(ask({ tools: [tool] }), AbortSignal.timeout(5000))).resolves.toMatchObject({ text: '', calls: [{ id: 'call-1', function: { name: 'scout_probe', arguments: '{"value": 7}' } }] });
  expect(bodyOf(good).tools).toHaveLength(1);
  const bad = api(() => Response.json(reply(call('{"value": "seven"}'))));
  await expect(source(bad).complete(ask({ tools: [tool] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
});

it('replays reasoning verbatim on the matching assistant turn and only there', async () => {
  await approved();
  const calls = [{ id: 'call-1', type: 'function', function: { name: 'scout_probe', arguments: '{"value": 7}' } }];
  const fetcher = api(() => Response.json(reply({ content: '\n', reasoning: 'Plan: call the probe.\n', tool_calls: calls })));
  const client = source(fetcher);
  const first = await client.complete(ask({ tools: [tool] }), AbortSignal.timeout(5000));
  const turn = [{ role: 'user', content: 'Synthetic hello.' }, { role: 'assistant', content: '', tool_calls: first.calls },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }];
  fetcher.mockImplementation(async url => String(url).endsWith('/v1/models') ? Response.json(catalog) : Response.json(reply({ content: 'Done.' })));
  await client.complete(ask({ tools: [tool], messages: turn }), AbortSignal.timeout(5000));
  const sent = bodyOf(fetcher, 1).messages;
  expect(sent[1]).toMatchObject({ role: 'assistant', reasoning_content: 'Plan: call the probe.\n' });
  expect(sent[0]).not.toHaveProperty('reasoning_content');
  expect(sent[2]).not.toHaveProperty('reasoning_content');
  // A different conversation that merely reuses the call id does not receive that reasoning.
  const other = [{ role: 'user', content: 'Other.' }, { role: 'assistant', content: '', tool_calls: [{ ...first.calls![0]!, function: { name: 'scout_probe', arguments: '{"value": 8}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }];
  await client.complete(ask({ tools: [tool], messages: other }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher, 2).messages[1].reasoning_content).toBe('');
});

it('accepts the documented reasoning_content field name too', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'Answer.', reasoning_content: 'because' })));
  const client = source(fetcher);
  await client.complete(ask(), AbortSignal.timeout(5000));
  await client.complete(ask({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Answer.' }, { role: 'user', content: 'again' }] }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher, 1).messages[1].reasoning_content).toBe('because');
});

it('reports a reply cut off by its budget as length-limited and drops its unfinished tool call', async () => {
  await approved();
  const cut = api(() => Response.json(reply({ content: '\nPartial answer', tool_calls: [{ id: 'c', type: 'function', function: { name: 'scout_probe', arguments: '{"val' } }] },
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '\nPartial answer', tool_calls: [{ id: 'c', type: 'function', function: { name: 'scout_probe', arguments: '{"val' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 64 } })));
  await expect(source(cut).complete(ask({ tools: [tool], maxTokens: 64 }), AbortSignal.timeout(5000)))
    .resolves.toEqual({ text: 'Partial answer', finishReason: 'length', inputTokens: 20, outputTokens: 64 });
});

it('stops on HTTP 402 and never treats it as quota', async () => {
  await approved();
  const client = source(api(() => new Response('{}', { status: 402 })));
  await expect(client.complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
});

it('uses Retry-After on a 429, and the next UTC midnight when the daily counter is empty', async () => {
  await approved();
  const now = Date.UTC(2026, 10, 25, 20, 0, 0);
  const limited = (headers: Record<string, string>) => source(api(() => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers })), () => now);
  await expect(limited({ 'retry-after': '37' }).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 37 });
  // Third-party day counters (seen only on the Cerebras route) are not the key's allowance.
  await expect(limited({ 'x-ratelimit-remaining-tokens-day': '0' }).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 30 });
  const daily = limited({ 'x-ratelimit-remaining-tokens-daily': '0' });
  await expect(daily.complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 4 * 3600 });
  expect(daily.quotaWindow()).toEqual({ startedAt: Date.UTC(2026, 10, 25), resetAt: Date.UTC(2026, 10, 26) });
  await expect(limited({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s' }).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 1 });
});

it('gives a bare 429 only a short local back-off, never the default hour', async () => {
  await approved();
  await expect(source(api(() => new Response('{}', { status: 429 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 30 });
});

it('spaces request starts to the observed guard of two per second and stays cancellable', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'ok' })));
  const client = source(fetcher);
  const started = Date.now();
  await Promise.all([1, 2, 3, 4, 5].map(() => client.complete(ask(), AbortSignal.timeout(10000))));
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect(posts(fetcher)).toHaveLength(5);
  const stop = new AbortController();
  const waiting = [1, 2, 3].map(() => client.complete(ask(), stop.signal).catch(error => error));
  setTimeout(() => stop.abort(), 50);
  const results = await Promise.all(waiting);
  expect(results.some(result => result instanceof Error)).toBe(true);
});

it('infers no reset from a bare 429', () => {
  expect(ifmRetryAfter(new Headers(), Date.now())).toBeUndefined();
  expect(ifmRetryAfter(new Headers({ 'x-ratelimit-remaining-tokens': '30000000', 'x-ratelimit-reset-tokens': '24h0m0s' }), Date.now())).toBeUndefined();
});

it('parses Go-style durations', () => {
  expect([ifmDuration('1s'), ifmDuration('1m30s'), ifmDuration('250ms'), ifmDuration('24h0m0s'), ifmDuration('soon'), ifmDuration(null)]).toEqual([1, 90, 1, 86400, undefined, undefined]);
});

it('maps 401 to logged out and 403 to refused', async () => {
  await approved();
  await expect(source(api(() => new Response('{}', { status: 401 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
  await expect(source(api(() => new Response('{}', { status: 403 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
});

it('refuses images and hosted tools before any request', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'x' })));
  await expect(source(fetcher).complete(ask({ imageInput: true }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  await expect(source(fetcher).complete(ask({ tools: [{ type: 'web_search' }] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('is a local opt-in with the lowest weight, outside the bundled registry, and states what is unverified', () => {
  const entry = localOptInAdapters.find(adapter => adapter.id === 'ifm')!;
  expect(entry.weight).toBeLessThan(Math.min(...localOptInAdapters.filter(adapter => adapter.id !== 'ifm').map(adapter => adapter.weight)));
  expect(entry.weight).toBeLessThan(Math.min(...bundledRegistry.adapters.map(adapter => adapter.weight)));
  expect(bundledRegistry.adapters.some(adapter => adapter.id === 'ifm')).toBe(false);
  const policy = DATA_SHARING_POLICIES.find(item => item.provider === 'ifm')!;
  expect(policy.approval).toBe('material');
  expect(policy.disclosure).toMatch(/unverified/);
  expect(policy.disclosure).toMatch(/Cerebras, Nebius and AWS/);
  expect(providerQuotaPolicy('ifm')).toMatchObject({ refill: 'utc-daily' });
});

it('is never recorded by naming the source: only its own listed approval records it, and a changed policy needs it again', async () => {
  const { approveDataSharing, readDataSharingConsent, refreshDataSharingConsent, recordDataSharingConsent: record } = await import('./data-sharing.js');
  const notice = vi.fn();
  expect(await approveDataSharing({ directory, providers: ['ifm', 'opencode'], notice, env: {} })).toMatchObject({ skipped: ['ifm'], approved: ['opencode'] });
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual([]);
  expect(await approveDataSharing({ directory, providers: ['ifm'], notice, env: { GRUNT_APPROVE_DATA_SHARING: 'millionseek,kilo' } })).toMatchObject({ skipped: ['ifm'] });
  expect(await approveDataSharing({ directory, providers: ['ifm'], notice, env: { GRUNT_APPROVE_DATA_SHARING: 'ifm' } })).toMatchObject({ approved: ['ifm'], skipped: [] });
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual(['ifm']);
  // A stale receipt for an older policy version is not renewed on its own.
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(join(directory, 'data-sharing-consent.json'), JSON.stringify({ version: 1, approved: { ifm: { policy: 'old', approvedAt: new Date().toISOString() } } }));
  await chmod(join(directory, 'data-sharing-consent.json'), 0o600);
  expect(await refreshDataSharingConsent(directory, {})).toEqual([]);
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual([]);
  await record(directory, ['ifm']);
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual(['ifm']);
});

it('lets another source take over after an inference timeout', async () => {
  // Routing treats a timeout as replayable only for inference-only sources; IFM runs no native work.
  expect(source(api(() => Response.json(reply({ content: 'hi' })))).inferenceOnly).toBe(true);
});

// Regression for the first live builder request: IFM's gateway answered HTTP 422 to a conversation whose history came
// from other sources, because its assistant turns had no thinking field. Bodies below are synthetic and shaped like the
// Anthropic Messages request Claude Code sends.
const claudeCodeShape = {
  system: [{ type: 'text', text: 'Synthetic system prompt.' }],
  tools: [{ name: 'Read', description: 'Read.', input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] } }],
  max_tokens: 32000,
  messages: [
    { role: 'user', content: 'Synthetic task.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_01AAA', name: 'Read', input: { path: 'a' } }, { type: 'tool_use', id: 'call_other_source_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01AAA', content: '' }, { type: 'tool_result', tool_use_id: 'call_other_source_1', content: 'ok' }, { type: 'text', text: '<system-reminder>synthetic</system-reminder>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Plain text turn from another source.' }] },
    { role: 'user', content: 'Continue.' }
  ]
};

it('gives every assistant turn a thinking field, including history another source produced', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'ok' })));
  const request = { ...decode(claudeCodeShape, 'messages'), model: 'ifm' } as ModelRequest;
  await source(fetcher).complete({ ...request, messages: [...request.messages, { role: 'user', content: 'Handoff prompt.' }], handoffPrompt: 'Handoff prompt.' }, AbortSignal.timeout(5000));
  const sent = bodyOf(fetcher);
  const assistants = sent.messages.filter((m: { role: string }) => m.role === 'assistant');
  expect(assistants).toHaveLength(2);
  for (const message of assistants) expect(message.reasoning_content).toBe('');
  expect(sent.max_tokens).toBe(32000);
  for (const message of sent.messages) expect(Object.keys(message).every(key => ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id'].includes(key))).toBe(true);
  expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'Handoff prompt.' });
});

it.each([[400, 'request_body'], [422, 'request_body'], [413, 'request_size']])('treats HTTP %i as a request-shape refusal, not provider health', async (status, reason) => {
  await approved();
  const client = source(api(() => Response.json({ error: { type: 'invalid_request_error', message: 'synthetic detail that must not be kept' } }, { status })));
  const error = await client.complete(ask(), AbortSignal.timeout(5000)).catch(e => e);
  expect(error).toMatchObject({ code: 'refused', diagnostics: { httpStatus: status, failureReason: reason } });
  expect(localRequestRefusal(error)).toBe(true);
  expect(error.message).not.toMatch(/synthetic detail/);
});

it('other 4xx and 5xx statuses still count as provider failures', async () => {
  await approved();
  for (const status of [404, 500, 502]) {
    const error = await source(api(() => new Response('{}', { status }))).complete(ask(), AbortSignal.timeout(5000)).catch(e => e);
    expect(error).toMatchObject({ code: 'upstream' });
    expect(localRequestRefusal(error)).toBe(false);
  }
});

it('drops "required" entries the schema does not back, as IFM rejects them, and keeps valid schemas intact', () => {
  expect(ifmSchema({ type: 'object', required: ['x'] })).toEqual({ type: 'object' });
  expect(ifmSchema({ type: 'object', properties: {}, required: [] })).toEqual({ type: 'object', properties: {}, required: [] });
  expect(ifmSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] })).toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  const nested = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', required: ['k'] } }, pick: { anyOf: [{ type: 'object', required: ['z'] }, { type: 'null' }] } }, required: ['list'] };
  expect(ifmSchema(nested)).toEqual({ type: 'object', properties: { list: { type: 'array', items: { type: 'object' } }, pick: { anyOf: [{ type: 'object', required: ['z'] }, { type: 'null' }] } }, required: ['list'] });
  const valid = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: { p: { type: 'string', format: 'uri' } }, required: ['p'] };
  expect(ifmSchema(valid)).toEqual(valid);
});

it('sends the normalised schema but validates the model’s call against the original', async () => {
  await approved();
  const loose = { type: 'function' as const, function: { name: 'loose', parameters: { type: 'object', allOf: [{ properties: { x: { type: 'string' } } }], required: ['x'] } } };
  const fetcher = api(() => Response.json(reply({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'loose', arguments: '{"y":1}' } }] })));
  await expect(source(fetcher).complete(ask({ tools: [loose] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
  expect(bodyOf(fetcher).tools[0].function.parameters).toEqual({ type: 'object', allOf: [{ properties: { x: { type: 'string' } } }] });
  expect(loose.function.parameters.required).toEqual(['x']);
});

// ---- Streaming. K2 is streamed purely for liveness: Grunt still returns one whole reply. ----
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}, finish: string | null = null) =>
  ({ id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', model: IFM_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usageChunk = (prompt = 17, completion = 9, extra: Record<string, unknown> = {}) => ({ id: 'chatcmpl-synthetic', model: IFM_MODEL, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, ...extra } });
const sse = (events: (object | string)[], headers: Record<string, string> = {}) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers } });
const hello = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning: 'Think ' }), chunk({ reasoning: 'more.' }), chunk({ content: '\n' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }),
  chunk({}, { usage: { prompt_tokens: 17, completion_tokens: 9 } }, 'stop'), '[DONE]'];

it('streams for liveness and returns one whole reply with usage, asking for usage in the stream', async () => {
  await approved();
  const fetcher = api(() => sse(hello, { 'ifm-served-model': IFM_MODEL }));
  await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).resolves.toEqual({ text: 'Hello', inputTokens: 17, outputTokens: 9 });
  expect(bodyOf(fetcher)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
});

it('accepts a finish chunk followed by a usage-only chunk with no choices', async () => {
  await approved();
  const events = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning: 'r' }), chunk({ content: 'Hi' }), chunk({}, {}, 'stop'), usageChunk(), '[DONE]'];
  await expect(source(api(() => sse(events))).complete(ask(), AbortSignal.timeout(5000))).resolves.toMatchObject({ text: 'Hi', inputTokens: 17, outputTokens: 9 });
});

it('counts reasoning deltas as progress, so a long thinking phase keeps the deadlines satisfied', async () => {
  await approved();
  const progress = vi.fn();
  await source(api(() => sse(hello))).complete(ask(), AbortSignal.timeout(5000), progress);
  expect(progress.mock.calls.length).toBeGreaterThanOrEqual(3);
  const reasoningOnly = vi.fn();
  const events = [chunk({ role: 'assistant' }), chunk({ reasoning: 'only thinking' }), chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 3 } }, 'length'), '[DONE]'];
  await source(api(() => sse(events))).complete(ask({ maxTokens: 3 }), AbortSignal.timeout(5000), reasoningOnly);
  expect(reasoningOnly).toHaveBeenCalled();
});

it('replays the streamed reasoning (either field name) on the next turn', async () => {
  await approved();
  const fetcher = api(() => sse(hello));
  const client = source(fetcher);
  await client.complete(ask(), AbortSignal.timeout(5000));
  await client.complete(ask({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'again' }] }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher, 1).messages[1].reasoning_content).toBe('Think more.');
});

it('assembles parallel tool calls delivered whole or in indexed fragments', async () => {
  await approved();
  const two = { type: 'function' as const, function: { name: 'scout_probe_b', parameters: tool.function.parameters } };
  const whole = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning: 'plan' }), chunk({ tool_calls: [
    { index: 0, id: 'a1', type: 'function', function: { name: 'scout_probe', arguments: '{"value": 1}' } },
    { index: 1, id: 'b1', type: 'function', function: { name: 'scout_probe_b', arguments: '{"value": 2}' } }] }), chunk({}, { usage: { prompt_tokens: 40, completion_tokens: 20 } }, 'tool_calls'), '[DONE]'];
  const replyWhole = await source(api(() => sse(whole))).complete(ask({ tools: [tool, two] }), AbortSignal.timeout(5000));
  expect(replyWhole.calls?.map(call => [call.id, call.function.name, call.function.arguments])).toEqual([['a1', 'scout_probe', '{"value": 1}'], ['b1', 'scout_probe_b', '{"value": 2}']]);
  const fragments = [chunk({ role: 'assistant' }), chunk({ tool_calls: [{ index: 0, id: 'a1', type: 'function', function: { name: 'scout_probe', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'b1', type: 'function', function: { name: 'scout_probe_b', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"value"' } }] }), chunk({ tool_calls: [{ index: 1, function: { arguments: '{"value": 2}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ': 1}' } }] }), chunk({}, { usage: { prompt_tokens: 40, completion_tokens: 20 } }, 'tool_calls'), '[DONE]'];
  const replyParts = await source(api(() => sse(fragments))).complete(ask({ tools: [tool, two] }), AbortSignal.timeout(5000));
  expect(replyParts.calls?.map(call => call.function.arguments)).toEqual(['{"value": 1}', '{"value": 2}']);
  const bad = [chunk({ tool_calls: [{ index: 0, id: 'a1', type: 'function', function: { name: 'scout_probe', arguments: '{"value": "x"}' } }] }), chunk({}, { usage: { prompt_tokens: 4, completion_tokens: 2 } }, 'tool_calls'), '[DONE]'];
  await expect(source(api(() => sse(bad))).complete(ask({ tools: [tool] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
});

it('reports a stream cut off by the output budget as length-limited, even with only reasoning', async () => {
  await approved();
  const cut = [chunk({ role: 'assistant' }), chunk({ reasoning: 'thinking without end' }), chunk({}, { usage: { prompt_tokens: 20, completion_tokens: 64 } }, 'length'), '[DONE]'];
  await expect(source(api(() => sse(cut))).complete(ask({ maxTokens: 64 }), AbortSignal.timeout(5000)))
    .resolves.toEqual({ text: '', finishReason: 'length', inputTokens: 20, outputTokens: 64 });
});

it.each([
  ['an answer that is only reasoning', [chunk({ role: 'assistant' }), chunk({ reasoning: 'thought' }), chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 3 } }, 'stop'), '[DONE]'], 'stream_incomplete'],
  ['a stream without [DONE]', [chunk({ content: 'Hi' }), chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 3 } }, 'stop')], 'stream_incomplete'],
  ['a stream without a finish reason', [chunk({ content: 'Hi' }), usageChunk(), '[DONE]'], 'stream_incomplete'],
  ['a chunk of another model', [{ ...chunk({ content: 'Hi' }), model: 'other/model' }, '[DONE]'], 'completion_model'],
  ['an error event', [{ error: { message: 'x' } }, '[DONE]'], 'stream_format'],
  ['a refusal delta', [chunk({ refusal: 'no' }), '[DONE]'], undefined]
])('treats %s as a failed reply', async (_name, events, reason) => {
  await approved();
  const error = await source(api(() => sse(events as (object | string)[]))).complete(ask(), AbortSignal.timeout(5000)).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  if (reason) expect(error).toMatchObject({ code: 'upstream', diagnostics: { failureReason: reason } });
  else expect(error).toMatchObject({ code: 'refused' });
});

it('refuses a reported charge and a stream with no usage', async () => {
  await approved();
  const charged = [chunk({ content: 'Hi' }), chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.02 } }, 'stop'), '[DONE]'];
  await expect(source(api(() => sse(charged))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  const unmetered = [chunk({ content: 'Hi' }), chunk({}, {}, 'stop'), '[DONE]'];
  await expect(source(api(() => sse(unmetered))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
  const over = [chunk({ content: 'Hi' }), chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 99 } }, 'stop'), '[DONE]'];
  await expect(source(api(() => sse(over))).complete(ask({ maxTokens: 10 }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
});

it('cancels the stream reader when the caller aborts mid-reply', async () => {
  await approved();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ reasoning: 'x' }))}\n\n`)); }, cancel() { cancelled = true; } });
  const fetcher = api(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const stop = new AbortController();
  const pending = source(fetcher).complete(ask(), stop.signal).catch(e => e);
  await new Promise(resolve => setTimeout(resolve, 100));
  stop.abort();
  expect(await pending).toBeInstanceOf(Error);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(cancelled).toBe(true);
});

it('accepts a streamed reply well past the shared 4 MiB stream cap', async () => {
  await approved();
  const events: (object | string)[] = [chunk({ role: 'assistant' }), ...Array.from({ length: 24000 }, () => chunk({ content: 'word ' }, { created: 1795594223, logprobs: null, token_ids: null, extra: 'x'.repeat(40) })),
    chunk({}, { usage: { prompt_tokens: 100, completion_tokens: 24000 } }, 'stop'), '[DONE]'];
  const reply = await source(api(() => sse(events))).complete(ask({ maxTokens: 32000 }), AbortSignal.timeout(30000));
  expect(reply.text.length).toBe(24000 * 5);
  expect(reply.outputTokens).toBe(24000);
});

it('keeps the shape refusals and the rate guard when the reply would have been streamed', async () => {
  await approved();
  await expect(source(api(() => new Response('{}', { status: 422 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_body' } });
  await expect(source(api(() => new Response('{}', { status: 429, headers: { 'retry-after': '9' } }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 9 });
});

it('survives the pool first-output deadline on a reply that streams for longer than a minute', async () => {
  await approved();
  const realTimeout = globalThis.setTimeout;
  const realSleep = (ms: number) => new Promise<void>(resolve => realTimeout(resolve, ms));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  try {
    const { Sources } = await import('./source.js');
    const encoder = new TextEncoder();
    // Thinking for 90 s, one reasoning delta every 20 s, then a short answer: a non-streamed reply would be cut at 60 s.
    const slow = new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`));
      for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 20000)); controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ reasoning: `step ${i} ` }))}\n\n`)); }
      for (const event of [chunk({ content: 'Done.' }), chunk({}, { usage: { prompt_tokens: 7, completion_tokens: 5 } }, 'stop'), '[DONE]']) controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
      controller.close();
    } });
    const pool = new Sources([source(api(() => new Response(slow, { headers: { 'content-type': 'text/event-stream' } })))]);
    const result = pool.complete({ ...ask(), model: 'grunt' }, AbortSignal.timeout(900000));
    // Let the request reach the stream in real time, then move the fake clock in ten-second steps.
    for (let elapsed = 0; elapsed < 130000; elapsed += 10000) { await realSleep(15); await vi.advanceTimersByTimeAsync(10000); }
    await expect(result).resolves.toMatchObject({ text: 'Done.' });
    await pool.close();
  } finally { vi.useRealTimers(); }
});
