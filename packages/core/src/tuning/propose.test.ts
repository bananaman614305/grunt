import { describe, expect, it } from "vitest";
import { aggregateDecisions, type TuningInputDecision } from "./aggregate.js";
import { DEFAULT_THRESHOLDS, propose, proposedProfile, TUNING_CAVEATS } from "./propose.js";
import type { RouteSignals, SampleUpstream, TaskType } from "../types.js";

const LEVELS: Record<0 | 1 | 2 | 3, number[]> = {
  0: [0.9, 0.1, 0, 0],
  1: [0.1, 0.6, 0.28, 0.02],
  2: [0.1, 0.2, 0.68, 0.02],
  3: [0.1, 0.3, 0.3, 0.3],
};

const NOW = new Date("2026-09-20T12:00:00.000Z");

function signals(band: 0 | 1 | 2 | 3, taskType: TaskType): RouteSignals {
  return {
    taskType,
    difficulty: band,
    difficultyLevels: LEVELS[band],
    needsReasoning: 0.4,
    longOutput: 0.2,
    confidences: {},
    jevRequestId: "req",
    jevModel: "jev-latest",
    latencyMs: 300,
  };
}

type RowOptions = {
  band: 0 | 1 | 2 | 3;
  taskType?: TaskType;
  samples?: number;
  pass?: boolean;
  costUsd?: number;
  sampleScores?: number[];
  samplePick?: number;
};

function row(opts: RowOptions): TuningInputDecision {
  const decision: TuningInputDecision = {
    tier: "fast",
    model: "deepseek/deepseek-v4-flash",
    signals: signals(opts.band, opts.taskType ?? "feature"),
    upstream: {
      status: 200,
      latencyMs: 300,
      costUsd: opts.costUsd ?? 0.0001,
      gate: { verdict: opts.pass === false ? "incomplete" : "complete", confidence: 0.9 },
    },
  };
  if (opts.samples !== undefined) decision.samples = opts.samples;
  if (opts.sampleScores !== undefined && decision.upstream) {
    decision.upstream.samples = opts.sampleScores.map(
      (score, index): SampleUpstream => ({ index, status: 200, latencyMs: 10, jevQuality: score }),
    );
    decision.upstream.samplePick = opts.samplePick ?? 0;
  }
  return decision;
}

/** `count` rows in one cell, `passing` of which the gate called complete. */
function cell(count: number, passing: number, opts: RowOptions): TuningInputDecision[] {
  return Array.from({ length: count }, (_, i) => row({ ...opts, pass: i < passing }));
}

function proposalFor(decisions: TuningInputDecision[], thresholds = {}) {
  const report = aggregateDecisions(decisions);
  return { report, proposal: propose(report, { now: NOW, thresholds }) };
}

describe("propose", () => {
  it("R1: proposes sampling for a one-call band whose pass rate is low", () => {
    // Band 1 is budgeted at one call (ADR-012). 120 graded, 60% passing.
    const { proposal } = proposalFor(cell(120, 72, { band: 1 }));

    const change = proposal.changes.find((c) => c.rule === "R1");
    expect(change).toBeDefined();
    expect(change?.kind).toBe("band-samples");
    expect(change?.band).toBe(1);
    expect(change?.from).toBe(1);
    expect(change?.to).toBe(5);
    expect(change?.evidence.gradedN).toBe(120);
    expect(change?.evidence.passRate).toBeCloseTo(0.6, 10);
    expect(change?.rationale).toContain("60.0%");
  });

  it("R1: stays quiet when the one-call band already passes", () => {
    const { proposal } = proposalFor(cell(120, 115, { band: 1 }));
    expect(proposal.changes.filter((c) => c.rule === "R1")).toHaveLength(0);
  });

  it("R2: proposes dropping a sampled band that passes well and shows no lift", () => {
    // Band 2 is budgeted best-of-5. Every request passes, and the picked
    // sample scores no better than the mean of its own draws.
    const { proposal } = proposalFor(cell(120, 120, { band: 2, samples: 5, sampleScores: [2.5, 2.5, 2.5] }));

    const change = proposal.changes.find((c) => c.rule === "R2");
    expect(change).toBeDefined();
    expect(change?.band).toBe(2);
    expect(change?.from).toBe(5);
    expect(change?.to).toBe(1);
    expect(change?.rationale).toContain("one call may be enough");
  });

  it("R2: refuses to drop sampling that is measurably buying quality", () => {
    // Picked 3.0 against a mean of 2.0: a lift of 1.0, far over minQualityLift.
    const { proposal } = proposalFor(
      cell(120, 120, { band: 2, samples: 5, sampleScores: [1, 2, 3], samplePick: 2 }),
    );
    expect(proposal.changes.filter((c) => c.rule === "R2")).toHaveLength(0);
  });

  it("R2: refuses to drop sampling on a band that is failing anyway", () => {
    // No lift, but only 60% passing: the band needs a better model, which is a
    // benchmark question, not a budget cut.
    const { proposal } = proposalFor(cell(120, 72, { band: 2, samples: 5, sampleScores: [2, 2, 2] }));
    expect(proposal.changes.filter((c) => c.rule === "R2")).toHaveLength(0);
  });

  it("R3: drops one task type inside a sampling band that otherwise holds", () => {
    const decisions = [
      // `edit` sampling buys nothing.
      ...cell(80, 80, { band: 2, taskType: "edit", samples: 5, sampleScores: [2.5, 2.5, 2.5] }),
      // `debug` sampling clearly does, so the band as a whole is not dropped.
      ...cell(80, 60, { band: 2, taskType: "debug", samples: 5, sampleScores: [1, 2, 3], samplePick: 2 }),
    ];
    const { proposal } = proposalFor(decisions);

    expect(proposal.changes.filter((c) => c.rule === "R2")).toHaveLength(0);
    const change = proposal.changes.find((c) => c.rule === "R3");
    expect(change?.kind).toBe("task-samples");
    expect(change?.taskType).toBe("edit");
    expect(change?.band).toBe(2);
    expect(change?.to).toBe(1);
    expect(change?.target).toBe("band 2 / edit");
  });

  it("R3: does not repeat a drop the band-level rule already proposed", () => {
    const { proposal } = proposalFor(cell(120, 120, { band: 2, taskType: "edit", samples: 5, sampleScores: [2, 2, 2] }));

    expect(proposal.changes.filter((c) => c.rule === "R2")).toHaveLength(1);
    expect(proposal.changes.filter((c) => c.rule === "R3")).toHaveLength(0);
  });

  it("R4: raises the fast gate when band 0 trails the pooled pass rate", () => {
    const decisions = [
      ...cell(200, 120, { band: 0 }), // 60% on the cheapest path
      ...cell(200, 190, { band: 1 }), // 95% elsewhere
    ];
    const { report, proposal } = proposalFor(decisions);

    const change = proposal.changes.find((c) => c.rule === "R4");
    expect(change?.kind).toBe("profile-threshold");
    expect(change?.threshold).toBe("fastBelowMass");
    expect(change?.from).toBe(report.profile.fastBelowMass);
    expect(change?.to).toBeCloseTo(0.4, 10);
    expect(proposedProfile(report, proposal)["fastBelowMass"]).toBeCloseTo(0.4, 10);
  });

  it("R4: stays quiet when band 0 is doing as well as everything else", () => {
    const decisions = [...cell(200, 190, { band: 0 }), ...cell(200, 190, { band: 1 })];
    const { proposal } = proposalFor(decisions);
    expect(proposal.changes.filter((c) => c.rule === "R4")).toHaveLength(0);
  });

  it("R5: lowers the hard-mass threshold when band 3 outperforms band 2", () => {
    const decisions = [
      ...cell(200, 140, { band: 2, samples: 5, sampleScores: [1, 2, 3], samplePick: 2 }), // 70%
      ...cell(200, 190, { band: 3, samples: 5, sampleScores: [1, 2, 3], samplePick: 2 }), // 95%
    ];
    const { report, proposal } = proposalFor(decisions);

    const change = proposal.changes.find((c) => c.rule === "R5");
    expect(change?.threshold).toBe("frontierHardMass");
    expect(change?.from).toBe(report.profile.frontierHardMass);
    expect(change?.to).toBeCloseTo(0.01, 10); // floored at the bound, not negative
  });

  it("flags a low-n change rather than hiding it, and leaves it blocking --apply", () => {
    // 60 graded: over minCellN (50) so a rule fires, under applyMinN (200).
    const { proposal } = proposalFor(cell(60, 30, { band: 1 }));

    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0]?.lowN).toBe(true);
    expect(proposal.changes[0]?.evidence.gradedN).toBe(60);
  });

  it("does not judge a cell under minCellN, and says why", () => {
    const { proposal } = proposalFor(cell(10, 1, { band: 1 }));

    expect(proposal.changes).toHaveLength(0);
    expect(proposal.lowNCells).toHaveLength(1);
    expect(proposal.lowNCells[0]?.target).toBe("band 1");
    expect(proposal.lowNCells[0]?.gradedN).toBe(10);
    expect(proposal.lowNCells[0]?.why).toContain("under the 50");
  });

  it("honors a caller's own thresholds", () => {
    const decisions = cell(10, 1, { band: 1 });
    const report = aggregateDecisions(decisions);

    const strict = propose(report, { now: NOW });
    expect(strict.changes).toHaveLength(0);

    const loose = propose(report, { now: NOW, thresholds: { minCellN: 5, applyMinN: 5 } });
    expect(loose.changes).toHaveLength(1);
    expect(loose.changes[0]?.lowN).toBe(false);
  });

  it("records the source window, the policy version, and the standing caveats", () => {
    const { proposal } = proposalFor(cell(60, 30, { band: 1 }), {});

    expect(proposal.generatedAt).toBe(NOW.toISOString());
    expect(proposal.policyVersion).toBe("v4");
    expect(proposal.source.decisions).toBe(60);
    expect(proposal.source.banded).toBe(60);
    expect(proposal.caveats).toEqual([...TUNING_CAVEATS]);
    expect(proposal.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("proposes nothing on an empty log", () => {
    const { proposal } = proposalFor([]);
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.lowNCells).toHaveLength(0);
  });

  it("is deterministic: the same rows and clock give the same proposal", () => {
    const decisions = cell(120, 72, { band: 1 });
    const a = propose(aggregateDecisions(decisions), { now: NOW });
    const b = propose(aggregateDecisions(decisions), { now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
