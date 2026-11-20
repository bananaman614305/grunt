import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { PromotionalApi, PROMOTIONAL_PROVIDERS, readPromotionalStream } from './promotional-api.js';
import type { PromotionalProvider } from './promotional-api.js';
import { writePrivateProviderGrant } from './provider-grant.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';
import { withDiagnosticContext } from './diagnostics.js';
import { bundledRegistry, localOptInAdapters } from '../registry.js';

const now = Date.parse('2026-11-20T03:00:00Z');
let directory: string;
const gate = () => ({ active: true, model_id: PROMOTIONAL_PROVIDERS.fikra.model, used_usd: 1, cap_usd: 1100,
  checked_at: new Date(now).toISOString(), expires_at: '2026-11-23T00:00:00Z', tokens_used: 100, tokens_cap: 30000000000 });
const offer = (id: PromotionalProvider) => id === 'fikra' ? { id: PROMOTIONAL_PROVIDERS[id].model,
  pricing: { unit: 'USD_PER_1M_TOKENS', input: 0, output: 0 }, context_window: 1048576 } : {
  id: PROMOTIONAL_PROVIDERS[id].model, pricing: { prompt: '0', completion: '0', cache_read: '0' },
  is_free: true, free_until: '2026-12-31', quota_multiplier: 0, context_length: 1048576, capabilities: { tool_calling: true }
};
const request = (id: PromotionalProvider) => ({ model: id, messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], cwd: directory, stream: false });
const grant = (id: PromotionalProvider) => ({ base_url: `https://${PROMOTIONAL_PROVIDERS[id].host}`, token: 'synthetic-key' });
const sse = (chunks: unknown[], done = true) => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
const frames = () => [
  { model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 200123, completion_tokens: 2 } }
];
const streamResponse = (body = sse(frames())) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
function transport(id: PromotionalProvider, catalog = offer(id), status = gate()) {
  return vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/status.json')) return Response.json(status);
    if (String(url).endsWith('/v1/models')) return Response.json({ data: [catalog] });
    return id === 'openference' ? streamResponse() : Response.json({ model: PROMOTIONAL_PROVIDERS[id].model,
      choices: [{ message: { content: 'Hello' } }], usage: { prompt_tokens: 200123, completion_tokens: 2 } });
  });
}
function source(id: PromotionalProvider, fetcher: typeof fetch, clock = () => now, access = grant(id)) {
  return new PromotionalApi(id, { directory, fetcher, now: clock, loadGrant: async () => access });
}
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'promotional-api-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it.each(['fikra', 'openference'] as const)('%s sends nothing without provider-specific approval', async id => {
  const fetcher = transport(id);
  await expect(source(id, fetcher).complete(request(id), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['fikra', 'openference'] as const)('%s pins free alias, records usage, and never calls paid quote APIs', async id => {
  await recordDataSharingConsent(directory, [id]);
  const fetcher = transport(id);
  await expect(source(id, fetcher).complete(request(id), AbortSignal.timeout(2000))).resolves.toEqual({ text: 'Hello', inputTokens: 200123, outputTokens: 2 });
  const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(body.model).toBe(PROMOTIONAL_PROVIDERS[id].model);
  expect(body.stream).toBe(id === 'openference');
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/quote'))).toBe(false);
});
it.each([
  { active: false }, { used_usd: 1100 }, { tokens_used: 30000000000 }, { expires_at: '2026-11-19T00:00:00Z' },
  { expires_at: 'bad' }, { checked_at: '2026-11-20T02:58:00Z' }, { model_id: 'paid-alias' }
])('Fikra rejects a closed, exhausted, stale or malformed live gate (%j)', async patch => {
  await recordDataSharingConsent(directory, ['fikra']);
  const fetcher = transport('fikra', offer('fikra'), { ...gate(), ...patch });
  expect(await source('fikra', fetcher).available()).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('Fikra rechecks the earlier live deadline after catalog I/O', async () => {
  await recordDataSharingConsent(directory, ['fikra']);
  let clock = now;
  const original = transport('fikra');
  const fetcher: typeof fetch = async (url, init) => {
    const response = await original(url, init);
    if (String(url).endsWith('/models')) clock = Date.parse(gate().expires_at);
    return response;
  };
  await expect(source('fikra', fetcher, () => clock).complete(request('fikra'), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(original).toHaveBeenCalledTimes(2);
});
it.each(['fikra', 'openference'] as const)('%s blocks changed pricing, expiry and hostile endpoints before inference', async id => {
  await recordDataSharingConsent(directory, [id]);
  const fetcher = transport(id, { ...offer(id), pricing: { input: 1, output: 1, prompt: '1', completion: '1' } } as ReturnType<typeof offer>);
  expect(await source(id, fetcher).available()).toBe(false);
  const fresh = transport(id);
  expect(await source(id, fresh, () => Date.parse(PROMOTIONAL_PROVIDERS[id].expires)).available()).toBe(false);
  expect(await source(id, fresh, () => now, { base_url: 'https://untrusted.example', token: 'synthetic' }).available()).toBe(false);
  expect(fresh).not.toHaveBeenCalled();
});
it('Openference skips automatic and worker requests before any egress', async () => {
  const fetcher = transport('openference'), adapter = source('openference', fetcher);
  expect(adapter.acceptsRequest({ ...request('openference'), model: 'grunt' })).toBe(false);
  await expect(adapter.complete({ ...request('openference'), worker: { id: 'w1', onSource() {} } }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('Openference preserves provider daily reset without retrying or changing models', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/chat/completions')
    ? Response.json({ error: { code: 'daily_usage_exceeded', resets_at: '2026-11-21T00:00:00Z' } }, { status: 429 }) : normal(url, init));
  await expect(source('openference', fetcher).complete(request('openference'), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'quota', retryAfter: 75600 });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
});
it('assembles native tool arguments across UTF-8 and SSE chunk boundaries', async () => {
  const body = sse([
    { model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{"ok":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"✓"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 21, completion_tokens: 6 } }
  ]);
  const bytes = new TextEncoder().encode(body);
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await expect(readPromotionalStream(response, PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000))).resolves.toEqual({
    text: '', calls: [{ id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{"ok":"✓"}' } }], inputTokens: 21, outputTokens: 6
  });
});
it.each([
  sse(frames(), false), sse(frames().slice(0, 1)),
  sse([{ model: 'paid-model', choices: [{ index: 0, delta: { content: 'Wrong' }, finish_reason: 'stop' }] }]),
  sse([...frames(), { error: { message: 'synthetic secret error' } }]),
  sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { content: 'No' }, finish_reason: 'content_filter' }] }])
])('rejects truncated, mismatched and failed SSE', async body => {
  await expect(readPromotionalStream(streamResponse(body), PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000))).rejects.toBeDefined();
});
it('aborts a stalled SSE reader', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
  const pending = readPromotionalStream(response, PROMOTIONAL_PROVIDERS.openference.model, controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
});
it('does not add unqualified promotions to default onboarding', () => {
  for (const id of ['fikra', 'openference']) {
    expect(bundledRegistry.adapters.some(adapter => adapter.id === id)).toBe(false);
    expect(localOptInAdapters.some(adapter => adapter.id === id)).toBe(true);
  }
});
it('routes Fikra native tools through the Grunt HTTP interface with a mixed source configuration', async () => {
  await recordDataSharingConsent(directory, ['fikra']);
  await writePrivateProviderGrant('fikra', grant('fikra'), directory);
  const normal = transport('fikra');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/status.json')) return Response.json({ ...gate(), checked_at: new Date(now).toISOString(), expires_at: gate().expires_at });
    if (!String(url).endsWith('/chat/completions')) return normal(url, init);
    return Response.json({ model: PROMOTIONAL_PROVIDERS.fikra.model, choices: [{ message: { content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{}' } }] } }] });
  }));
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'freellmapi,fikra' });
  try {
    const response = await createLocalApp(sources, { cwd: directory }).request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request('fikra'), tools: [{ type: 'function', function: { name: 'ready', parameters: { type: 'object' } } }] })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].finish_reason).toBe('tool_calls');
  } finally { await sources.close(); }
});

it('Openference rejects background maintenance before inference', async () => {
  const fetcher = transport('openference'), adapter = source('openference', fetcher);
  await withDiagnosticContext({ requestId: 'synthetic-maintenance', kind: 'maintenance' }, async () => {
    expect(adapter.acceptsRequest(request('openference'))).toBe(false);
    await expect(adapter.complete(request('openference'), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['length', 'tool_calls'])('rejects incomplete function JSON with finish %s', async finish => {
  const response = streamResponse(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: finish }] }]));
  await expect(readPromotionalStream(response, PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000))).rejects.toBeDefined();
});

it('Openference streams native tools through Grunt HTTP while rejecting automatic selection', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  await writePrivateProviderGrant('openference', grant('openference'), directory);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return normal(url, init);
    return streamResponse(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]));
  });
  vi.stubGlobal('fetch', fetcher);
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'openference' });
  const app = createLocalApp(sources, { cwd: directory });
  try {
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request('openference'), tools: [{ type: 'function', function: { name: 'ready', parameters: { type: 'object' } } }] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe('openference');
    expect((await response.json()).choices[0].finish_reason).toBe('tool_calls');
    fetcher.mockClear();
    const auto = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request('openference'), model: 'grunt' }) });
    expect(auto.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});
