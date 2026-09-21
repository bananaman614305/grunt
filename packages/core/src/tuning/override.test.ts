import { describe, expect, it } from "vitest";
import {
  buildOverride,
  checkApplicable,
  DEFAULT_OVERRIDE_PATH,
  parsePolicyOverride,
  POLICY_OVERRIDE_VERSION,
} from "./override.js";
import { DEFAULT_THRESHOLDS, type PolicyChange, type PolicyProposal } from "./propose.js";

function change(overrides: Partial<PolicyChange> = {}): PolicyChange {
  return {
    kind: "band-samples",
    target: "band 1",
    band: 1,
    from: 1,
    to: 5,
    rule: "R1",
    rationale: "band 1 passes 60.0% of 400 graded requests",
    evidence: {
      n: 400,
      gradedN: 400,
      passRate: 0.6,
      passRateDelta: null,
      qualityLift: null,
      qualityLiftN: 0,
      avgCostUsd: 0.0001,
      costRatio: null,
    },
    lowN: false,
    ...overrides,
  };
}

function proposal(changes: PolicyChange[]): PolicyProposal {
  return {
    generatedAt: "2026-09-20T12:00:00.000Z",
    policyVersion: "v4",
    thresholds: DEFAULT_THRESHOLDS,
    source: { decisions: 1000, banded: 980, unbanded: 20 },
    changes,
    lowNCells: [],
    caveats: ["the gate verdict is a proxy"],
  };
}

describe("checkApplicable", () => {
  it("accepts a proposal whose every change clears the sample-size floor", () => {
    expect(checkApplicable(proposal([change()]))).toEqual({ ok: true });
  });

  it("refuses when any change is low-n, naming it", () => {
    const result = checkApplicable(
      proposal([change(), change({ target: "band 2", band: 2, lowN: true, evidence: { ...change().evidence, gradedN: 40 } })]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("band 2");
    expect(result.blockers[0]).toContain("40 graded requests");
    expect(result.blockers[0]).toContain("under the 200");
  });

  it("refuses a proposal with nothing in it", () => {
    const result = checkApplicable(proposal([]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.blockers[0]).toContain("no changes");
  });
});

describe("buildOverride", () => {
  it("folds band, task and threshold changes into one document", () => {
    const doc = buildOverride(
      proposal([
        change(),
        change({ kind: "task-samples", target: "band 2 / edit", band: 2, taskType: "edit", from: 5, to: 1, rule: "R3" }),
        change({
          kind: "profile-threshold",
          target: "fastBelowMass",
          threshold: "fastBelowMass",
          from: 0.35,
          to: 0.4,
          rule: "R4",
        }),
      ]),
    );

    expect(doc.bandSamples).toEqual({ "1": 5 });
    expect(doc.taskSamples).toEqual({ "2": { edit: 1 } });
    expect(doc.profile).toEqual({ fastBelowMass: 0.4 });
    expect(doc.version).toBe(POLICY_OVERRIDE_VERSION);
    expect(doc.policyVersion).toBe("v4");
    expect(doc.source.decisions).toBe(1000);
  });

  it("marks every document as needing a benchmark and says nothing reads it", () => {
    const doc = buildOverride(proposal([change()]));

    expect(doc.requiresBenchmark).toBe(true);
    expect(doc.note).toContain("NOT in force");
    expect(doc.note).toContain("benchmark");
  });

  it("carries the evidence and the caveats with the numbers", () => {
    const doc = buildOverride(proposal([change()]));

    expect(doc.evidence).toHaveLength(1);
    expect(doc.caveats).toEqual(["the gate verdict is a proxy"]);
  });

  it("round-trips through the schema", () => {
    const doc = buildOverride(proposal([change()]));
    const parsed = parsePolicyOverride(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });

  it("omits the maps a proposal never touched", () => {
    const doc = buildOverride(proposal([change()]));
    expect(doc.taskSamples).toBeUndefined();
    expect(doc.profile).toBeUndefined();
  });
});

describe("parsePolicyOverride", () => {
  it("rejects a document that claims it does not need a benchmark", () => {
    const doc = { ...buildOverride(proposal([change()])), requiresBenchmark: false };
    expect(() => parsePolicyOverride(doc)).toThrow(/requiresBenchmark/);
  });

  it("rejects an out-of-range sample count", () => {
    const doc = { ...buildOverride(proposal([change()])), bandSamples: { "1": 99 } };
    expect(() => parsePolicyOverride(doc)).toThrow(/bandSamples/);
  });

  it("rejects an unknown band key", () => {
    const doc = { ...buildOverride(proposal([change()])), bandSamples: { "9": 5 } };
    expect(() => parsePolicyOverride(doc)).toThrow(/invalid document/);
  });
});

describe("DEFAULT_OVERRIDE_PATH", () => {
  it("sits beside the decision log, not in the source tree", () => {
    expect(DEFAULT_OVERRIDE_PATH).toBe("./.milo/policy-override.json");
  });
});
