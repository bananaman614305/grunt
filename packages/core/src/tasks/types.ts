import type { JevQuestion } from "../jev/types.js";

export const TASK_STATUSES = ["pending", "active", "blocked", "complete", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskDependency = {
  taskId: string;
  status: TaskStatus;
  /** Short state supplied by the task store; never a transcript. */
  summary?: string;
};

export type DeterministicEvaluation = {
  type: "deterministic";
  /** Name or description of the authoritative mechanical check. */
  oracle: string;
};

export type BinaryEvaluation = {
  type: "binary";
  /** Observable evidence that means the criterion passed. */
  pass: string;
  /** Observable evidence that means it failed. */
  fail?: string;
};

export type ChoiceEvaluation = {
  type: "choice";
  /** Bounded answer vocabulary. */
  choices: Record<string, string>;
  /** Choices treated as satisfying the criterion by downstream policy. */
  passingChoices: string[];
};

export type CriterionEvaluation = DeterministicEvaluation | BinaryEvaluation | ChoiceEvaluation;

export type TaskCriterion = {
  id: string;
  requirement: string;
  evaluation: CriterionEvaluation;
};

/**
 * Canonical long-range record for one task. Dossiers and rubrics are derived
 * from this record; neither is an independent source of task truth.
 */
export type TaskRecord = {
  id: string;
  version: number;
  objective: string;
  acceptanceCriteria: TaskCriterion[];
  status: TaskStatus;
  constraints?: string[];
  parentId?: string;
  ancestorIds?: string[];
  dependencies?: TaskDependency[];
  evidenceRefs?: string[];
  outputRefs?: string[];
  verifierGates?: string[];
};

export type CompiledCriterion = {
  id: string;
  requirement: string;
  evaluation: CriterionEvaluation;
  /** Jev question key; absent when a deterministic oracle is authoritative. */
  questionKey?: string;
};

export type TaskRubric = {
  taskId: string;
  taskVersion: number;
  version: string;
  criteria: CompiledCriterion[];
  questions: Record<string, JevQuestion>;
  deterministicCriterionIds: string[];
};

export type DossierSource = {
  id: string;
  summary: string;
  sourceRef: string;
  criterionIds?: string[];
};

export type CandidateSummary = DossierSource & {
  candidateId: string;
};

export type ComparisonSummary = DossierSource & {
  candidateIds: string[];
};

export type DossierContext = {
  decisionId: string;
  recentDeltas?: DossierSource[];
  evidence?: DossierSource[];
  candidates?: CandidateSummary[];
  priorComparisons?: ComparisonSummary[];
  /** Budget for human-authored text included in the Jev state. */
  maxTextChars?: number;
};

export type OmittedDossierSource = {
  kind: "task" | "delta" | "evidence" | "candidate" | "comparison";
  id: string;
  sourceRef?: string;
  reason: "context_budget" | "irrelevant_criterion";
};

export type DossierManifest = {
  maxTextChars: number;
  includedTextChars: number;
  truncated: boolean;
  includedSourceRefs: string[];
  omitted: OmittedDossierSource[];
};

/** JSON-ready, decision-local state for one Jev call. */
export type JevDossier = {
  decisionId: string;
  taskId: string;
  taskVersion: number;
  rubricVersion: string;
  state: Record<string, unknown>;
  manifest: DossierManifest;
};

export type CompiledTaskArtifacts = {
  rubric: TaskRubric;
  dossier: JevDossier;
};
