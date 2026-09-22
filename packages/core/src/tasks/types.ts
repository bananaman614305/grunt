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

export const CRITERION_DECISIONS = ["veto", "required", "preference"] as const;
export type CriterionDecision = (typeof CRITERION_DECISIONS)[number];

export const CRITERION_VERDICTS = ["satisfied", "violated", "unknown"] as const;
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

export type TaskCriterion = {
  id: string;
  requirement: string;
  evaluation: CriterionEvaluation;
  /** Vetoes dominate requirements; preferences only break otherwise-safe ties. */
  decision?: CriterionDecision;
};

/** Source-linked evidence supplied by a harness or deterministic verifier. */
export type CriterionEvidence = {
  criterionId: string;
  verdict: CriterionVerdict;
  confidence: number;
  summary: string;
  sourceRef: string;
  /** Omit for task-wide evidence; set to bind evidence to one generated candidate. */
  candidateId?: string;
};

export type TaskCandidateDelta = DossierSource & {
  decisionId: string;
  candidateId: string;
  outcome: "accept" | "reject" | "abstain";
};

export type TaskObligation = DossierSource & {
  criterionId: string;
  verdict: CriterionVerdict;
  confidence: number;
};

export type TaskProvenance = DossierSource & {
  decisionId: string;
  taskVersion: number;
};

export type TaskCriterionOutcome = {
  criterionId: string;
  verdict: CriterionVerdict;
  confidence: number;
};

export type TaskAttemptRecord = {
  decisionId: string;
  candidateDeltas: TaskCandidateDelta[];
  unresolvedCriteria?: TaskCriterionOutcome[];
  selectedCandidateId?: string;
  selectedCriteria?: TaskCriterionOutcome[];
  selection: "selected" | "abstained" | "failed";
};

/** Durable verification scope for one caller and canonical task id. */
export type TaskVerificationState = {
  task: TaskRecord;
  rubricVersion: string;
  evidence: CriterionEvidence[];
  candidateDeltas: TaskCandidateDelta[];
  unresolvedObligations: TaskObligation[];
  provenance: TaskProvenance[];
  createdAt: string;
  updatedAt: string;
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
  decision: CriterionDecision;
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
  criterionEvidence?: CriterionEvidence[];
  obligations?: TaskObligation[];
  provenance?: TaskProvenance[];
  candidates?: CandidateSummary[];
  priorComparisons?: ComparisonSummary[];
  /** Budget for human-authored text included in the Jev state. */
  maxTextChars?: number;
};

export type OmittedDossierSource = {
  kind: "task" | "delta" | "evidence" | "candidate" | "comparison" | "obligation" | "provenance";
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
