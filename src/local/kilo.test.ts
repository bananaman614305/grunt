import { claudeCodeRequest } from './fixtures/claude-code-tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kilo, KILO_BEAM, KILO_CATALOG_CACHE_MS, KILO_IMAGE_MAX_BYTES, KILO_NOT_FOR_TOOL_WORK, KILO_ORIGIN, KILO_PARTICLE, KILO_TEXT_MAX_BYTES, verifyKiloAccess, verifyKiloCatalog } from './kilo.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { writePrivateProviderGrant } from './provider-grant.js';
import { beginSetupSession, readSetupSession } from './setup-session.js';
import { DiagnosticsStore } from './diagnostics.js';
import { buildRecoveryAudit } from '../recovery-audit.js';
import { createLocalApp } from './api.js';
import { Sources, endingOf, guardToolCalls } from './source.js';
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
it.each([true, false])('scores only choices conveyed in the Kilo POST (model supports tool choice: %s)', async supported => {
  const catalog = model();
  if (supported) catalog.supported_parameters.push('tool_choice');
  const named = (name: string) => ({ type: 'function', function: { name } });
  const tools = [tool, { ...tool, function: { ...tool.function, name: 'another' } }];
  const f = fixture({ catalog, infer: init => {
    const choice = JSON.parse(String(init?.body)).tool_choice;
    return Response.json(choice?.function ? result({ choices: [{ message: { content: '', tool_calls: [call] } }] }) : result());
  } });
  const pool = new Sources([f.source]), store = await DiagnosticsStore.open({ directory });
  pool.setDiagnostics(store);
  const app = createLocalApp(pool);
  try {
    for (const choice of ['required', named('nonce'), named('another'), 'auto']) {
      const response = await app.request('http://localhost:8788/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request(), tools, tool_choice: choice })
      });
      expect(response.status).toBe(200);
      const wire = JSON.parse(String(f.posts().at(-1)?.[1]?.body));
      expect(wire.tool_choice).toEqual(supported && choice !== 'auto' ? choice : undefined);
    }
    const events = (await store.list()).events;
    const audit = buildRecoveryAudit(events, { since: 0, until: Date.now() + 1 }, undefined, undefined, [{ id: 'kilo', tier: 'stable' }]);
    expect(audit.toolTiers.adapters[0]).toMatchObject({ attempts: 4, expectedCalls: supported ? 3 : 0,
      toolCallPassRate: supported ? 1 / 3 : null, passRate: 1 });
  } finally { await pool.close(); await store.close(); }
});

it.each([false, true])('aborts a stalled Kilo stream after the first delta (client stream: %s)', async stream => {
  const f = fixture({ infer: () => new Response(new ReadableStream({
    start(controller) {
      const frame = { model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: 'Hello' } }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
    }
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pool = new Sources([f.source], undefined, new Set(), 50);
  try {
    await expect(pool.complete({ ...request(), stream }, AbortSignal.timeout(500))).rejects.toMatchObject({
      code: 'timeout', replay: 'safe', message: expect.stringContaining('no further output')
    });
    expect(f.posts()[0]?.[1]?.signal?.aborted).toBe(true);
  } finally { await pool.close(); }
});
it('uses only fixed anonymous Particle with no inherited key, and checks live free metadata before inference', async () => {
  vi.stubEnv('KILO_API_KEY', 'synthetic-unrelated-private-key'); const f = fixture();
  expect(await f.source.available()).toBe(true); expect(f.posts()).toHaveLength(0);
  expect(await f.source.complete({ ...request(), model: 'arbitrary-paid-alias', maxTokens: 10000 }, new AbortController().signal)).toEqual({ text: 'Hello.', inputTokens: 20, outputTokens: 5, free: true, servedModel: KILO_PARTICLE });
  expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([`${KILO_ORIGIN}/models`, `${KILO_ORIGIN}/chat/completions`]);
  for (const [, init] of f.fetcher.mock.calls) { expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).has('authorization')).toBe(false); }
  expect(JSON.parse(f.posts()[0]![1]!.body as string)).toMatchObject({ model: KILO_PARTICLE, max_tokens: 10000,
    stream: true, stream_options: { include_usage: true } });
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
  await expect(f.source.complete({ ...request(), maxTokens: 4000 }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.posts()).toHaveLength(1);
});
it('preserves native call IDs and validates arguments against the requested schema', async () => {
  const f = fixture({ infer: () => Response.json(result({ choices: [{ message: { content: null, tool_calls: [call] } }] })) });
  expect((await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).calls).toEqual([call]);
  expect(JSON.parse(String(f.posts()[0]![1]?.body))).not.toHaveProperty('max_tokens');
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
  ['request_body', () => ({ ...request(), messages: [{ role: 'user', content: [] }] })],
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
  ['upstream', 'response_content', () => Response.json(result({ choices: [{ message: { content: '   ' } }] }))],
  ['upstream', 'response_tools', () => Response.json(result({ choices: [{ message: { tool_calls: [call] } }] }))],
  ['refused', 'completion_model', () => Response.json(result({ model: 'unverified' }))],
  ['refused', 'completion_billing', () => Response.json(result({ usage: { ...usage(), cost: 1 } }))],
  ['refused', 'completion_usage', () => Response.json(result({ usage: { ...usage(), completion_tokens: 5000 } }))],
  ['refused', 'refusal', () => Response.json(result({ choices: [{ message: { refusal: 'private upstream rationale' } }] }))]
] as const)('records bounded HTTP 200 failure metadata for %s %s', async (code, failureReason, infer) => {
  const f = fixture({ infer });
  const completion = f.source.complete({ ...request(), maxTokens: 4000 }, new AbortController().signal);
  await expect(completion).rejects.toHaveProperty('code', code);
  await expect(completion).rejects.toHaveProperty('diagnostics', {
    transport: 'http', endpointLabel: 'chat.completions', httpStatus: 200, failureReason
  });
  // An invalid function call is sampled once more; every other failure is final.
  expect(f.posts()).toHaveLength(failureReason === 'response_tools' ? 2 : 1);
});
it.each([null, 'partial answer'])('keeps usable truncated text and falls back only for empty truncation (%s)', async text => {
  const f = fixture({ infer: () => Response.json(result({ choices: [{ finish_reason: 'length', message: { content: text, tool_calls: [call] } }] })) });
  const backup = { id: 'backup', supportsFunctionTools: true, available: async () => true,
    complete: vi.fn(async () => ({ text: 'usable answer' })) };
  const pool = new Sources([f.source, backup]);
  const payload = { ...request(), model: 'grunt', maxTokens: 4096, tools: [tool], messages: [{ role: 'user', content: ' word'.repeat(35_000) }] };
  try {
    const response = await pool.complete(payload, AbortSignal.timeout(5000));
    if (text) {
      expect(response).toMatchObject({ text, finishReason: 'length' });
      expect(response.calls).toBeUndefined();
      expect(backup.complete).not.toHaveBeenCalled();
    } else {
      expect(response).toEqual({ text: 'usable answer' });
      expect(backup.complete).toHaveBeenCalledExactlyOnceWith(payload, expect.any(AbortSignal));
      await expect(pool.complete({ ...payload, model: f.source.id }, AbortSignal.timeout(5000)))
        .resolves.toMatchObject({ text: '', finishReason: 'length' });
    }
    expect(JSON.parse(String(f.posts()[0]![1]?.body))).toMatchObject({ max_tokens: 4096, tools: [tool] });
  } finally { await pool.close(); }
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
const endingReply = (finish: unknown, message: Record<string, unknown>, usagePatch: Record<string, unknown> = {}, served = KILO_PARTICLE) =>
  Response.json(result({ model: served, choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }], usage: { ...usage(), ...usagePatch } }));
const route = (reflectionBeam: boolean) => ({ reflectionBeam, ...(reflectionBeam ? { catalog: model(KILO_BEAM) } : {}) });
it.each([false, true])('records a content-free ending for a normal text stop and keeps it a normal reply (reflection beam %s)', async reflectionBeam => {
  await recordDataSharingConsent(directory, ['reflection-beam']);
  const f = fixture({ ...route(reflectionBeam), infer: () => endingReply('stop', { content: 'Done, no call needed.' }, { completion_tokens_details: { reasoning_tokens: 3 } }, reflectionBeam ? KILO_BEAM : KILO_PARTICLE) });
  const reply = await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal);
  expect(reply.text).toBe('Done, no call needed.'); expect(reply.calls).toBeUndefined();
  expect(endingOf(reply)).toEqual({ finish: 'stop', providerFinish: 'stop', toolCalls: false, reasoningTokens: 3 });
  expect(guardToolCalls(reply, {})).toBe(reply);
  expect(f.posts()).toHaveLength(1);
});
it('records a tool-call ending with its parsed call, and an unknown finish as other', async () => {
  const f = fixture({ infer: () => endingReply('tool_calls', { content: null, tool_calls: [call] }) });
  expect(endingOf(await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal))).toEqual({ finish: 'tool_calls', providerFinish: 'tool_calls', toolCalls: true });
  const g = fixture({ infer: () => endingReply('PRIVATE_NEW_REASON', { content: 'ok' }) });
  expect(endingOf(await g.source.complete(request(), new AbortController().signal))).toEqual({ finish: 'other', toolCalls: false });
});
it.each([false, true])('treats a tool_calls or function_call ending without a parsed call as an invalid sample, retried once then reported as response_tools (reflection beam %s)', async reflectionBeam => {
  await recordDataSharingConsent(directory, ['reflection-beam']);
  const served = reflectionBeam ? KILO_BEAM : KILO_PARTICLE;
  const cases: [string, () => Response][] = [
    ['tool_calls with markup text', () => endingReply('tool_calls', { content: '<tool_call>{"name":"nonce"}</tool_call>' }, {}, served)],
    ['tool_calls with empty call list', () => endingReply('tool_calls', { content: 'I will call it', tool_calls: [] }, {}, served)],
    ['tool_calls with no text', () => endingReply('tool_calls', { content: null }, {}, served)],
    ['function_call finish with text', () => endingReply('function_call', { content: 'Calling now' }, {}, served)],
    ['legacy function_call object with text', () => endingReply('stop', { content: 'Calling now', function_call: { name: 'nonce', arguments: '{"nonce":"synthetic"}' } }, {}, served)]
  ];
  for (const [name, infer] of cases) {
    const f = fixture({ ...route(reflectionBeam), infer });
    await expect(f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal), name).rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools', httpStatus: 200 } });
    expect(f.posts(), name).toHaveLength(2);
  }
});
it('recovers when the retry after a tool-call ending without a call returns the call', async () => {
  const replies = [() => endingReply('tool_calls', { content: 'about to call' }), () => endingReply('tool_calls', { content: null, tool_calls: [call] })];
  const f = fixture({ infer: () => replies.shift()!() });
  await expect(f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).resolves.toMatchObject({ calls: [call] });
});
const rotation = () => [model('kilo-auto/free'), model('nvidia/nemotron-3.5-lightning:free'), { ...model('vendor/paid:free'), isFree: false }, model(KILO_BEAM), model(), model('openrouter/free')];
const sentModel = (init?: RequestInit) => JSON.parse(String(init?.body)).model as string;
it('lists exact free models with Particle, then Reflection Beam, then catalog order, and no router aliases', async () => {
  const fetcher = async () => Response.json({ data: rotation() });
  expect(await verifyKiloAccess({ fetcher })).toEqual([KILO_PARTICLE, KILO_BEAM, 'nvidia/nemotron-3.5-lightning:free']);
  const sized = ['liquid/lfm-3-1.7b:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'vendor/tiny-8b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', KILO_BEAM, KILO_PARTICLE];
  expect(await verifyKiloAccess({ fetcher: async () => Response.json({ data: sized.map(id => model(id)) }) })).toEqual([KILO_PARTICLE, KILO_BEAM,
    'liquid/lfm-3-1.7b:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'vendor/tiny-8b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']);
  expect(await verifyKiloAccess({ fetcher, reflectionBeam: true })).toEqual([KILO_BEAM]);
  expect(await verifyKiloAccess({ fetcher: async () => Response.json({ data: [model('nvidia/nemotron-3.5-lightning:free')] }) })).toEqual(['nvidia/nemotron-3.5-lightning:free']);
});
const LFM = 'liquid/lfm-3-1.7b:free';
const toolRotation = () => [model(LFM), model('nvidia/nemotron-3.5-lightning:free'), model(KILO_BEAM), model()];
it('keeps the 1.7B liquid model out of the rotation for tool requests only, with evidence recorded', async () => {
  expect([...KILO_NOT_FOR_TOOL_WORK]).toEqual([LFM]);
  const sent = async (tools: unknown[]) => {
    const f = fixture({ catalogRows: toolRotation(), infer: () => new Response('limited', { status: 429, headers: { 'retry-after': '60' } }) });
    await expect(f.source.complete({ ...request(), tools: tools as ModelRequest['tools'] }, new AbortController().signal)).rejects.toMatchObject({ code: 'quota' });
    return f.posts().map(([, init]) => sentModel(init));
  };
  // Every model limited: a tool request never reaches the small model, a text request still does (the old rotation).
  expect(await sent([tool])).toEqual([KILO_PARTICLE, KILO_BEAM, 'nvidia/nemotron-3.5-lightning:free']);
  expect(await sent([])).toEqual([KILO_PARTICLE, KILO_BEAM, LFM, 'nvidia/nemotron-3.5-lightning:free']);
});
it('falls back to the whole rotation for a tool request when only excluded models remain', async () => {
  const f = fixture({ catalogRows: [model(LFM)], infer: init => Response.json(result({ model: sentModel(init) })) });
  await expect(f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).resolves.toMatchObject({ servedModel: LFM });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([LFM]);
});
it('does not change the listed free models or availability, and never selects the small model as the remembered first choice for tools', async () => {
  const rows = toolRotation(), fetcher = async () => Response.json({ data: rows });
  expect(await verifyKiloAccess({ fetcher })).toContain(LFM);
  // A text request answered by the small model makes it the remembered first choice; a later tool request skips it.
  const f = fixture({ catalogRows: [model(LFM), model(KILO_PARTICLE)], infer: init => sentModel(init) === KILO_PARTICLE ? new Response('limited', { status: 429, headers: { 'retry-after': '60' } }) : Response.json(result({ model: sentModel(init) })) });
  await f.source.complete(request(), new AbortController().signal);
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, LFM]);
  await expect(f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).rejects.toMatchObject({ code: 'quota' });
  expect(f.posts().slice(2).map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE]);
});
it('moves to the next free Kilo model when Particle returns 429, and keeps the model that answered first', async () => {
  const f = fixture({ catalogRows: rotation(), infer: init => sentModel(init) === KILO_PARTICLE
    ? new Response('private upstream body', { status: 429, headers: { 'retry-after': '60' } }) : Response.json(result({ model: sentModel(init) })) });
  await expect(f.source.complete(request(), new AbortController().signal)).resolves.toMatchObject({ text: 'Hello.' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM]);
  await f.source.complete(request(), new AbortController().signal);
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM, KILO_BEAM]);
});
it('moves on when a model reports a server error or answers as another model', async () => {
  const lightning = 'nvidia/nemotron-3.5-lightning:free';
  const f = fixture({ catalogRows: rotation(), infer: init => sentModel(init) === KILO_PARTICLE ? new Response('private upstream body', { status: 503 })
    : sentModel(init) === KILO_BEAM ? Response.json(result()) : Response.json(result({ model: lightning })) });
  await expect(f.source.complete(request(), new AbortController().signal)).resolves.toMatchObject({ text: 'Hello.' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM, lightning]);
  const refused = fixture({ catalogRows: rotation(), infer: () => Response.json(result({ model: 'unverified' })) });
  await expect(refused.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'completion_model' } });
  expect(refused.posts()).toHaveLength(3);
});
it.each([
  ['a client error', () => new Response(null, { status: 400 })],
  ['an invalid completion', () => Response.json(result({ choices: [] }))],
  ['a billed completion', () => Response.json(result({ usage: { ...usage(), cost: 1 } }))]
] as const)('does not move on after %s', async (_name, infer) => {
  const f = fixture({ catalogRows: rotation(), infer });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toThrow(); expect(f.posts()).toHaveLength(1);
});
it('does not move on after a request timeout', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/models')) return Response.json({ data: rotation() });
    queueMicrotask(() => deadline.abort());
    return new Promise<Response>(() => {});
  });
  const source = new Kilo({ directory, fetcher }); sources.push(source);
  await expect(source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
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
it.each([
  [[429, 503, 503], 'upstream', { httpStatus: 503 }],
  [[503, 429, 429], 'upstream', { httpStatus: 503 }],
  [[429, 200, 429], 'refused', { failureReason: 'completion_model' }],
  [[503, 200, 429], 'refused', { failureReason: 'completion_model' }],
  [[200, 502, 429], 'upstream', { httpStatus: 502 }]
] as const)('reports the last non-quota failure for mixed rotation results %j', async (statuses, code, diagnostics) => {
  let attempt = 0;
  const f = fixture({ catalogRows: rotation(), infer: () => {
    const status = statuses[attempt++]!;
    return status === 200 ? Response.json(result({ model: 'unverified' }))
      : new Response(null, { status, headers: { 'retry-after': '28800' } });
  } });
  const completion = f.source.complete(request(), new AbortController().signal);
  await expect(completion).rejects.toMatchObject({ code, diagnostics, retryAfter: undefined });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, KILO_BEAM, 'nvidia/nemotron-3.5-lightning:free']);
});
it('keeps the Reflection Beam route on its single model', async () => {
  await recordDataSharingConsent(directory, ['reflection-beam']);
  const f = fixture({ reflectionBeam: true, catalogRows: rotation(), infer: () => new Response(null, { status: 429 }) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_BEAM]);
});
it.each([false, true])('accepts every tool of a recorded Claude Code request and forwards them unchanged (reflection-beam %s)', async reflectionBeam => {
  const tools = claudeCodeRequest(0).tools;
  await recordDataSharingConsent(directory, ['reflection-beam']);
  for (const index of [0, 1, 2] as const) {
    const f = fixture({ reflectionBeam, ...(reflectionBeam ? { catalogRows: rotation() } : {}), infer: init => Response.json(result({ model: sentModel(init) })) });
    await expect(f.source.complete(claudeCodeRequest(index, 'kilo'), new AbortController().signal)).resolves.toMatchObject({ text: expect.any(String) });
    expect(JSON.parse(f.posts()[0]![1]!.body as string).tools).toEqual(tools);
  }
});

it('caches verified /models metadata for 60s while preserving exact model and zero-cost checks on every completion', async () => {
  let now = 1_000_000;
  let billed = false;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === `${KILO_ORIGIN}/models`) return Response.json({ data: [model()] });
    return Response.json(result(billed ? { usage: { ...usage(), cost: 0.01 } } : {}));
  });
  const source = new Kilo({ directory, fetcher, now: () => now });
  sources.push(source);
  const modelGets = () => fetcher.mock.calls.filter(([url]) => String(url) === `${KILO_ORIGIN}/models`).length;

  expect(await source.available()).toBe(true);
  await source.complete(request(), new AbortController().signal);
  now += KILO_CATALOG_CACHE_MS - 1;
  await source.complete(request(), new AbortController().signal);
  expect(modelGets()).toBe(1);

  // After 60s the catalog refreshes.
  now += 1;
  await source.complete(request(), new AbortController().signal);
  expect(modelGets()).toBe(2);

  // Billing verification still runs on every completion and invalidates the catalog cache.
  billed = true;
  await expect(source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'completion_billing' } });
  billed = false;
  await source.complete(request(), new AbortController().signal);
  expect(modelGets()).toBe(3);
});

const visionModel = (id: string = KILO_PARTICLE, extra: Record<string, unknown> = {}) => ({
  ...model(id),
  architecture: { input_modalities: ['text', 'image'] },
  ...extra
});
const imageMessage = (data = 'AAAA') => ({
  role: 'user',
  content: [
    { type: 'text' as const, text: 'Describe this image' },
    { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${data}` } }
  ]
});

it('discovers only verified $0 :free vision models from architecture.input_modalities and rejects text-only or paid vision models', async () => {
  const ling = 'inclusionai/ling-3.2-flash:free';
  const nemotronVl = 'nvidia/nemotron-3.5-super-vl:free';
  const rows = [
    visionModel(ling),
    { ...model('nvidia/nemotron-3.5-lightning:free'), architecture: { input_modalities: ['text'] } },
    visionModel('vendor/paid-vision:free', { isFree: false }),
    visionModel('vendor/billed-image:free', { pricing: { prompt: '0', completion: '0', image: '0.001' } }),
    visionModel('vendor/nonfree-suffix', { isFree: true }),
    visionModel(KILO_BEAM), // Reflection Beam stays text-only even if catalog lists image.
    visionModel(KILO_PARTICLE, { pricing: { prompt: '0', completion: '0', image: '0' } }),
    visionModel(nemotronVl, { architecture: { input_modalities: ['text', 'image', 'video'] } })
  ];
  const fetcher = async () => Response.json({ data: rows });
  const catalog = await verifyKiloCatalog({ fetcher });
  expect(catalog.models).toEqual([KILO_PARTICLE, KILO_BEAM, ling, 'nvidia/nemotron-3.5-lightning:free', nemotronVl]);
  expect(catalog.imageModels).toEqual([KILO_PARTICLE, ling, nemotronVl]);
  expect(await verifyKiloAccess({ fetcher, imageInput: true })).toEqual([KILO_PARTICLE, ling, nemotronVl]);
  expect((await verifyKiloCatalog({ fetcher, reflectionBeam: true })).imageModels).toEqual([]);
  await expect(verifyKiloAccess({ fetcher: async () => Response.json({ data: [model(KILO_PARTICLE), visionModel('vendor/paid:free', { isFree: false })] }), imageInput: true }))
    .rejects.toMatchObject({ code: 'refused' });
});

it('routes image requests on kilo only to verified free vision models, forwards multimodal parts, and keeps reflection-beam text-only', async () => {
  const ling = 'inclusionai/ling-3.2-flash:free';
  const textOnly = 'nvidia/nemotron-3.5-lightning:free';
  const rows = [
    { ...model(textOnly), architecture: { input_modalities: ['text'] } },
    visionModel(KILO_PARTICLE),
    visionModel(ling),
    visionModel('vendor/paid-vl:free', { isFree: false }),
    visionModel('vendor/image-cost:free', { pricing: { prompt: '0', completion: '0', image: '0.01' } }),
    model(KILO_BEAM)
  ];
  let sentBody: Record<string, unknown> = {};
  const f = fixture({
    catalogRows: rows,
    infer: init => {
      sentBody = JSON.parse(String(init?.body));
      if (sentBody.model === KILO_PARTICLE) return new Response('limited', { status: 429, headers: { 'retry-after': '30' } });
      return Response.json(result({ model: sentBody.model as string }));
    }
  });
  // Even if a text-only model became preferred earlier, an image request skips it and tries only verified vision models.
  await expect(f.source.complete({ ...request(), messages: [imageMessage()], imageInput: true }, new AbortController().signal))
    .resolves.toMatchObject({ servedModel: ling, free: true, text: 'Hello.' });
  expect(f.posts().map(([, init]) => sentModel(init))).toEqual([KILO_PARTICLE, ling]);
  expect(sentBody.messages).toEqual([imageMessage()]);

  // When no free vision model is verified in the catalog, kilo refuses cleanly without posting.
  const noVision = fixture({ catalogRows: [{ ...model(KILO_PARTICLE), architecture: { input_modalities: ['text'] } }, visionModel('vendor/paid-vl:free', { isFree: false })] });
  await expect(noVision.source.complete({ ...request(), messages: [imageMessage()], imageInput: true }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_body' } });
  expect(noVision.posts()).toHaveLength(0);

  // Reflection Beam remains strictly text-only and refuses before hitting the network.
  await recordDataSharingConsent(directory, ['reflection-beam']);
  const beam = fixture({ reflectionBeam: true, catalogRows: [visionModel(KILO_BEAM)] });
  await expect(beam.source.complete({ ...request(), model: 'reflection-beam', messages: [imageMessage()], imageInput: true }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_body' } });
  expect(beam.fetcher).not.toHaveBeenCalled();
});

it('allows larger bounded payloads for image requests on kilo while keeping text-only requests capped at 2 MiB', async () => {
  const f = fixture({ catalogRows: [visionModel(KILO_PARTICLE)] });
  // 3 MiB base64 image exceeds the 2 MiB text cap but fits within KILO_IMAGE_MAX_BYTES.
  const mediumImage = 'A'.repeat(3 * 1024 * 1024);
  await expect(f.source.complete({ ...request(), messages: [imageMessage(mediumImage)], imageInput: true }, new AbortController().signal))
    .resolves.toMatchObject({ servedModel: KILO_PARTICLE, free: true });
  expect(f.posts()).toHaveLength(1);
  // Over KILO_IMAGE_MAX_BYTES is still rejected locally before the network.
  const hugeImage = 'A'.repeat(KILO_IMAGE_MAX_BYTES + 1024);
  await expect(f.source.complete({ ...request(), messages: [imageMessage(hugeImage)], imageInput: true }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_size' } });
  expect(f.posts()).toHaveLength(1);
  // Text-only stays capped at KILO_TEXT_MAX_BYTES.
  await expect(f.source.complete({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(KILO_TEXT_MAX_BYTES + 1) }] }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_size' } });
  expect(f.posts()).toHaveLength(1);
});

it('accepts trailing empty-string content on a post-finish usage SSE chunk while still rejecting non-empty content after finish', async () => {
  const nemotronVl = 'nvidia/nemotron-3.5-super-vl:free';
  const sse = (frames: unknown[]) => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  const good = fixture({
    catalogRows: [visionModel(nemotronVl)],
    infer: () => new Response(sse([
      { model: nemotronVl, choices: [{ index: 0, delta: { content: 'Green', role: 'assistant' }, finish_reason: null }] },
      { model: nemotronVl, choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop' }] },
      { model: nemotronVl, choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop' }], usage: usage() }
    ]), { headers: { 'content-type': 'text/event-stream' } })
  });
  await expect(good.source.complete({ ...request(), messages: [imageMessage()], imageInput: true }, new AbortController().signal))
    .resolves.toMatchObject({ servedModel: nemotronVl, free: true, text: 'Green' });

  const bad = fixture({
    catalogRows: [visionModel(nemotronVl)],
    infer: () => new Response(sse([
      { model: nemotronVl, choices: [{ index: 0, delta: { content: 'Green', role: 'assistant' }, finish_reason: 'stop' }] },
      { model: nemotronVl, choices: [{ index: 0, delta: { content: 'extra', role: 'assistant' }, finish_reason: 'stop' }], usage: usage() }
    ]), { headers: { 'content-type': 'text/event-stream' } })
  });
  await expect(bad.source.complete({ ...request(), messages: [imageMessage()], imageInput: true }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_content' } });
});
