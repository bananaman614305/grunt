import { describe, expect, it } from "vitest";
import type { TaskRecord } from "./types.js";
import {
  beginTaskVerification,
  recordTaskAttempt,
  TASK_DELTA_LIMIT,
  TaskVerificationConflictError,
} from "./state.js";

const TASK: TaskRecord = {
  id: "task-1",
  version: 1,
  objective: "Ship a verified answer.",
  status: "active",
  acceptanceCriteria: [{
    id: "safe",
    requirement: "The answer is safe.",
    decision: "veto",
    evaluation: { type: "binary", pass: "No unsafe behavior is present." },
  }],
};

describe("durable task verification state", () => {
  it("resumes evidence and bounded attempt deltas across decisions", () => {
    const initial = beginTaskVerification(undefined, TASK, [{
      criterionId: "safe",
      verdict: "satisfied",
      confidence: 0.95,
      summary: "The deterministic safety check passed.",
      sourceRef: "check://safety/1",
    }], "decision-1", "2026-09-22T00:00:00.000Z");
    const attempted = recordTaskAttempt(initial, {
      decisionId: "decision-1",
      selection: "abstained",
      unresolvedCriteria: [{ criterionId: "safe", verdict: "unknown", confidence: 0.4 }],
      candidateDeltas: Array.from({ length: TASK_DELTA_LIMIT + 3 }, (_, index) => ({
        id: `delta-${index}`,
        decisionId: "decision-1",
        candidateId: `decision-1:sample-${index}`,
        outcome: "abstain" as const,
        summary: `Candidate ${index} abstained.`,
        sourceRef: `decision://decision-1/candidate/${index}`,
        criterionIds: ["safe"],
      })),
    }, "2026-09-22T00:01:00.000Z");
    const resumed = beginTaskVerification(attempted, TASK, [], "decision-2", "2026-09-22T00:02:00.000Z");

    expect(resumed.evidence).toEqual(initial.evidence);
    expect(resumed.candidateDeltas).toHaveLength(TASK_DELTA_LIMIT);
    expect(resumed.candidateDeltas[0]?.id).toBe("delta-3");
    expect(resumed.unresolvedObligations).toMatchObject([
      { criterionId: "__selection__" },
      { criterionId: "safe", verdict: "unknown" },
    ]);
    expect(resumed.provenance.map((entry) => entry.decisionId)).toEqual(["decision-1", "decision-1", "decision-2"]);
    expect(JSON.stringify(resumed)).not.toContain("candidate answer text");
  });

  it("rejects stale versions and same-version rubric mutation", () => {
    const initial = beginTaskVerification(undefined, { ...TASK, version: 2 }, [], "decision-1");
    expect(() => beginTaskVerification(initial, TASK, [], "decision-2")).toThrow(TaskVerificationConflictError);
    expect(() => beginTaskVerification(initial, {
      ...TASK,
      version: 2,
      acceptanceCriteria: [{ ...TASK.acceptanceCriteria[0]!, requirement: "A changed requirement." }],
    }, [], "decision-2")).toThrow(TaskVerificationConflictError);
  });

  it("accepts an explicit task version bump and resolves obligations on selection", () => {
    const initial = recordTaskAttempt(beginTaskVerification(undefined, TASK, [], "decision-1"), {
      decisionId: "decision-1",
      selection: "failed",
      candidateDeltas: [],
    });
    const bumped = beginTaskVerification(initial, { ...TASK, version: 2 }, [], "decision-2");
    const selected = recordTaskAttempt(bumped, {
      decisionId: "decision-2",
      selection: "selected",
      candidateDeltas: [],
      selectedCandidateId: "decision-2:sample-0",
      selectedCriteria: [{ criterionId: "safe", verdict: "satisfied", confidence: 0.9 }],
    });
    expect(selected.task.version).toBe(2);
    expect(selected.unresolvedObligations).toEqual([]);
  });

  it("clears rubric-dependent state when a version bump changes criterion meaning", () => {
    const initial = recordTaskAttempt(beginTaskVerification(undefined, TASK, [{
      criterionId: "safe",
      verdict: "satisfied",
      confidence: 0.99,
      summary: "The original safety check passed.",
      sourceRef: "check://old-safety",
    }], "decision-1"), {
      decisionId: "decision-1",
      selection: "failed",
      unresolvedCriteria: [{ criterionId: "safe", verdict: "unknown", confidence: 0 }],
      candidateDeltas: [{
        id: "decision-1:sample-0:delta",
        decisionId: "decision-1",
        candidateId: "decision-1:sample-0",
        outcome: "abstain",
        summary: "The original candidate abstained.",
        sourceRef: "decision://decision-1/candidate/0",
        criterionIds: ["safe"],
      }],
    });
    const changed = beginTaskVerification(initial, {
      ...TASK,
      version: 2,
      acceptanceCriteria: [{
        ...TASK.acceptanceCriteria[0]!,
        requirement: "A new security audit passes.",
        evaluation: { type: "deterministic", oracle: "new security audit receipt" },
      }],
    }, [], "decision-2");

    expect(changed.evidence).toEqual([]);
    expect(changed.candidateDeltas).toEqual([]);
    expect(changed.unresolvedObligations).toEqual([]);
    expect(changed.provenance.map((entry) => entry.decisionId)).toContain("decision-1");
  });
});
