import { describe, expect, it } from "vitest";
import { compileJevDossier, compileTaskArtifacts, compileTaskRubric } from "./compile.js";
import type { TaskRecord } from "./types.js";

const TASK: TaskRecord = {
  id: "task-auth",
  version: 3,
  objective: "Repair authentication without changing the agent's native tool surface.",
  status: "active",
  constraints: ["Milo may verify and route, but must not execute agent tools."],
  parentId: "project-milo",
  ancestorIds: ["session-1", "project-milo"],
  dependencies: [
    { taskId: "task-contract", status: "complete", summary: "Contracts landed." },
    { taskId: "task-receipts", status: "blocked", summary: "Waiting for a receipt adapter." },
  ],
  evidenceRefs: ["evidence://ledger/task-auth"],
  outputRefs: ["artifact://patch/task-auth"],
  verifierGates: ["pnpm test", "typecheck"],
  acceptanceCriteria: [
    {
      id: "tests",
      requirement: "The authentication tests pass.",
      evaluation: { type: "deterministic", oracle: "test receipt for the authentication suite" },
    },
    {
      id: "tool-boundary",
      requirement: "Milo does not execute agent tools.",
      evaluation: {
        type: "binary",
        pass: "The design contains only orchestration, evidence, rubric, and dossier contracts.",
        fail: "The design exposes shell, editor, browser, or harness execution through Milo.",
      },
    },
    {
      id: "closure",
      requirement: "The candidate handles the task completely.",
      evaluation: {
        type: "choice",
        choices: {
          complete: "Every requested outcome is supported by evidence.",
          partial: "Some requested outcome is missing or unsupported.",
          wrong: "The candidate does not solve the requested task.",
        },
        passingChoices: ["complete"],
      },
    },
  ],
};

describe("compileTaskRubric", () => {
  it("keeps deterministic checks authoritative and compiles fuzzy criteria into typed Jev questions", () => {
    const rubric = compileTaskRubric(TASK);

    expect(rubric.taskId).toBe(TASK.id);
    expect(rubric.taskVersion).toBe(TASK.version);
    expect(rubric.version).toMatch(/^[0-9a-f]{16}$/);
    expect(rubric.deterministicCriterionIds).toEqual(["tests"]);
    expect(rubric.criteria.map((criterion) => criterion.decision)).toEqual(["required", "required", "required"]);
    expect(rubric.questions["tests"]).toBeUndefined();
    expect(rubric.questions["tool-boundary"]).toMatchObject({ type: "noul" });
    expect(rubric.questions["closure"]).toEqual({
      type: "choice",
      instructions:
        "Which outcome best describes the candidate for this acceptance criterion: The candidate handles the task completely.",
      criteria: TASK.acceptanceCriteria[2]?.evaluation.type === "choice"
        ? TASK.acceptanceCriteria[2].evaluation.choices
        : {},
    });
  });

  it("versions the rubric from acceptance criteria, not changing task state", () => {
    const first = compileTaskRubric(TASK);
    const stateOnly = compileTaskRubric({ ...TASK, version: 4, status: "blocked", evidenceRefs: ["new-ref"] });
    const criterionChange = compileTaskRubric({
      ...TASK,
      version: 4,
      acceptanceCriteria: TASK.acceptanceCriteria.map((criterion) =>
        criterion.id === "tool-boundary" ? { ...criterion, requirement: "Milo never owns agent tool execution." } : criterion,
      ),
    });

    expect(stateOnly.version).toBe(first.version);
    expect(criterionChange.version).not.toBe(first.version);
    expect(compileTaskRubric({
      ...TASK,
      acceptanceCriteria: TASK.acceptanceCriteria.map((criterion) =>
        criterion.id === "tool-boundary" ? { ...criterion, decision: "veto" as const } : criterion),
    }).version).not.toBe(first.version);
  });

  it("does not change the rubric version when choice map insertion order changes", () => {
    const reordered = compileTaskRubric({
      ...TASK,
      acceptanceCriteria: TASK.acceptanceCriteria.map((criterion) =>
        criterion.evaluation.type === "choice"
          ? {
              ...criterion,
              evaluation: {
                ...criterion.evaluation,
                choices: {
                  wrong: criterion.evaluation.choices["wrong"] as string,
                  complete: criterion.evaluation.choices["complete"] as string,
                  partial: criterion.evaluation.choices["partial"] as string,
                },
              },
            }
          : criterion,
      ),
    });

    expect(reordered.version).toBe(compileTaskRubric(TASK).version);
  });

  it("rejects malformed or ambiguous criteria", () => {
    expect(() =>
      compileTaskRubric({ ...TASK, acceptanceCriteria: [TASK.acceptanceCriteria[0] as TaskRecord["acceptanceCriteria"][number], TASK.acceptanceCriteria[0] as TaskRecord["acceptanceCriteria"][number]] }),
    ).toThrow(/duplicate criterion/);
    expect(() =>
      compileTaskRubric({
        ...TASK,
        acceptanceCriteria: [
          {
            id: "bad-choice",
            requirement: "Choose.",
            evaluation: { type: "choice", choices: { yes: "Yes", no: "No" }, passingChoices: ["missing"] },
          },
        ],
      }),
    ).toThrow(/unknown passing choice/);
    expect(() => compileTaskRubric({
      ...TASK,
      acceptanceCriteria: Array.from({ length: 9 }, (_, index) => ({
        id: `criterion-${index}`,
        requirement: `Requirement ${index}`,
        evaluation: { type: "binary" as const, pass: "It passed." },
      })),
    })).toThrow(/at most 8/);
  });
});

describe("compileJevDossier", () => {
  it("derives bounded decision state and its rubric version from the same task record", () => {
    const artifacts = compileTaskArtifacts(TASK, {
      decisionId: "decision-7",
      maxTextChars: 2_000,
      recentDeltas: [{ id: "delta-1", summary: "The task became blocked.", sourceRef: "event://delta-1" }],
      evidence: [
        {
          id: "receipt-1",
          summary: "Authentication tests passed.",
          sourceRef: "receipt://1",
          criterionIds: ["tests"],
        },
        {
          id: "unrelated",
          summary: "Unrelated project evidence.",
          sourceRef: "receipt://other",
          criterionIds: ["other-task"],
        },
      ],
      criterionEvidence: [{
        criterionId: "tool-boundary",
        verdict: "satisfied",
        confidence: 0.97,
        summary: "The verifier found no tool execution surface.",
        sourceRef: "veritaserum://tool-boundary/1",
      }],
      candidates: [
        {
          id: "candidate-summary-1",
          candidateId: "candidate-1",
          summary: "Adds task contracts and pure compilers only.",
          sourceRef: "trajectory://candidate-1",
          criterionIds: ["tool-boundary", "closure"],
        },
      ],
      priorComparisons: [
        {
          id: "comparison-1",
          candidateIds: ["candidate-1", "candidate-2"],
          summary: "Candidate 1 preserved the execution boundary more clearly.",
          sourceRef: "comparison://1",
        },
      ],
    });

    expect(artifacts.dossier.rubricVersion).toBe(artifacts.rubric.version);
    expect(artifacts.dossier.taskVersion).toBe(TASK.version);
    expect(artifacts.dossier.state["task"]).toMatchObject({
      id: TASK.id,
      objective: TASK.objective,
      unresolvedDependencies: [{ taskId: "task-receipts", status: "blocked", summary: "Waiting for a receipt adapter." }],
    });
    expect(artifacts.dossier.state["evidence"]).toHaveLength(1);
    expect(artifacts.dossier.state["criterionEvidence"]).toEqual([expect.objectContaining({
      criterionId: "tool-boundary",
      verdict: "satisfied",
      sourceRef: "veritaserum://tool-boundary/1",
    })]);
    expect(artifacts.dossier.manifest.includedSourceRefs).toEqual([
      "trajectory://candidate-1",
      "receipt://1",
      "veritaserum://tool-boundary/1",
      "event://delta-1",
      "comparison://1",
    ]);
    expect(artifacts.dossier.manifest.omitted).toContainEqual({
      kind: "evidence",
      id: "unrelated",
      sourceRef: "receipt://other",
      reason: "irrelevant_criterion",
    });
  });

  it("clips text at the budget and reports every budget omission", () => {
    const dossier = compileJevDossier(
      { ...TASK, objective: "x".repeat(400), constraints: [] },
      {
        decisionId: "decision-small",
        maxTextChars: 256,
        evidence: [{ id: "late", summary: "never included", sourceRef: "receipt://late" }],
      },
    );

    expect(dossier.manifest.maxTextChars).toBe(256);
    expect(dossier.manifest.includedTextChars).toBeLessThanOrEqual(256);
    expect(dossier.manifest.truncated).toBe(true);
    expect(dossier.manifest.omitted).toContainEqual({
      kind: "evidence",
      id: "late",
      sourceRef: "receipt://late",
      reason: "context_budget",
    });
  });
});
