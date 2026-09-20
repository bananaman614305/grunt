/**
 * Cost aggregation over decision-log rows. Milo's pitch is "near-frontier
 * quality at a fraction of the cost", and this is where that fraction becomes
 * a measured number rather than a claim: it reads the per-request cost the
 * decision log already stores (`upstream.costUsd`, the aggregate across every
 * best-of-N sample) and rolls it up by tier, by model, per request, and into
 * the extra spend that sampling costs.
 *
 * Pure arithmetic over a structural shape, not a query: `DecisionLog.stats`
 * feeds it the rows it already fetched, and a test feeds it fixtures. It never
 * touches SQLite and stores nothing, so it is not a persisted contract and
 * lives here rather than in `types.ts`.
 */

/** The minimum a decision has to expose for its cost to be aggregated. */
export type CostInputDecision = {
  tier: string;
  model: string;
  /** Best-of-N fan-out size (ADR-010); > 1 on a sampled decision, else absent. */
  samples?: number;
  /**
   * The upstream outcome. `costUsd` is the aggregate across every sample on a
   * sampled decision, so it is what a caller was actually charged. Absent when
   * the call never completed or the provider reported no cost.
   */
  upstream?: { costUsd?: number };
};

export type CostBreakdown = {
  /** Total spend in USD across every decision that reported a cost. */
  total: number;
  /** Spend in USD by tier (fast/mid/frontier), decisions with a cost only. */
  byTier: Record<string, number>;
  /** Spend in USD by model id, decisions with a cost only. */
  byModel: Record<string, number>;
  /**
   * Mean spend over the decisions that reported a cost, or null when none did.
   * Priced requests only: a decision with no cost (a failed or in-flight call)
   * would otherwise drag the average toward zero and understate the real
   * per-answer spend.
   */
  avgPerRequest: number | null;
  /**
   * The extra spend attributable to best-of-N sampling (ADR-010). A sampled
   * decision fans out to N calls and `costUsd` covers all N, so a single call
   * would have cost about `costUsd / N`; the tax is the rest, summed over every
   * sampled decision: `sum(costUsd * (N - 1) / N)`.
   */
  samplingTax: number;
  /** How many decisions reported a cost -- the denominator for `avgPerRequest`. */
  withCost: number;
};

/** Rounds to 6 decimal places, enough for sub-cent per-token costs, and keeps
 * floating-point sums from leaking noise into the reported numbers. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isFiniteCost(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Rolls a set of decisions up into a {@link CostBreakdown}. A decision with no
 * `upstream.costUsd` is counted nowhere (not in `total`, `byTier`, `byModel`,
 * or the average denominator), so a run full of failed or in-flight calls
 * reads as `total: 0, withCost: 0, avgPerRequest: null` rather than a lie.
 */
export function aggregateCost(decisions: Iterable<CostInputDecision>): CostBreakdown {
  const byTier: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let total = 0;
  let withCost = 0;
  let samplingTax = 0;

  for (const decision of decisions) {
    const cost = decision.upstream?.costUsd;
    if (!isFiniteCost(cost)) continue;

    total += cost;
    withCost += 1;
    byTier[decision.tier] = (byTier[decision.tier] ?? 0) + cost;
    byModel[decision.model] = (byModel[decision.model] ?? 0) + cost;

    const samples = decision.samples;
    if (typeof samples === "number" && samples > 1) {
      samplingTax += (cost * (samples - 1)) / samples;
    }
  }

  for (const tier of Object.keys(byTier)) byTier[tier] = round(byTier[tier] ?? 0);
  for (const model of Object.keys(byModel)) byModel[model] = round(byModel[model] ?? 0);

  return {
    total: round(total),
    byTier,
    byModel,
    avgPerRequest: withCost > 0 ? round(total / withCost) : null,
    samplingTax: round(samplingTax),
    withCost,
  };
}
