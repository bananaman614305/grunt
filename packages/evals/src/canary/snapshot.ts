/**
 * The canary snapshot: what one canary run reduces to for drift comparison.
 * Pure and deterministic given a `CanaryRun` -- no clock, no network, no
 * message content (the rule in `CLAUDE.md`: the decision log stores no
 * message content, and neither does this).
 */
import type { CostPosture, Tier } from "@milo/core";
import { defaultRosterModel, TIERS } from "@milo/core";
import type { CanaryExampleResult, CanaryRun, CanaryScoredExample } from "./run.js";

/**
 * The canary has no OpenRouter call to measure real token usage against (it
 * only exercises the routing decision, never sends the request upstream), so
 * "cost" here is a proxy: a fixed, documented token profile priced against
 * the chosen model's known roster price. It moves exactly when a real
 * request's cost would move for the same reason -- a tier-mix shift or a
 * roster price change -- without spending anything or touching the network.
 * A model outside the default roster (a custom `candidates`/roster override)
 * has no known price and is simply excluded from the cost mean, the same way
 * `aggregateCost` (`packages/core/src/log/cost.ts`) excludes a decision with
 * no reported cost.
 */
export const CANARY_NOMINAL_INPUT_TOKENS = 1500;
export const CANARY_NOMINAL_OUTPUT_TOKENS = 500;

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile, `NaN` when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

/** The nominal-profile cost estimate for `model`, or `undefined` if it has no known roster price. */
export function estimatedCostUsd(model: string): number | undefined {
  const known = defaultRosterModel(model);
  if (known === undefined) return undefined;
  return (
    (known.inputUsdPerM / 1_000_000) * CANARY_NOMINAL_INPUT_TOKENS +
    (known.outputUsdPerM / 1_000_000) * CANARY_NOMINAL_OUTPUT_TOKENS
  );
}

export type Snapshot = {
  createdAt: string;
  policyVersion: string;
  posture: CostPosture;
  /** How many examples the run asked for. */
  requestedSize: number;
  /** `scoredN + unscoredN`. */
  n: number;
  scoredN: number;
  unscoredN: number;
  /** Tier agreement over the scored examples, `NaN` when none scored. */
  passRate: number;
  /** Mean of `estimatedCostUsd` over scored examples with a known roster price, `NaN` when none priced. */
  meanCostUsd: number;
  /** How many scored examples had a known roster price and fed `meanCostUsd`. */
  pricedN: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** Predicted-tier counts over scored examples. */
  tierCounts: Record<Tier, number>;
  /** Chosen-model counts over scored examples. */
  modelCounts: Record<string, number>;
};

/** Reduces a `CanaryRun` to its `Snapshot`. */
export function computeSnapshot(run: CanaryRun): Snapshot {
  const scored = run.results.filter((r): r is CanaryScoredExample => r.kind === "scored");
  const unscored = run.results.filter((r: CanaryExampleResult) => r.kind === "unscored");

  const tierCounts = Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<Tier, number>;
  const modelCounts: Record<string, number> = {};
  const latencies: number[] = [];
  const costs: number[] = [];
  let agree = 0;

  for (const example of scored) {
    tierCounts[example.predictedTier] += 1;
    modelCounts[example.model] = (modelCounts[example.model] ?? 0) + 1;
    latencies.push(example.latencyMs);
    if (example.agree) agree += 1;
    const cost = estimatedCostUsd(example.model);
    if (cost !== undefined) costs.push(cost);
  }

  return {
    createdAt: run.generatedAt,
    policyVersion: run.policyVersion,
    posture: run.posture,
    requestedSize: run.requestedSize,
    n: run.results.length,
    scoredN: scored.length,
    unscoredN: unscored.length,
    passRate: scored.length === 0 ? NaN : agree / scored.length,
    meanCostUsd: mean(costs),
    pricedN: costs.length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    tierCounts,
    modelCounts,
  };
}
