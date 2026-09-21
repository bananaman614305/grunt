import { describe, expect, it } from "vitest";
import type { CanaryExampleResult, CanaryRun } from "./run.js";
import { computeSnapshot, estimatedCostUsd } from "./snapshot.js";

const FAST_MODEL = "deepseek/deepseek-v4-flash"; // $0.07/M in, $0.14/M out (packages/core/src/router/roster-default.json)
const MID_MODEL = "openai/gpt-5.6-luna"; // $0.20/M in, $1.20/M out

function scored(over: Partial<Extract<CanaryExampleResult, { kind: "scored" }>> = {}): CanaryExampleResult {
  return {
    kind: "scored",
    id: "r-001",
    taskType: "chat",
    difficultyBand: 0,
    expectedTier: "fast",
    predictedTier: "fast",
    model: FAST_MODEL,
    latencyMs: 100,
    agree: true,
    ...over,
  };
}

function unscored(over: Partial<Extract<CanaryExampleResult, { kind: "unscored" }>> = {}): CanaryExampleResult {
  return {
    kind: "unscored",
    id: "r-002",
    taskType: "chat",
    difficultyBand: 0,
    expectedTier: "fast",
    errorClass: "timeout",
    ...over,
  };
}

function runOf(results: CanaryExampleResult[]): CanaryRun {
  return { posture: "balanced", policyVersion: "v4", generatedAt: "2026-09-20T00:00:00.000Z", requestedSize: results.length, results };
}

describe("estimatedCostUsd", () => {
  it("prices a known roster model against the nominal token profile", () => {
    // (0.07/1e6)*1500 + (0.14/1e6)*500 = 0.000105 + 0.00007
    expect(estimatedCostUsd(FAST_MODEL)).toBeCloseTo(0.000175, 9);
  });

  it("is undefined for a model with no known roster price", () => {
    expect(estimatedCostUsd("some/custom-model-not-in-the-roster")).toBeUndefined();
  });
});

describe("computeSnapshot", () => {
  it("computes pass rate, latency percentiles, and counts over scored examples only", () => {
    const run = runOf([
      scored({ id: "r-001", agree: true, latencyMs: 100, model: FAST_MODEL, predictedTier: "fast" }),
      scored({ id: "r-002", agree: true, latencyMs: 200, model: FAST_MODEL, predictedTier: "fast" }),
      scored({ id: "r-003", agree: false, latencyMs: 300, model: MID_MODEL, predictedTier: "mid", expectedTier: "frontier" }),
      unscored({ id: "r-004" }),
    ]);
    const snapshot = computeSnapshot(run);

    expect(snapshot.n).toBe(4);
    expect(snapshot.scoredN).toBe(3);
    expect(snapshot.unscoredN).toBe(1);
    expect(snapshot.passRate).toBeCloseTo(2 / 3, 10);
    expect(snapshot.latencyP50Ms).toBe(200);
    expect(snapshot.latencyP95Ms).toBe(300);
    expect(snapshot.tierCounts).toEqual({ fast: 2, mid: 1, frontier: 0 });
    expect(snapshot.modelCounts).toEqual({ [FAST_MODEL]: 2, [MID_MODEL]: 1 });
    expect(snapshot.pricedN).toBe(3);
    expect(snapshot.meanCostUsd).toBeGreaterThan(0);
    expect(snapshot.requestedSize).toBe(4);
    expect(snapshot.policyVersion).toBe("v4");
    expect(snapshot.posture).toBe("balanced");
    expect(snapshot.createdAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("excludes unpriced models from the cost mean but keeps them in tier counts", () => {
    const run = runOf([
      scored({ id: "r-001", model: "custom/unknown-model", predictedTier: "frontier" }),
      scored({ id: "r-002", model: FAST_MODEL, predictedTier: "fast" }),
    ]);
    const snapshot = computeSnapshot(run);
    expect(snapshot.pricedN).toBe(1);
    expect(snapshot.tierCounts.frontier).toBe(1);
    expect(snapshot.meanCostUsd).toBeCloseTo(estimatedCostUsd(FAST_MODEL) as number, 9);
  });

  it("reports NaN rate/latency/cost fields, not zero, when nothing was scored", () => {
    const run = runOf([unscored({ id: "r-001" }), unscored({ id: "r-002" })]);
    const snapshot = computeSnapshot(run);
    expect(snapshot.scoredN).toBe(0);
    expect(snapshot.unscoredN).toBe(2);
    expect(snapshot.passRate).toBeNaN();
    expect(snapshot.meanCostUsd).toBeNaN();
    expect(snapshot.latencyP50Ms).toBeNaN();
    expect(snapshot.latencyP95Ms).toBeNaN();
    expect(snapshot.pricedN).toBe(0);
    expect(snapshot.tierCounts).toEqual({ fast: 0, mid: 0, frontier: 0 });
  });

  it("a perfect run reports pass rate 1", () => {
    const run = runOf([scored({ id: "r-001", agree: true }), scored({ id: "r-002", agree: true })]);
    expect(computeSnapshot(run).passRate).toBe(1);
  });
});
