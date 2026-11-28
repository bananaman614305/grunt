import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { DiagnosticsStore } from './diagnostics.js';
import { parseStatus } from './dashboard.js';
import { observedQuota } from './quota-policy.js';
import { DelegatingSource } from './delegating-source.js';
import { Darus, DARUS_MODEL } from './darus.js';
import { MillionSeek, MILLIONSEEK_MODEL } from './millionseek.js';
import { FreePi, FREEPI_CLIENT_VERSION, FREEPI_MODEL } from './freepi.js';
import { Pollinations, POLLINATIONS_MODEL, POLLINATIONS_ORIGIN } from './pollinations.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { collectUiSnapshot } from './ui-data.js';
import { createUiApp, detectTailscaleIpv4, isHeadlessEnvironment, startUiServer, uiCommand, validateBindHost } from './ui-server.js';
import { renderStaticSnapshotHtml, UI_CLIENT_JS, UI_CSS } from './ui-assets.js';
import { encodeQrMatrix, renderTerminalQr } from './ui-qr.js';

const tempDirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close().catch(() => {})));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function mockDaemonFetcher(now: number, overrides: { status?: Record<string, unknown>; observe?: Record<string, unknown>; metrics?: Record<string, unknown> } = {}): typeof fetch {
  const statusPayload = overrides.status ?? {
    version: 1,
    updatedAt: now,
    activeRequests: 1,
    sources: [
      {
        id: 'darus',
        state: 'answering',
        model: 'darus/deepseek-v4.1-flash-1017-FREE',
        active: 1,
        routable: true,
        checkedAgoSeconds: 5,
        supportsFunctionTools: true,
        lastReplyMs: 1420,
        lastSuccessAt: now - 5000,
        quotaObserved: { unit: 'tokens', limit: 10000000, used: 3580000, remaining: 6420000, observedAt: now - 40000, source: 'provider_api' },
        detail: 'Request in progress'
      },
      {
        id: 'goedel',
        state: 'ready',
        model: 'deepseek-v4.1-flash',
        active: 0,
        routable: true,
        checkedAgoSeconds: 120,
        supportsFunctionTools: true,
        lastReplyMs: 1680,
        detail: 'A successful reply was observed'
      },
      {
        id: 'millionseek',
        state: 'limited',
        model: 'deepseek-v4.1-flash-free',
        active: 0,
        routable: false,
        checkedAgoSeconds: 20,
        retryAt: now + 3600000,
        errorCode: 'quota',
        quotaObserved: { unit: 'tokens', limit: 100000000, used: 100000000, remaining: 0, observedAt: now - 20000, source: 'provider_header' },
        detail: 'Free quota or rate limit reached'
      },
      {
        id: 'zro',
        state: 'unavailable',
        active: 0,
        routable: false,
        errorCode: 'logged_out',
        detail: 'sign-in required; run usegrunt setup'
      }
    ]
  };

  const observePayload = overrides.observe ?? {
    version: 1,
    observedAt: now,
    daemon: { version: '0.10.20', uptimeMs: 120000, readiness: 'ready', config: { host: '127.0.0.1', port: 8788 } },
    diagnostics: { historyAvailable: true, health: { enabled: true, available: true, queued: 0, droppedEvents: 0 }, losses: null },
    inFlight: [
      {
        id: 'req-live-1', kind: 'user', actor: 'client', caller: 'claude-code', endpoint: 'messages',
        model: 'grunt', selectedRoute: 'darus', startedAt: now - 2000, endedAt: null, durationMs: 2000,
        state: 'receiving_output', stateSince: now - 1000, stateDurationMs: 1000, queuePosition: 0,
        outcome: null, httpStatus: null, errorCode: null, errorText: null, promptBytes: 12000, responseBytes: 900, maxOutputTokens: 4096,
        tokens: { input: null, output: null, reasoning: null, outputExcludingReasoning: null },
        attempts: [{ id: 'att-1', provider: 'darus', account: 'vaulted', model: 'darus/deepseek-v4.1-flash-1017-FREE', startedAt: now - 2000, firstTokenAt: now - 1000, lastProgressAt: now - 100, endedAt: null, durationMs: null, outcome: null, providerFinishReason: null, finishReason: null, hadToolCalls: null, tokens: { input: null, output: null, reasoning: null, outputExcludingReasoning: null }, maxOutputTokens: 4096, requestedMaxOutputTokens: 4096, responseBytes: null, errorCode: null, errorText: null, failureReason: null, httpStatus: null, retryAfterSeconds: null, replaySafe: null, dispatches: [], transport: [] }],
        routeDecisions: []
      }
    ],
    completed: [],
    routes: []
  };

  const hour = Math.floor(now / 3600000) * 3600000;
  const metricsPayload = overrides.metrics ?? {
    version: 1,
    streamId: '00000000-0000-4000-8000-000000000001',
    window: { since: now - 86400000, until: now, alignedSince: hour - 86400000, alignedUntil: hour + 3600000 },
    coverage: { startedAt: hour - 86400000, retainedFrom: hour - 86400000, deduplicationFloor: 0, droppedLateEvents: 0, overflowEvents: 0, available: true, droppedEvents: 0, persistentDroppedEvents: 0 },
    ingestionHealth: { enabled: true, available: true, queued: 0, droppedEvents: 0 },
    histogram: { upperBoundsMs: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 3600000], overflowBucket: true, cumulative: false },
    buckets: [
      {
        hour,
        dimensions: { type: 'request.finish', kind: 'user', outcome: 'passed', source: 'darus' },
        count: 5, durationCount: 5, durationSumMs: 7000, durationMaxMs: 2000,
        durationHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0],
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0
      },
      {
        hour,
        dimensions: { type: 'attempt.finish', kind: 'user', outcome: 'passed', source: 'goedel' },
        count: 4, durationCount: 4, durationSumMs: 6400, durationMaxMs: 1800,
        durationHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0],
        inputTokens: 182000, outputTokens: 41000, reasoningTokens: 11000, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0
      }
    ],
    limits: { retentionDays: 30, maxRows: 50000, maxSeriesPerHour: 256, maxSeenEventIds: 200000 }
  };

  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/v1/status')) return Response.json(statusPayload);
    if (url.includes('/v1/observe')) return Response.json(observePayload);
    if (url.includes('/v1/diagnostics/metrics')) return Response.json(metricsPayload);
    if (url.includes('/v1/diagnostics/summary')) return Response.json({ streamId: null, window: { since: now - 86400000, until: now }, requests: { total: 5, succeeded: 5, failed: 0, cancelled: 0 }, attempts: { total: 4, succeeded: 4, failed: 0, cancelled: 0, inputTokens: 182000, outputTokens: 41000, reasoningTokens: 11000, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0 }, providers: [], health: { enabled: true, available: true, queued: 0, droppedEvents: 0 } });
    return new Response('Not found', { status: 404 });
  };
}

describe('daemon reasoningTokens and quotaObserved additions', () => {
  it('aggregates reasoningTokens and unknownReasoning in hourly metrics and summary, and upgrades legacy SQLite rows', async () => {
    const dir = await makeTempDir('grunt-rsn-');
    const start = 1795363200000;
    const hour = Math.floor(start / 3600000) * 3600000;
    const store = await DiagnosticsStore.open({ directory: dir, now: () => start + 10000 });
    closers.push(() => store.close());

    // Simulate a pre-upgrade SQLite bucket row (2 historical attempts) missing reasoningTokens and unknownReasoning keys.
    const rawDb = createClient({ url: pathToFileURL(join(dir, 'diagnostics.db')).href });
    const legacyDims = { type: 'attempt.finish', kind: 'user', source: 'darus', outcome: 'passed' };
    const legacyBucket = {
      hour,
      dimensions: legacyDims,
      count: 2,
      durationCount: 0,
      durationSumMs: 0,
      durationMaxMs: 0,
      durationHistogram: Array.from({ length: 18 }, () => 0),
      inputTokens: 100,
      outputTokens: 40,
      unknownInput: 0,
      unknownOutput: 0
    };
    await rawDb.execute({
      sql: 'INSERT INTO diagnostic_metric_hours(hour,series,data) VALUES(?,?,?)',
      args: [hour, JSON.stringify(legacyDims), JSON.stringify(legacyBucket)]
    });
    rawDb.close();

    // Reading legacy attempt bucket preserves its historical count as unknownReasoning.
    const before = await store.metrics({ since: hour, until: start + 10000 });
    const legacyRead = before.buckets.find(b => b.dimensions.type === 'attempt.finish')!;
    expect(legacyRead.reasoningTokens).toBe(0);
    expect(legacyRead.unknownReasoning).toBe(2);

    // Recording new events in the same hour merges cleanly onto the legacy bucket (2 legacy unknown + 1 new unknown = 3).
    store.record({ version: 1, id: randomUUID(), requestId: randomUUID(), at: start + 1000, type: 'attempt.finish', kind: 'user', source: 'darus', outcome: 'passed', inputTokens: 500, outputTokens: 120, reasoningTokens: 45 });
    store.record({ version: 1, id: randomUUID(), requestId: randomUUID(), at: start + 2000, type: 'attempt.finish', kind: 'user', source: 'darus', outcome: 'passed', inputTokens: 300, outputTokens: 80 });
    await store.flush();

    const metrics = await store.metrics({ since: hour, until: start + 10000 });
    const bucket = metrics.buckets.find(b => b.dimensions.type === 'attempt.finish')!;
    expect(bucket.count).toBe(4);
    expect(bucket.inputTokens).toBe(900);
    expect(bucket.outputTokens).toBe(240);
    expect(bucket.reasoningTokens).toBe(45);
    expect(bucket.unknownReasoning).toBe(3);
    expect(JSON.stringify(metrics)).not.toMatch(/finishReason|hadToolCalls/);

    const summary = await store.summary({ since: start });
    expect(summary.attempts.reasoningTokens).toBe(45);
    expect(summary.attempts.unknownReasoning).toBe(1);
    expect(summary.providers[0]?.reasoningTokens).toBe(45);
  });

  it('validates observedQuota strictly and preserves it through parseStatus', () => {
    const valid = observedQuota({ unit: 'tokens', remaining: 500, limit: 1000, used: 500, observedAt: 1795363200000, source: 'provider_header' });
    expect(valid).toEqual({ unit: 'tokens', remaining: 500, limit: 1000, used: 500, observedAt: 1795363200000, source: 'provider_header' });
    expect(observedQuota({ unit: 'bad', remaining: 10, observedAt: 1795363200000, source: 'provider_api' })).toBeUndefined();
    expect(observedQuota({ unit: 'tokens', remaining: -1, observedAt: 1795363200000, source: 'provider_api' })).toBeUndefined();

    const snap = parseStatus({
      version: 1,
      updatedAt: 1795363200000,
      activeRequests: 0,
      sources: [
        { id: 'darus', state: 'ready', active: 0, quotaObserved: valid },
        { id: 'zro', state: 'ready', active: 0, quotaObserved: { unit: 'bogus', remaining: 1 } }
      ]
    });
    expect(snap.sources[0]?.quotaObserved).toEqual(valid);
    expect(snap.sources[1]?.quotaObserved).toBeUndefined();
  });

  it('surfaces already-fetched quotaObserved from Darus, MillionSeek, FreePi, and Pollinations via DelegatingSource', async () => {
    const dir = await makeTempDir('grunt-obs-quota-');
    const now = Date.UTC(2026, 10, 27, 12, 0, 0);
    const day = '2026-11-27';
    const nextReset = Date.UTC(2026, 10, 28, 0, 0, 0);
    await recordDataSharingConsent(dir, ['darus', 'millionseek', 'freepi', 'pollinations']);

    const darus = new Darus({
      directory: dir,
      now: () => now,
      loadGrant: async () => ({ base_url: 'https://gateway.darusalfatah.id', token: 'darus-test-token' }),
      fetcher: async (input) => {
        const u = String(input);
        if (u.endsWith('/v1/models')) return Response.json({ data: [{ id: DARUS_MODEL, free: true, owned_by: 'Darus Gateway' }] });
        if (u.endsWith('/v1/tpd')) return Response.json({ status: { eligible: true, protectBalance: true, day, tier: { key: 'FREE', tpd: 10000000, minBalance: 0 }, allowance: 10000000, multiplier: 1, balance: 0, used: 2500000, remaining: 7500000 } });
        return new Response('nope', { status: 404 });
      }
    });
    expect(await darus.available()).toBe(true);
    expect(new DelegatingSource(darus).quotaObserved()).toEqual({ unit: 'tokens', limit: 10000000, used: 2500000, remaining: 7500000, observedAt: now, source: 'provider_api' });

    const ms = new MillionSeek({
      directory: dir,
      now: () => now,
      loadGrant: async () => ({ base_url: 'https://100milionseek.top', token: 'ms-test-token' }),
      fetcher: async (input) => {
        const u = String(input);
        if (u.endsWith('/api/status')) return Response.json({ updated_at: new Date(now).toISOString(), base_daily_tokens: 100000000, model: { id: MILLIONSEEK_MODEL, context_length: 198000, max_output_tokens: 65536, tools: true }, allowance: { reset: '00:00 UTC', session_limit: 5, daily_tokens: 100000000 } });
        if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: MILLIONSEEK_MODEL, owned_by: '100milionseek', context_length: 198000, max_output_tokens: 65536, quota_multiplier: 1 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-quota-limit': '100000000', 'x-quota-used': '40000000', 'x-quota-remaining': '60000000', 'x-quota-reset': new Date(nextReset).toISOString() }
        });
        return new Response('nope', { status: 404 });
      }
    });
    expect(await ms.available()).toBe(true);
    expect(ms.quotaObserved()).toEqual({ unit: 'tokens', limit: 100000000, used: 40000000, remaining: 60000000, observedAt: now, source: 'provider_header' });

    const freepi = new FreePi({
      directory: dir,
      now: () => now,
      loadToken: async () => 'freepi-test-token',
      fetcher: async (input) => {
        const u = String(input);
        if (u.endsWith('/client-version')) return Response.json({ latest: FREEPI_CLIENT_VERSION, min: '0.6.21', models: [{ id: FREEPI_MODEL, free: true, stats_id: 'deepseek/deepseek-v4.1-flash-1017' }] });
        if (u.endsWith('/me/stats')) return Response.json({ guest: false, lane: 'standard', refill_at: new Date(nextReset).toISOString(), credit_usd: 0, credit_credits: 0, bonus_credits: 0, bonus_wallet_credits: 0, premium_credits: 0, premium_bought_credits: 0, premium_gifted_credits: 0, allowance_credits: 500, remaining_credits_today: 420, remaining_usd_today: 0.42 });
        return new Response('nope', { status: 404 });
      }
    });
    expect(await freepi.available()).toBe(true);
    expect(freepi.quotaObserved()).toEqual({ unit: 'credits', limit: 500, used: 80, remaining: 420, observedAt: now, source: 'provider_api' });
    expect(freepi.quotaWindow()).toEqual({ startedAt: nextReset - 86400000, resetAt: nextReset });

    const pol = new Pollinations({
      directory: dir,
      loadGrant: async () => ({ version: 1, base_url: POLLINATIONS_ORIGIN, token: 'pk_test_1234567890abcdef', upstream_origin: POLLINATIONS_ORIGIN, model: POLLINATIONS_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, key_zero_budget_verified: true, quest_pollen_only: true }),
      fetcher: async (input) => {
        const u = String(input);
        if (u.endsWith('/account/key')) return Response.json({ valid: true, type: 'secret', pollenBudget: 0, questPollenOnly: true, expiresAt: null, permissions: { models: [POLLINATIONS_MODEL], account: ['usage'] } });
        if (u.endsWith('/account/balance')) return Response.json({ balance: 0, accountBalance: { paid: 0, tier: 0.75 } });
        if (u.includes('/v1/models/')) return Response.json({ id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII', category: 'text', community: true, paid_only: false, pricing: { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] });
        return new Response('nope', { status: 404 });
      }
    });
    expect(await pol.available()).toBe(true);
    expect(pol.quotaObserved()).toMatchObject({ unit: 'credits', remaining: 0.75, source: 'provider_api' });
    await Promise.all([darus.close?.(), ms.close?.(), freepi.close?.(), pol.close()]);
  });
});

describe('UI snapshot aggregation and 3-tier remaining usage', () => {
  it('distinguishes verified, policy-estimated, and unknown remaining usage and aggregates reasoning tokens', async () => {
    const now = 1795830000000;
    const snap = await collectUiSnapshot({ daemonPort: 8788, window: '24h', fetcher: mockDaemonFetcher(now), now: () => now });
    expect(snap.daemonReachable).toBe(true);
    expect(snap.poolState).toBe('provider_exhausted');
    expect(snap.totals.input).toBe(182000);
    expect(snap.totals.output).toBe(41000);
    expect(snap.totals.reasoning).toBe(11000);
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]?.reasoning).toBe(11000);

    const darus = snap.routes.find(r => r.id === 'darus')!;
    expect(darus.remaining.tier).toBe('verified');
    expect(darus.remaining.remaining).toBe(6420000);

    const goedel = snap.routes.find(r => r.id === 'goedel')!;
    expect(goedel.remaining.tier).toBe('estimate');
    expect(goedel.remaining.limit).toBe(600000);
    expect(goedel.remaining.remaining).toBe(418000);

    const zro = snap.routes.find(r => r.id === 'zro')!;
    expect(zro.remaining.tier).toBe('unknown');
    expect(zro.actionCommand).toBe('usegrunt add zro');

    expect(snap.earliestResetRoute).toBe('MillionSeek');
    expect(snap.earliestResetAt).toBe(now + 3600000);
  });

  it('keeps daily policy estimates independent of display window and falls back to unknown when coverage is incomplete', async () => {
    // 10:30 UTC so UTC midnight is 10.5 hours earlier than now (wider than 1h display window).
    const now = Date.UTC(2026, 10, 27, 10, 30, 0);
    const utcDayStart = Date.UTC(2026, 10, 27, 0, 0, 0);
    const earlierHour = Date.UTC(2026, 10, 27, 4, 0, 0);
    const recentHour = Date.UTC(2026, 10, 27, 10, 0, 0);

    const allBuckets = [
      {
        hour: earlierHour,
        dimensions: { type: 'attempt.finish', kind: 'user', outcome: 'passed', source: 'goedel' },
        count: 2, durationCount: 2, durationSumMs: 2000, durationMaxMs: 1100,
        durationHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0],
        inputTokens: 200000, outputTokens: 30000, reasoningTokens: 8000, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0
      },
      {
        hour: recentHour,
        dimensions: { type: 'attempt.finish', kind: 'user', outcome: 'passed', source: 'goedel' },
        count: 1, durationCount: 1, durationSumMs: 1000, durationMaxMs: 1000,
        durationHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
        inputTokens: 50000, outputTokens: 12000, reasoningTokens: 4000, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0
      }
    ];

    const windowedFetcher = (coveragePatch: Record<string, unknown> = {}): typeof fetch => async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/status') {
        return Response.json({
          version: 1, updatedAt: now, activeRequests: 0,
          sources: [{ id: 'goedel', state: 'ready', active: 0, routable: true }]
        });
      }
      if (url.pathname === '/v1/observe') {
        return Response.json({
          version: 1, observedAt: now,
          daemon: { version: '0.10.20', uptimeMs: 1000, readiness: 'ready', config: { host: '127.0.0.1', port: 8788 } },
          diagnostics: { historyAvailable: true, health: { enabled: true, available: true, queued: 0, droppedEvents: 0 }, losses: null },
          inFlight: [], completed: [], routes: []
        });
      }
      if (url.pathname === '/v1/diagnostics/metrics') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const alignedSince = Math.floor(since / 3600000) * 3600000;
        return Response.json({
          version: 1, streamId: '00000000-0000-4000-8000-000000000002',
          window: { since, until: now, alignedSince, alignedUntil: recentHour + 3600000 },
          coverage: {
            startedAt: utcDayStart - 3600000,
            retainedFrom: utcDayStart - 3600000,
            deduplicationFloor: 0,
            droppedLateEvents: 0,
            overflowEvents: 0,
            available: true,
            droppedEvents: 0,
            persistentDroppedEvents: 0,
            ...coveragePatch
          },
          ingestionHealth: { enabled: true, available: true, queued: 0, droppedEvents: 0 },
          histogram: { upperBoundsMs: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 3600000], overflowBucket: true, cumulative: false },
          buckets: allBuckets.filter(b => b.hour >= alignedSince),
          limits: { retentionDays: 30, maxRows: 50000, maxSeriesPerHour: 256, maxSeenEventIds: 200000 }
        });
      }
      if (url.pathname === '/v1/diagnostics/summary') {
        return Response.json({
          streamId: null, window: { since: utcDayStart, until: now },
          requests: { total: 0, succeeded: 0, failed: 0, cancelled: 0 },
          attempts: { total: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0 },
          providers: [], health: { enabled: true, available: true, queued: 0, droppedEvents: 0 }
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const snap1h = await collectUiSnapshot({ daemonPort: 8788, window: '1h', fetcher: windowedFetcher(), now: () => now });
    const snap24h = await collectUiSnapshot({ daemonPort: 8788, window: '24h', fetcher: windowedFetcher(), now: () => now });

    // Display chart/totals follow the selected window (1h shows only recentHour; 24h shows both).
    expect(snap1h.totals.input).toBe(50000);
    expect(snap1h.history).toHaveLength(1);
    expect(snap1h.history[0]?.reasoning).toBe(4000);
    expect(snap24h.totals.input).toBe(250000);
    expect(snap24h.history).toHaveLength(2);
    expect(snap24h.history.map(h => h.reasoning)).toEqual([8000, 4000]);

    // Policy remaining estimate stays identical across 1h and 24h display windows (600,000 - 250,000 = 350,000).
    expect(snap1h.routes[0]?.remaining).toMatchObject({ tier: 'estimate', used: 250000, remaining: 350000, limit: 600000 });
    expect(snap24h.routes[0]?.remaining).toMatchObject({ tier: 'estimate', used: 250000, remaining: 350000, limit: 600000 });

    // Quiet period after window open: diagnostics started before UTC midnight, first event recorded at 04:00 UTC (retainedFrom > utcDayStart).
    const snapQuietMorning = await collectUiSnapshot({
      daemonPort: 8788, window: '1h',
      fetcher: windowedFetcher({ retainedFrom: earlierHour }),
      now: () => now
    });
    expect(snapQuietMorning.routes[0]?.remaining).toMatchObject({ tier: 'estimate', used: 250000, remaining: 350000, limit: 600000 });

    // Incomplete coverage (started after UTC midnight, pruned deduplication floor, or dropped events) falls back to unknown.
    const snapLateStart = await collectUiSnapshot({
      daemonPort: 8788, window: '24h',
      fetcher: windowedFetcher({ startedAt: utcDayStart + 3600000 }),
      now: () => now
    });
    expect(snapLateStart.routes[0]?.remaining.tier).toBe('unknown');

    const snapPrunedFloor = await collectUiSnapshot({
      daemonPort: 8788, window: '24h',
      fetcher: windowedFetcher({ deduplicationFloor: utcDayStart + 3600000 }),
      now: () => now
    });
    expect(snapPrunedFloor.routes[0]?.remaining.tier).toBe('unknown');

    const snapDropped = await collectUiSnapshot({
      daemonPort: 8788, window: '24h',
      fetcher: windowedFetcher({ droppedEvents: 2 }),
      now: () => now
    });
    expect(snapDropped.routes[0]?.remaining.tier).toBe('unknown');
  });

  it('reports daemonReachable false without throwing when daemon is offline', async () => {
    const snap = await collectUiSnapshot({
      daemonPort: 8788,
      window: '24h',
      fetcher: async () => { throw new Error('ECONNREFUSED'); }
    });
    expect(snap.daemonReachable).toBe(false);
    expect(snap.routes).toEqual([]);
  });
});

describe('UI server security boundaries, DESIGN.md assets, and headless modes', () => {
  it('enforces Host, method, Origin, Sec-Fetch-Site, and strict CSP with no inline scripts', async () => {
    const now = 1795830000000;
    const { app, closeHubs } = createUiApp({ daemonPort: 8788, uiPort: () => 8789, fetcher: mockDaemonFetcher(now), now: () => now });
    closers.push(async () => closeHubs());

    const ok = await app.request('http://127.0.0.1:8789/', { headers: { Host: '127.0.0.1:8789' } });
    expect(ok.status).toBe(200);
    const csp = ok.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const html = await ok.text();
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/i);

    // DESIGN.md tokens & touch targets & XSS-safe client JS assertions.
    expect(UI_CSS).toContain('#0d121c');
    expect(UI_CSS).toContain('#f2b531');
    expect(UI_CSS).toContain('--touch: 44px');
    expect(UI_CSS).toContain('prefers-reduced-motion');
    expect(UI_CLIENT_JS).not.toContain('innerHTML');
    expect(UI_CLIENT_JS).not.toContain('style:');
    // Reasoning tokens are a subset of outputTokens and must never be added on top of output.
    expect(UI_CLIENT_JS).not.toContain('+ t.reasoning');
    expect(UI_CLIENT_JS).not.toContain('+ b.reasoning');
    expect(UI_CLIENT_JS).not.toContain('+ cur.reasoning');
    expect(UI_CLIENT_JS).not.toContain('+ r.tokens.reasoning');
    expect(UI_CLIENT_JS).not.toContain('+ trsn');

    // Host rebinding rejected.
    const badHost = await app.request('http://evil.example:8789/', { headers: { Host: 'evil.example:8789' } });
    expect(badHost.status).toBe(403);

    // Write methods rejected.
    const post = await app.request('http://127.0.0.1:8789/api/snapshot', { method: 'POST', headers: { Host: '127.0.0.1:8789' } });
    expect(post.status).toBe(405);

    // Cross-site and foreign origin rejected.
    const crossSite = await app.request('http://127.0.0.1:8789/api/snapshot', { headers: { Host: '127.0.0.1:8789', 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    const badOrigin = await app.request('http://127.0.0.1:8789/api/snapshot', { headers: { Host: '127.0.0.1:8789', Origin: 'https://evil.example' } });
    expect(badOrigin.status).toBe(403);

    // Export JSON returns attachment.
    const exp = await app.request('http://127.0.0.1:8789/api/export?window=24h', { headers: { Host: '127.0.0.1:8789' } });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toContain('attachment; filename="grunt-status-');
  });

  it('protects non-loopback --bind sessions with a 303 HttpOnly SameSite=Strict cookie exchange', async () => {
    const now = 1795830000000;
    const token = 'test-session-token-12345';
    const { app, closeHubs } = createUiApp({
      daemonPort: 8788,
      uiPort: () => 8789,
      bindHost: '100.84.12.9',
      sessionToken: token,
      fetcher: mockDaemonFetcher(now),
      now: () => now
    });
    closers.push(async () => closeHubs());

    const unauthPage = await app.request('http://100.84.12.9:8789/', { headers: { Host: '100.84.12.9:8789' } });
    expect(unauthPage.status).toBe(401);
    const unauthApi = await app.request('http://100.84.12.9:8789/api/snapshot', { headers: { Host: '100.84.12.9:8789' } });
    expect(unauthApi.status).toBe(401);

    const exchange = await app.request(`http://100.84.12.9:8789/?t=${token}`, { headers: { Host: '100.84.12.9:8789' } });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get('location')).toBe('/');
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`grunt_ui_session=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const authed = await app.request('http://100.84.12.9:8789/api/snapshot', {
      headers: { Host: '100.84.12.9:8789', Cookie: `grunt_ui_session=${token}` }
    });
    expect(authed.status).toBe(200);
  });

  it('validates bind addresses, detects Tailscale and headless environments, and renders QR matrices', () => {
    expect(validateBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(validateBindHost('192.168.1.50')).toBe('192.168.1.50');
    expect(validateBindHost('100.84.12.9')).toBe('100.84.12.9');
    expect(() => validateBindHost('0.0.0.0')).toThrow(/wildcard/i);
    expect(() => validateBindHost('::')).toThrow(/wildcard/i);
    expect(() => validateBindHost('8.8.8.8')).toThrow(/non-private/i);

    expect(detectTailscaleIpv4({
      tailscale0: [{ address: '100.84.12.9', netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '100.84.12.9/32' }]
    })).toBe('100.84.12.9');
    expect(detectTailscaleIpv4({})).toBeUndefined();

    expect(isHeadlessEnvironment({ SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22' }, 'darwin')).toBe(true);
    expect(isHeadlessEnvironment({}, 'linux')).toBe(true);
    expect(isHeadlessEnvironment({ DISPLAY: ':0' }, 'linux')).toBe(false);

    const matrix = encodeQrMatrix('http://100.84.12.9:8789/?t=abc123');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.length).toBe(matrix[0]!.length);
    // Top-left 7x7 finder outer border is dark.
    for (let i = 0; i < 7; i++) {
      expect(matrix[0]![i]).toBe(true);
      expect(matrix[6]![i]).toBe(true);
    }
    const qrText = renderTerminalQr('http://100.84.12.9:8789/?t=abc123');
    expect(qrText.split('\n').length).toBeGreaterThan(10);
  });

  it('streams SSE snapshots and falls back to an ephemeral port when the default port is busy', async () => {
    const now = 1795830000000;
    const first = await startUiServer({ daemonPort: 8788, uiPort: 0, explicitUiPort: false, fetcher: mockDaemonFetcher(now), now: () => now });
    closers.push(() => first.close());

    // Simulate collision on first.port without explicitUiPort -> falls back to another ephemeral port.
    const second = await startUiServer({ daemonPort: 8788, uiPort: first.port, explicitUiPort: false, fetcher: mockDaemonFetcher(now), now: () => now });
    closers.push(() => second.close());
    expect(second.port).not.toBe(first.port);

    // Read first SSE event from live server.
    const ctrl = new AbortController();
    const res = await fetch(`${first.url}/api/stream?window=24h`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let chunkText = '';
    while (!chunkText.includes('event: snapshot')) {
      const part = await reader.read();
      if (part.done) break;
      chunkText += Buffer.from(part.value).toString('utf8');
    }
    ctrl.abort();
    await reader.cancel().catch(() => {});
    expect(chunkText).toContain('event: snapshot');
    expect(chunkText).toContain('"darus"');
  });

  it('writes XSS-safe script-free static HTML via --snapshot and prints SSH hint on headless uiCommand', async () => {
    const dir = await makeTempDir('grunt-snap-');
    const outPath = join(dir, 'status.html');
    const now = 1795830000000;
    const lines: string[] = [];

    const xssFetcher = mockDaemonFetcher(now, {
      status: {
        version: 1,
        updatedAt: now,
        activeRequests: 0,
        sources: [{ id: 'darus', state: 'error', active: 0, detail: '<script>alert(1)</script>' }]
      }
    });

    await uiCommand(['--port', '8788', '--snapshot', outPath], { fetcher: xssFetcher, now: () => now, output: l => lines.push(l) });
    const html = await readFile(outPath, 'utf8');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(lines[0]).toContain('Wrote static Grunt status snapshot');

    // Headless uiCommand prints SSH port-forward instruction and never calls open().
    const openSpy = vi.fn();
    const ac = new AbortController();
    const headlessLines: string[] = [];
    const run = uiCommand(['--port', '8788', '--ui-port', '0'], {
      env: { SSH_TTY: '/dev/pts/0' },
      platform: 'linux',
      fetcher: mockDaemonFetcher(now),
      output: l => {
        headlessLines.push(l);
        if (l.includes('Press Ctrl-C')) ac.abort();
      },
      open: openSpy,
      signal: ac.signal
    });
    await run;
    expect(openSpy).not.toHaveBeenCalled();
    expect(headlessLines.join('\n')).toContain('ssh -N -L');

    // Verify renderStaticSnapshotHtml directly contains zero scripts and does not double-count reasoning tokens.
    const snap = await collectUiSnapshot({ daemonPort: 8788, window: '24h', fetcher: mockDaemonFetcher(now), now: () => now });
    const staticHtml = renderStaticSnapshotHtml(snap);
    expect(staticHtml).not.toContain('<script');
    // 182,000 input + 41,000 output = 223K (NOT 234K with 11K reasoning added twice).
    expect(staticHtml).toContain('223K');
    expect(staticHtml).not.toContain('234K');
    expect(staticHtml).toContain('incl. 11.0K rsn');
  });
});
