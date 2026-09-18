import { describe, expect, it } from "vitest";
import { armLabel, formatBenchMarkdown, percentile, summarizeArm, summarizeCompute, summarizeJudgeAudit, summarizeRouting, summarizeSpend, summaryArms } from "./report.js";
import type { ArmResult, BenchReport, BenchRow, ComputeRecord, Grade } from "./types.js";

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
    providerPins: {},
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

  it("scores agreement on the unsampled tier when the gateway sampled", () => {
    const sampledRow = row("r-s", "mid", [
      result({ arm: "milo", model: "fast/model", tier: "fast", unsampledTier: "mid", gatewaySamples: 5, grade: pass }),
    ]);
    const routing = summarizeRouting(report([sampledRow]));
    expect(routing.tiers).toEqual({ fast: 0, mid: 1, frontier: 0 });
    expect(routing.agreement).toBe(1);
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
    expect(md).toContain("| r-2 | chat | 0 | frontier | fast | fast/model | – | ✗ | ✓ | – | ✗ |");
  });
});

describe("spend and judge audit", () => {
  const judged = (over: Partial<Grade>): Grade => ({ score: 0.9, pass: true, by: "judge", ...over });

  function auditedReport(): BenchReport {
    const rows: BenchRow[] = [
      row("r-1", "fast", [
        result({ arm: "milo", model: "fast/model", tier: "fast", costUsd: 0.001, grade: judged({ judgeCostUsd: 0.0001, audit: { model: "judge/strong", score: 0.4, pass: false, judgeCostUsd: 0.002 } }) }),
        result({ arm: "fast", model: "fast/model", tier: "fast", costUsd: 0.002, grade: judged({ judgeCostUsd: 0.0001 }) }),
      ]),
      row("r-2", "fast", [
        // A cache hit: judged, no fresh cost; audited and agreeing.
        result({ arm: "fast", model: "fast/model", tier: "fast", costUsd: 0.004, grade: judged({ audit: { model: "judge/strong", score: 0.9, pass: true } }) }),
        // A failed call costs nothing and is not judged.
        result({ arm: "milo", model: "x", tier: "mid", status: 503, error: "HTTP 503", costUsd: 9 }),
      ]),
    ];
    const r = report(rows);
    r.judgeAudit = { model: "judge/strong", fraction: 0.5 };
    r.judgeCacheStats = { hits: 1, misses: 2 };
    return r;
  }

  it("splits the spend into arms, samples, and fresh judge calls", () => {
    const spend = summarizeSpend(auditedReport());
    expect(spend.armsUsd).toBeCloseTo(0.007, 9); // the failed call's cost is not counted
    expect(spend.samplesUsd).toBe(0);
    expect(spend.judgeUsd).toBeCloseTo(0.0001 + 0.0001 + 0.002, 9); // two fresh primaries + one fresh audit; the hit is free
    expect(spend.totalUsd).toBeCloseTo(0.007 + 0.0022, 9);
  });

  it("counts sample draws and their judge costs once, leaving the synthetic best-of arms out", () => {
    const shared: Grade = judged({ judgeCostUsd: 0.0005 });
    const rows: BenchRow[] = [
      {
        ...row("r-1", "fast", [
          result({ arm: "fast", model: "fast/model", tier: "fast", costUsd: 0.001 }),
          result({ arm: "bestof-jev", model: "fast/model", tier: "fast", costUsd: 0.02, grade: shared }),
        ]),
        samples: [
          { index: 0, variant: "", model: "fast/model", status: 200, ttfbMs: 1, totalMs: 2, costUsd: 0.01, grade: shared },
          { index: 1, variant: "", model: "fast/model", status: 200, ttfbMs: 1, totalMs: 2, costUsd: 0.01, grade: judged({ judgeCostUsd: 0.0005, pass: false, score: 0 }) },
        ],
      },
    ];
    const r = report(rows);
    r.sampling = { n: 2, model: "fast/model", tier: "fast", vary: false, jevUsdPerCall: 0.00002 };
    const spend = summarizeSpend(r);
    expect(spend.armsUsd).toBeCloseTo(0.001, 9); // not the best-of arm's 0.02
    expect(spend.samplesUsd).toBeCloseTo(0.02, 9);
    expect(spend.judgeUsd).toBeCloseTo(0.001, 9); // each sample's judge call once, the shared grade not double-counted
  });

  it("summarizes the audit: agreement, pass-rate delta, both judges' costs", () => {
    const audit = summarizeJudgeAudit(auditedReport());
    expect(audit).toEqual({
      model: "judge/strong",
      fraction: 0.5,
      judged: 3,
      audited: 2,
      agreement: 0.5, // r-2 agreed, r-1 did not
      passRateDelta: 0.5, // primary 2/2 pass, audit 1/2
      primaryUsd: 0.0002,
      auditUsd: 0.002,
    });
    expect(summarizeJudgeAudit(report([]))).toBeUndefined();
  });

  it("prints the spend, judge-cost, and judge-audit header lines", () => {
    const md = formatBenchMarkdown(auditedReport());
    expect(md).toContain("- Judge: `judge/model`, judge cost $0.00220 (fresh calls only; cache 1 hits, 2 misses)");
    expect(md).toContain(
      "- Judge audit: `judge/strong` re-judged 2 of 3 judged answers (fraction 50.0%): agreement 50.0%, pass-rate delta +50.0 pp (primary minus audit); primary judge $0.00020, audit $0.00200",
    );
    expect(md).toContain("- Spend: $0.00920 upstream — arms $0.00700, judge $0.00220");
  });

  it("says the cache was bypassed when no stats were recorded", () => {
    const md = formatBenchMarkdown(report([]));
    expect(md).toContain("(fresh calls only; cache bypassed)");
    expect(md).not.toContain("- Judge audit:");
  });
});

describe("deepseek and custom arms in the report", () => {
  const band2: ComputeRecord = { band: 2, budget: 5, completed: 3, aborted: 2, earlyStop: true, pick: 0, sizingLatencyMs: 20, rankLatencyMs: 5, jevCalls: 4, jevCostUsd: 0.00008, samples: [] };
  const band0: ComputeRecord = { band: 0, budget: 1, completed: 1, aborted: 0, earlyStop: false, pick: 0, sizingLatencyMs: 30, jevCalls: 1, jevCostUsd: 0.00002, samples: [] };

  const rows = [
    row("r-1", "fast", [
      result({ arm: "fast", model: "fast/model", tier: "fast", grade: pass }),
      result({ arm: "deepseek", model: "ds/flash", tier: "fast", grade: pass, costUsd: 0.001, jevLatencyMs: 20, compute: band2 }),
      result({ arm: "custom:anthropic/claude-fable-5.1", model: "anthropic/claude-fable-5.1", tier: "mid", grade: fail, costUsd: 0.01 }),
    ]),
    row("r-2", "fast", [
      result({ arm: "deepseek", model: "ds/flash", tier: "fast", grade: pass, costUsd: 0.0005, compute: band0 }),
    ]),
  ];
  const r = report(rows);

  it("summaryArms appends the extra arms in first-seen order and armLabel names a custom arm by its model", () => {
    const arms = summaryArms(r);
    expect(arms.slice(-2)).toEqual(["deepseek", "custom:anthropic/claude-fable-5.1"]);
    expect(armLabel("custom:anthropic/claude-fable-5.1")).toBe("anthropic/claude-fable-5.1");
    expect(armLabel("deepseek")).toBe("deepseek");
  });

  it("summarizeCompute aggregates budgets per band, adaptive stops, and Jev spend", () => {
    const c = summarizeCompute(r);
    expect(c).toBeDefined();
    expect(c?.sized).toBe(2);
    expect(c?.byBand).toEqual([
      { band: 0, model: "ds/flash", samples: 1, count: 1 },
      { band: 2, model: "ds/flash", samples: 5, count: 1 },
    ]);
    expect(c?.multiSample).toBe(1);
    expect(c?.earlyStops).toBe(1);
    expect(c?.aborted).toBe(2);
    expect(c?.meanCompleted).toBe(3);
    expect(c?.meanBudget).toBe(5);
    expect(c?.jevUsd).toBeCloseTo(0.0001, 9);
  });

  it("is undefined when the arm never ran", () => {
    expect(summarizeCompute(report([rows[0] as BenchRow].map((x) => ({ ...x, results: x.results.filter((res) => res.arm === "fast") }))))).toBeUndefined();
  });

  it("the markdown includes both arms in the headline and a compute-controller section", () => {
    const md = formatBenchMarkdown(r);
    expect(md).toContain("`deepseek`");
    expect(md).toContain("`anthropic/claude-fable-5.1`");
    expect(md).not.toContain("`custom:anthropic/claude-fable-5.1`");
    expect(md).toContain("## Compute controller (`deepseek` arm, ADR-012 phase 1)");
    expect(md).toContain("Adaptive stops: 1 of 1 multi-sample budgets returned early, aborting 2 stragglers");
    expect(md).toContain("mean 3.0 of 5.0 budgeted");
  });

  it("counts deepseek and custom arms as real arms in the spend summary", () => {
    const spend = summarizeSpend(r);
    // fast (tokens: 1000*0.1/1e6 + 100*0.2/1e6 = 0.00012) + 0.001 + 0.01 + 0.0005.
    expect(spend.armsUsd).toBeCloseTo(0.01162, 9);
  });
});
