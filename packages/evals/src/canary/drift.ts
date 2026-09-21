/**
 * Drift detection: compares one `Snapshot` against a baseline `Snapshot`
 * (rolling or pinned, see `./store.ts`) against configurable thresholds.
 * Pure arithmetic, no I/O -- `./run.ts` produces run data, `./snapshot.ts`
 * reduces it, this only compares two already-reduced numbers.
 */
import type { Tier } from "@milo/core";
import { TIERS } from "@milo/core";
import type { Snapshot } from "./snapshot.js";

export type DriftThresholds = {
  /** Pass-rate drop, in percentage points, that counts as drift. */
  maxPassRateDropPts: number;
  /** Mean-cost increase, as a percent of the baseline, that counts as drift. */
  maxCostIncreasePct: number;
  /** p95-latency increase, as a percent of the baseline, that counts as drift. */
  maxP95LatencyIncreasePct: number;
  /** Any single tier's share of scored examples moving by more than this many points. */
  maxTierShiftPts: number;
};

/**
 * Defaults: loose enough that ordinary run-to-run noise on a 20-30 example
 * subset does not cry wolf, tight enough to catch a real regression (a
 * flipped roster, a policy threshold moved the wrong way, the Jev-via-
 * OpenRouter alpha endpoint drifting). Tune per deployment with the CLI's
 * `--max-*` flags.
 */
export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  maxPassRateDropPts: 10,
  maxCostIncreasePct: 25,
  maxP95LatencyIncreasePct: 50,
  maxTierShiftPts: 20,
};

/**
 * Baseline p95 latency below this (ms) is treated as noise: a percentage
 * change on a few milliseconds of local compute (fixtures mode, or a very
 * fast cached response) is not a meaningful drift signal, so the p95-latency
 * check is skipped below the floor. Real inference latency is hundreds of ms,
 * well above this, so live drift detection is unaffected.
 */
export const LATENCY_DRIFT_FLOOR_MS = 50;

export type MetricCheck = {
  metric: "pass_rate" | "mean_cost" | "p95_latency";
  label: string;
  current: number;
  baseline: number;
  /** Percentage points for `pass_rate`; percent-of-baseline for the other two. */
  delta: number;
  threshold: number;
  /** `false` when either side had no data (`NaN`) -- there is nothing to compare. */
  breached: boolean;
};

export type TierShift = {
  tier: Tier;
  currentPct: number;
  baselinePct: number;
  deltaPts: number;
  threshold: number;
  breached: boolean;
};

export type DriftResult = {
  hasBaseline: boolean;
  thresholds: DriftThresholds;
  checks: MetricCheck[];
  tierShifts: TierShift[];
  /** `true` when any check or tier shift breached its threshold. Always `false` without a baseline. */
  drifted: boolean;
};

function tierSharePct(snapshot: Snapshot, tier: Tier): number {
  return snapshot.scoredN === 0 ? 0 : (snapshot.tierCounts[tier] / snapshot.scoredN) * 100;
}

/**
 * Compares `current` against `baseline` (`undefined` means no baseline
 * exists yet -- the first run, or an empty history) using `thresholds`.
 * Never throws: a metric with no data on either side (`NaN`) is simply
 * omitted from `checks` rather than reported as drift or as an error.
 */
export function compareToBaseline(
  current: Snapshot,
  baseline: Snapshot | undefined,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): DriftResult {
  if (baseline === undefined) {
    return { hasBaseline: false, thresholds, checks: [], tierShifts: [], drifted: false };
  }

  const checks: MetricCheck[] = [];

  if (!Number.isNaN(current.passRate) && !Number.isNaN(baseline.passRate)) {
    const deltaPts = (current.passRate - baseline.passRate) * 100;
    checks.push({
      metric: "pass_rate",
      label: "Pass rate",
      current: current.passRate,
      baseline: baseline.passRate,
      delta: deltaPts,
      threshold: thresholds.maxPassRateDropPts,
      breached: deltaPts < -thresholds.maxPassRateDropPts,
    });
  }

  if (!Number.isNaN(current.meanCostUsd) && !Number.isNaN(baseline.meanCostUsd) && baseline.meanCostUsd > 0) {
    const deltaPct = ((current.meanCostUsd - baseline.meanCostUsd) / baseline.meanCostUsd) * 100;
    checks.push({
      metric: "mean_cost",
      label: "Mean cost",
      current: current.meanCostUsd,
      baseline: baseline.meanCostUsd,
      delta: deltaPct,
      threshold: thresholds.maxCostIncreasePct,
      breached: deltaPct > thresholds.maxCostIncreasePct,
    });
  }

  if (
    !Number.isNaN(current.latencyP95Ms) &&
    !Number.isNaN(baseline.latencyP95Ms) &&
    baseline.latencyP95Ms >= LATENCY_DRIFT_FLOOR_MS
  ) {
    const deltaPct = ((current.latencyP95Ms - baseline.latencyP95Ms) / baseline.latencyP95Ms) * 100;
    checks.push({
      metric: "p95_latency",
      label: "p95 latency",
      current: current.latencyP95Ms,
      baseline: baseline.latencyP95Ms,
      delta: deltaPct,
      threshold: thresholds.maxP95LatencyIncreasePct,
      breached: deltaPct > thresholds.maxP95LatencyIncreasePct,
    });
  }

  const tierShifts: TierShift[] =
    current.scoredN === 0 || baseline.scoredN === 0
      ? []
      : TIERS.map((tier) => {
          const currentPct = tierSharePct(current, tier);
          const baselinePct = tierSharePct(baseline, tier);
          const deltaPts = currentPct - baselinePct;
          return {
            tier,
            currentPct,
            baselinePct,
            deltaPts,
            threshold: thresholds.maxTierShiftPts,
            breached: Math.abs(deltaPts) > thresholds.maxTierShiftPts,
          };
        });

  const drifted = checks.some((c) => c.breached) || tierShifts.some((t) => t.breached);
  return { hasBaseline: true, thresholds, checks, tierShifts, drifted };
}
