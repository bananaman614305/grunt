import { describe, expect, it } from "vitest";
import { formatBenchMarkdown, percentile, summarizeArm, summarizeRouting } from "./report.js";
import type { ArmResult, BenchReport, BenchRow } from "./types.js";

const FABLE = { id: "anthropic/claude-fable-5.1", inputUsdPerM: 10, outputUsdPerM: 50 };
const PRICES = {
  "fast/model": { id: "fast/model", inputUsdPerM: 0.1, outputUsdPerM: 0.2 },
  "frontier/model": { id: "frontier/model", inputUsdPerM: 1, outputUsdPerM: 4 },
};

function result(partial: Partial<ArmResult> & Pick<ArmResult, "arm" | "model" | "tier">): ArmResult {
  return { status: 200, ttfbMs: 100, totalMs: 1000, inputTokens: 1000, outputTokens: 100, ...partial };
}

function row(id: string, expectedTier: BenchRow["expectedTier"], results: ArmResult[], hasGrader = true): BenchRow {
  return { id, taskType: "chat", difficultyBand: 0, expectedTier, hasGrader, results };
}

const pass = { score: 1, pass: true, by: "mechanical" as const };
const fail = { score: 0, pass: false, by: "mechanical" as const };

function report(rows: BenchRow[]): BenchReport {
  return {
    generatedAt: "2026-09-17T00:00:00.000Z",
    gateway: "http://gw/v1",
    posture: "balanced",
    fixedModels: { fast: "fast/model", mid: "mid/model", frontier: "frontier/model" },
    prices: PRICES,
    baseline: FABLE,
    judgeModel: "judge/model",
    rows,
  };
}

describe("percentile", () => {
  it("is nearest-rank and NaN on empty", () => {
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

describe("summarizeArm", () => {
  const rows = [
    row("r-1", "fast", [
      result({ arm: "milo", model: "fast/model", tier: "fast", costUsd: 0.00003, grade: pass, ttfbMs: 150, jevLatencyMs: 120 }),
      result({ arm: "fast", model: "fast/model", tier: "fast", costUsd: 0.00003, grade: pass, ttfbMs: 100 }),
      result({ arm: "frontier", model: "frontier/model", tier: "frontier", costUsd: 0.0014, grade: pass, ttfbMs: 300 }),
    ]),
    row("r-2", "frontier", [
      result({ arm: "milo", model: "fast/model", tier: "fast", grade: fail, ttfbMs: 160, jevLatencyMs: 200 }),
      result({ arm: "fast", model: "fast/model", tier: "fast", grade: fail, ttfbMs: 90 }),
      result({ arm: "frontier", model: "frontier/model", tier: "frontier", costUsd: 0.0014, grade: pass, ttfbMs: 400 }),
    ]),
    row("r-3", "mid", [result({ arm: "milo", model: "x", tier: "mid", status: 503, error: "HTTP 503" })], false),
  ];
  const r = report(rows);

  it("counts calls, successes, grades, and pass rate", () => {
    const milo = summarizeArm(r, "milo");
    expect(milo.calls).toBe(3);
    expect(milo.ok).toBe(2);
    expect(milo.graded).toBe(2);
    expect(milo.passRate).toBe(0.5);
    expect(milo.qualityRetained).toBe(0.5);
  });

  it("uses the reported cost, falling back to price times tokens, and estimates the baseline", () => {
    const milo = summarizeArm(r, "milo");
    // r-1 reported 0.00003; r-2 fell back to 1000*0.1/1e6 + 100*0.2/1e6 = 0.00012.
    expect(milo.costUsd).toBeCloseTo(0.00015, 9);
    // Baseline per call: 1000*10/1e6 + 100*50/1e6 = 0.015; two calls.
    expect(milo.baselineUsd).toBeCloseTo(0.03, 9);
    expect(milo.baselineUsd2x).toBeCloseTo(0.04, 9);
    expect(milo.savings).toBeCloseTo(1 - 0.00015 / 0.03, 6);
    expect(milo.savings2x).toBeCloseTo(1 - 0.00015 / 0.04, 6);
  });

  it("oracle picks the fixed arm of the labeled tier", () => {
    const oracle = summarizeArm(r, "oracle");
    // r-1 -> fast (pass), r-2 -> frontier (pass), r-3 -> mid (absent).
    expect(oracle.calls).toBe(2);
    expect(oracle.passRate).toBe(1);
    expect(oracle.qualityRetained).toBe(1);
  });

  it("summarizes routing: agreement, overhead against the same model, jev latency, downgrades", () => {
    const routing = summarizeRouting(r);
    expect(routing.tiers).toEqual({ fast: 2, mid: 0, frontier: 0 });
    expect(routing.agreement).toBe(0.5);
    expect(routing.overheadN).toBe(2);
    expect(routing.overheadP50).toBe(50);
    expect(routing.overheadP95).toBe(70);
    expect(routing.jevLatencyN).toBe(2);
    expect(routing.jevLatencyMean).toBe(160);
    expect(routing.comparedN).toBe(2);
    expect(routing.badDowngrades).toBe(1);
    expect(routing.missedSavings).toBe(0);
  });

  it("renders markdown with the headline, routing, failures, and per-example sections", () => {
    const md = formatBenchMarkdown(r);
    expect(md).toContain("# Milo benchmark report");
    expect(md).toContain("| `milo` | 2/3 | 2 | 50.0% |");
    expect(md).toContain("| `oracle` |");
    expect(md).toContain("Bad downgrades (routed cheaper than frontier, failed, frontier passed): 1 of 2");
    expect(md).toContain("- **r-3** `milo` (x): HTTP 503");
    expect(md).toContain("| r-2 | chat | 0 | frontier | fast | fast/model | ✗ | ✓ | – | ✗ |");
  });
});
