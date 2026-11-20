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
it('Openference permits automatic and worker use of the zero-price on-demand offer', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const fetcher = transport('openference'), adapter = source('openference', fetcher);
  for (const input of [{ ...request('openference'), model: 'grunt' }, { ...request('openference'), worker: { id: 'w1', onSource() {} } }]) {
    await expect(adapter.complete(input, AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'Hello' });
  }
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(2);
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
it.each(['fikra', 'openference'] as const)('includes qualified %s in automatic onboarding with the exact free alias', id => {
  expect(bundledRegistry.adapters.find(adapter => adapter.id === id)?.model).toBe(PROMOTIONAL_PROVIDERS[id].model);
  expect(localOptInAdapters.some(adapter => adapter.id === id)).toBe(false);
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

it('Openference maintenance retains the free-price guard', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const fetcher = transport('openference', { ...offer('openference'), pricing: { prompt: '1', completion: '0', cache_read: '0' } } as ReturnType<typeof offer>);
  const adapter = source('openference', fetcher);
  await withDiagnosticContext({ requestId: 'synthetic-maintenance', kind: 'maintenance' }, async () => {
    await expect(adapter.complete(request('openference'), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/chat/completions'))).toBe(false);
});
it.each(['length', 'tool_calls'])('rejects incomplete function JSON with finish %s', async finish => {
  const response = streamResponse(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: finish }] }]));
  await expect(readPromotionalStream(response, PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000))).rejects.toBeDefined();
});

it('Openference streams native tools through Grunt HTTP and automatic selection', async () => {
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
    expect(auto.status).toBe(200);
    expect(fetcher).toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('falls back from an Openference upstream rejection to free Fikra automatically', async () => {
  await recordDataSharingConsent(directory, ['fikra', 'openference']);
  for (const id of ['fikra', 'openference'] as const) await writePrivateProviderGrant(id, grant(id), directory);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const id = String(url).includes('openference') ? 'openference' : 'fikra';
    if (String(url).endsWith('/status.json')) return Response.json(gate());
    if (String(url).endsWith('/models')) return Response.json({ data: [offer(id)] });
    const body = JSON.parse(String(init?.body)); sent.push(body.model);
    return id === 'openference' ? Response.json({ error: { code: 'invalid_request_error' } }, { status: 422 })
      : Response.json({ model: PROMOTIONAL_PROVIDERS.fikra.model, choices: [{ message: { content: 'Hello' } }] });
  }));
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'openference,fikra' });
  try {
    // Routing may use the first ready source without waiting for slower metadata.
    // Admit both offers before draw 0 so this fixture exercises Openference's
    // upstream rejection and actual Fikra failover, not admission completion order.
    for (const source of sources.sources) expect(await sources.observation.available(source)).toBe(true);
    const response = await createLocalApp(sources, { cwd: directory }).request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request('fikra'), model: 'grunt' })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe('fikra');
    expect(sent).toEqual([PROMOTIONAL_PROVIDERS.openference.model, PROMOTIONAL_PROVIDERS.fikra.model]);
  } finally { await sources.close(); }
});
