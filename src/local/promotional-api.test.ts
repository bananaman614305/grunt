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
import type { DiagnosticEvent, DiagnosticsStore } from './diagnostics.js';
import { Sources, SourceError, endingOf } from './source.js';
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
  expect(body).not.toHaveProperty('max_tokens');
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
it('Openference permits automatic use of the zero-price on-demand offer', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const fetcher = transport('openference'), adapter = source('openference', fetcher);
  for (const input of [{ ...request('openference'), model: 'grunt' }]) {
    await expect(adapter.complete(input, AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'Hello' });
  }
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
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

it('reports meaningful reasoning, content and tool fragments, excluding heartbeats and role-only events', async () => {
  const progress = vi.fn();
  const body = ': heartbeat\n\n' + sse([
    { model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'Working through the question' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '', reasoning_content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ]);
  const observe = { failure: vi.fn(), cleanup: vi.fn(), progress };
  await expect(readPromotionalStream(streamResponse(body), PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(1000), observe))
    .resolves.toMatchObject({ text: 'Answer', calls: [{ id: 'call_1' }] });
  expect(progress).toHaveBeenCalledTimes(3);
});

it('falls back from an Openference stream that starts reasoning then stalls, cancelling its reader once', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const cancel = vi.fn(), normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model,
        choices: [{ index: 0, delta: { reasoning_content: 'Reasoning started' }, finish_reason: null }] }], false)));
    }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } })) : normal(url, init));
  const fallback = { id: 'fikra', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  const sources = new Sources([source('openference', fetcher), fallback], undefined, new Set(), 50);
  try {
    await expect(sources.complete({ ...request('openference'), model: 'grunt' }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'fallback' });
    expect(fallback.complete).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
  } finally { await sources.close(); }
});

it('retains a healthy Openference reasoning stream longer than the first-output deadline', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(new Response(new ReadableStream({ async start(controller) {
      for (let i = 0; i < 5; i++) {
        controller.enqueue(new TextEncoder().encode(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model,
          choices: [{ index: 0, delta: { reasoning_content: `Reasoning step ${i}` }, finish_reason: null }] }], false)));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      controller.enqueue(new TextEncoder().encode(sse(frames()))); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } })) : normal(url, init));
  const fallback = { id: 'fikra', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  const sources = new Sources([source('openference', fetcher), fallback], undefined, new Set(), 60);
  try {
    await expect(sources.complete({ ...request('openference'), model: 'grunt' }, AbortSignal.timeout(1000))).resolves.toMatchObject({ text: 'Hello' });
    expect(fallback.complete).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
  } finally { await sources.close(); }
});

it('does not let transport heartbeats or role-only events postpone the first-output deadline', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cancel = vi.fn(() => clearInterval(heartbeat));
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }], false)));
      heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 10);
    }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } })) : normal(url, init));
  const fallback = { id: 'fikra', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  const sources = new Sources([source('openference', fetcher), fallback], undefined, new Set(), 50);
  try {
    await expect(sources.complete({ ...request('openference'), model: 'grunt' }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'fallback' });
    expect(fallback.complete).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
  } finally { clearInterval(heartbeat); await sources.close(); }
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
  const reply = readPromotionalStream(response, PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000));
  if (finish === 'length') await expect(reply).resolves.toEqual({ text: '', finishReason: 'length' });
  else await expect(reply).rejects.toBeDefined();
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

// These fixtures never contact a provider. HTTP headers can succeed before a
// body or protocol failure, so each stage needs fixed diagnostic metadata.
it.each([
  ['stream_read', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_STREAM_EXCEPTION')); } }), { headers: { 'Content-Type': 'text/event-stream' } })],
  ['stream_read', () => new Response(new ReadableStream({ start(controller) { controller.error('PRIVATE_NON_ERROR_EXCEPTION'); } }), { headers: { 'Content-Type': 'text/event-stream' } })],
  ['response_json', () => streamResponse('data: PRIVATE_INVALID_JSON\n\n')],
  ['stream_format', () => new Response('PRIVATE_BODY', { headers: { 'Content-Type': 'application/json' } })],
  ['stream_incomplete', () => streamResponse(sse(frames(), false))],
  ['response_tools', () => streamResponse(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'ready', arguments: 'PRIVATE_ARGUMENTS' } }] }, finish_reason: 'tool_calls' }] }]))]
] as const)('classifies post-header %s without retaining content or replaying inference', async (reason, makeResponse) => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions') ? Promise.resolve(makeResponse()) : normal(url, init));
  const error = await source('openference', fetcher).complete(request('openference'), AbortSignal.timeout(2000)).catch(error => error);
  expect(error).toBeInstanceOf(SourceError);
  expect(error).toMatchObject({ code: 'upstream', diagnostics: { failureReason: reason } });
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
});

it('preserves an existing SourceError identity, code and retry delay from the reader', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const original = new SourceError('quota', 'PRIVATE_EXCEPTION', 23);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(original); } }), { headers: { 'Content-Type': 'text/event-stream' } })) : normal(url, init));
  await expect(source('openference', fetcher).complete(request('openference'), AbortSignal.timeout(2000))).rejects.toBe(original);
  expect(original).toMatchObject({ code: 'quota', retryAfter: 23 });
  expect(original.diagnostics).toBeUndefined();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
});
it('observes swallowed cleanup failures without failing success or retaining exception text', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  const fetcher = vi.fn<typeof fetch>((url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse(frames()))); },
      cancel() { throw new Error('PRIVATE_CLEANUP_EXCEPTION'); } }), { headers: { 'Content-Type': 'text/event-stream' } })) : normal(url, init));
  const events: DiagnosticEvent[] = [];
  const sink = { record(event: DiagnosticEvent) { events.push(event); } } as unknown as DiagnosticsStore;
  await expect(withDiagnosticContext({ requestId: '11111111-1111-4111-8111-111111111111', kind: 'diagnostic', sink },
    () => source('openference', fetcher).complete(request('openference'), AbortSignal.timeout(2000)))).resolves.toMatchObject({ text: 'Hello' });
  expect(events).toContainEqual(expect.objectContaining({ source: 'openference', type: 'transport.finish', failureReason: 'stream_cleanup', outcome: 'failed', httpStatus: 200 }));
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|synthetic-key|Synthetic hello/);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(1);
});

it('retains the existing fifteen-minute router cooldown for malformed streamed tools', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const normal = transport('openference');
  const fetcher: typeof fetch = (url, init) => String(url).endsWith('/chat/completions')
    ? Promise.resolve(streamResponse(sse([{ model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call', type: 'function', function: { name: 'ready', arguments: 'INVALID' } }
    ] }, finish_reason: 'tool_calls' }] }]))) : normal(url, init);
  const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(row => ['openference', 'fikra'].includes(row.id)).map(row => ({ ...row, weight: 0.5 })) };
  const sources = new Sources([source('openference', fetcher), { id: 'fikra', available: async () => true, complete: async () => ({ text: 'fallback' }) }],
    { registry: () => registry, now: () => now, random: () => 0 });
  try {
    for (const entry of sources.sources) await sources.observation.available(entry);
    await expect(sources.complete({ ...request('openference'), model: 'grunt' }, AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'fallback' });
    expect(sources.status().sources.find(row => row.id === 'openference')).toMatchObject({ errorCode: 'upstream', retryAt: now + 900000 });
  } finally { await sources.close(); }
});

it('records a content-free ending for a streamed reply and still refuses an unknown stream finish', async () => {
  const stream = (finish: string) => new Response(sse([
    { model: PROMOTIONAL_PROVIDERS.openference.model, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } }
  ]), { headers: { 'Content-Type': 'text/event-stream' } });
  const stopped = await readPromotionalStream(stream('stop'), PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000));
  expect(endingOf(stopped)).toEqual({ finish: 'stop', toolCalls: false, reasoningTokens: 2 });
  expect(stopped).toEqual({ text: 'Hello', inputTokens: 3, outputTokens: 4 });
  await expect(readPromotionalStream(stream('PRIVATE_REASON'), PROMOTIONAL_PROVIDERS.openference.model, AbortSignal.timeout(2000))).rejects.toBeDefined();
});
