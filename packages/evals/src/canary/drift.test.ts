import { describe, expect, it } from "vitest";
import { compareToBaseline, DEFAULT_DRIFT_THRESHOLDS } from "./drift.js";
import type { Snapshot } from "./snapshot.js";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    createdAt: "2026-09-20T00:00:00.000Z",
    policyVersion: "v4",
    posture: "balanced",
    requestedSize: 24,
    n: 24,
    scoredN: 24,
    unscoredN: 0,
    passRate: 0.9,
    meanCostUsd: 0.001,
    pricedN: 24,
    latencyP50Ms: 400,
    latencyP95Ms: 600,
    tierCounts: { fast: 12, mid: 8, frontier: 4 },
    modelCounts: {},
    ...over,
  };
}

describe("compareToBaseline: no baseline", () => {
  it("reports no drift and no checks when there is nothing to compare against", () => {
    const result = compareToBaseline(makeSnapshot(), undefined);
    expect(result.hasBaseline).toBe(false);
    expect(result.drifted).toBe(false);
    expect(result.checks).toEqual([]);
    expect(result.tierShifts).toEqual([]);
  });
});

describe("compareToBaseline: pass rate", () => {
  it("does not flag a drop within the threshold", () => {
    const current = makeSnapshot({ passRate: 0.85 });
    const baseline = makeSnapshot({ passRate: 0.9 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxPassRateDropPts: 10 });
    expect(result.drifted).toBe(false);
    expect(result.checks.find((c) => c.metric === "pass_rate")?.breached).toBe(false);
  });

  it("flags a drop beyond the threshold", () => {
    const current = makeSnapshot({ passRate: 0.7 });
    const baseline = makeSnapshot({ passRate: 0.9 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxPassRateDropPts: 10 });
    expect(result.drifted).toBe(true);
    const check = result.checks.find((c) => c.metric === "pass_rate");
    expect(check?.breached).toBe(true);
    expect(check?.delta).toBeCloseTo(-20, 5);
  });

  it("does not flag an improvement", () => {
    const current = makeSnapshot({ passRate: 1.0 });
    const baseline = makeSnapshot({ passRate: 0.5 });
    const result = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    expect(result.checks.find((c) => c.metric === "pass_rate")?.breached).toBe(false);
  });

  it("skips the check when either side has no scored data (NaN)", () => {
    const current = makeSnapshot({ passRate: NaN });
    const baseline = makeSnapshot({ passRate: 0.9 });
    const result = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    expect(result.checks.find((c) => c.metric === "pass_rate")).toBeUndefined();
    expect(result.drifted).toBe(false);
  });
});

describe("compareToBaseline: mean cost", () => {
  it("does not flag an increase within the threshold", () => {
    const current = makeSnapshot({ meanCostUsd: 0.0011 });
    const baseline = makeSnapshot({ meanCostUsd: 0.001 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxCostIncreasePct: 25 });
    expect(result.checks.find((c) => c.metric === "mean_cost")?.breached).toBe(false);
  });

  it("flags an increase beyond the threshold", () => {
    const current = makeSnapshot({ meanCostUsd: 0.002 });
    const baseline = makeSnapshot({ meanCostUsd: 0.001 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxCostIncreasePct: 25 });
    expect(result.drifted).toBe(true);
    const check = result.checks.find((c) => c.metric === "mean_cost");
    expect(check?.breached).toBe(true);
    expect(check?.delta).toBeCloseTo(100, 5);
  });

  it("does not flag a decrease", () => {
    const current = makeSnapshot({ meanCostUsd: 0.0001 });
    const baseline = makeSnapshot({ meanCostUsd: 0.001 });
    expect(compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS).drifted).toBe(false);
  });
});

describe("compareToBaseline: p95 latency", () => {
  it("does not flag an increase within the threshold", () => {
    const current = makeSnapshot({ latencyP95Ms: 800 });
    const baseline = makeSnapshot({ latencyP95Ms: 600 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxP95LatencyIncreasePct: 50 });
    expect(result.checks.find((c) => c.metric === "p95_latency")?.breached).toBe(false);
  });

  it("flags an increase beyond the threshold", () => {
    const current = makeSnapshot({ latencyP95Ms: 1000 });
    const baseline = makeSnapshot({ latencyP95Ms: 600 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxP95LatencyIncreasePct: 50 });
    expect(result.drifted).toBe(true);
    expect(result.checks.find((c) => c.metric === "p95_latency")?.breached).toBe(true);
  });
});

describe("compareToBaseline: tier mix", () => {
  it("does not flag a shift within the threshold", () => {
    const current = makeSnapshot({ tierCounts: { fast: 13, mid: 7, frontier: 4 }, scoredN: 24 });
    const baseline = makeSnapshot({ tierCounts: { fast: 12, mid: 8, frontier: 4 }, scoredN: 24 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxTierShiftPts: 20 });
    expect(result.tierShifts.every((t) => !t.breached)).toBe(true);
    expect(result.drifted).toBe(false);
  });

  it("flags a shift beyond the threshold in either direction", () => {
    // fast share moves from 50% (12/24) to 1/24 (~4.17%): a swing beyond 20pp.
    const current = makeSnapshot({ tierCounts: { fast: 1, mid: 11, frontier: 12 }, scoredN: 24 });
    const baseline = makeSnapshot({ tierCounts: { fast: 12, mid: 8, frontier: 4 }, scoredN: 24 });
    const result = compareToBaseline(current, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, maxTierShiftPts: 20 });
    expect(result.drifted).toBe(true);
    const fast = result.tierShifts.find((t) => t.tier === "fast");
    expect(fast?.breached).toBe(true);
    expect(fast?.deltaPts).toBeCloseTo((1 / 24) * 100 - 50, 6);
  });

  it("skips tier shifts entirely when either side scored nothing", () => {
    const current = makeSnapshot({ scoredN: 0, tierCounts: { fast: 0, mid: 0, frontier: 0 } });
    const baseline = makeSnapshot({ scoredN: 24 });
    const result = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    expect(result.tierShifts).toEqual([]);
  });
});

describe("compareToBaseline: combined", () => {
  it("drifted is true if any single check or tier shift breaches, even if others pass", () => {
    const current = makeSnapshot({ passRate: 0.89, meanCostUsd: 0.05, latencyP95Ms: 610 });
    const baseline = makeSnapshot({ passRate: 0.9, meanCostUsd: 0.001, latencyP95Ms: 600 });
    const result = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    expect(result.drifted).toBe(true);
    expect(result.checks.find((c) => c.metric === "pass_rate")?.breached).toBe(false);
    expect(result.checks.find((c) => c.metric === "mean_cost")?.breached).toBe(true);
  });

  it("an identical snapshot compared to itself never drifts", () => {
    const snapshot = makeSnapshot();
    const result = compareToBaseline(snapshot, snapshot, DEFAULT_DRIFT_THRESHOLDS);
    expect(result.drifted).toBe(false);
    expect(result.checks.every((c) => !c.breached)).toBe(true);
    expect(result.tierShifts.every((t) => !t.breached)).toBe(true);
  });
});
