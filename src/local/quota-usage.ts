import { DIAGNOSTIC_METRIC_HOUR_MS } from './diagnostic-metrics.js';
import { providerQuotaPolicy } from './quota-policy.js';
import type { ObservedQuota } from './quota-policy.js';
import type { DiagnosticMetrics } from './diagnostics.js';
import type { SourceSnapshot } from './source-status.js';

export interface RemainingUsage {
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

function windowStartForPeriod(period: 'minute' | 'hour' | 'day' | 'month', now: number, quotaWindow?: { startedAt: number; resetAt: number }): number {
  if (quotaWindow && quotaWindow.startedAt <= now && quotaWindow.resetAt > now) return quotaWindow.startedAt;
  const d = new Date(now);
  if (period === 'minute') return now - 60000;
  if (period === 'hour') return now - 3600000;
  if (period === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

interface EstimablePolicyLimit {
  amount: number;
  unit: 'tokens' | 'requests';
  period: 'hour' | 'day' | 'month';
  scope: 'account' | 'workspace' | 'ip' | 'free projects';
}

function selectEstimablePolicyLimit(source: SourceSnapshot): EstimablePolicyLimit | undefined {
  const policy = source.quotaPolicy ?? providerQuotaPolicy(source.id);
  const estimable: EstimablePolicyLimit[] = [];
  for (const l of policy?.limits ?? []) {
    if ((l.unit === 'tokens' || l.unit === 'requests') && l.period !== 'minute') {
      estimable.push({ amount: l.amount, unit: l.unit, period: l.period, scope: l.scope });
    }
  }
  return estimable.find(l => l.period === 'day' && l.unit === 'tokens')
    ?? estimable.find(l => l.period === 'day' && l.unit === 'requests')
    ?? estimable.find(l => l.period === 'month')
    ?? estimable.find(l => l.period === 'hour')
    ?? estimable[0];
}

export function requiredPolicyWindowStart(source: SourceSnapshot, rawObserved: ObservedQuota | undefined, now: number): number | null {
  if (rawObserved ?? source.quotaObserved) return null;
  const preferredLimit = selectEstimablePolicyLimit(source);
  if (preferredLimit) {
    return Math.max(0, windowStartForPeriod(preferredLimit.period, now, source.quotaWindow));
  }
  const seller = source.sellerQuota;
  if (seller && (seller.perAddress || seller.perIp) && seller.windowSeconds >= 3600) {
    return Math.max(0, now - seller.windowSeconds * 1000);
  }
  return null;
}

function hasCompletePolicyCoverage(metrics: DiagnosticMetrics | null, windowStart: number, alignedStart: number, now: number): boolean {
  if (!metrics || !metrics.coverage.available) return false;
  if (metrics.window.alignedSince > alignedStart) return false;
  const { startedAt, deduplicationFloor, droppedEvents, droppedLateEvents, overflowEvents } = metrics.coverage;
  if (startedAt === null || startedAt > windowStart) return false;
  if (deduplicationFloor > windowStart) return false;
  if (droppedEvents > 0 || droppedLateEvents > 0 || overflowEvents > 0) return false;
  const retentionMs = metrics.limits.retentionDays * 86400000;
  if (windowStart < now - retentionMs) return false;
  return true;
}

export function buildRemainingUsage(
  source: SourceSnapshot,
  rawObserved: ObservedQuota | undefined,
  quotaMetrics: DiagnosticMetrics | null,
  now: number
): RemainingUsage {
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

  // Policy-estimated remaining usage from local Grunt spend across the full policy window.
  const preferredLimit = selectEstimablePolicyLimit(source);
  if (preferredLimit) {
    const start = Math.max(0, windowStartForPeriod(preferredLimit.period, now, source.quotaWindow));
    const alignedStart = Math.floor(start / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
    if (!hasCompletePolicyCoverage(quotaMetrics, start, alignedStart, now)) {
      return {
        tier: 'unknown',
        note: `Local diagnostics do not cover the full ${preferredLimit.period} policy window; remaining quota is not estimated.`
      };
    }
    let spent = 0;
    let unknownTokenCount = 0;
    for (const bucket of quotaMetrics!.buckets) {
      if (bucket.dimensions.type !== 'attempt.finish' || bucket.dimensions.source !== source.id) continue;
      if (bucket.hour < alignedStart) continue;
      if (preferredLimit.unit === 'tokens') {
        if (source.id === 'goedel') {
          spent += bucket.inputTokens;
          unknownTokenCount += bucket.unknownInput;
        } else {
          spent += bucket.inputTokens + bucket.outputTokens;
          unknownTokenCount += bucket.unknownInput + bucket.unknownOutput;
        }
      } else {
        spent += bucket.count;
      }
    }
    if (preferredLimit.unit === 'tokens' && unknownTokenCount > 0) {
      return {
        tier: 'unknown',
        note: `Some local attempts in this ${preferredLimit.period} window omitted token counts; remaining quota is not estimated.`
      };
    }
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

  const seller = source.sellerQuota;
  if (seller && (seller.perAddress || seller.perIp) && seller.windowSeconds >= 3600) {
    const cap = seller.perAddress ?? seller.perIp!;
    const start = Math.max(0, now - seller.windowSeconds * 1000);
    const alignedStart = Math.floor(start / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
    if (!hasCompletePolicyCoverage(quotaMetrics, start, alignedStart, now)) {
      return {
        tier: 'unknown',
        note: `Local diagnostics do not cover the full ${Math.round(seller.windowSeconds / 3600)}h seller window; remaining quota is not estimated.`
      };
    }
    let spent = 0;
    for (const bucket of quotaMetrics!.buckets) {
      if (bucket.dimensions.type === 'attempt.finish' && bucket.dimensions.source === source.id && bucket.hour >= alignedStart) {
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
