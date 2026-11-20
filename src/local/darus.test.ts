import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry, validateRegistry } from '../registry.js';
import { createLocalApp } from './api.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Darus, DARUS_HOST, DARUS_MODEL } from './darus.js';
import { configure } from './main.js';
import { writePrivateProviderGrant } from './provider-grant.js';

const now = Date.parse('2026-11-20T04:00:00Z');
let directory: string;
const grant = { base_url: `https://${DARUS_HOST}`, token: 'synthetic-key' };
const offer = () => ({ id: DARUS_MODEL, free: true, owned_by: 'Darus Gateway' });
const status = () => ({ eligible: true, day: '2026-11-20', allowance: 10000000, used: 0, remaining: 10000000, balance: 0,
  protectBalance: true, multiplier: 1, tier: { key: 'FREE', tpd: 10000000, minBalance: 0 } });
const request = () => ({ model: 'darus', messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], cwd: directory, stream: false });
const response = () => ({ model: DARUS_MODEL, choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 201100, completion_tokens: 2 } });
function transport(account: unknown = status(), model: unknown = offer(), answer: unknown = response()) {
  return vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/tpd') ? Response.json({ status: account })
    : String(url).endsWith('/v1/models') ? Response.json({ data: [model] }) : Response.json(answer));
}
const source = (fetcher: typeof fetch, access = grant) => new Darus({ directory, fetcher, now: () => now, loadGrant: async () => access });
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'darus-test-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it('does not send account metadata or prompts before source-specific approval', async () => {
  const fetcher = transport();
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('pins the free route and protects a nonempty wallet without drawing credit', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport({ ...status(), balance: 9000000 });
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).resolves.toEqual({ text: 'Hello', inputTokens: 201100, outputTokens: 2 });
  expect(fetcher.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['models', 'tpd', 'completions']);
  const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(body).toMatchObject({ model: DARUS_MODEL, stream: true, max_tokens: 4096 });
  expect(fetcher.mock.calls.some(([url]) => /check.?in|reward|wallet|topup/i.test(String(url)))).toBe(false);
});
it.each([
  { protectBalance: false }, { protectBalance: undefined }, { eligible: false }, { eligible: undefined },
  { day: '2026-11-19' }, { tier: { key: 'PAID', tpd: 10000000, minBalance: 0 } },
  { tier: { key: 'FREE', tpd: 10000000, minBalance: 1 } }, { allowance: 20000000 }, { used: -1 },
  { remaining: 20000000 }, { remaining: '10000000' }, { multiplier: 2 }, { balance: null }
])('refuses unsafe, stale or inconsistent entitlement before inference: %j', async patch => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport({ ...status(), ...patch });
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher.mock.calls).toHaveLength(2);
});
it('checks protectBalance on every dispatch, including after a prior success', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  let protectedBalance = true;
  const normal = transport();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/v1/tpd')
    ? Response.json({ status: { ...status(), protectBalance: protectedBalance } }) : normal(url, init));
  const adapter = source(fetcher);
  await adapter.complete(request(), AbortSignal.timeout(2000));
  protectedBalance = false;
  await expect(adapter.complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(normal.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
});
it('reports known daily exhaustion until the next UTC midnight, preserving window metadata', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport({ ...status(), used: 10000000, remaining: 0 }), adapter = source(fetcher);
  await expect(adapter.complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: 72000 });
  expect(adapter.quotaWindow()).toEqual({ startedAt: Date.parse('2026-11-20T00:00:00Z'), resetAt: Date.parse('2026-11-21T00:00:00Z') });
  expect(fetcher.mock.calls).toHaveLength(2);
});
it('retains the exact daily refill time and limited state when routing checks availability', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  await writePrivateProviderGrant('darus', grant, directory);
  const fetcher = transport({ ...status(), used: 10000000, remaining: 0 });
  vi.stubGlobal('fetch', fetcher);
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'darus' });
  try {
    await expect(sources.complete({ ...request(), model: 'grunt' }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: 72000 });
    expect(sources.status().sources.find(row => row.id === 'darus')).toMatchObject({ state: 'limited', errorCode: 'quota', retryAt: Date.parse('2026-11-21T00:00:00Z') });
    expect(fetcher.mock.calls).toHaveLength(2);
  } finally { await sources.close(); }
});
it('defers an oversized request until refill without spending the small remaining allowance', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport({ ...status(), used: 9999990, remaining: 10 });
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: 72000 });
  expect(fetcher.mock.calls).toHaveLength(2);
});
it('refuses provider-reported model failover even if the body repeats the requested alias', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const normal = transport(), fetcher: typeof fetch = async (url, init) => String(url).endsWith('/chat/completions')
    ? Response.json(response(), { headers: { 'X-Darus-Model-Failover': 'another-model' } }) : normal(url, init);
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
});
it.each([{ ...offer(), free: false }, { ...offer(), id: DARUS_MODEL.replace('-FREE', '') }])('rejects a changed free model catalog: %j', async model => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport(status(), model);
  expect(await source(fetcher).available()).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects hostile grant destinations without sending credentials', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const fetcher = transport();
  expect(await source(fetcher, { ...grant, base_url: 'https://example.test' }).available()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('assembles native SSE function fragments and usage, without executing a tool', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const chunks = [
    { model: DARUS_MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'scout_probe', arguments: '{"nonce":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 52, completion_tokens: 9 } }
  ];
  const normal = transport(), fetcher: typeof fetch = async (url, init) => String(url).endsWith('/chat/completions')
    ? new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : normal(url, init);
  await expect(source(fetcher).complete({ ...request(), tools: [{ type: 'function', function: { name: 'scout_probe', parameters: { type: 'object' } } }] }, AbortSignal.timeout(2000))).resolves.toEqual({
    text: '', calls: [{ id: 'c1', type: 'function', function: { name: 'scout_probe', arguments: '{"nonce":"test"}' } }], inputTokens: 52, outputTokens: 9
  });
});
it.each([
  { ...response(), model: 'paid-model' },
  { model: DARUS_MODEL, choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }] },
  { ...response(), choices: [{ message: { content: 'partial' }, finish_reason: null }] }
])('rejects changed model identities and malformed/truncated completions', async answer => {
  await recordDataSharingConsent(directory, ['darus']);
  await expect(source(transport(status(), offer(), answer)).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'upstream' });
});
it('cancels a pending response body and never returns partial output', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  let cancelled = false;
  const normal = transport(), controller = new AbortController();
  const fetcher: typeof fetch = async (url, init) => String(url).endsWith('/chat/completions')
    ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) : normal(url, init);
  const work = source(fetcher).complete(request(), controller.signal);
  await vi.waitFor(() => expect(normal.mock.calls).toHaveLength(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await expect(work).rejects.toBeDefined();
  expect(cancelled).toBe(true);
});
it('routes auto and worker requests through the exact configured native source', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  await writePrivateProviderGrant('darus', grant, directory);
  vi.stubGlobal('fetch', transport());
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'darus' });
  const app = createLocalApp(sources, { cwd: directory });
  try {
    const result = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'grunt', messages: request().messages }) });
    expect(result.status).toBe(200);
    expect(result.headers.get('x-grunt-source')).toBe('darus');
    const completion = await sources.complete({ ...request(), model: 'grunt', worker: { id: 'w1', onSource() {} } }, AbortSignal.timeout(2000));
    expect(completion.text).toBe('Hello');
  } finally { await sources.close(); }
  expect(bundledRegistry.adapters.find(row => row.id === 'darus')?.model).toBe(DARUS_MODEL);
  expect(() => validateRegistry(bundledRegistry)).not.toThrow();
});
