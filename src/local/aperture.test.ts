import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry, validateRegistry } from '../registry.js';
import { Aperture, APERTURE_ID, APERTURE_MODEL } from './aperture.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { writePrivateProviderGrant } from './provider-grant.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import type { ModelRequest } from './source.js';

const now = Date.parse('2026-11-20T04:30:00Z');
let directory: string;
const grant = { base_url: 'https://www.aperture-ai.run', token: 'synthetic-aperture-grant' };
const offer = () => ({ id: APERTURE_MODEL, pricing: { prompt: '0', completion: '0' }, context_length: 1024000,
  supported_parameters: ['max_tokens', 'tools', 'tool_choice'], expiration_date: null, endpoints: ['/api/v1/chat/completions'] });
const result = () => ({ model: APERTURE_MODEL, choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }], usage: { prompt_tokens: 200123, completion_tokens: 66 } });
const request = (): ModelRequest => ({ model: APERTURE_ID, messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], cwd: directory, stream: false, maxTokens: 1024 });
function transport(account: unknown = { valid: true, plan: 'free' }, catalog: unknown = { data: [offer()] }, reply = () => Response.json(result())) {
  return vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/auth/me')) return Response.json(account);
    if (String(url).endsWith('/api/v1/models')) return Response.json(catalog);
    return reply();
  });
}
const source = (fetcher: typeof fetch, access = grant) => new Aperture({ directory, fetcher, now: () => now, loadGrant: async () => access });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aperture-test-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it('requires its own current source consent before account, catalog or inference access', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = transport();
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('checks the Free plan and zero-price exact alias before each native JSON request', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport(), adapter = source(fetcher);
  await expect(adapter.complete(request(), AbortSignal.timeout(2000))).resolves.toEqual({ text: 'Hello', inputTokens: 200123, outputTokens: 66 });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    'https://www.aperture-ai.run/auth/me', 'https://www.aperture-ai.run/api/v1/models', 'https://www.aperture-ai.run/api/v1/chat/completions'
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({ model: APERTURE_MODEL, messages: request().messages,
    stream: true, stream_options: { include_usage: true }, max_tokens: 1024 });
  const withoutLimit = request(); delete withoutLimit.maxTokens;
  await adapter.complete({ ...withoutLimit, model: 'grunt' }, AbortSignal.timeout(2000));
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).not.toHaveProperty('max_tokens');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'))).toHaveLength(2);
});
it.each([APERTURE_MODEL, 'other-model'])('verifies the SSE model and reports progress on buffered calls (%s)', async model => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const frames = [{ model, choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }];
  const wire = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  const adapter = source(transport(undefined, undefined, () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })));
  const progress = vi.fn();
  try {
    const pending = adapter.complete(request(), AbortSignal.timeout(1000), progress);
    if (model === APERTURE_MODEL) {
      await expect(pending).resolves.toEqual({ text: 'Hello', inputTokens: 5, outputTokens: 1 });
      expect(progress).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'upstream' });
      expect(progress).not.toHaveBeenCalled();
    }
  } finally { await adapter.close(); }
});
it.each([{ valid: false, plan: 'free' }, { valid: true, plan: 'pro' }, { valid: true }, { plan: 'free' }, null])('blocks unverified or paid account metadata %j', async account => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport(account);
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { pricing: { prompt: '0.001', completion: '0' } }, { pricing: { prompt: '0', completion: '0', cache_read: '0.01' } },
  { pricing: { prompt: null, completion: '0' } }, { context_length: 128000 }, { supported_parameters: ['max_tokens'] },
  { expiration_date: '2026-11-21' }, { endpoints: ['/api/v1/messages'] }, { id: 'baidu/ernie-5.5-flash-preview' }
])('blocks changed price, model, tool support or context before inference: %j', async change => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport(undefined, { data: [{ ...offer(), ...change }] });
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects duplicate catalog identities rather than selecting a convenient free row', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport(undefined, { data: [offer(), offer()] });
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['https://www.aperture-ai.run.evil.test', 'https://www.aperture-ai.run:444', 'https://www.aperture-ai.run/api/v1', 'https://trusty-squire-api.fly.dev/v1/egress/not-a-grant'])('rejects unrelated or path-injecting endpoints %s', async base_url => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport();
  await expect(source(fetcher, { ...grant, base_url }).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('returns correlated native tool calls without executing them', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'scout_probe', arguments: '{"ok":true}' } }];
  const fetcher = transport(undefined, undefined, () => Response.json({ model: APERTURE_MODEL,
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: calls } }] }));
  const tools = [{ type: 'function', function: { name: 'scout_probe', parameters: { type: 'object' } } }];
  await expect(source(fetcher).complete({ ...request(), tools }, AbortSignal.timeout(2000))).resolves.toEqual({ text: '', calls });
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).tools).toEqual(tools);
});
it.each([
  { model: 'silently-substituted-model' }, { choices: [] },
  { choices: [{ finish_reason: 'content_filter', message: { content: 'Filtered' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
  { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'probe', arguments: 'invalid-json' } }] } }] },
  { choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'probe', arguments: '{}' } }] } }] }
])('rejects wrong model and incomplete or malformed completions: %j', async change => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const reply = source(transport(undefined, undefined, () => Response.json({ ...result(), ...change }))).complete(request(), AbortSignal.timeout(2000));
  if (change.choices?.[0]?.finish_reason === 'length') await expect(reply).resolves.toMatchObject({ text: '', finishReason: 'length' });
  else await expect(reply).rejects.toMatchObject({ code: 'upstream' });
});
it.each([
  [{ error: { code: 'daily_quota_exceeded' } }, undefined, 70200],
  [{ error: { code: 'daily_quota_exceeded', resets_at: '2026-11-21T00:00:00Z' } }, undefined, 70200],
  [{ error: { code: 'upstream_rate_limit' } }, '90', 90],
  [{ error: { code: 'rate_limit' } }, undefined, undefined],
])('distinguishes daily exhaustion from upstream/generic throttling: %j', async (body, retry, expected) => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = transport(undefined, undefined, () => Response.json(body, { status: 429, ...(retry ? { headers: { 'Retry-After': retry } } : {}) }));
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: expected });
});
it('retains availability quota signals in Sources and skips requests during their explicit cooldown', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'rate_limit' } }, { status: 429, headers: { 'Retry-After': '60' } }));
  const pool = new Sources([source(fetcher)], { registry: () => bundledRegistry, now: () => now });
  try {
    expect(await pool.models()).toEqual(['grunt']);
    expect(pool.status().sources).toEqual([expect.objectContaining({ id: APERTURE_ID, state: 'limited', retryAt: now + 60000 })]);
    await expect(pool.complete({ ...request(), model: 'grunt' }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: 60 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await pool.close(); }
});
it('bounds account metadata and cancels a pending completion body', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const oversized = transport({ valid: true, plan: 'free', extra: 'x'.repeat(8192) });
  await expect(source(oversized).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(oversized).toHaveBeenCalledTimes(1);
  const cancel = vi.fn(), controller = new AbortController();
  const fetcher = transport(undefined, undefined, () => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
  const adapter = source(fetcher), completion = adapter.complete(request(), controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  controller.abort();
  await expect(completion).rejects.toBeDefined();
  expect(cancel).toHaveBeenCalled();
  await adapter.close();
  await expect(adapter.complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'cancelled' });
});
it('reaches the exact source through Grunt and includes it in candidate automatic onboarding', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  await writePrivateProviderGrant(APERTURE_ID, grant, directory);
  vi.stubGlobal('fetch', transport());
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: APERTURE_ID });
  try {
    const response = await createLocalApp(sources, { cwd: directory }).request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: APERTURE_ID, messages: request().messages, max_tokens: 1024 }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe(APERTURE_ID);
    expect((await response.json()).choices[0].message.content).toBe('Hello');
    expect(bundledRegistry.adapters.find(adapter => adapter.id === APERTURE_ID)).toMatchObject({ model: APERTURE_MODEL, install: 'builtin:aperture-ai' });
    expect(() => validateRegistry({ ...bundledRegistry, adapters: bundledRegistry.adapters.map(adapter => adapter.id === APERTURE_ID ? { ...adapter, model: 'paid-model' } : adapter) })).toThrow();
  } finally { await sources.close(); }
});
