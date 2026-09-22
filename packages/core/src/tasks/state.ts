import { compileTaskRubric } from "./compile.js";
import type {
  CriterionEvidence,
  TaskAttemptRecord,
  TaskObligation,
  TaskRecord,
  TaskVerificationState,
} from "./types.js";

export const TASK_EVIDENCE_LIMIT = 32;
export const TASK_DELTA_LIMIT = 24;
export const TASK_PROVENANCE_LIMIT = 24;

export class TaskVerificationConflictError extends Error {
  constructor(
    message: string,
    readonly cause_: "stale_version" | "version_conflict",
  ) {
    super(message);
    this.name = "TaskVerificationConflictError";
  }
}

function takeNewest<T>(values: T[], limit: number): T[] {
  return values.slice(Math.max(0, values.length - limit));
}

function mergeEvidence(existing: CriterionEvidence[], incoming: CriterionEvidence[]): CriterionEvidence[] {
  const merged = new Map<string, CriterionEvidence>();
  for (const evidence of [...existing, ...incoming]) {
    const key = `${evidence.criterionId}\0${evidence.candidateId ?? ""}\0${evidence.sourceRef}`;
    // Reinsert replacements so insertion order also reflects recency before
    // the bounded tail is taken.
    merged.delete(key);
    merged.set(key, evidence);
  }
  return takeNewest([...merged.values()], TASK_EVIDENCE_LIMIT);
}

/** Start or resume the durable verification scope for one canonical task. */
export function beginTaskVerification(
  existing: TaskVerificationState | undefined,
  task: TaskRecord,
  evidence: CriterionEvidence[],
  decisionId: string,
  now = new Date().toISOString(),
): TaskVerificationState {
  const rubric = compileTaskRubric(task);
  if (existing !== undefined) {
    if (task.version < existing.task.version) {
      throw new TaskVerificationConflictError(
        `task ${task.id} version ${task.version} is older than stored version ${existing.task.version}`,
        "stale_version",
      );
    }
    if (task.version === existing.task.version && rubric.version !== existing.rubricVersion) {
      throw new TaskVerificationConflictError(
        `task ${task.id} version ${task.version} changed its rubric without a version bump`,
        "version_conflict",
      );
    }
  }

  const criterionIds = new Set(task.acceptanceCriteria.map((criterion) => criterion.id));
  const retainedEvidence = existing?.evidence.filter((entry) => criterionIds.has(entry.criterionId)) ?? [];
  const retainedDeltas = existing?.candidateDeltas.filter((entry) =>
    entry.criterionIds === undefined || entry.criterionIds.some((id) => criterionIds.has(id))) ?? [];
  const retainedObligations = existing?.unresolvedObligations.filter((entry) =>
    entry.criterionId === "__selection__" || criterionIds.has(entry.criterionId)) ?? [];
  const provenance = takeNewest([
    ...(existing?.provenance ?? []),
    {
      id: `${decisionId}:resume`,
      decisionId,
      taskVersion: task.version,
      summary: `Decision ${decisionId} resumed canonical task ${task.id} version ${task.version}.`,
      sourceRef: `decision://${decisionId}`,
    },
  ], TASK_PROVENANCE_LIMIT);

  return {
    task,
    rubricVersion: rubric.version,
    evidence: mergeEvidence(retainedEvidence, evidence),
    candidateDeltas: takeNewest(retainedDeltas, TASK_DELTA_LIMIT),
    unresolvedObligations: retainedObligations,
    provenance,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Fold one best-of-N attempt into the durable task scope without storing candidate text. */
export function recordTaskAttempt(
  state: TaskVerificationState,
  attempt: TaskAttemptRecord,
  now = new Date().toISOString(),
): TaskVerificationState {
  const obligations = new Map(state.unresolvedObligations.map((entry) => [entry.criterionId, entry]));
  const required = new Set(
    state.task.acceptanceCriteria
      .filter((criterion) => (criterion.decision ?? "required") !== "preference")
      .map((criterion) => criterion.id),
  );

  if (attempt.selection === "selected" && attempt.selectedCriteria !== undefined) {
    obligations.delete("__selection__");
    for (const finding of attempt.selectedCriteria) {
      if (!required.has(finding.criterionId)) continue;
      if (finding.verdict === "satisfied" && finding.confidence >= 0.6) {
        obligations.delete(finding.criterionId);
        continue;
      }
      const obligation: TaskObligation = {
        id: `${attempt.decisionId}:obligation:${finding.criterionId}`,
        criterionId: finding.criterionId,
        verdict: finding.verdict,
        confidence: finding.confidence,
        summary: `Criterion ${finding.criterionId} remains ${finding.verdict} after decision ${attempt.decisionId}.`,
        sourceRef: `decision://${attempt.decisionId}`,
        criterionIds: [finding.criterionId],
      };
      obligations.set(finding.criterionId, obligation);
    }
  } else {
    obligations.set("__selection__", {
      id: `${attempt.decisionId}:obligation:selection`,
      criterionId: "__selection__",
      verdict: "unknown",
      confidence: 0,
      summary: `Decision ${attempt.decisionId} did not produce a safely selected candidate.`,
      sourceRef: `decision://${attempt.decisionId}`,
    });
    for (const finding of attempt.unresolvedCriteria ?? []) {
      if (!required.has(finding.criterionId)) continue;
      obligations.set(finding.criterionId, {
        id: `${attempt.decisionId}:obligation:${finding.criterionId}`,
        criterionId: finding.criterionId,
        verdict: finding.verdict,
        confidence: finding.confidence,
        summary: `Criterion ${finding.criterionId} remains ${finding.verdict} after decision ${attempt.decisionId}.`,
        sourceRef: `decision://${attempt.decisionId}`,
        criterionIds: [finding.criterionId],
      });
    }
  }

  const provenance = takeNewest([
    ...state.provenance,
    {
      id: `${attempt.decisionId}:attempt`,
      decisionId: attempt.decisionId,
      taskVersion: state.task.version,
      summary: `Decision ${attempt.decisionId} recorded a ${attempt.selection} best-of-N attempt.`,
      sourceRef: `decision://${attempt.decisionId}`,
    },
  ], TASK_PROVENANCE_LIMIT);

  return {
    ...state,
    candidateDeltas: takeNewest([...state.candidateDeltas, ...attempt.candidateDeltas], TASK_DELTA_LIMIT),
    unresolvedObligations: [...obligations.values()],
    provenance,
    updatedAt: now,
  };
}
