import { fetchBoundedJson } from './daemon-json.js';
import { isDiagnosticModel } from './diagnostics.js';
import type { DiagnosticMetrics } from './diagnostics.js';
import { OBSERVATION_PATH } from './observe.js';
import type { Observation } from './observe.js';
import { buildRemainingUsage, requiredPolicyWindowStart } from './quota-usage.js';
import type { RemainingUsage } from './quota-usage.js';
import type { PoolSnapshot, SourceSnapshot } from './source-status.js';

const observationLimitBytes = 2 * 1024 * 1024;
const metricsLimitBytes = 8 * 1024 * 1024;
const providerId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const servingStates = new Set(['waiting_for_output', 'receiving_output']);
const nonServingStates = new Set(['receiving_request', 'routing', 'queued', 'returning_response']);

function time(at: unknown) {
  return typeof at === 'number' && at >= 0 && at <= 8640000000000000 ? new Date(at).toISOString() : 'unknown';
}

function servingNow(snapshot: PoolSnapshot, observation: Observation | null) {
  if (!observation) return snapshot.activeRequests > 0
    ? 'unknown (live route diagnostics unavailable)'
    : 'idle (no active attempts in pool snapshot; live route diagnostics unavailable)';

  const serving = new Set<string>();
  let inFlight = false, incomplete = false;
  for (const request of observation.inFlight) {
    if (!request || request.kind === 'maintenance') continue;
    inFlight = true;
    if (request.state && nonServingStates.has(request.state)) continue;
    const attempt = Array.isArray(request.attempts) ? request.attempts.at(-1) : undefined;
    if (!request.state || !servingStates.has(request.state) || !attempt || attempt.endedAt !== null
      || typeof attempt.provider !== 'string' || !providerId.test(attempt.provider)) {
      incomplete = true;
      continue;
    }
    // Observation also uses waiting_for_output at attempt start and dequeue.
    // receiving_output already requires an attempt.progress event.
    if (request.state === 'waiting_for_output') {
      const dispatches = Array.isArray(attempt.dispatches) ? attempt.dispatches : null;
      if (dispatches?.length === 0) continue;
      if (!Number.isFinite(dispatches?.at(-1)?.at)) {
        incomplete = true;
        continue;
      }
    }
    const model = isDiagnosticModel(attempt.model) ? attempt.model : 'unknown';
    serving.add(`${attempt.provider} / ${model}`);
  }
  if (serving.size) return [...serving].join(', ') + (incomplete ? ' (some route details unavailable)' : '');
  if (incomplete || (!inFlight && snapshot.activeRequests > 0)) return 'unknown (live route details unavailable)';
  return inFlight ? 'none (requests queued, in preflight, or finishing)' : 'idle';
}

function formatQuota(quota: RemainingUsage) {
  const { used, remaining, limit, unit } = quota;
  const amount = (value: number | undefined) => value === undefined ? 'unknown' : `${value} ${unit}`;
  const provenance = quota.tier === 'verified'
    ? ` (measured via ${quota.source === 'provider_header' ? 'provider header' : 'provider API'} at ${time(quota.observedAt)})`
    : quota.tier === 'estimate' ? ` (estimate from local usage, ${quota.period}/${quota.scope})` : '';
  return `Used ${amount(used)} · remaining ${amount(remaining)}${limit === undefined ? '' : ` · limit ${amount(limit)}`}${provenance}`;
}

function formatRoute(source: SourceSnapshot, quota: RemainingUsage, cooldown: Observation['routes'][number]['cooldown'] | undefined, now: number) {
  const retryAt = cooldown?.until ?? source.retryAt;
  const retry = retryAt !== undefined && retryAt > now ? time(retryAt) : cooldown?.until === null ? 'indefinite' : undefined;
  const resetAt = source.quotaWindow?.resetAt;
  const reset = resetAt !== undefined && resetAt > now
    ? time(resetAt)
    : source.scheduledQuotaRefillAt !== undefined && source.scheduledQuotaRefillAt > now
      ? `${time(source.scheduledQuotaRefillAt)} (scheduled)` : 'unknown';
  const model = source.model === 'Free model rotation' || isDiagnosticModel(source.model) ? ` · configured model ${source.model}` : '';
  return [
    `  ${source.id} · ${source.state}${source.active ? ` · ${source.active} active` : ''}${model}${source.lastReplyMs === undefined ? '' : ` · last reply ${Math.round(source.lastReplyMs)} ms`}`,
    `    ${formatQuota(quota)} · quota reset ${reset}${retry === undefined ? '' : ` · cooldown ${retry}`}`
  ];
}

function quotaMetrics(value: unknown, until: number): DiagnosticMetrics | null {
  const metrics = value as DiagnosticMetrics | null;
  if (metrics?.version !== 1 || metrics.coverage?.available !== true || metrics.window?.until !== until
    || !Array.isArray(metrics.buckets)) return null;
  const { startedAt, deduplicationFloor, droppedEvents, droppedLateEvents, overflowEvents } = metrics.coverage;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (![startedAt, deduplicationFloor, droppedEvents, droppedLateEvents, overflowEvents,
    metrics.window.alignedSince, metrics.limits?.retentionDays].every(finite)) return null;
  if (!metrics.buckets.every(bucket => bucket?.dimensions && finite(bucket.hour) && (bucket.dimensions.type !== 'attempt.finish'
    || [bucket.count, bucket.inputTokens, bucket.outputTokens, bucket.unknownInput, bucket.unknownOutput].every(finite)))) return null;
  return metrics;
}

export async function statusReport(snapshot: PoolSnapshot, port: number, fetcher: typeof fetch, signal?: AbortSignal) {
  const now = Date.now();
  if (now - snapshot.updatedAt > 15000 || snapshot.updatedAt > now + 60000) {
    return 'Grunt status is stale. Current provider, provider states, and quota are unknown.';
  }

  const base = `http://127.0.0.1:${port}`;
  let since = now;
  for (const source of snapshot.sources) {
    const start = requiredPolicyWindowStart(source, undefined, now);
    if (start !== null) since = Math.min(since, start);
  }
  const [rawObservation, rawMetrics] = await Promise.all([
    fetchBoundedJson(`${base}${OBSERVATION_PATH}?limit=0`, fetcher, observationLimitBytes, signal).catch(() => null),
    since < now ? fetchBoundedJson(`${base}/v1/diagnostics/metrics?since=${since}&until=${now}`, fetcher, metricsLimitBytes, signal).catch(() => null) : null
  ]);
  const report = rawObservation as Observation | null;
  const observation = report?.version === 1 && Array.isArray(report.inFlight) && Array.isArray(report.routes) ? report : null;
  const cooldowns = new Map(observation?.routes.filter(route => route && typeof route.id === 'string').map(route => [route.id, route.cooldown]));
  const metrics = quotaMetrics(rawMetrics, now);
  const last = snapshot.sources.reduce<SourceSnapshot | undefined>((latest, source) =>
    (source.lastSuccessAt ?? -1) > (latest?.lastSuccessAt ?? -1) ? source : latest, undefined);

  return [
    `Grunt status${snapshot.poolState ? ` · ${snapshot.poolState.replaceAll('_', ' ')}` : ''}`,
    `Serving now: ${servingNow(snapshot, observation)}`,
    `Last successful route: ${last ? `${last.id} at ${time(last.lastSuccessAt)}` : 'unknown'}`,
    '',
    ...(snapshot.sources.length ? ['Providers', ...snapshot.sources.flatMap(source =>
      formatRoute(source, buildRemainingUsage(source, undefined, metrics, now), cooldowns.get(source.id), now)
    )] : ['No providers in the daemon snapshot.'])
  ].join('\n');
}
