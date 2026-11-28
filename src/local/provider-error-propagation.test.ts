import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, BeatAPI, writeBeatAPIGrant } from './beatapi.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { parseStatus, renderDashboard } from './dashboard.js';
import { configureCodex } from './harnesses.js';
import { classifyHttpFailure } from './provider-error.js';
import { PromotionalApi } from './promotional-api.js';
import { bundledRegistry } from '../registry.js';
import { Sources, SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const request: ModelRequest = {
  model: 'grunt',
  messages: [{ role: 'user', content: 'hello' }],
  cwd: '/tmp',
  tools: [],
  stream: false
};
const make = (id: string, supportsFunctionTools = true): Source => ({
  id,
  supportsFunctionTools,
  available: vi.fn(async () => true),
  complete: vi.fn(async () => ({ text: `${id} ok` }))
});
const twoRouteRegistry = {
  ...bundledRegistry,
  adapters: ['opencode', 'kilo'].map(id => ({
    ...bundledRegistry.adapters.find(adapter => adapter.id === id)!,
    weight: 0.5
  }))
};

const dirs: string[] = [];
const pools: Sources[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('fails fast with HTTP 402 and x-should-retry: false when all routes are long-exhausted across all APIs', async () => {
  const now = 10_000;
  const a = make('opencode'), b = make('kilo');
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'daily limit', 2 * 3600));
  vi.mocked(b.complete).mockRejectedValue(new SourceError('quota', 'daily limit', 6 * 3600));
  const sources = new Sources([a, b], { registry: () => twoRouteRegistry, random: () => 0, now: () => now });
  pools.push(sources);
  const app = createLocalApp(sources);

  for (const [path, body] of [
    ['chat/completions', { model: 'grunt', stream: false, messages: request.messages }],
    ['chat/completions', { model: 'grunt', stream: true, messages: request.messages }],
    ['messages', { model: 'grunt', stream: false, messages: request.messages }],
    ['responses', { model: 'grunt', stream: false, input: 'hello' }]
  ] as const) {
    const response = await app.request(`http://127.0.0.1:8788/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(402);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('retry-after')).toBeNull();
    expect(response.headers.get('x-grunt-pool-state')).toBe('globally_exhausted');
    const json = await response.json();
    expect(json.error).toMatchObject({ type: 'pool_exhausted', code: 'globally_exhausted' });
    expect(json.error.message).toContain('Grunt pool globally exhausted');
    expect(json.error.message).toContain('2h');
    expect(json.error.message).toContain('usegrunt status');
  }
});

it('fails fast with HTTP 402 instead of retryable 429 when all routes are unconfigured', async () => {
  const a = make('opencode'), b = make('kilo');
  vi.mocked(a.available).mockResolvedValue(false);
  vi.mocked(b.available).mockResolvedValue(false);
  const sources = new Sources([a, b], { registry: () => twoRouteRegistry, random: () => 0 });
  pools.push(sources);
  const app = createLocalApp(sources);
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: request.messages })
  });
  expect(response.status).toBe(402);
  expect(response.headers.get('x-should-retry')).toBe('false');
  expect(response.headers.get('retry-after')).toBeNull();
  expect(response.headers.get('x-grunt-pool-state')).toBe('globally_exhausted');
  const json = await response.json();
  expect(json.error.message).toContain('2 unconfigured');
  expect(sources.status().poolState).toBe('globally_exhausted');
});

it('keeps HTTP 429 with Retry-After and transient_error state for short rate-limit waits (<= 60s)', async () => {
  const now = 10_000;
  const a = make('opencode'), b = make('kilo');
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'burst limit', 30));
  vi.mocked(b.complete).mockRejectedValue(new SourceError('quota', 'burst limit', 45));
  const sources = new Sources([a, b], { registry: () => twoRouteRegistry, random: () => 0, now: () => now });
  pools.push(sources);
  const app = createLocalApp(sources);
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: request.messages })
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('x-should-retry')).toBeNull();
  expect(response.headers.get('retry-after')).toBe('30');
  expect(response.headers.get('x-grunt-pool-state')).toBe('transient_error');
  expect(sources.status().poolState).toBe('transient_error');
});

it('bounds cold-pool admission probing so hanging probes do not spin forever', async () => {
  const ids = ['opencode', 'kilo', 'zro', 'livekit', 'darus', 'runcrate'];
  const adapters = ids.map(id => ({ ...bundledRegistry.adapters.find(a => a.id === id)!, weight: 1 }));
  const hanging = ids.map(id => ({
    ...make(id),
    available: vi.fn((signal?: AbortSignal) => new Promise<boolean>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }))
  }));
  const sources = new Sources(hanging, {
    registry: () => ({ ...bundledRegistry, adapters }),
    coldProbeBudgetMs: 40
  });
  pools.push(sources);
  const app = createLocalApp(sources);
  const started = Date.now();
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: request.messages })
  });
  expect(response.status).toBe(402);
  expect(Date.now() - started).toBeLessThan(1000);
});

it('classifies HTTP provider failures consistently and preserves BeatAPI 403 ban without triggering re-signup', async () => {
  expect(classifyHttpFailure({ source: 'test', status: 401 })).toMatchObject({ code: 'logged_out', failureCause: 'auth_invalid' });
  expect(classifyHttpFailure({ source: 'test', status: 402 })).toMatchObject({ code: 'quota', failureCause: 'exhausted' });
  expect(classifyHttpFailure({ source: 'test', status: 402, paymentAsRefusal: true })).toMatchObject({ code: 'refused', failureCause: 'banned' });
  expect(classifyHttpFailure({ source: 'test', status: 403 })).toMatchObject({ code: 'refused', failureCause: 'banned' });
  expect(classifyHttpFailure({ source: 'test', status: 429, retryAfter: 20 })).toMatchObject({ code: 'quota', failureCause: 'transient' });
  expect(classifyHttpFailure({ source: 'test', status: 429, retryAfter: 3600 })).toMatchObject({ code: 'quota', failureCause: 'exhausted' });
  expect(classifyHttpFailure({ source: 'test', status: 503 })).toMatchObject({ code: 'upstream', failureCause: 'transient' });

  const dir = await mkdtemp(join(tmpdir(), 'grunt-ban-cause-'));
  dirs.push(dir);
  await recordDataSharingConsent(dir, ['beatapi']);
  await writeBeatAPIGrant({
    version: 2,
    base_url: BEATAPI_ORIGIN,
    upstream_origin: BEATAPI_ORIGIN,
    token: 'synthetic-token',
    model: BEATAPI_MODEL,
    models: BEATAPI_MODELS,
    free_account_verified: true,
    credit_provenance: 'zero',
    baseline_balance: 0,
    lifetime_paid: 0,
    payment_method_present: false,
    auto_recharge: false,
    verified_at: new Date().toISOString()
  }, dir);
  const beatapi = new BeatAPI({
    directory: dir,
    fetcher: async () => new Response('banned', { status: 403 })
  });
  const expired = new PromotionalApi('fikra', { directory: dir, now: () => Date.parse('2026-12-01T00:00:00Z') });
  const sources = new Sources([beatapi, expired], { registry: () => bundledRegistry });
  pools.push(sources);

  expect(await sources.available(beatapi)).toBe(false);
  expect(await sources.available(expired)).toBe(false);

  const beatRow = sources.status().sources.find(s => s.id === 'beatapi')!;
  expect(beatRow).toMatchObject({ state: 'unavailable', errorCode: 'refused', failureCause: 'banned', httpStatus: 403 });
  expect(beatRow.detail).toContain('HTTP 403');
  expect(beatRow.detail).not.toContain('setup incomplete');
  expect(sources.needsSignup('beatapi')).toBe(false);

  const fikraRow = sources.status().sources.find(s => s.id === 'fikra')!;
  expect(fikraRow).toMatchObject({ failureCause: 'offer_ended' });
  expect(sources.needsSignup('fikra')).toBe(false);
});

it('tracks all six pool states (idle, working, switching, transient_error, provider_exhausted, globally_exhausted)', async () => {
  let now = 5_000_000;
  const a = make('opencode'), b = make('kilo');
  const sources = new Sources([a, b], { registry: () => twoRouteRegistry, random: () => 0, now: () => now });
  pools.push(sources);

  // 1. idle
  expect(sources.status().poolState).toBe('idle');

  // 2. working
  let finishA!: (value: Completion) => void;
  vi.mocked(a.complete).mockImplementationOnce(() => new Promise<Completion>(resolve => { finishA = resolve; }));
  const turn1 = sources.complete(request, AbortSignal.timeout(2000));
  await vi.waitFor(() => expect(a.complete).toHaveBeenCalledTimes(1));
  expect(sources.status().poolState).toBe('working');
  finishA({ text: 'ok' });
  await turn1;
  expect(sources.status().poolState).toBe('idle');
  // Ready route stays routable after 31s while probeFresh flips false.
  now += 31_000;
  expect(sources.status().sources.find(s => s.id === 'opencode')).toMatchObject({
    state: 'ready', routable: true, probeFresh: false, checkedAgoSeconds: 31
  });

  // 3. switching (failover from opencode -> kilo) + 4. provider_exhausted after settle
  let finishB!: (value: Completion) => void;
  vi.mocked(a.complete).mockRejectedValueOnce(new SourceError('quota', 'daily spent', 3600));
  vi.mocked(b.complete).mockImplementationOnce(() => new Promise<Completion>(resolve => { finishB = resolve; }));
  const turn2 = sources.complete({ ...request, userMessages: ['second'] }, AbortSignal.timeout(2000));
  await vi.waitFor(() => expect(b.complete).toHaveBeenCalledTimes(1));
  expect(sources.status().poolState).toBe('switching');
  expect(sources.status().pool).toMatchObject({ switchingFrom: 'opencode', switchingTo: 'kilo' });
  finishB({ text: 'kilo ok' });
  await turn2;
  expect(sources.status().poolState).toBe('provider_exhausted');
  expect(sources.needsSignup('opencode')).toBe(false);

  // 5. transient_error (second provider hits short 30s limit while first is limited for 1h -> earliest is 30s)
  vi.mocked(b.complete).mockRejectedValueOnce(new SourceError('quota', 'burst', 30));
  await expect(sources.complete({ ...request, userMessages: ['third'] }, AbortSignal.timeout(2000))).rejects.toThrow();
  expect(sources.status().poolState).toBe('transient_error');

  // 6. globally_exhausted (second provider hits long 2h limit too)
  now += 31_000;
  vi.mocked(b.complete).mockRejectedValueOnce(new SourceError('quota', 'daily', 7200));
  await expect(sources.complete({ ...request, userMessages: ['fourth'] }, AbortSignal.timeout(2000))).rejects.toThrow();
  expect(sources.status().poolState).toBe('globally_exhausted');
});

it('renders global exhaustion banner, parses poolState/failureCause safely, and disables Codex client retries', async () => {
  const now = Date.now();
  const raw = {
    version: 1 as const,
    updatedAt: now,
    activeRequests: 0,
    poolState: 'globally_exhausted' as const,
    pool: {
      state: 'globally_exhausted' as const,
      detail: 'All routes unavailable (1 quota-limited, 1 errored or barred).',
      earliestResetAt: now + 3600_000,
      exhaustedCount: 1,
      readyCount: 0,
      unconfiguredCount: 0,
      errorCount: 1
    },
    sources: [
      { id: 'zro', state: 'limited' as const, active: 0, retryAt: now + 3600_000, errorCode: 'quota' as const, failureCause: 'exhausted' as const, httpStatus: 402, routable: false, probeFresh: false },
      { id: 'beatapi', state: 'unavailable' as const, active: 0, errorCode: 'refused' as const, failureCause: 'banned' as const, httpStatus: 403, detail: 'provider refused or banned access (HTTP 403); check account status', routable: false, probeFresh: false }
    ]
  };
  const parsed = parseStatus(raw);
  expect(parsed.poolState).toBe('globally_exhausted');
  expect(parsed.sources[1]).toMatchObject({ failureCause: 'banned', httpStatus: 403, routable: false, probeFresh: false });
  const view = renderDashboard(parsed, { width: 80, now, selected: 1, details: true });
  expect(view).toContain('GLOBALLY EXHAUSTED');
  expect(view).toContain('next reset in 1h');
  expect(view).toContain('Cause: banned (HTTP 403)');

  const codexDir = await mkdtemp(join(tmpdir(), 'grunt-codex-retries-'));
  dirs.push(codexDir);
  vi.stubEnv('CODEX_HOME', codexDir);
  await configureCodex(19878);
  const profile = await readFile(join(codexDir, 'grunt.config.toml'), 'utf8');
  expect(profile).toContain('request_max_retries = 0');
});
