import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kilo, KILO_BEAM, KILO_ORIGIN, KILO_PARTICLE, verifyKiloAccess } from './kilo.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { writePrivateProviderGrant } from './provider-grant.js';
import { beginSetupSession, readSetupSession } from './setup-session.js';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';
let directory: string;
const sources: Kilo[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-kilo-')); await recordDataSharingConsent(directory, ['kilo']); });
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const request = (): ModelRequest => ({ model: 'kilo', messages: [{ role: 'user', content: 'Hello' }], tools: [], cwd: '/tmp', stream: false });
const model = (id: string = KILO_PARTICLE) => ({ id, isFree: true, pricing: { prompt: '0', completion: '0' }, context_length: 1048576, supported_parameters: ['tools', 'max_tokens'] });
const usage = () => ({ prompt_tokens: 20, completion_tokens: 5, cost: 0, cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } });
const result = (patch: Record<string, unknown> = {}) => ({ model: KILO_PARTICLE, choices: [{ message: { role: 'assistant', content: 'Hello.' } }], usage: usage(), ...patch });
const tool = { type: 'function', function: { name: 'nonce', parameters: { type: 'object', properties: { nonce: { type: 'string', const: 'synthetic' } }, required: ['nonce'], additionalProperties: false } } };
const call: ToolCall = { id: 'native_call', type: 'function', function: { name: 'nonce', arguments: '{"nonce":"synthetic"}' } };
function fixture(options: { catalog?: unknown; catalogRows?: unknown[]; reflectionBeam?: boolean; infer?: (init?: RequestInit) => Response | Promise<Response>; timeout?: number; anonymous?: () => boolean } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === `${KILO_ORIGIN}/models`) return Response.json({ data: options.catalogRows ?? [options.catalog ?? model()] });
    if (String(url) === `${KILO_ORIGIN}/chat/completions`) return options.infer?.(init) ?? Response.json(result());
    throw new Error('Unexpected endpoint');
  });
  const source = new Kilo({ directory, fetcher, ...(options.reflectionBeam ? { reflectionBeam: true } : {}), ...(options.timeout ? { timeout: options.timeout } : {}), ...(options.anonymous ? { anonymous: options.anonymous } : {}) }); sources.push(source);
  return { source, fetcher, posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST') };
}
it('uses only fixed anonymous Particle with no inherited key, and checks live free metadata before inference', async () => {
  vi.stubEnv('KILO_API_KEY', 'synthetic-unrelated-private-key'); const f = fixture();
  expect(await f.source.available()).toBe(true); expect(f.posts()).toHaveLength(0);
  expect(await f.source.complete({ ...request(), model: 'arbitrary-paid-alias', maxTokens: 10000 }, new AbortController().signal)).toEqual({ text: 'Hello.', inputTokens: 20, outputTokens: 5 });
  expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([`${KILO_ORIGIN}/models`, `${KILO_ORIGIN}/models`, `${KILO_ORIGIN}/chat/completions`]);
  for (const [, init] of f.fetcher.mock.calls) { expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).has('authorization')).toBe(false); }
  expect(JSON.parse(f.posts()[0]![1]!.body as string)).toMatchObject({ model: KILO_PARTICLE, max_tokens: 4096, stream: false });
});

it('probes Kilo without its saved grant until setup switches to account bootstrap', async () => {
  await writePrivateProviderGrant('kilo', { base_url: 'https://squire.test', token: 'synthetic' }, directory);
  const session = await beginSetupSession(directory, ['kilo'], { anonymousKilo: true });
  try {
    let anonymous = (await readSetupSession(directory))?.anonymousKilo === true;
    const f = fixture({ anonymous: () => anonymous });
    await expect(f.source.complete(request(), session.signal)).resolves.toMatchObject({ text: 'Hello.' });
    expect(f.posts().map(([url]) => url)).toEqual([`${KILO_ORIGIN}/chat/completions`]);
    await session.useKiloAccount();
    anonymous = (await readSetupSession(directory))?.anonymousKilo === true;
    await expect(f.source.complete(request(), session.signal)).rejects.toThrow();
    expect(f.posts().at(-1)?.[0]).toBe('https://squire.test/api/gateway/chat/completions');
  } finally { await session.close(); }
});
it.each([
  { isFree: false }, { id: 'kilo-auto/free' }, { context_length: 199999 }, { pricing: { prompt: '0', completion: '0.01' } },
  { pricing: { prompt: '', completion: '0' } }, { pricing: { prompt: '0', completion: '0', request: '0.01' } }, { supported_parameters: ['max_tokens'] }
])('fails closed before inference when the free catalog changes (%j)', async patch => {
  const f = fixture({ catalog: { ...model(), ...patch } }); expect(await f.source.available()).toBe(false);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.posts()).toHaveLength(0);
});
it('rejects missing or duplicate exact catalog rows', async () => {
  for (const data of [[], [model(), model()]]) await expect(verifyKiloAccess({ fetcher: async () => Response.json({ data }) })).rejects.toMatchObject({ code: 'refused' });
});
it('requires current consent before metadata or inference', async () => {
  await rm(join(directory, 'data-sharing-consent.json')); const f = fixture(); expect(await f.source.available()).toBe(false);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.fetcher).not.toHaveBeenCalled();
});
it('honors the caller cap without raising it, and refuses invalid caps before the network', async () => {
  const f = fixture({ infer: () => Response.json(result({ usage: { ...usage(), completion_tokens: 1 } })) });
  await f.source.complete({ ...request(), maxTokens: 1 }, new AbortController().signal); expect(JSON.parse(f.posts()[0]![1]!.body as string).max_tokens).toBe(1);
  for (const maxTokens of [0, -1, 1.1, NaN]) await expect(f.source.complete({ ...request(), maxTokens }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(f.posts()).toHaveLength(1);
});
it.each([
  { model: 'kilo-auto/free' }, { model: 'particle-ai/particle-1' }, { usage: { ...usage(), cost: 0.001 } },
  { usage: { ...usage(), cost_details: {} } }, { usage: { ...usage(), cost_details: { ...usage().cost_details, upstream_inference_cost: 1 } } },
  { usage: { ...usage(), completion_tokens: 5000 } }, { usage: { ...usage(), prompt_tokens: -1 } }
])('rejects unverified identity, charges and malformed usage without retrying (%j)', async patch => {
  const f = fixture({ infer: () => Response.json(result(patch)) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.posts()).toHaveLength(1);
});
it('preserves native call IDs and validates arguments against the requested schema', async () => {
  const f = fixture({ infer: () => Response.json(result({ choices: [{ message: { content: null, tool_calls: [call] } }] })) });
  expect((await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).calls).toEqual([call]);
  const invalid = fixture({ infer: () => Response.json(result({ choices: [{ message: { content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: '{"nonce":"wrong"}' } }] } }] })) });
  await expect(invalid.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
});
it('rejects unknown/duplicate/reused function calls', async () => {
  for (const calls of [[{ ...call, function: { ...call.function, name: 'invented' } }], [call, call]]) {
    const f = fixture({ infer: () => Response.json(result({ choices: [{ message: { content: null, tool_calls: calls } }] })) });
    await expect(f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
  }
});
it('rejects invalid schemas and uncorrelated results before any request', async () => {
  const f = fixture();
  for (const payload of [
    { ...request(), messages: [{ role: 'tool', content: 'invented', tool_call_id: 'invented' }] },
    { ...request(), tools: [{ type: 'web_search' }] },
    { ...request(), tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'imaginary' } } }] }
  ]) await expect(f.source.complete(payload, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  ['request_tool_schema', () => ({ ...request(), tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'imaginary' } } }] })],
  ['request_tools', () => ({ ...request(), messages: [{ role: 'tool', content: 'private uncorrelated result', tool_call_id: 'invented' }] })],
  ['request_body', () => ({ ...request(), maxTokens: 0 })],
  ['request_body', () => ({ ...request(), imageInput: true })],
  ['request_size', () => ({ ...request(), messages: [{ role: 'user', content: 'private request marker ' + 'x'.repeat(2 * 1024 * 1024) }] })]
] as const)('records only a fixed %s reason for local request refusals before the network', async (failureReason, makeRequest) => {
  const f = fixture();
  const pending = f.source.complete(makeRequest(), new AbortController().signal);
  await expect(pending).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason } });
  try { await pending; } catch (error) {
    expect((error as { diagnostics?: unknown }).diagnostics).toEqual({ failureReason });
    expect(JSON.stringify((error as { diagnostics?: unknown }).diagnostics)).not.toContain('private');
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('coalesces Responses parallel calls and preserves both correlated results on the native wire', async () => {
  let sent: Record<string, unknown> = {}; const f = fixture({ infer: init => { sent = JSON.parse(String(init?.body)); return Response.json(result()); } });
  const app = createLocalApp(new Sources([f.source]));
  const response = await app.request('http://localhost:8788/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'kilo', input: [
    { role: 'user', content: 'Use two results' },
    { type: 'function_call', call_id: 'a', name: 'nonce', arguments: '{"nonce":"synthetic"}' },
    { type: 'function_call', call_id: 'b', name: 'nonce', arguments: '{"nonce":"synthetic"}' },
    { type: 'function_call_output', call_id: 'a', output: 'result-a' },
    { type: 'function_call_output', call_id: 'b', output: 'result-b' }
  ] }) });
  expect(response.status).toBe(200); expect(sent.messages).toEqual([
    { role: 'user', content: 'Use two results' },
    { role: 'assistant', content: '', tool_calls: [{ ...call, id: 'a' }, { ...call, id: 'b' }] },
    { role: 'tool', content: 'result-a', tool_call_id: 'a' }, { role: 'tool', content: 'result-b', tool_call_id: 'b' }
  ]);
});
it('remaps a reused historical call ID only after its results completed, without mutating the request', async () => {
  let sent: ModelRequest['messages'] = []; const f = fixture({ infer: init => { sent = JSON.parse(String(init?.body)).messages; return Response.json(result()); } });
  // Metadata-only reproduction: separately completed turns reuse one call ID.
  const payload = { ...request(), messages: [
    { role: 'user', content: 'synthetic context' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'first synthetic result', tool_call_id: call.id },
    { role: 'assistant', content: '', tool_calls: [{ ...call, id: 'other_call' }] },
    { role: 'tool', content: 'other synthetic result', tool_call_id: 'other_call' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'second synthetic result', tool_call_id: call.id },
    { role: 'user', content: 'continue' }
  ] };
  const before = structuredClone(payload);
  await expect(f.source.complete(payload, new AbortController().signal)).resolves.toMatchObject({ text: 'Hello.' });
  expect(payload).toEqual(before);
  expect(sent[1]!.tool_calls![0]!.id).toBe(call.id);
  const repeatedId = sent[5]!.tool_calls![0]!.id;
  expect(repeatedId).not.toBe(call.id); expect(repeatedId).not.toBe('other_call');
  expect(sent[2]).toEqual({ role: 'tool', content: 'first synthetic result', tool_call_id: call.id });
  expect(sent[6]).toEqual({ role: 'tool', content: 'second synthetic result', tool_call_id: repeatedId });
});
it('reserves future original IDs and rejects responses reusing remapped history IDs', async () => {
  const payload = { ...request(), tools: [tool], messages: [
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'synthetic result one', tool_call_id: call.id },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'synthetic result two', tool_call_id: call.id },
    { role: 'assistant', content: '', tool_calls: [{ ...call, id: 'grunt_call_1' }] },
    { role: 'tool', content: 'synthetic result three', tool_call_id: 'grunt_call_1' }
  ] };
  const sent: ModelRequest['messages'][] = [];
  const f = fixture({ infer: init => {
    const messages: ModelRequest['messages'] = JSON.parse(String(init?.body)).messages; sent.push(messages);
    return Response.json(result({ choices: [{ message: { content: null, tool_calls: [{ ...call, id: messages[2]!.tool_calls![0]!.id }] } }] }));
  } });
  await expect(f.source.complete(payload, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools' } });
  expect(sent).toHaveLength(2); // Existing single malformed-call retry also remains guarded.
  expect(sent[0]![2]!.tool_calls![0]!.id).toBe('grunt_call_2');
  expect(sent[0]![3]!.tool_call_id).toBe('grunt_call_2');
  expect(sent[0]![4]!.tool_calls![0]!.id).toBe('grunt_call_1');
  expect(sent[1]).toEqual(sent[0]);
});
it.each([
  [{ role: 'assistant', content: '', tool_calls: [call, call] }, { role: 'tool', content: 'synthetic result', tool_call_id: call.id }],
  [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: 'synthetic result', tool_call_id: call.id }],
  [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: 'synthetic result', tool_call_id: 'orphan' }],
  [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: 'synthetic result', tool_call_id: call.id }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: 'synthetic orphan', tool_call_id: 'grunt_call_1' }],
  [{ role: 'assistant', content: '', tool_calls: [call] }],
  [{ role: 'assistant', content: '', tool_calls: [{ ...call, function: { ...call.function, arguments: 'null' } }] }, { role: 'tool', content: 'synthetic result', tool_call_id: call.id }]
])('still rejects ambiguous pending IDs and missing/orphan results before the network (%j)', async (...messages) => {
  const f = fixture();
  await expect(f.source.complete({ ...request(), messages }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_tools' } });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('maps free rate limits to a bounded retry without trying another endpoint', async () => {
  const f = fixture({ infer: () => new Response('private upstream body', { status: 429, headers: { 'retry-after': '13' } }) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 13 }); expect(f.posts()).toHaveLength(1);
});
it.each([
  ['upstream', 'response_body', () => new Response('private upstream body', { headers: { 'content-length': '999999999' } })],
  ['upstream', 'response_json', () => new Response('private malformed JSON')],
  ['upstream', 'response_choices', () => Response.json(result({ choices: [] }))],
  ['upstream', 'response_content', () => Response.json(result({ choices: [{ message: { content: 42 } }] }))],
  ['upstream', 'response_tools', () => Response.json(result({ choices: [{ message: { tool_calls: [call] } }] }))],
  ['refused', 'completion_model', () => Response.json(result({ model: 'unverified' }))],
  ['refused', 'completion_billing', () => Response.json(result({ usage: { ...usage(), cost: 1 } }))],
  ['refused', 'completion_usage', () => Response.json(result({ usage: { ...usage(), completion_tokens: 5000 } }))],
  ['refused', 'refusal', () => Response.json(result({ choices: [{ message: { refusal: 'private upstream rationale' } }] }))]
] as const)('records bounded HTTP 200 failure metadata for %s %s', async (code, failureReason, infer) => {
  const f = fixture({ infer });
  const completion = f.source.complete(request(), new AbortController().signal);
  await expect(completion).rejects.toHaveProperty('code', code);
  await expect(completion).rejects.toHaveProperty('diagnostics', {
    transport: 'http', endpointLabel: 'chat.completions', httpStatus: 200, failureReason
  });
  // An invalid function call is sampled once more; every other failure is final.
  expect(f.posts()).toHaveLength(failureReason === 'response_tools' ? 2 : 1);
});
it('bounds completion bytes and does not expose provider payloads', async () => {
  const f = fixture({ infer: () => new Response('private upstream body', { headers: { 'content-length': '999999999' } }) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toThrow('supported size');
  const broken = fixture({ infer: () => { throw new Error('synthetic-private-token'); } });
  await expect(broken.source.complete(request(), new AbortController().signal)).rejects.toThrow('Kilo request failed');
});
it('cancels stalled response bodies without waiting for the upstream', async () => {
  const controller = new AbortController(), f = fixture({ infer: () => new Response(new ReadableStream({ start() {} })) });
  const pending = f.source.complete(request(), controller.signal); const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(() => expect(f.posts()).toHaveLength(1)); controller.abort(); await rejected;
});
it('enforces shutdown and deadlines even when the fetcher ignores abort', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
  const source = new Kilo({ directory, fetcher }); sources.push(source);
  const pending = source.complete(request(), new AbortController().signal), rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); await source.close(); await rejected; expect(await source.available()).toBe(false);
  const timed = new Kilo({ directory, fetcher, timeout: 5 }); sources.push(timed);
  await expect(timed.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
});
it('asks once more when Particle samples an invalid function call, then reports a repeat', async () => {
  const bad = () => Response.json(result({ choices: [{ message: { content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: '{"nonce":"wrong"}' } }] } }] }));
  const good = () => Response.json(result({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
  const replies = [bad, good];
  const recovered = fixture({ infer: () => replies.shift()!() });
  await expect(recovered.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).resolves.toMatchObject({ calls: [call] });
  expect(recovered.posts()).toHaveLength(2);
  const repeated = fixture({ infer: bad });
  await expect(repeated.source.complete({ ...request(), tools: [tool] }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools' } });
  expect(repeated.posts()).toHaveLength(2);
});
const rotation = () => [model('kilo-auto/free'), model('nvidia/nemotron-3.5-lightning:free'), { ...model('vendor/paid:free'), isFree: false }, model(KILO_BEAM), model(), model('openrouter/free')];
const sentModel = (init?: RequestInit) => JSON.parse(String(init?.body)).model as string;
it('lists exact free models with Particle and Reflection Beam first, and no router aliases', async () => {
  const fetcher = async () => Response.json({ data: rotation() });
  expect(await verifyKiloAccess({ fetcher })).toEqual([KILO_PARTICLE, KILO_BEAM, 'nvidia/nemotron-3.5-lightning:free']);
  expect(await verifyKiloAccess({ fetcher, reflectionBeam: true })).toEqual([KILO_BEAM]);
  expect(await verifyKiloAccess({ fetcher: async () => Response.json({ data: [model('nvidia/nemotron-3.5-lightning:free')] }) })).toEqual(['nvidia/nemotron-3.5-lightning:free']);
});
it('moves to the next free Kilo model when Particle returns 429, and keeps the model that answered first', async () => {
  const f = fixture({ catalogRows: rotation(), infer: init => sentModel(init) === KILO_PARTICLE
    ? new Response('private upstream body', { status: 429, headers: { 'retry-after': '60' } }) : Response.json(result({ model: sentModel(init) })) });
  await expect(f.source.complete(request(), new AbortController().signal)).resolves.toMatchObject({ text: 'Hello.' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM]);
  await f.source.complete(request(), new AbortController().signal);
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM, KILO_BEAM]);
});
it('still refuses a reply from a model other than the one asked after rotating', async () => {
  const f = fixture({ catalogRows: rotation(), infer: init => sentModel(init) === KILO_PARTICLE ? new Response(null, { status: 429 }) : Response.json(result()) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'completion_model' } });
  expect(f.posts()).toHaveLength(2);
});
it('reports quota with the earliest refill once every free Kilo model returns 429, and the pool falls back', async () => {
  const waits: Record<string, string> = { [KILO_PARTICLE]: '600', [KILO_BEAM]: '90', 'nvidia/nemotron-3.5-lightning:free': '300' };
  const f = fixture({ catalogRows: rotation(), infer: init => new Response(null, { status: 429, headers: { 'retry-after': waits[sentModel(init)]! } }) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 90 });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM, 'nvidia/nemotron-3.5-lightning:free']);
  const next: Source = { id: 'next', supportsFunctionTools: true, available: async () => true, complete: async (): Promise<Completion> => ({ text: 'fallback' }) };
  const pool = new Sources([f.source, next]);
  await expect(pool.complete({ ...request(), model: 'grunt' }, new AbortController().signal)).resolves.toMatchObject({ text: 'fallback' });
  expect(pool.status().sources.find(source => source.id === 'kilo')).toMatchObject({ errorCode: 'quota' });
});
it('keeps the Reflection Beam route on its single model', async () => {
  await recordDataSharingConsent(directory, ['reflection-beam']);
  const f = fixture({ reflectionBeam: true, catalogRows: rotation(), infer: () => new Response(null, { status: 429 }) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_BEAM]);
});
