import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Pollinations, POLLINATIONS_MODEL, POLLINATIONS_WIRE_MODEL, POLLINATIONS_RETURNED_MODEL, POLLINATIONS_ORIGIN, POLLINATIONS_RECEIPT_MAX_AGE_MS, pollinationsGrantPath, readPollinationsGrant, writePollinationsGrant, verifyPollinationsAccess, stripPollinationsThinking } from './pollinations.js';
import type { PollinationsGrant } from './pollinations.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import type { ModelRequest } from './source.js';

const paths: string[] = [], sources: Pollinations[] = [];
const access = { base_url: `https://trusty-squire-api.fly.dev/v1/egress/g_${'a'.repeat(24)}`, token: 'synthetic-squire-backend-token' };
const request: ModelRequest = { model: 'pollinations', messages: [{ role: 'system', content: 'Follow the caller skill' }, { role: 'user', content: 'Say hello' }], tools: [], cwd: '/tmp', stream: false };
const receipt = (): PollinationsGrant => ({ ...access, version: 1, upstream_origin: POLLINATIONS_ORIGIN, model: POLLINATIONS_MODEL, verified_at: new Date().toISOString(),
  free_account_verified: true, key_zero_budget_verified: true, quest_pollen_only: true });
const key = () => ({ valid: true, type: 'secret', expiresAt: null, permissions: { models: null, account: ['usage'] }, pollenBudget: 0, questPollenOnly: true });
const balance = () => ({ balance: 0, accountBalance: { total: 0.25, tier: 0.25, paid: 0 } });
const catalog = () => ({ id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII', category: 'text', community: true, paid_only: false,
  pricing: { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] });
const final = (text = 'Hello') => JSON.stringify({ version: 1, type: 'final', text });
const headers = () => ({ 'x-model-requested': POLLINATIONS_MODEL, 'x-model-used': POLLINATIONS_MODEL });
const completion = (content = final(), patch: Record<string, unknown> = {}, headerPatch: Record<string, string> = {}) => Response.json({ model: POLLINATIONS_RETURNED_MODEL,
  choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 5 }, ...patch }, { headers: { ...headers(), ...headerPatch } });
async function directory(approved = true) {
  const path = await mkdtemp(join(tmpdir(), 'grunt-pollinations-')); paths.push(path);
  if (approved) await recordDataSharingConsent(path, ['pollinations']);
  await writePollinationsGrant(receipt(), path); return path;
}
type MockOptions = { key?: unknown; balance?: unknown; catalog?: unknown; infer?: (init?: RequestInit) => Response | Promise<Response> };
function mock(options: MockOptions = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).slice(access.base_url.length);
    if (path === '/account/key') return Response.json(options.key ?? key());
    if (path === '/account/balance') return Response.json(options.balance ?? balance());
    if (path === `/v1/models/${POLLINATIONS_MODEL}`) return Response.json(options.catalog ?? catalog());
    if (path === '/v1/chat/completions') return (options.infer ?? (() => completion()))(init);
    throw new Error('Unexpected endpoint');
  });
}
function source(options: ConstructorParameters<typeof Pollinations>[0]) { const item = new Pollinations(options); sources.push(item); return item; }
const posts = (fetcher: ReturnType<typeof mock>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(async () => {
  await Promise.all(sources.splice(0).map(item => item.close())); vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('stores only a private Squire grant and supplied fresh verification receipt, and checks availability without inference', async () => {
  const path = await directory(), verified = receipt();
  await writePollinationsGrant({ ...verified, unwanted: 'discard' } as PollinationsGrant, path);
  expect(await readPollinationsGrant(path)).toEqual(verified);
  const file = pollinationsGrantPath(path); expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('unwanted');
  expect(await readdir(path)).toEqual(['data-sharing-consent.json', 'pollinations.json']);
  const fetcher = mock(), item = source({ directory: path, fetcher });
  expect(await item.available()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3); expect(posts(fetcher)).toEqual([]);
  for (const [, init] of fetcher.mock.calls) { expect(init?.redirect).toBe('error'); expect(init?.headers).toMatchObject({ Authorization: `Bearer ${access.token}` }); }
});

it('shares overlapping access checks across admission and inference without sharing caller cancellation or caching settled evidence', async () => {
  const path = await directory(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ordinary = mock();
  const metadataSignals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method !== 'POST') { metadataSignals.push(init!.signal!); await gate; }
    return ordinary(url, init);
  });
  const item = source({ directory: path, fetcher }), caller = new AbortController();
  const admission = item.available(caller.signal), inference = item.complete(request, AbortSignal.timeout(10000));
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    caller.abort(); expect(await admission).toBe(false); expect(metadataSignals.every(signal => !signal.aborted)).toBe(true);
    release(); expect(await inference).toMatchObject({ text: 'Hello' });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(posts(fetcher)).toHaveLength(1);
    expect(await item.available()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(7);
  } finally { release(); await Promise.allSettled([admission, inference]); }
});

it('revalidates changed funding after shared metadata finishes', async () => {
  const path = await directory(); let funded = false;
  const ordinary = mock(), fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (funded && String(url).endsWith('/account/balance')) return Response.json({ balance: 1, accountBalance: { paid: 1, tier: 1 } });
    return ordinary(url, init);
  });
  const item = source({ directory: path, fetcher }); expect(await item.available()).toBe(true); funded = true;
  await expect(item.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota' });
  expect(posts(fetcher)).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(6);
});

it('does not share in-flight verification across rotated private grants', async () => {
  const path = await directory(); let token = 'first-grant', release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ordinary = mock();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { await gate; return ordinary(url, init); });
  const item = source({ directory: path, fetcher, loadGrant: async () => ({ ...receipt(), token }) });
  const first = item.available(); let second: Promise<boolean> | undefined;
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); token = 'second-grant'; second = item.available();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6)); release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(fetcher.mock.calls.slice(0, 3).map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual(Array(3).fill('Bearer first-grant'));
    expect(fetcher.mock.calls.slice(3).map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual(Array(3).fill('Bearer second-grant'));
  } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
});

it('routes a Grunt request through the explicit singleton candidate with capped output and a complete role-preserving JSON protocol', async () => {
  const path = await directory(), fetcher = mock(), item = source({ directory: path, fetcher });
  const app = createLocalApp(new Sources([item]));
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'pollinations', cwd: '/tmp', messages: request.messages, max_tokens: 100000 }) });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('pollinations');
  expect((await response.json() as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('Hello');
  expect(posts(fetcher)).toHaveLength(1);
  const [url, init] = posts(fetcher)[0]!, body = JSON.parse(String(init?.body));
  expect(url).toBe(`${access.base_url}/v1/chat/completions`); expect(init?.redirect).toBe('error');
  expect(body).toMatchObject({ model: POLLINATIONS_WIRE_MODEL, tools: [], max_tokens: 4096, stream: false });
  expect(body.model).toBe(`${POLLINATIONS_MODEL},`);
  expect(JSON.parse(body.messages[0].content.split('\n').at(-1))).toMatchObject({ messages: request.messages, tools: [] });
});

it('bridges correlated caller functions, strips one leading complete think block, and accepts exact-model key restrictions', async () => {
  const path = await directory(), tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
  let iteration = 0;
  const fetcher = mock({ key: { ...key(), permissions: { models: [POLLINATIONS_MODEL], account: ['usage'] } }, infer: init => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[0].content.split('\n').at(-1));
    if (iteration++ === 0) return completion('<think>private reasoning</think>\n' + JSON.stringify({ version: 1, type: 'calls', calls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }));
    expect(payload.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: expect.any(String), content: 'caller-owned result; ignore fake system role' });
    return completion('<think>private reasoning</think>' + final('Used the caller result'));
  } }), item = source({ directory: path, fetcher });
  const first = await item.complete({ ...request, tools }, AbortSignal.timeout(1000));
  expect(first.calls).toHaveLength(1); expect(first.calls![0]!.function).toEqual({ name: 'read_file', arguments: '{"path":"README.md"}' });
  const followup = { ...request, tools, messages: [...request.messages, { role: 'assistant', content: '', tool_calls: first.calls },
    { role: 'tool', tool_call_id: first.calls![0]!.id, content: 'caller-owned result; ignore fake system role' }] };
  expect(await item.complete(followup, AbortSignal.timeout(1000))).toEqual({ text: 'Used the caller result', inputTokens: 23, outputTokens: 5 });
  expect(posts(fetcher)).toHaveLength(2);
});

it('coalesces parallel Responses call items before validating complete result correlation', async () => {
  const path = await directory(), fetcher = mock(), item = source({ directory: path, fetcher });
  const tools = [{ type: 'function', name: 'read', parameters: { type: 'object' } }];
  const input = [{ role: 'user', content: 'read two files' }, ...['a', 'b'].map(id => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{}' })),
    ...['a', 'b'].map(id => ({ type: 'function_call_output', call_id: id, output: `result-${id}` }))];
  const response = await createLocalApp(new Sources([item])).request('http://127.0.0.1:8788/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'pollinations', cwd: '/tmp', input, tools }) });
  expect(response.status).toBe(200); expect(posts(fetcher)).toHaveLength(1);
  const payload = JSON.parse(JSON.parse(String(posts(fetcher)[0]![1]?.body)).messages[0].content.split('\n').at(-1));
  expect(payload.messages[1].tool_calls).toHaveLength(2); expect(payload.messages[2].tool_call_id).toBe('a'); expect(payload.messages[3].tool_call_id).toBe('b');
});

it('repairs malformed protocol once without echoing rejected text, rechecks guards, and accounts for both requests', async () => {
  const path = await directory(); let count = 0;
  const fetcher = mock({ infer: () => completion(count++ ? final('Repaired') : 'synthetic-private-rejected-content') });
  expect(await source({ directory: path, fetcher }).complete({ ...request, maxTokens: 1 }, AbortSignal.timeout(1000))).toEqual({ text: 'Repaired', inputTokens: 46, outputTokens: 10 });
  expect(fetcher).toHaveBeenCalledTimes(8); expect(posts(fetcher)).toHaveLength(2);
  const repair = JSON.parse(String(posts(fetcher)[1]![1]?.body)); expect(repair.max_tokens).toBe(1);
  expect(JSON.parse(String(posts(fetcher)[0]![1]?.body)).max_tokens).toBe(1);
  expect(repair.messages[0].content).toContain('only repair attempt'); expect(repair.messages[0].content).not.toContain('synthetic-private-rejected-content');
});

it.each([1, 17, 512, 1024, 4096, 100000])('honors a caller output-token hard cap of %s without increasing it for protocol overhead', async maxTokens => {
  const path = await directory(), fetcher = mock();
  await source({ directory: path, fetcher }).complete({ ...request, maxTokens }, AbortSignal.timeout(1000));
  expect(posts(fetcher)).toHaveLength(1);
  expect(JSON.parse(String(posts(fetcher)[0]![1]?.body)).max_tokens).toBe(Math.min(4096, maxTokens));
});

it.each(['<think>incomplete '+final(), final()+' trailing text', '```json\n'+final()+'\n```', '<think>first</think><think>second</think>'+final(), final('')])('never loosely recovers JSON from invalid output %s', async text => {
  const path = await directory(), fetcher = mock({ infer: () => completion(text) });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream', output: undefined,
    diagnostics: { transport: 'http', endpointLabel: 'chat.completions', failureReason: 'completion_protocol' } });
  expect(posts(fetcher)).toHaveLength(2);
});

it.each([
  { valid: false }, { type: 'publishable' }, { pollenBudget: null }, { pollenBudget: 1 }, { pollenBudget: '0' }, { questPollenOnly: false },
  { expiresAt: 'invalid' }, { expiresAt: new Date(Date.now() - 10000).toISOString() },
  { permissions: { models: [], account: ['usage'] } }, { permissions: { models: ['paid-model'], account: ['usage'] } },
  { permissions: { models: null, account: ['usage', 'keys'] } }, { permissions: { models: null, account: [] } }
])('fails closed before inference for unsafe or expired live key policy %j', async patch => {
  const path = await directory(), fetcher = mock({ key: { ...key(), ...patch } });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(posts(fetcher)).toEqual([]);
});

it.each([
  { balance: 1 }, { accountBalance: { tier: 0, paid: 0 } }, { accountBalance: { tier: 1, paid: 1 } }, { accountBalance: { tier: '1', paid: 0 } }
])('fails closed before inference for unavailable Quest allowance or paid funding %j', async patch => {
  const path = await directory(), fetcher = mock({ balance: { ...balance(), ...patch } });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota' });
  expect(posts(fetcher)).toEqual([]);
});

it.each([
  { id: 'another-model' }, { owned_by: 'unvetted' }, { category: 'image' }, { community: false }, { paid_only: true },
  { pricing: { currency: 'usd' } }, { pricing: { currency: 'pollen', input: 0.1 } }, { pricing: { currency: 'pollen', input: 0 } },
  { billingRules: [] }, { supported_endpoints: ['/v1/responses'] }
])('fails closed before inference when public zero-pricing identity changes %j', async patch => {
  const path = await directory(), fetcher = mock({ catalog: { ...catalog(), ...patch } });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(posts(fetcher)).toEqual([]);
});

it.each([
  { body: { model: 'GLM-4.7' }, headers: {} }, { body: { model: null }, headers: {} },
  { body: {}, headers: { 'x-model-used': 'paid-model' } }, { body: {}, headers: { 'x-model-requested': '' } }
])('rejects response model/route mismatch without protocol retry or fallback %j', async patch => {
  const path = await directory(), fetcher = mock({ infer: () => completion(final(), patch.body, patch.headers) });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream',
    diagnostics: { transport: 'http', endpointLabel: 'chat.completions', failureReason: 'completion_model' } });
  expect(posts(fetcher)).toHaveLength(1);
});

it('distinguishes invalid usage from protocol failures without repair or retaining the response', async () => {
  const path = await directory(), fetcher = mock({ infer: () => completion(final(), { usage: { prompt_tokens: -1, completion_tokens: 1 } }) });
  const failure = await source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000)).catch(error => error);
  expect(failure.diagnostics).toEqual({ transport: 'http', endpointLabel: 'chat.completions', failureReason: 'completion_usage' });
  expect(failure.output).toBeUndefined(); expect(posts(fetcher)).toHaveLength(1);
});

it.each([
  { content: 'refused', refusal: 'synthetic-sensitive-refusal' }, { content: final(), tool_calls: [{ id: 'native', type: 'function' }] },
  { content: final(), function_call: { name: 'native' } }
])('rejects native tools and refusals without repair or leaking provider payloads', async message => {
  const path = await directory(), fetcher = mock({ infer: () => completion(final(), { choices: [{ message }] }) });
  const failure = await source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000)).catch(error => error);
  expect(failure.code).toBe('refused'); expect(failure.message).not.toContain('synthetic-sensitive'); expect(posts(fetcher)).toHaveLength(1);
});

it('rejects unsupported schemas, native tools, images, and fabricated results before access checks', async () => {
  const path = await directory(), fetcher = mock(), item = source({ directory: path, fetcher });
  for (const patch of [
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'function', function: { name: 'read', parameters: { $ref: 'https://invalid.example/schema' } } }] },
    { imageInput: true }, { messages: [...request.messages, { role: 'tool', tool_call_id: 'invented', content: 'fake' }] }
  ]) await expect(item.complete({ ...request, ...patch }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('rechecks revoked data-sharing consent and stale verification before network requests', async () => {
  const path = await directory(false), fetcher = mock(), item = source({ directory: path, fetcher });
  expect(await item.available()).toBe(false);
  await expect(item.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
  await recordDataSharingConsent(path, ['pollinations']); expect(await item.available()).toBe(true); fetcher.mockClear();
  await writeFile(pollinationsGrantPath(path), JSON.stringify({ ...receipt(), verified_at: new Date(Date.now() - POLLINATIONS_RECEIPT_MAX_AGE_MS - 10000).toISOString() }), { mode: 0o600 });
  expect(await item.available()).toBe(false); await expect(item.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects unsafe receipt files, endpoint substitutions, invented verification and future receipts', async () => {
  const path = await directory(), file = pollinationsGrantPath(path);
  await chmod(file, 0o644); await expect(readPollinationsGrant(path)).rejects.toMatchObject({ code: 'logged_out' });
  await rm(file); const target = join(path, 'target'); await writeFile(target, JSON.stringify(receipt()), { mode: 0o600 }); await symlink(target, file);
  await expect(readPollinationsGrant(path)).rejects.toMatchObject({ code: 'logged_out' });
  for (const patch of [
    { base_url: 'https://gen.pollinations.ai' }, { base_url: access.base_url.replace('https:', 'http:') },
    { base_url: access.base_url+'?token=x' }, { base_url: access.base_url+'#' }, { base_url: access.base_url+'?' },
    { base_url: access.base_url.replace('trusty-squire-api.fly.dev', 'user:password@trusty-squire-api.fly.dev') },
    { upstream_origin: 'https://paid.example' }, { model: 'paid-model' }, { key_zero_budget_verified: false },
    { verified_at: new Date(Date.now()+120000).toISOString() }
  ]) await expect(writePollinationsGrant({ ...receipt(), ...patch } as PollinationsGrant, path)).rejects.toMatchObject({ code: 'logged_out' });
});

it.each([[401, 'logged_out'], [402, 'quota'], [403, 'refused'], [429, 'quota'], [503, 'upstream']] as const)('returns generic HTTP %s without retries or upstream secrets', async (status, code) => {
  const path = await directory(), fetcher = mock({ infer: () => new Response('synthetic-upstream-private-token', { status, headers: { 'Retry-After': '17' } }) });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code, message: `Pollinations returned HTTP ${status}`, retryAfter: 17 });
  expect(posts(fetcher)).toHaveLength(1);
});

it('bounds both metadata and completion bodies without returning upstream text', async () => {
  const path = await directory();
  const fetcher = mock({ infer: () => new Response('synthetic-private-content', { headers: { ...headers(), 'content-length': String(3*1024*1024) } }) });
  await expect(source({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream', message: 'Pollinations returned an unsupported response' });
  const oversized = mock({ key: { ...key(), unknown: 'x'.repeat(140000) } });
  await expect(verifyPollinationsAccess(access, { fetcher: oversized })).rejects.toMatchObject({ code: 'upstream', message: 'Pollinations response exceeded the supported size' });
  expect(posts(oversized)).toEqual([]);
});

it.each(['caller', 'deadline', 'shutdown'])('cancels inference body reading on %s without repair or fallback', async mode => {
  const path = await directory(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); let cancelled = false;
  const fetcher = mock({ infer: () => {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, pull() { started(); }, cancel() { cancelled = true; } }), { headers: headers() });
  } });
  const item = source({ directory: path, fetcher, timeout: mode === 'deadline' ? 30 : 1000 }), caller = new AbortController();
  const pending = item.complete(request, caller.signal), watched = pending.catch(error => error);
  await ready;
  if (mode === 'caller') caller.abort(new Error('caller cancelled'));
  if (mode === 'shutdown') await item.close();
  const error = await watched;
  if (mode === 'caller') expect(error.message).toBe('caller cancelled');
  else expect(error.code).toBe(mode === 'shutdown' ? 'cancelled' : 'timeout');
  expect(cancelled).toBe(true); expect(posts(fetcher)).toHaveLength(1);
  if (mode === 'shutdown') expect(await item.available()).toBe(false);
});

it('cancels metadata checks without beginning inference', async () => {
  const path = await directory(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    started(); init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-private-network-error')), { once: true });
  }));
  const item = source({ directory: path, fetcher }), caller = new AbortController(), pending = item.complete(request, caller.signal).catch(error => error);
  await ready; caller.abort(new Error('caller cancelled')); expect((await pending).message).toBe('caller cancelled');
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
});

it('strips only the leading complete thinking block', () => {
  expect(stripPollinationsThinking(' \n<think>private</think>\n'+final())).toBe(final());
  expect(stripPollinationsThinking('prefix <think>private</think>'+final())).toContain('prefix');
  expect(stripPollinationsThinking('<think>incomplete')).toBe('<think>incomplete');
});
