import { describe, expect, it } from "vitest";
import { aggregateDecisions, sampleQualityLift, type TuningInputDecision } from "./aggregate.js";
import type { GateUpstream, RouteSignals, SampleUpstream, TaskType } from "../types.js";

/**
 * Level distributions that land a decision in each band under `JEV_PROFILE`
 * (fast gate on P1+ below 0.35, hard gate on P3 at 0.05, upper gate at 0.65).
 */
const LEVELS: Record<0 | 1 | 2 | 3, number[]> = {
  0: [0.9, 0.1, 0, 0],
  1: [0.1, 0.6, 0.28, 0.02],
  2: [0.1, 0.2, 0.68, 0.02],
  3: [0.1, 0.3, 0.3, 0.3],
};

function signals(band: 0 | 1 | 2 | 3, taskType: TaskType = "feature"): RouteSignals {
  const levels = LEVELS[band];
  return {
    taskType,
    difficulty: band,
    difficultyLevels: levels,
    needsReasoning: 0.4,
    longOutput: 0.2,
    confidences: { difficulty: 0.9 },
    jevRequestId: `req-${band}`,
    jevModel: "jev-latest",
    latencyMs: 300,
  };
}

type RowOptions = {
  band: 0 | 1 | 2 | 3;
  taskType?: TaskType;
  samples?: number;
  sticky?: boolean;
  costUsd?: number;
  status?: number;
  verdict?: string;
  confidence?: number;
  retried?: boolean;
  pick?: "original" | "retry";
  sampleScores?: number[];
  samplePick?: number;
  sampleNote?: "ranking_failed" | "all_samples_failed";
  noUpstream?: boolean;
  createdAt?: string;
};

function row(opts: RowOptions): TuningInputDecision {
  const decision: TuningInputDecision = {
    tier: "fast",
    model: "deepseek/deepseek-v4-flash",
    signals: signals(opts.band, opts.taskType),
  };
  if (opts.samples !== undefined) decision.samples = opts.samples;
  if (opts.sticky !== undefined) decision.sticky = opts.sticky;
  if (opts.createdAt !== undefined) decision.createdAt = opts.createdAt;
  if (opts.noUpstream === true) return decision;

  const upstream: NonNullable<TuningInputDecision["upstream"]> = {
    status: opts.status ?? 200,
    latencyMs: 400,
  };
  if (opts.costUsd !== undefined) upstream.costUsd = opts.costUsd;
  if (opts.verdict !== undefined) {
    const gate: GateUpstream = { verdict: opts.verdict };
    if (opts.confidence !== undefined) gate.confidence = opts.confidence;
    if (opts.retried !== undefined) gate.retried = opts.retried;
    if (opts.pick !== undefined) gate.pick = opts.pick;
    upstream.gate = gate;
  }
  if (opts.sampleScores !== undefined) {
    upstream.samples = opts.sampleScores.map(
      (score, index): SampleUpstream => ({ index, status: 200, latencyMs: 100, jevQuality: score }),
    );
    upstream.samplePick = opts.samplePick ?? 0;
  }
  if (opts.sampleNote !== undefined) upstream.sampleNote = opts.sampleNote;
  decision.upstream = upstream;
  return decision;
}

describe("aggregateDecisions", () => {
  it("bands each decision with the controller's own rule and rolls up per band", () => {
    const report = aggregateDecisions([
      row({ band: 0 }),
      row({ band: 0 }),
      row({ band: 1 }),
      row({ band: 2 }),
      row({ band: 3 }),
    ]);

    expect(report.total).toBe(5);
    expect(report.banded).toBe(5);
    expect(report.bands.map((b) => [b.band, b.n])).toEqual([
      [0, 2],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  it("carries ADR-012's configured budget alongside each band", () => {
    const report = aggregateDecisions([row({ band: 1 }), row({ band: 2 }), row({ band: 3 })]);
    const byBand = new Map(report.bands.map((b) => [b.band, b]));

    expect(byBand.get(1)?.configuredSamples).toBe(1);
    expect(byBand.get(2)?.configuredSamples).toBe(5);
    expect(byBand.get(2)?.configuredModel).toBe("deepseek/deepseek-v4-flash");
    expect(byBand.get(3)?.configuredModel).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("counts decisions with no signals as unbanded and leaves them out of the cells", () => {
    const report = aggregateDecisions([
      row({ band: 0 }),
      { tier: "mid", model: "openai/gpt-5.6-luna" },
      { tier: "mid", model: "openai/gpt-5.6-luna" },
    ]);

    expect(report.total).toBe(3);
    expect(report.banded).toBe(1);
    expect(report.unbanded).toBe(2);
    expect(report.bands).toHaveLength(1);
    expect(report.overall.n).toBe(1);
  });

  it("splits cells per task type and names them", () => {
    const report = aggregateDecisions([
      row({ band: 2, taskType: "edit" }),
      row({ band: 2, taskType: "edit" }),
      row({ band: 2, taskType: "docs" }),
    ]);

    expect(report.cells.map((c) => [c.target, c.n])).toEqual([
      ["band 2 / docs", 1],
      ["band 2 / edit", 2],
    ]);
  });

  it("computes the pass rate over graded requests only, and excludes gate errors", () => {
    const report = aggregateDecisions([
      row({ band: 1, verdict: "complete", confidence: 0.9 }),
      row({ band: 1, verdict: "complete", confidence: 0.9 }),
      row({ band: 1, verdict: "incomplete", confidence: 0.9 }),
      row({ band: 1, verdict: "error" }), // the gate itself failed: not a grade
      row({ band: 1 }), // gates were off: not a grade
    ]);

    const band = report.bands[0];
    expect(band?.n).toBe(5);
    expect(band?.gate.answered).toBe(3);
    expect(band?.gate.ungraded).toBe(2);
    expect(band?.gate.complete).toBe(2);
    expect(band?.gate.failed).toBe(1);
    expect(band?.gate.passRate).toBeCloseTo(2 / 3, 10);
  });

  it("counts a low-confidence `complete` as a pass but also as suspect", () => {
    const report = aggregateDecisions([
      row({ band: 1, verdict: "complete", confidence: 0.95 }),
      row({ band: 1, verdict: "complete", confidence: 0.4 }),
    ]);

    const band = report.bands[0];
    expect(band?.gate.complete).toBe(2);
    expect(band?.gate.suspect).toBe(1);
    expect(band?.gate.passRate).toBe(1);
    expect(band?.gate.trustedPassRate).toBe(0.5);
  });

  it("reports the retry rate and how often the retry's answer won", () => {
    const report = aggregateDecisions([
      row({ band: 1, verdict: "incomplete", retried: true, pick: "retry" }),
      row({ band: 1, verdict: "incomplete", retried: true, pick: "original" }),
      row({ band: 1, verdict: "complete", confidence: 0.9 }),
      row({ band: 1, verdict: "complete", confidence: 0.9 }),
    ]);

    const band = report.bands[0];
    expect(band?.gate.retried).toBe(2);
    expect(band?.gate.retryWon).toBe(1);
    expect(band?.gate.retryRate).toBe(0.5);
  });

  it("averages cost over priced requests only", () => {
    const report = aggregateDecisions([
      row({ band: 0, costUsd: 0.0002 }),
      row({ band: 0, costUsd: 0.0004 }),
      row({ band: 0 }), // no cost reported: not in the denominator
    ]);

    const band = report.bands[0];
    expect(band?.cost.withCost).toBe(2);
    expect(band?.cost.avgUsd).toBeCloseTo(0.0003, 10);
    expect(band?.cost.totalUsd).toBeCloseTo(0.0006, 10);
  });

  it("counts upstream failures, degraded picks and sticky reuse", () => {
    const report = aggregateDecisions([
      row({ band: 0, status: 500 }),
      row({ band: 0, sticky: true }),
      row({ band: 0, samples: 5, sampleNote: "all_samples_failed" }),
      row({ band: 0, noUpstream: true }),
    ]);

    const band = report.bands[0];
    expect(band?.upstreamFailures).toBe(1);
    expect(band?.sticky).toBe(1);
    expect(band?.degraded).toBe(1);
    expect(band?.withUpstream).toBe(3);
  });

  it("splits a cell into its sampled and single-call arms and compares them", () => {
    const sampled = Array.from({ length: 4 }, () =>
      row({ band: 2, samples: 5, verdict: "complete", confidence: 0.9, costUsd: 0.0005 }),
    );
    const single = [
      row({ band: 2, verdict: "complete", confidence: 0.9, costUsd: 0.0001 }),
      row({ band: 2, verdict: "incomplete", costUsd: 0.0001 }),
      row({ band: 2, verdict: "incomplete", costUsd: 0.0001 }),
      row({ band: 2, verdict: "incomplete", costUsd: 0.0001 }),
    ];
    const report = aggregateDecisions([...sampled, ...single], { minArmN: 4 });

    const band = report.bands[0];
    expect(band?.sampling.sampled.n).toBe(4);
    expect(band?.sampling.single.n).toBe(4);
    expect(band?.sampling.sampled.gate.passRate).toBe(1);
    expect(band?.sampling.single.gate.passRate).toBe(0.25);
    expect(band?.sampling.passRateDelta).toBeCloseTo(0.75, 10);
    expect(band?.sampling.costRatio).toBeCloseTo(5, 10);
    expect(band?.sampling.comparable).toBe(true);
    expect(band?.observedSamples).toBe(1); // a tie breaks toward the smaller count
  });

  it("marks a comparison incomparable when one arm is too small", () => {
    const report = aggregateDecisions(
      [
        row({ band: 2, samples: 5, verdict: "complete", confidence: 0.9 }),
        row({ band: 2, verdict: "complete", confidence: 0.9 }),
      ],
      { minArmN: 20 },
    );

    expect(report.bands[0]?.sampling.comparable).toBe(false);
  });

  it("leaves the cross-arm delta null when one arm was never graded", () => {
    const report = aggregateDecisions([
      row({ band: 2, samples: 5, verdict: "complete", confidence: 0.9 }),
      row({ band: 2 }),
    ]);

    expect(report.bands[0]?.sampling.passRateDelta).toBeNull();
  });

  it("measures the within-decision sampling lift as pick minus mean", () => {
    const report = aggregateDecisions([
      row({ band: 2, samples: 3, sampleScores: [1, 2, 3], samplePick: 2 }),
      row({ band: 2, samples: 3, sampleScores: [1, 2, 3], samplePick: 1 }),
    ]);

    // Means are 2.0; picks are 3 and 2, so the lifts are +1 and 0.
    expect(report.bands[0]?.sampling.qualityLift).toBeCloseTo(0.5, 10);
    expect(report.bands[0]?.sampling.qualityLiftN).toBe(2);
  });

  it("leaves the lift null when no sampled decision carried per-sample scores", () => {
    const report = aggregateDecisions([row({ band: 2, samples: 5 }), row({ band: 2 })]);
    expect(report.bands[0]?.sampling.qualityLift).toBeNull();
    expect(report.bands[0]?.sampling.qualityLiftN).toBe(0);
  });

  it("reports the window the rows cover", () => {
    const report = aggregateDecisions([
      row({ band: 0, createdAt: "2026-09-19T00:00:00.000Z" }),
      row({ band: 0, createdAt: "2026-09-17T00:00:00.000Z" }),
    ]);

    expect(report.from).toBe("2026-09-17T00:00:00.000Z");
    expect(report.to).toBe("2026-09-19T00:00:00.000Z");
  });

  it("pools every banded decision into the overall row", () => {
    const report = aggregateDecisions([
      row({ band: 0, verdict: "complete", confidence: 0.9 }),
      row({ band: 3, verdict: "incomplete" }),
    ]);

    expect(report.overall.target).toBe("all bands");
    expect(report.overall.n).toBe(2);
    expect(report.overall.gate.passRate).toBe(0.5);
  });
});

describe("sampleQualityLift", () => {
  it("returns undefined with fewer than two scored samples", () => {
    expect(sampleQualityLift({ status: 200, latencyMs: 1 })).toBeUndefined();
    expect(
      sampleQualityLift({
        status: 200,
        latencyMs: 1,
        samples: [{ index: 0, status: 200, latencyMs: 1, jevQuality: 2 }],
        samplePick: 0,
      }),
    ).toBeUndefined();
  });

  it("falls back to the `picked` flag when no samplePick index is recorded", () => {
    const lift = sampleQualityLift({
      status: 200,
      latencyMs: 1,
      samples: [
        { index: 0, status: 200, latencyMs: 1, jevQuality: 1 },
        { index: 1, status: 200, latencyMs: 1, jevQuality: 3, picked: true },
      ],
    });
    expect(lift).toBeCloseTo(1, 10);
  });

  it("returns undefined when the pick is not among the scored samples", () => {
    expect(
      sampleQualityLift({
        status: 200,
        latencyMs: 1,
        samples: [
          { index: 0, status: 200, latencyMs: 1, jevQuality: 1 },
          { index: 1, status: 200, latencyMs: 1, jevQuality: 3 },
        ],
        samplePick: 7,
      }),
    ).toBeUndefined();
  });
});
