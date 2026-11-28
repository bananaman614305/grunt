import type { DiagnosticMetrics, DiagnosticSummary } from './diagnostics.js';
import type { Observation } from './observe.js';
import { OBSERVATION_PATH } from './observe.js';
import { DIAGNOSTIC_LATENCY_BOUNDS_MS, DIAGNOSTIC_METRIC_HOUR_MS } from './diagnostic-metrics.js';
import { observedQuota, providerQuotaPolicy, scheduledQuotaRefill, sellerQuota } from './quota-policy.js';
import type { ObservedQuota } from './quota-policy.js';
import type { PoolSnapshot, SourceSnapshot, SourceState } from './source-status.js';
import { parseStatus } from './dashboard.js';

export type UiWindow = '1h' | '24h' | '7d' | '30d';
export type UiPoolState = 'idle' | 'working' | 'switching' | 'transient_error' | 'provider_exhausted' | 'globally_exhausted';

export const UI_WINDOWS: Record<UiWindow, number> = {
  '1h': 3600000,
  '24h': 24 * 3600000,
  '7d': 7 * 24 * 3600000,
  '30d': 30 * 24 * 3600000
};

export function parseUiWindow(raw: string | undefined): UiWindow {
  if (raw === '1h' || raw === '24h' || raw === '7d' || raw === '30d') return raw;
  return '24h';
}

export interface UiTokenCounts {
  input: number;
  output: number;
  reasoning: number;
  unknownInput: number;
  unknownOutput: number;
  unknownReasoning: number;
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface UiRemainingUsage {
  tier: 'verified' | 'estimate' | 'unknown';
  unit?: 'tokens' | 'credits' | 'requests' | 'usd' | 'PT';
  remaining?: number;
  limit?: number;
  used?: number;
  observedAt?: number;
  source?: 'provider_header' | 'provider_api' | 'local_policy';
  period?: 'minute' | 'hour' | 'day' | 'month' | 'window';
  scope?: string;
  note: string;
}

export interface UiRouteView {
  id: string;
  name: string;
  state: SourceState;
  model: string | null;
  active: number;
  routable: boolean;
  probeFresh: boolean;
  checkedAgoSeconds: number | null;
  supportsFunctionTools: boolean;
  lastReplyMs: number | null;
  lastSuccessAt: number | null;
  errorCode: string | null;
  detail: string;
  retired: boolean;
  trialInProgress: boolean;
  retryAt: number | null;
  comesBackAt: number | null;
  comesBackKind: 'cooldown' | 'quota_window' | 'scheduled_refill' | 'manual' | 'ready' | 'policy' | 'disabled';
  resetCadence: string;
  actionCommand: string | null;
  remaining: UiRemainingUsage;
  tokens: UiTokenCounts;
  maintenance: SourceSnapshot['maintenance'] | null;
  policyDetail: string | null;
}

export interface UiTimeBucket {
  hour: number;
  input: number;
  output: number;
  reasoning: number;
  attempts: number;
}

export interface UiRequestAttempt {
  id: string;
  provider: string | null;
  model: string | null;
  account: string | null;
  outcome: string | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorText: string | null;
  tokens: { input: number | null; output: number | null; reasoning: number | null };
}

export interface UiRequestView {
  id: string;
  live: boolean;
  caller: string | null;
  endpoint: string | null;
  state: string | null;
  outcome: string | null;
  selectedRoute: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  promptBytes: number | null;
  responseBytes: number | null;
  queuePosition: number | null;
  errorText: string | null;
  tokens: { input: number | null; output: number | null; reasoning: number | null };
  attempts: UiRequestAttempt[];
}

export interface UiSnapshot {
  version: 1;
  observedAt: number;
  window: UiWindow;
  daemonPort: number;
  daemonReachable: boolean;
  daemonError: string | null;
  daemonVersion: string | null;
  daemonUptimeMs: number | null;
  daemonReadiness: string | null;
  poolState: UiPoolState;
  poolReason: string;
  activeRequests: number;
  routableCount: number;
  limitedCount: number;
  earliestResetAt: number | null;
  earliestResetRoute: string | null;
  totals: UiTokenCounts & { requests: number; requestsPassed: number; requestsFailed: number; requestsCancelled: number; failovers: number; medianLatencyMs: number | null };
  metricsAvailable: boolean;
  history: UiTimeBucket[];
  routes: UiRouteView[];
  inFlight: UiRequestView[];
  completed: UiRequestView[];
}

const ROUTE_NAMES: Readonly<Record<string, string>> = {
  opencode: 'OpenCode',
  kilo: 'Kilo',
  zro: 'Zro',
  tokenharbor: 'TokenHarbor',
  runcrate: 'Runcrate',
  'mistral-vibe': 'Mistral Vibe',
  livekit: 'LiveKit',
  pollinations: 'Pollinations',
  beatapi: 'BeatAPI',
  perch: 'Perch',
  nous: 'Nous',
  kenari: 'Kenari',
  'aperture-ai': 'Aperture AI',
  darus: 'Darus',
  fikra: 'Fikra',
  openference: 'Openference',
  crowllm: 'CrowLLM',
  goedel: 'Goedel',
  millionseek: 'MillionSeek',
  ifm: 'IFM',
  numes: 'Numes',
  freepi: 'Free-Pi',
  'antseed-vikey': 'Antseed Vikey',
  'reflection-beam': 'Reflection Beam',
  nvidia: 'NVIDIA',
  freebuff: 'Freebuff',
  apinex: 'APInex',
  codex: 'Codex'
};

function displayName(id: string): string {
  return ROUTE_NAMES[id] ?? id.replace(/(^|-)([a-z])/g, (_, sep: string, ch: string) => `${sep ? ' ' : ''}${ch.toUpperCase()}`);
}

const emptyTokens = (): UiTokenCounts => ({
  input: 0, output: 0, reasoning: 0,
  unknownInput: 0, unknownOutput: 0, unknownReasoning: 0,
  attempts: 0, succeeded: 0, failed: 0, cancelled: 0
});

const REFILL_LABELS: Record<string, string> = {
  'utc-daily': 'UTC daily (00:00 UTC)',
  'utc-monthly': 'UTC monthly (1st)',
  daily: 'Daily (provider clock)',
  monday: 'Weekly (Mondays)',
  monthly: 'Monthly (1st)',
  rolling: 'Rolling window',
  'account-window': 'Account window',
  earned: 'Earned balance',
  'provider-reported': 'Provider-reported',
  unpublished: 'Unpublished',
  disabled: 'Disabled'
};

async function fetchBoundedJson(url: string, fetcher: typeof fetch, limitBytes: number, signal?: AbortSignal): Promise<unknown> {
  const combined = signal ? AbortSignal.any([AbortSignal.timeout(4000), signal]) : AbortSignal.timeout(4000);
  const response = await fetcher(url, { signal: combined, redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limitBytes) throw new Error('Response exceeded size bound');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function medianFromHistogram(histogram: readonly number[]): number | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;
  const target = total / 2;
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] ?? 0;
    if (seen >= target) {
      return i < DIAGNOSTIC_LATENCY_BOUNDS_MS.length ? DIAGNOSTIC_LATENCY_BOUNDS_MS[i]! : DIAGNOSTIC_LATENCY_BOUNDS_MS.at(-1)!;
    }
  }
  return null;
}

function windowStartForPeriod(period: 'minute' | 'hour' | 'day' | 'month', now: number, quotaWindow?: { startedAt: number; resetAt: number }): number {
  if (quotaWindow && quotaWindow.startedAt <= now && quotaWindow.resetAt > now) return quotaWindow.startedAt;
  const d = new Date(now);
  if (period === 'minute') return now - 60000;
  if (period === 'hour') return now - 3600000;
  if (period === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function buildRemainingUsage(
  source: SourceSnapshot,
  rawObserved: ObservedQuota | undefined,
  metrics: DiagnosticMetrics | null,
  now: number
): UiRemainingUsage {
  const policy = source.quotaPolicy ?? providerQuotaPolicy(source.id);
  const observed = rawObserved ?? source.quotaObserved;
  if (observed) {
    return {
      tier: 'verified',
      unit: observed.unit,
      remaining: observed.remaining,
      ...(observed.limit === undefined ? {} : { limit: observed.limit }),
      ...(observed.used === undefined ? {} : { used: observed.used }),
      observedAt: observed.observedAt,
      source: observed.source,
      note: policy?.detail ?? 'Reported directly by provider preflight metadata.'
    };
  }

  // Policy-estimated remaining usage from local Grunt spend inside the policy's window.
  const limits = policy?.limits ?? [];
  const preferredLimit = limits.find(l => l.period === 'day' && l.unit === 'tokens')
    ?? limits.find(l => l.period === 'day' && l.unit === 'requests')
    ?? limits.find(l => l.period === 'month')
    ?? limits.find(l => l.period === 'hour')
    ?? limits[0];

  if (preferredLimit && metrics?.coverage.available) {
    const start = windowStartForPeriod(preferredLimit.period, now, source.quotaWindow);
    const alignedStart = Math.floor(start / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
    let spent = 0;
    for (const bucket of metrics.buckets) {
      if (bucket.dimensions.type !== 'attempt.finish' || bucket.dimensions.source !== source.id) continue;
      if (bucket.hour < alignedStart) continue;
      if (preferredLimit.unit === 'tokens') {
        spent += source.id === 'goedel' ? bucket.inputTokens : bucket.inputTokens + bucket.outputTokens;
      } else if (preferredLimit.unit === 'requests') {
        spent += bucket.count;
      }
    }
    if (preferredLimit.unit === 'tokens' || preferredLimit.unit === 'requests') {
      const remaining = source.state === 'limited' ? 0 : Math.max(0, preferredLimit.amount - spent);
      return {
        tier: 'estimate',
        unit: preferredLimit.unit,
        remaining,
        limit: preferredLimit.amount,
        used: spent,
        source: 'local_policy',
        period: preferredLimit.period,
        scope: preferredLimit.scope,
        note: `Estimated from local Grunt spend vs published ${preferredLimit.amount.toLocaleString('en-US')} ${preferredLimit.unit}/${preferredLimit.period} (${preferredLimit.scope}). External API usage is not visible.`
      };
    }
  }

  const seller = source.sellerQuota ?? (source.id === 'antseed-vikey' ? sellerQuota(source.sellerQuota) : undefined);
  if (seller && (seller.perAddress || seller.perIp)) {
    const cap = seller.perAddress ?? seller.perIp!;
    const start = Math.floor((now - seller.windowSeconds * 1000) / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
    let spent = 0;
    for (const bucket of metrics?.buckets ?? []) {
      if (bucket.dimensions.type === 'attempt.finish' && bucket.dimensions.source === source.id && bucket.hour >= start) {
        spent += bucket.count;
      }
    }
    return {
      tier: 'estimate',
      unit: 'requests',
      remaining: source.state === 'limited' ? 0 : Math.max(0, cap - spent),
      limit: cap,
      used: spent,
      source: 'local_policy',
      period: 'window',
      scope: seller.perAddress ? 'address' : 'ip',
      note: `Estimated from local Grunt requests vs seller-advertised window (${Math.round(seller.windowSeconds / 3600)}h).`
    };
  }

  return {
    tier: 'unknown',
    note: policy?.detail ?? 'Provider does not expose a live remaining balance.'
  };
}

function actionCommandFor(source: SourceSnapshot): string | null {
  if (source.state === 'approval') return `usegrunt add ${source.id}`;
  if (source.errorCode === 'logged_out') return `usegrunt add ${source.id}`;
  if (source.state === 'unavailable' && source.errorCode !== 'refused') return `usegrunt add ${source.id}`;
  return null;
}

function derivePoolState(
  rawStatus: Record<string, unknown>,
  routes: readonly UiRouteView[],
  inFlight: readonly UiRequestView[],
  activeRequests: number
): { poolState: UiPoolState; reason: string } {
  const validStates = new Set<UiPoolState>(['idle', 'working', 'switching', 'transient_error', 'provider_exhausted', 'globally_exhausted']);
  if (typeof rawStatus.poolState === 'string' && validStates.has(rawStatus.poolState as UiPoolState)) {
    const reason = typeof rawStatus.poolReason === 'string' && rawStatus.poolReason.trim()
      ? rawStatus.poolReason.trim()
      : `${rawStatus.poolState.replace(/_/g, ' ')}`;
    return { poolState: rawStatus.poolState as UiPoolState, reason };
  }

  const enabled = routes.filter(r => r.state !== 'disabled');
  const routable = enabled.filter(r => r.routable);
  const limited = enabled.filter(r => r.state === 'limited');
  const errored = enabled.filter(r => r.state === 'error' && r.retryAt !== null);

  if (enabled.length > 0 && routable.length === 0) {
    return { poolState: 'globally_exhausted', reason: `0 of ${enabled.length} configured routes are routable right now` };
  }
  if (inFlight.some(req => req.attempts.length > 1 || req.state === 'routing')) {
    return { poolState: 'switching', reason: 'Failover in progress across healthy providers' };
  }
  if (errored.length > 0 && activeRequests > 0) {
    return { poolState: 'transient_error', reason: `${errored.length} route${errored.length === 1 ? '' : 's'} cooling down from transient errors; ${routable.length} still routable` };
  }
  if (limited.length > 0) {
    return { poolState: 'provider_exhausted', reason: `${limited.length} route${limited.length === 1 ? '' : 's'} hit quota limits; ${routable.length} still routable` };
  }
  if (activeRequests > 0) {
    return { poolState: 'working', reason: `${activeRequests} active request${activeRequests === 1 ? '' : 's'} across ${routable.length} routable provider${routable.length === 1 ? '' : 's'}` };
  }
  return { poolState: 'idle', reason: routable.length ? `${routable.length} routable provider${routable.length === 1 ? '' : 's'} ready` : 'No routes configured yet' };
}

function mapObservedRequest(req: Observation['inFlight'][number], live: boolean): UiRequestView {
  return {
    id: req.id,
    live,
    caller: req.caller,
    endpoint: req.endpoint,
    state: req.state,
    outcome: req.outcome,
    selectedRoute: req.selectedRoute,
    startedAt: req.startedAt,
    endedAt: req.endedAt,
    durationMs: req.durationMs,
    promptBytes: req.promptBytes,
    responseBytes: req.responseBytes,
    queuePosition: req.queuePosition,
    errorText: req.errorText,
    tokens: { input: req.tokens.input, output: req.tokens.output, reasoning: req.tokens.reasoning },
    attempts: req.attempts.map(a => ({
      id: a.id,
      provider: a.provider,
      model: a.model,
      account: a.account,
      outcome: a.outcome,
      durationMs: a.durationMs,
      httpStatus: a.httpStatus,
      errorCode: a.errorCode,
      errorText: a.errorText,
      tokens: { input: a.tokens.input, output: a.tokens.output, reasoning: a.tokens.reasoning }
    }))
  };
}

export async function collectUiSnapshot(options: {
  daemonPort: number;
  window: UiWindow;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<UiSnapshot> {
  const fetcher = options.fetcher ?? fetch;
  const now = (options.now ?? Date.now)();
  const base = `http://127.0.0.1:${options.daemonPort}`;
  const spanMs = UI_WINDOWS[options.window];
  const since = Math.max(0, now - spanMs);

  let rawStatusObj: Record<string, unknown>;
  let parsedStatus: PoolSnapshot;
  try {
    const raw = await fetchBoundedJson(`${base}/v1/status`, fetcher, 512 * 1024, options.signal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid status payload');
    rawStatusObj = raw as Record<string, unknown>;
    parsedStatus = parseStatus(raw);
  } catch (error) {
    return {
      version: 1,
      observedAt: now,
      window: options.window,
      daemonPort: options.daemonPort,
      daemonReachable: false,
      daemonError: error instanceof Error ? error.message : 'Local Grunt daemon unreachable',
      daemonVersion: null,
      daemonUptimeMs: null,
      daemonReadiness: null,
      poolState: 'idle',
      poolReason: `Local Grunt daemon unreachable on 127.0.0.1:${options.daemonPort}`,
      activeRequests: 0,
      routableCount: 0,
      limitedCount: 0,
      earliestResetAt: null,
      earliestResetRoute: null,
      totals: { ...emptyTokens(), requests: 0, requestsPassed: 0, requestsFailed: 0, requestsCancelled: 0, failovers: 0, medianLatencyMs: null },
      metricsAvailable: false,
      history: [],
      routes: [],
      inFlight: [],
      completed: []
    };
  }

  // Fetch observe + metrics + summary in parallel; none of these failures should break status rendering.
  const [observeRes, metricsRes, summaryRes] = await Promise.allSettled([
    fetchBoundedJson(`${base}${OBSERVATION_PATH}?limit=25`, fetcher, 2 * 1024 * 1024, options.signal) as Promise<Observation>,
    fetchBoundedJson(`${base}/v1/diagnostics/metrics?since=${since}&until=${now}`, fetcher, 8 * 1024 * 1024, options.signal) as Promise<DiagnosticMetrics>,
    fetchBoundedJson(`${base}/v1/diagnostics/summary?since=${since}`, fetcher, 2 * 1024 * 1024, options.signal) as Promise<DiagnosticSummary>
  ]);

  const observation = observeRes.status === 'fulfilled' ? observeRes.value : null;
  const metrics = metricsRes.status === 'fulfilled' && metricsRes.value?.version === 1 ? metricsRes.value : null;
  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;

  const obsRouteMap = new Map<string, Observation['routes'][number]>();
  for (const r of observation?.routes ?? []) obsRouteMap.set(r.id, r);

  const rawSourceMap = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawStatusObj.sources)) {
    for (const s of rawStatusObj.sources) {
      if (s && typeof s === 'object' && typeof (s as Record<string, unknown>).id === 'string') {
        rawSourceMap.set(String((s as Record<string, unknown>).id), s as Record<string, unknown>);
      }
    }
  }

  // Aggregate tokens & attempts by route and by hour from metrics (falling back to summary).
  const routeTokens = new Map<string, UiTokenCounts>();
  const hourMap = new Map<number, UiTimeBucket>();
  const totals = {
    ...emptyTokens(),
    requests: 0,
    requestsPassed: 0,
    requestsFailed: 0,
    requestsCancelled: 0,
    failovers: 0,
    medianLatencyMs: null as number | null
  };
  const combinedHistogram = Array.from({ length: DIAGNOSTIC_LATENCY_BOUNDS_MS.length + 1 }, () => 0);

  if (metrics?.coverage.available) {
    for (const bucket of metrics.buckets) {
      if (bucket.dimensions.type === 'request.finish') {
        totals.requests += bucket.count;
        if (bucket.dimensions.outcome === 'passed') totals.requestsPassed += bucket.count;
        else if (bucket.dimensions.outcome === 'cancelled') totals.requestsCancelled += bucket.count;
        else totals.requestsFailed += bucket.count;
        for (let i = 0; i < combinedHistogram.length; i++) {
          combinedHistogram[i] = combinedHistogram[i]! + (bucket.durationHistogram[i] ?? 0);
        }
      }
      if (bucket.dimensions.type === 'attempt.finish') {
        const src = bucket.dimensions.source ?? 'unknown';
        let agg = routeTokens.get(src);
        if (!agg) { agg = emptyTokens(); routeTokens.set(src, agg); }
        for (const target of [agg, totals]) {
          target.attempts += bucket.count;
          if (bucket.dimensions.outcome === 'passed') target.succeeded += bucket.count;
          else if (bucket.dimensions.outcome === 'cancelled') target.cancelled += bucket.count;
          else target.failed += bucket.count;
          target.input += bucket.inputTokens;
          target.output += bucket.outputTokens;
          target.unknownInput += bucket.unknownInput;
          target.unknownOutput += bucket.unknownOutput;
        }
        let h = hourMap.get(bucket.hour);
        if (!h) { h = { hour: bucket.hour, input: 0, output: 0, reasoning: 0, attempts: 0 }; hourMap.set(bucket.hour, h); }
        h.input += bucket.inputTokens;
        h.output += bucket.outputTokens;
        h.attempts += bucket.count;
      }
    }
    totals.medianLatencyMs = medianFromHistogram(combinedHistogram);
    // Hourly metrics deliberately exclude ending metadata (see endings.test.ts),
    // so merge reasoning token totals from /v1/diagnostics/summary when available.
    if (summary) {
      totals.reasoning = summary.attempts.reasoningTokens ?? 0;
      totals.unknownReasoning = summary.attempts.unknownReasoning ?? 0;
      for (const p of summary.providers) {
        let agg = routeTokens.get(p.source);
        if (!agg) { agg = emptyTokens(); routeTokens.set(p.source, agg); }
        agg.reasoning = p.reasoningTokens ?? 0;
        agg.unknownReasoning = p.unknownReasoning ?? 0;
      }
    }
  } else if (summary) {
    totals.requests = summary.requests.total;
    totals.requestsPassed = summary.requests.succeeded;
    totals.requestsFailed = summary.requests.failed;
    totals.requestsCancelled = summary.requests.cancelled;
    totals.attempts = summary.attempts.total;
    totals.succeeded = summary.attempts.succeeded;
    totals.failed = summary.attempts.failed;
    totals.cancelled = summary.attempts.cancelled;
    totals.input = summary.attempts.inputTokens;
    totals.output = summary.attempts.outputTokens;
    totals.reasoning = summary.attempts.reasoningTokens ?? 0;
    totals.unknownInput = summary.attempts.unknownInput;
    totals.unknownOutput = summary.attempts.unknownOutput;
    totals.unknownReasoning = summary.attempts.unknownReasoning ?? 0;
    for (const p of summary.providers) {
      routeTokens.set(p.source, {
        attempts: p.total,
        succeeded: p.succeeded,
        failed: p.failed,
        cancelled: p.cancelled,
        input: p.inputTokens,
        output: p.outputTokens,
        reasoning: p.reasoningTokens ?? 0,
        unknownInput: p.unknownInput,
        unknownOutput: p.unknownOutput,
        unknownReasoning: p.unknownReasoning ?? 0
      });
    }
  }

  totals.failovers = Math.max(0, totals.attempts - totals.requests);

  const routes: UiRouteView[] = parsedStatus.sources.map(source => {
    const obs = obsRouteMap.get(source.id);
    const raw = rawSourceMap.get(source.id);
    const policy = source.quotaPolicy ?? providerQuotaPolicy(source.id);
    const rawObs = observedQuota(raw?.quotaObserved);
    const cooldownUntil = obs?.cooldown?.until ?? null;
    const retryAt = source.retryAt ?? (cooldownUntil && cooldownUntil > now ? cooldownUntil : null);
    const quotaResetAt = source.quotaWindow?.resetAt ?? source.scheduledQuotaRefillAt ?? scheduledQuotaRefill(source.id, now) ?? null;
    const actionCmd = actionCommandFor(source);

    // Derive routable faithfully whether running on new or older daemon snapshots.
    const retired = obs?.retired ?? false;
    const stateAllowsRoute = source.state === 'ready' || source.state === 'available' || source.state === 'answering';
    const routable = typeof raw?.routable === 'boolean' && stateAllowsRoute
      ? (raw.routable || (raw.probeFresh === undefined && !retired))
      : stateAllowsRoute && !retired && (retryAt === null || retryAt <= now);
    const checkedAgo = typeof raw?.checkedAgoSeconds === 'number' ? raw.checkedAgoSeconds : null;
    const probeFresh = typeof raw?.probeFresh === 'boolean'
      ? raw.probeFresh
      : (checkedAgo !== null && checkedAgo <= 30);

    let comesBackAt: number | null = null;
    let comesBackKind: UiRouteView['comesBackKind'] = 'policy';
    if (source.state === 'disabled' || retired) {
      comesBackKind = 'disabled';
    } else if (retryAt !== null && retryAt > now) {
      comesBackAt = retryAt;
      comesBackKind = 'cooldown';
    } else if (actionCmd !== null) {
      comesBackKind = 'manual';
    } else if (routable) {
      comesBackAt = quotaResetAt && quotaResetAt > now ? quotaResetAt : null;
      comesBackKind = 'ready';
    } else if (source.quotaWindow?.resetAt && source.quotaWindow.resetAt > now) {
      comesBackAt = source.quotaWindow.resetAt;
      comesBackKind = 'quota_window';
    } else if (quotaResetAt && quotaResetAt > now) {
      comesBackAt = quotaResetAt;
      comesBackKind = 'scheduled_refill';
    }

    return {
      id: source.id,
      name: displayName(source.id),
      state: source.state,
      model: source.model ?? null,
      active: source.active,
      routable,
      probeFresh,
      checkedAgoSeconds: checkedAgo,
      supportsFunctionTools: Boolean(raw?.supportsFunctionTools ?? obs?.supportsFunctionTools),
      lastReplyMs: source.lastReplyMs ?? null,
      lastSuccessAt: source.lastSuccessAt ?? null,
      errorCode: source.errorCode ?? null,
      detail: source.detail ?? 'No runtime activity observed yet',
      retired,
      trialInProgress: obs?.trialInProgress ?? false,
      retryAt: retryAt && retryAt > now ? retryAt : null,
      comesBackAt,
      comesBackKind,
      resetCadence: policy ? (REFILL_LABELS[policy.refill] ?? policy.refill) : 'Unpublished',
      actionCommand: actionCmd,
      remaining: buildRemainingUsage(source, rawObs, metrics, now),
      tokens: routeTokens.get(source.id) ?? emptyTokens(),
      maintenance: source.maintenance ?? null,
      policyDetail: policy?.detail ?? null
    };
  });

  const inFlight = (observation?.inFlight ?? []).map(req => mapObservedRequest(req, true));
  const completed = (observation?.completed ?? []).map(req => mapObservedRequest(req, false));
  const { poolState, reason } = derivePoolState(rawStatusObj, routes, inFlight, parsedStatus.activeRequests);

  const waiting = routes
    .filter(r => r.retryAt !== null && r.retryAt > now)
    .sort((a, b) => a.retryAt! - b.retryAt!);

  const history = [...hourMap.values()].sort((a, b) => a.hour - b.hour);

  return {
    version: 1,
    observedAt: now,
    window: options.window,
    daemonPort: options.daemonPort,
    daemonReachable: true,
    daemonError: null,
    daemonVersion: observation?.daemon.version ?? null,
    daemonUptimeMs: observation?.daemon.uptimeMs ?? null,
    daemonReadiness: observation?.daemon.readiness ?? null,
    poolState,
    poolReason: reason,
    activeRequests: parsedStatus.activeRequests,
    routableCount: routes.filter(r => r.routable).length,
    limitedCount: routes.filter(r => r.state === 'limited' || (r.retryAt !== null && r.retryAt > now)).length,
    earliestResetAt: waiting[0]?.retryAt ?? null,
    earliestResetRoute: waiting[0]?.name ?? null,
    totals,
    metricsAvailable: Boolean(metrics?.coverage.available || summary),
    history,
    routes,
    inFlight,
    completed
  };
}
