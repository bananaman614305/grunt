import { describe, expect, it } from "vitest";
import { compareToBaseline, DEFAULT_DRIFT_THRESHOLDS } from "./drift.js";
import { CANARY_EXIT_DRIFT, CANARY_EXIT_OK, canaryExitCode, formatCanaryReport } from "./report.js";
import type { Snapshot } from "./snapshot.js";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    createdAt: "2026-09-20T00:00:00.000Z",
    policyVersion: "v4",
    posture: "balanced",
    requestedSize: 24,
    n: 24,
    scoredN: 22,
    unscoredN: 2,
    passRate: 0.9,
    meanCostUsd: 0.00042,
    pricedN: 22,
    latencyP50Ms: 410,
    latencyP95Ms: 612,
    tierCounts: { fast: 12, mid: 6, frontier: 4 },
    modelCounts: { "deepseek/deepseek-v4-flash": 12, "openai/gpt-5.6-luna": 6, "z-ai/glm-5.3": 4 },
    ...over,
  };
}

const meta = { mode: "fixtures", baselineSource: "rolling (window 5)" };

describe("canaryExitCode", () => {
  it("is 0 when there is no drift or no baseline", () => {
    const current = makeSnapshot();
    expect(canaryExitCode(compareToBaseline(current, undefined))).toBe(CANARY_EXIT_OK);
    expect(canaryExitCode(compareToBaseline(current, current))).toBe(CANARY_EXIT_OK);
  });

  it("is non-zero (2) when drift is detected", () => {
    const current = makeSnapshot({ passRate: 0.5 });
    const baseline = makeSnapshot({ passRate: 0.95 });
    const drift = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    expect(drift.drifted).toBe(true);
    expect(canaryExitCode(drift)).toBe(CANARY_EXIT_DRIFT);
    expect(CANARY_EXIT_DRIFT).not.toBe(0);
  });
});

describe("formatCanaryReport", () => {
  it("prints the snapshot summary, pass rate, cost, latency, and tier/model distribution", () => {
    const snapshot = makeSnapshot();
    const text = formatCanaryReport(snapshot, compareToBaseline(snapshot, undefined), meta);

    expect(text).toContain("Milo canary");
    expect(text).toContain("Mode: fixtures");
    expect(text).toContain("Pass rate     90.0%");
    expect(text).toContain("fast 12");
    expect(text).toContain("mid 6");
    expect(text).toContain("frontier 4");
    expect(text).toContain("deepseek/deepseek-v4-flash 12");
  });

  it("reports 'no baseline' cleanly and does not print a drift section", () => {
    const snapshot = makeSnapshot();
    const text = formatCanaryReport(snapshot, compareToBaseline(snapshot, undefined), meta);
    expect(text).toContain("Baseline: none yet");
    expect(text).toContain("Result: PASS (no baseline)");
    expect(text).not.toContain("DRIFT");
  });

  it("prints PASS when compared to an identical baseline", () => {
    const snapshot = makeSnapshot();
    const drift = compareToBaseline(snapshot, snapshot, DEFAULT_DRIFT_THRESHOLDS);
    const text = formatCanaryReport(snapshot, drift, meta);
    expect(text).toContain("Result: PASS (no drift)");
  });

  it("prints DRIFT DETECTED and names the breached metric with its delta and threshold", () => {
    const current = makeSnapshot({ passRate: 0.5 });
    const baseline = makeSnapshot({ passRate: 0.95 });
    const drift = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    const text = formatCanaryReport(current, drift, meta);

    expect(text).toContain("Result: DRIFT DETECTED");
    expect(text).toContain("Pass rate moved");
    expect(text).toMatch(/threshold 10/);
  });

  it("names a breached tier shift", () => {
    const current = makeSnapshot({ tierCounts: { fast: 1, mid: 11, frontier: 10 }, scoredN: 22 });
    const baseline = makeSnapshot({ tierCounts: { fast: 12, mid: 6, frontier: 4 }, scoredN: 22 });
    const drift = compareToBaseline(current, baseline, DEFAULT_DRIFT_THRESHOLDS);
    const text = formatCanaryReport(current, drift, meta);
    expect(text).toContain("Result: DRIFT DETECTED");
    expect(text).toMatch(/tier share moved/);
  });

  it("prints '(none scored)' for models when nothing was scored", () => {
    const snapshot = makeSnapshot({ scoredN: 0, unscoredN: 24, tierCounts: { fast: 0, mid: 0, frontier: 0 }, modelCounts: {} });
    const text = formatCanaryReport(snapshot, compareToBaseline(snapshot, undefined), meta);
    expect(text).toContain("(none scored)");
  });
});
