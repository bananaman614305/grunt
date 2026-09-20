import { describe, expect, it } from "vitest";
import { aggregateCost, type CostInputDecision } from "./cost.js";

function d(overrides: Partial<CostInputDecision> = {}): CostInputDecision {
  return { tier: "mid", model: "anthropic/claude-sonnet-5", ...overrides };
}

describe("aggregateCost", () => {
  it("returns an empty, honest breakdown for no decisions", () => {
    expect(aggregateCost([])).toEqual({
      total: 0,
      byTier: {},
      byModel: {},
      avgPerRequest: null,
      samplingTax: 0,
      withCost: 0,
    });
  });

  it("totals spend and splits it by tier and by model", () => {
    const cost = aggregateCost([
      d({ tier: "fast", model: "anthropic/claude-haiku-4.5", upstream: { costUsd: 0.0001 } }),
      d({ tier: "mid", model: "anthropic/claude-sonnet-5", upstream: { costUsd: 0.002 } }),
      d({ tier: "mid", model: "anthropic/claude-sonnet-5", upstream: { costUsd: 0.001 } }),
      d({ tier: "frontier", model: "anthropic/claude-opus-4.8", upstream: { costUsd: 0.02 } }),
    ]);

    expect(cost.total).toBe(0.0231);
    expect(cost.byTier).toEqual({ fast: 0.0001, mid: 0.003, frontier: 0.02 });
    expect(cost.byModel).toEqual({
      "anthropic/claude-haiku-4.5": 0.0001,
      "anthropic/claude-sonnet-5": 0.003,
      "anthropic/claude-opus-4.8": 0.02,
    });
    expect(cost.withCost).toBe(4);
    expect(cost.avgPerRequest).toBe(0.005775);
  });

  it("ignores decisions with no cost everywhere, including the average denominator", () => {
    const cost = aggregateCost([
      d({ tier: "fast", upstream: { costUsd: 0.004 } }),
      d({ tier: "mid", upstream: {} }), // call happened, provider reported no cost
      d({ tier: "mid" }), // no upstream at all (failed or in-flight)
      d({ tier: "frontier", upstream: { costUsd: Number.NaN } }), // garbage guarded out
    ]);

    expect(cost.total).toBe(0.004);
    expect(cost.withCost).toBe(1);
    expect(cost.avgPerRequest).toBe(0.004);
    expect(cost.byTier).toEqual({ fast: 0.004 });
  });

  it("charges the sampling tax as cost * (N-1)/N on best-of-N decisions", () => {
    // 3 samples for a total of 0.0009 => a single call would have been ~0.0003,
    // so the tax is the other 0.0006.
    const cost = aggregateCost([d({ tier: "fast", samples: 3, upstream: { costUsd: 0.0009 } })]);
    expect(cost.total).toBe(0.0009);
    expect(cost.samplingTax).toBe(0.0006);
  });

  it("treats samples of 1 or absent as unsampled (no tax)", () => {
    const cost = aggregateCost([
      d({ tier: "fast", samples: 1, upstream: { costUsd: 0.001 } }),
      d({ tier: "mid", upstream: { costUsd: 0.002 } }),
    ]);
    expect(cost.samplingTax).toBe(0);
  });

  it("sums the tax across several sampled decisions and leaves unsampled ones out", () => {
    const cost = aggregateCost([
      d({ tier: "fast", samples: 2, upstream: { costUsd: 0.004 } }), // tax 0.002
      d({ tier: "fast", samples: 5, upstream: { costUsd: 0.005 } }), // tax 0.004
      d({ tier: "frontier", upstream: { costUsd: 0.01 } }), // tax 0
    ]);
    expect(cost.samplingTax).toBe(0.006);
    expect(cost.total).toBe(0.019);
  });
});
