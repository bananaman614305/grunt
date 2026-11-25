import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { OPENROUTER_PARTICLE_ENDPOINT, OPENROUTER_PARTICLE_MODEL, OpenRouterParticle, OPENROUTER_PARTICLE_PREFLIGHT_MS } from './openrouter-particle.js';
import type { SourceError } from './source.js';
import type { ModelRequest } from './source.js';

const now = Date.parse('2026-11-25T04:00:00Z');
const grant = { base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_synthetic', token: 'synthetic-key' };
let directory: string, clock = now;
const offer = (patch: Record<string, unknown> = {}) => ({ tag: OPENROUTER_PARTICLE_ENDPOINT, model_id: OPENROUTER_PARTICLE_MODEL, status: 0, context_length: 1048576, max_prompt_tokens: null,
  pricing: { prompt: '0', completion: '0', discount: 0 }, supported_parameters: ['tools', 'tool_choice', 'max_tokens', 'reasoning'], ...patch });
const catalog = (offers: unknown[] = [offer()]) => ({ data: { id: OPENROUTER_PARTICLE_MODEL, endpoints: offers } });
const keyInfo = (patch: Record<string, unknown> = {}, quota: Record<string, unknown> = {}) => ({ data: { is_management_key: false, is_provisioning_key: false,
  free_model_daily_requests: { used: 3, limit: 50, remaining: 47, ...quota }, ...patch } });
const req = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'openrouter-particle', messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], stream: false, cwd: directory, maxTokens: 128, ...extra });
const tool = { type: 'function', function: { name: 'record_probe', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } } };
const free = { prompt_tokens: 20, completion_tokens: 3, cost: 0, cost_details: { upstream_inference_cost: 0 } };
const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null, model = OPENROUTER_PARTICLE_MODEL) => ({ id: 'gen-1', model, choices: [{ index: 0, delta, finish_reason: finish }] });
function sse(...events: unknown[]) {
  const encoder = new TextEncoder();
  // OpenRouter interleaves comment keepalives; they carry no data and are not progress.
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
    for (const item of [...events, '[DONE]']) controller.enqueue(encoder.encode(event(item)));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const hello = (usage: Record<string, unknown> = free, model = OPENROUTER_PARTICLE_MODEL) => sse(chunk({ role: 'assistant' }, null, model), chunk({ reasoning: 'thinking' }, null, model),
  chunk({ content: 'Hel' }, null, model), chunk({ content: 'lo' }, null, model), chunk({}, 'stop', model), { id: 'gen-1', model, choices: [], usage });
function transport(completion: () => Response | Promise<Response>, patch: { catalog?: unknown; key?: unknown } = {}) {
  return vi.fn<typeof fetch>(async input => String(input).endsWith('/key') ? Response.json(patch.key ?? keyInfo())
    : String(input).includes('/endpoints') ? Response.json(patch.catalog ?? catalog()) : completion());
}
const source = (fetcher: typeof fetch) => new OpenRouterParticle({ directory, fetcher, now: () => clock, loadGrant: async () => grant });
const posts = (fetcher: ReturnType<typeof transport>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
const failure = async (work: Promise<unknown>) => work.then(() => { throw new Error('expected failure'); }, (error: unknown) => error as SourceError);
beforeEach(async () => { clock = now; vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'openrouter-particle-')); await recordDataSharingConsent(directory, ['openrouter-particle']); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('streams a hello from the pinned free route, sends only free-safe routing, and reports usage', async () => {
  const fetcher = transport(() => hello()), progress = vi.fn();
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000), progress)).resolves.toEqual({ text: 'Hello', inputTokens: 20, outputTokens: 3 });
  const [url, init] = posts(fetcher)[0]!, body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  expect(String(url)).toBe(`${grant.base_url}/api/v1/chat/completions`);
  expect(body).toEqual({ model: 'particle-ai/particle-1:free', messages: [{ role: 'user', content: 'Synthetic hello' }], stream: true, stream_options: { include_usage: true }, max_tokens: 128,
    provider: { only: ['particle-ai/us'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } });
  // No model list, router or plugin that could move the request to a paid model.
  expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['models', 'route', 'plugins', 'transforms']));
  expect(progress).toHaveBeenCalledTimes(3);
});
it('accepts OpenRouter\u2019s final usage chunk, whose delta is an empty content string after the finish chunk, and still rejects text after the finish', async () => {
  const trailing = (content: string) => sse(chunk({ role: 'assistant' }), chunk({ content: 'Hello' }), chunk({}, 'stop'),
    { id: 'gen-1', model: OPENROUTER_PARTICLE_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }], usage: free });
  await expect(source(transport(() => trailing(''))).complete(req(), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'Hello', inputTokens: 20, outputTokens: 3 });
  expect((await failure(source(transport(() => trailing('late text'))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('upstream');
});
it('uses the caller output budget, never above the endpoint maximum, and omits an unspecified one', async () => {
  const fetcher = transport(() => hello());
  await source(fetcher).complete(req({ maxTokens: 9999999 }), AbortSignal.timeout(1000));
  await source(fetcher).complete(req({ maxTokens: undefined as unknown as number }), AbortSignal.timeout(1000));
  expect(posts(fetcher).map(([, init]) => (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)).toEqual([131072, undefined]);
});
it('accepts one whole JSON reply from a gateway that ignores streaming', async () => {
  const whole = { model: OPENROUTER_PARTICLE_MODEL, choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: free };
  await expect(source(transport(() => Response.json(whole))).complete(req(), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'Hi', inputTokens: 20, outputTokens: 3 });
});
it('returns a validated native function call, including from a 2020-12 schema', async () => {
  const call = (args: string, id = 'call-a', name = 'record_probe') => sse(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }), chunk({}, 'tool_calls'),
    { id: 'gen-1', model: OPENROUTER_PARTICLE_MODEL, choices: [], usage: free });
  const request = req({ tools: [tool] });
  await expect(source(transport(() => call('{"marker":"one"}'))).complete(request, AbortSignal.timeout(1000))).resolves.toMatchObject({ text: '',
    calls: [{ id: 'call-a', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"one"}' } }] });
  for (const bad of [call('{"marker":1}'), call('{"marker":"x","extra":true}'), call('{"marker":"x"}', 'call-a', 'other_tool'), call('not json')]) {
    expect((await failure(source(transport(() => bad)).complete(request, AbortSignal.timeout(1000)))).code).toBe('upstream');
  }
  const reused = req({ tools: [tool], messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"a"}' } }] },
    { role: 'tool', content: 'ok', tool_call_id: 'call-a' }] });
  expect((await failure(source(transport(() => call('{"marker":"one"}'))).complete(reused, AbortSignal.timeout(1000)))).code).toBe('upstream');
});
it('refuses a malformed tool schema locally, before any provider is reached', async () => {
  const fetcher = transport(() => hello());
  const error = await failure(source(fetcher).complete(req({ tools: [{ type: 'function', function: { name: 'bad', parameters: { type: 'nonsense' } } }] }), AbortSignal.timeout(1000)));
  expect(error).toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_tool_schema' } });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  ['a reported cost', { ...free, cost: 0.0001 }],
  ['a nonzero upstream inference cost', { ...free, cost_details: { upstream_inference_cost: 0.5 } }],
  ['a credits charge', { ...free, credits_charged: 1 }],
  ['no reported cost', { prompt_tokens: 20, completion_tokens: 3 }],
  ['no usage counts', { cost: 0 }]
])('rejects a reply with %s', async (_name, usage) => {
  expect((await failure(source(transport(() => hello(usage))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('upstream');
});
it.each(['particle-ai/particle-1', 'particle-ai/particle-1-20261027', 'deepseek/deepseek-v4.1-flash:free'])('rejects a reply attributed to %s', async model => {
  expect((await failure(source(transport(() => hello(free, model))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('upstream');
});
it('serves only its exact free text route and never a named paid alias, image, or hosted tool', async () => {
  const fetcher = transport(() => hello());
  for (const bad of [req({ model: 'particle-ai/particle-1' }), req({ model: 'particle-ai/particle-1:free' }), req({ imageInput: true }), req({ tools: [{ type: 'web_search' }] })]) {
    expect((await failure(source(fetcher).complete(bad, AbortSignal.timeout(1000)))).code).toBe('refused');
  }
  expect(fetcher).not.toHaveBeenCalled();
  for (const model of ['grunt', 'milo', 'openrouter-particle']) await expect(source(transport(() => hello())).complete(req({ model }), AbortSignal.timeout(1000))).resolves.toMatchObject({ text: 'Hello' });
});
it('needs its own data-sharing approval; Kilo approval does not count', async () => {
  const other = await mkdtemp(join(tmpdir(), 'openrouter-particle-kilo-'));
  try {
    await recordDataSharingConsent(other, ['kilo', 'reflection-beam']);
    const fetcher = transport(() => hello()), unapproved = new OpenRouterParticle({ directory: other, fetcher, loadGrant: async () => grant });
    expect(await unapproved.available()).toBe(false);
    expect((await failure(unapproved.complete(req(), AbortSignal.timeout(1000)))).code).toBe('refused');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await rm(other, { recursive: true, force: true }); }
});
it.each([
  ['a priced endpoint', { catalog: catalog([offer({ pricing: { prompt: '0.00000007', completion: '0.0000005' } })]) }],
  ['a priced extra field', { catalog: catalog([offer({ pricing: { prompt: '0', completion: '0', request: '0.01' } })]) }],
  ['a different endpoint tag', { catalog: catalog([offer({ tag: 'particle-ai/us/flex' })]) }],
  ['two endpoints with the tag', { catalog: catalog([offer(), offer()]) }],
  ['a small context', { catalog: catalog([offer({ context_length: 32768 })]) }],
  ['no tool support', { catalog: catalog([offer({ supported_parameters: ['max_tokens'] })]) }],
  ['a capped prompt', { catalog: catalog([offer({ max_prompt_tokens: 100000 })]) }],
  ['another model id', { catalog: { data: { id: 'particle-ai/particle-1', endpoints: [offer()] } } }],
  ['a management key', { key: keyInfo({ is_management_key: true }) }],
  ['an unreadable allowance', { key: { data: { is_management_key: false } } }]
])('refuses to send anything when the entitlement check finds %s', async (_name, patch) => {
  const fetcher = transport(() => hello(), patch);
  expect((await failure(source(fetcher).complete(req(), AbortSignal.timeout(1000)))).code).toBe('refused');
  expect(posts(fetcher)).toHaveLength(0);
});
it('holds until the UTC midnight reset when the daily free allowance is spent', async () => {
  const fetcher = transport(() => hello(), { key: keyInfo({}, { used: 50, remaining: 0 }) });
  const error = await failure(source(fetcher).complete(req(), AbortSignal.timeout(1000)));
  expect(error).toMatchObject({ code: 'quota', retryAfter: 20 * 3600 });
  expect(posts(fetcher)).toHaveLength(0);
  const policy = source(fetcher);
  await expect(policy.available()).rejects.toMatchObject({ code: 'quota' });
  expect(policy.quotaWindow()).toEqual({ startedAt: Date.parse('2026-11-25T00:00:00Z'), resetAt: Date.parse('2026-11-26T00:00:00Z') });
});
it('checks the entitlement once per minute and again after any failure', async () => {
  const fetcher = transport(() => hello()), adapter = source(fetcher);
  await adapter.complete(req(), AbortSignal.timeout(1000));
  await adapter.complete(req(), AbortSignal.timeout(1000));
  const reads = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/key')).length;
  expect(reads()).toBe(1);
  clock += OPENROUTER_PARTICLE_PREFLIGHT_MS;
  await adapter.complete(req(), AbortSignal.timeout(1000));
  expect(reads()).toBe(2);
  const failing = transport(() => new Response('', { status: 500 })), bad = source(failing);
  await failure(bad.complete(req(), AbortSignal.timeout(1000)));
  await failure(bad.complete(req(), AbortSignal.timeout(1000)));
  expect(failing.mock.calls.filter(([url]) => String(url).endsWith('/key'))).toHaveLength(2);
});

const limited = (status: number, body: unknown, headers: Record<string, string> = {}) => () => Response.json(body, { status, headers });
const capacity = { error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Particle AI', limit_source: 'upstream_provider_shared_pool', provider_error_code: 'fleet_capacity_exhausted', retry_after_seconds: 1 } } };
it('treats Particle capacity 429s as a cooldown of at least a minute and never as daily exhaustion', async () => {
  const error = await failure(source(transport(limited(429, capacity, { 'retry-after': '1' }))).complete(req(), AbortSignal.timeout(1000)));
  expect(error).toMatchObject({ code: 'quota', retryAfter: 60, diagnostics: { httpStatus: 429 } });
  // A longer provider hint always wins.
  expect((await failure(source(transport(limited(429, capacity, { 'retry-after': '300' }))).complete(req(), AbortSignal.timeout(1000)))).retryAfter).toBe(300);
});
it('honours OpenRouter platform reset headers, in epoch milliseconds, and the 402 and auth classes', async () => {
  const reset = String(now + 3 * 3600 * 1000);
  const platform = { error: { code: 429, message: 'rate limit' } };
  expect((await failure(source(transport(limited(429, platform, { 'x-ratelimit-reset': reset }))).complete(req(), AbortSignal.timeout(1000)))).retryAfter).toBe(3 * 3600);
  expect((await failure(source(transport(limited(429, platform))).complete(req(), AbortSignal.timeout(1000)))).retryAfter).toBeUndefined();
  expect((await failure(source(transport(limited(402, { error: {} }))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('quota');
  expect((await failure(source(transport(limited(401, { error: {} }))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('logged_out');
  expect((await failure(source(transport(limited(403, { error: {} }))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('refused');
  expect((await failure(source(transport(limited(404, { error: {} }))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('refused');
  expect((await failure(source(transport(limited(502, { error: {} }))).complete(req(), AbortSignal.timeout(1000)))).code).toBe('upstream');
});
it('never keeps upstream error text', async () => {
  const error = await failure(source(transport(limited(429, { error: { message: 'private prompt echo', metadata: { raw: 'private prompt echo' } } }))).complete(req(), AbortSignal.timeout(1000)));
  expect(JSON.stringify([error.message, error.diagnostics])).not.toContain('private prompt echo');
});
it('stops cleanly when the caller cancels', async () => {
  const controller = new AbortController();
  const fetcher = transport(() => { controller.abort(); return hello(); });
  await expect(source(fetcher).complete(req(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
