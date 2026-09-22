import { createHash } from "node:crypto";
import type { JevChoiceQuestion, JevNoulQuestion } from "../jev/types.js";
import type {
  CandidateSummary,
  CompiledTaskArtifacts,
  ComparisonSummary,
  DossierContext,
  DossierManifest,
  DossierSource,
  JevDossier,
  OmittedDossierSource,
  TaskCriterion,
  TaskRecord,
  TaskRubric,
} from "./types.js";

export const DEFAULT_DOSSIER_TEXT_BUDGET = 12_000;
export const MIN_DOSSIER_TEXT_BUDGET = 256;

function requireText(path: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`task compiler: ${path} must be non-empty`);
  return trimmed;
}

function validateRecord(record: TaskRecord): void {
  requireText("id", record.id);
  requireText("objective", record.objective);
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new Error("task compiler: version must be a positive integer");
  }
  if (record.acceptanceCriteria.length === 0) {
    throw new Error("task compiler: at least one acceptance criterion is required");
  }
  const ids = new Set<string>();
  for (const criterion of record.acceptanceCriteria) {
    requireText("criterion id", criterion.id);
    requireText(`criterion ${criterion.id}`, criterion.requirement);
    if (ids.has(criterion.id)) throw new Error(`task compiler: duplicate criterion id "${criterion.id}"`);
    ids.add(criterion.id);
    if (criterion.evaluation.type === "deterministic") {
      requireText(`criterion ${criterion.id} oracle`, criterion.evaluation.oracle);
    } else if (criterion.evaluation.type === "binary") {
      requireText(`criterion ${criterion.id} pass condition`, criterion.evaluation.pass);
    } else {
      const choices = Object.keys(criterion.evaluation.choices);
      if (choices.length < 2) throw new Error(`task compiler: criterion ${criterion.id} needs at least two choices`);
      for (const choice of choices) {
        requireText(`criterion ${criterion.id} choice`, choice);
        requireText(`criterion ${criterion.id} choice ${choice}`, criterion.evaluation.choices[choice] ?? "");
      }
      if (criterion.evaluation.passingChoices.length === 0) {
        throw new Error(`task compiler: criterion ${criterion.id} needs a passing choice`);
      }
      for (const passing of criterion.evaluation.passingChoices) {
        if (!(passing in criterion.evaluation.choices)) {
          throw new Error(`task compiler: criterion ${criterion.id} has unknown passing choice "${passing}"`);
        }
      }
    }
  }
}

function questionFor(criterion: TaskCriterion): JevNoulQuestion | JevChoiceQuestion | undefined {
  const { evaluation, requirement } = criterion;
  if (evaluation.type === "deterministic") return undefined;
  if (evaluation.type === "binary") {
    return {
      type: "noul",
      instructions: `Does the candidate satisfy this acceptance criterion: ${requirement}`,
      criteria: {
        true: evaluation.pass,
        false: evaluation.fail ?? `The candidate does not satisfy: ${requirement}`,
      },
    };
  }
  return {
    type: "choice",
    instructions: `Which outcome best describes the candidate for this acceptance criterion: ${requirement}`,
    criteria: { ...evaluation.choices },
  };
}

function rubricVersion(record: TaskRecord): string {
  const canonical = {
    taskId: record.id,
    acceptanceCriteria: record.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      requirement: criterion.requirement,
      evaluation:
        criterion.evaluation.type === "choice"
          ? {
              ...criterion.evaluation,
              choices: Object.fromEntries(Object.entries(criterion.evaluation.choices).sort(([a], [b]) => a.localeCompare(b))),
              passingChoices: [...criterion.evaluation.passingChoices].sort(),
            }
          : criterion.evaluation,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").slice(0, 16);
}

/** Compile immutable, task-specific Jev questions from the canonical record. */
export function compileTaskRubric(record: TaskRecord): TaskRubric {
  validateRecord(record);
  const questions: TaskRubric["questions"] = {};
  const deterministicCriterionIds: string[] = [];
  const criteria = record.acceptanceCriteria.map((criterion) => {
    const question = questionFor(criterion);
    if (question === undefined) {
      deterministicCriterionIds.push(criterion.id);
      return { ...criterion };
    }
    questions[criterion.id] = question;
    return { ...criterion, questionKey: criterion.id };
  });
  return {
    taskId: record.id,
    taskVersion: record.version,
    version: rubricVersion(record),
    criteria,
    questions,
    deterministicCriterionIds,
  };
}

type SourceKind = OmittedDossierSource["kind"];

type Budget = {
  max: number;
  used: number;
  truncated: boolean;
  includedRefs: Set<string>;
  omitted: OmittedDossierSource[];
};

function takeText(budget: Budget, kind: SourceKind, id: string, text: string, sourceRef?: string): string | undefined {
  if (budget.used >= budget.max) {
    budget.omitted.push({ kind, id, ...(sourceRef === undefined ? {} : { sourceRef }), reason: "context_budget" });
    return undefined;
  }
  const remaining = budget.max - budget.used;
  if (text.length <= remaining) {
    budget.used += text.length;
    if (sourceRef !== undefined) budget.includedRefs.add(sourceRef);
    return text;
  }
  const marker = "…[truncated]";
  const clipped = remaining <= marker.length ? marker.slice(0, remaining) : `${text.slice(0, remaining - marker.length)}${marker}`;
  budget.used += clipped.length;
  budget.truncated = true;
  budget.omitted.push({ kind, id, ...(sourceRef === undefined ? {} : { sourceRef }), reason: "context_budget" });
  if (sourceRef !== undefined) budget.includedRefs.add(sourceRef);
  return clipped;
}

function relevant(source: DossierSource, criterionIds: Set<string>): boolean {
  return source.criterionIds === undefined || source.criterionIds.length === 0 || source.criterionIds.some((id) => criterionIds.has(id));
}

function compactSources<T extends DossierSource>(
  sources: readonly T[],
  kind: SourceKind,
  budget: Budget,
  criterionIds: Set<string>,
  extra: (source: T) => Record<string, unknown> = () => ({}),
): Array<Record<string, unknown>> {
  const compacted: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    if (!relevant(source, criterionIds)) {
      budget.omitted.push({ kind, id: source.id, sourceRef: source.sourceRef, reason: "irrelevant_criterion" });
      continue;
    }
    const summary = takeText(budget, kind, source.id, source.summary, source.sourceRef);
    if (summary === undefined) continue;
    compacted.push({
      id: source.id,
      summary,
      sourceRef: source.sourceRef,
      ...(source.criterionIds === undefined ? {} : { criterionIds: source.criterionIds }),
      ...extra(source),
    });
  }
  return compacted;
}

function taskState(record: TaskRecord, budget: Budget): Record<string, unknown> {
  const objective = takeText(budget, "task", record.id, record.objective) ?? "";
  const constraints = (record.constraints ?? []).flatMap((constraint, index) => {
    const value = takeText(budget, "task", `${record.id}:constraint:${index}`, constraint);
    return value === undefined ? [] : [value];
  });
  const criteria = record.acceptanceCriteria.flatMap((criterion) => {
    const requirement = takeText(budget, "task", `${record.id}:criterion:${criterion.id}`, criterion.requirement);
    return requirement === undefined ? [] : [{ id: criterion.id, requirement, evaluationType: criterion.evaluation.type }];
  });
  const unresolvedDependencies = (record.dependencies ?? [])
    .filter((dependency) => dependency.status !== "complete" && dependency.status !== "cancelled")
    .map((dependency) => ({
      taskId: dependency.taskId,
      status: dependency.status,
      ...(dependency.summary === undefined
        ? {}
        : { summary: takeText(budget, "task", `${record.id}:dependency:${dependency.taskId}`, dependency.summary) ?? "" }),
    }));
  return {
    id: record.id,
    version: record.version,
    objective,
    status: record.status,
    ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
    ...(record.ancestorIds === undefined ? {} : { ancestorIds: record.ancestorIds }),
    constraints,
    acceptanceCriteria: criteria,
    unresolvedDependencies,
    evidenceRefs: record.evidenceRefs ?? [],
    outputRefs: record.outputRefs ?? [],
    verifierGates: record.verifierGates ?? [],
  };
}

/** Assemble bounded, source-linked Jev state from one canonical task record. */
export function compileJevDossier(record: TaskRecord, context: DossierContext): JevDossier {
  const rubric = compileTaskRubric(record);
  const max = Math.max(MIN_DOSSIER_TEXT_BUDGET, context.maxTextChars ?? DEFAULT_DOSSIER_TEXT_BUDGET);
  const budget: Budget = { max, used: 0, truncated: false, includedRefs: new Set(), omitted: [] };
  const criterionIds = new Set(record.acceptanceCriteria.map((criterion) => criterion.id));
  const task = taskState(record, budget);
  const candidates = compactSources<CandidateSummary>(
    context.candidates ?? [],
    "candidate",
    budget,
    criterionIds,
    (candidate) => ({ candidateId: candidate.candidateId }),
  );
  const evidence = compactSources(context.evidence ?? [], "evidence", budget, criterionIds);
  const recentDeltas = compactSources(context.recentDeltas ?? [], "delta", budget, criterionIds);
  const priorComparisons = compactSources<ComparisonSummary>(
    context.priorComparisons ?? [],
    "comparison",
    budget,
    criterionIds,
    (comparison) => ({ candidateIds: comparison.candidateIds }),
  );
  const manifest: DossierManifest = {
    maxTextChars: max,
    includedTextChars: budget.used,
    truncated: budget.truncated || budget.omitted.some((entry) => entry.reason === "context_budget"),
    includedSourceRefs: [...budget.includedRefs],
    omitted: budget.omitted,
  };
  return {
    decisionId: context.decisionId,
    taskId: record.id,
    taskVersion: record.version,
    rubricVersion: rubric.version,
    state: {
      task,
      rubric: {
        version: rubric.version,
        fuzzyCriterionIds: rubric.criteria.filter((criterion) => criterion.questionKey !== undefined).map((criterion) => criterion.id),
        deterministicCriterionIds: rubric.deterministicCriterionIds,
      },
      recentDeltas,
      evidence,
      candidates,
      priorComparisons,
      context: manifest,
    },
    manifest,
  };
}

/** Compile both derived artifacts together so their task/rubric versions cannot drift. */
export function compileTaskArtifacts(record: TaskRecord, context: DossierContext): CompiledTaskArtifacts {
  const rubric = compileTaskRubric(record);
  const dossier = compileJevDossier(record, context);
  return { rubric, dossier };
}
