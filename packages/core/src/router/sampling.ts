/**
 * Best-of-N sampling primitives (ADR-010): the varied prompt framings the
 * gateway fans out with, and the closed Jev questions that rank the answers.
 *
 * Sampling is a routing outcome, not a mode: policy v4 resolves some cells to
 * `{ tier: "fast", samples: N }` (see `policy.ts`), and the gateway executes
 * that by drawing N answers from the fast tier -- each with one of these
 * framings appended to the system prompt -- then asking Jev to decide every
 * answer against a closed rubric and returning the best. The framings were
 * validated by the benchmark in `packages/evals/src/bench` (two live runs,
 * AUROC 0.87/0.91 against the graders). The closed selector has deterministic
 * veto, abstention, quality, correctness, and tie fixtures beside this module.
 */

import type { JevAnswer, JevClientLike, JevQuestion } from "../jev/types.js";
import { compileTaskArtifacts } from "../tasks/compile.js";
import type { CriterionEvidence, CriterionVerdict, TaskRecord } from "../tasks/types.js";
import type { ChatMessage } from "../types.js";
import { messageText } from "./context.js";

/** Framings appended to the system prompt, cycled by sample index. */
export const PROMPT_VARIANTS: readonly string[] = [
  "",
  "Think the problem through step by step before you answer, then give the final answer.",
  "Give your answer, then re-check it for mistakes and correct any you find before finishing.",
  "Be precise and concise. Prefer a direct answer over discussion.",
  "Consider two different approaches, then commit to the better one and answer.",
];

/** The framing for sample `index`: cycled through `PROMPT_VARIANTS`. */
export function variantFor(index: number): string {
  return PROMPT_VARIANTS[index % PROMPT_VARIANTS.length] as string;
}

/**
 * Returns the conversation with the framing appended to (or added as) the
 * system message. The empty framing returns the messages untouched, so the
 * first sample is always the request exactly as the user sent it.
 *
 * This is the benchmarked placement (ADR-010): the framing rides the *system*
 * message, which sits at the head of the token sequence. That means the N
 * samples of one request diverge before any of the (usually much larger) user
 * turns, so a provider prompt cache cannot reuse the conversation body across
 * them -- see `applyVariantSuffix` for the cache-friendly alternative.
 */
export function applyVariant(messages: ChatMessage[], variant: string): ChatMessage[] {
  if (variant === "") return messages;
  const index = messages.findIndex((m) => m.role === "system");
  if (index === -1) return [{ role: "system", content: variant }, ...messages];
  const system = messages[index] as ChatMessage;
  const content = typeof system.content === "string" ? `${system.content}\n\n${variant}` : variant;
  return messages.map((m, i) => (i === index ? { ...m, content } : m));
}

/**
 * The cache-friendly placement of the same framing (ADR-024, opt-in): append
 * it to the *end* of the last message instead of the system message, so every
 * message before the tail -- the system prompt and the whole conversation --
 * is byte-identical across the N samples. A provider that prompt-caches on the
 * shared prefix (the DeepSeek family; ADR-012's "shared prompt caches across
 * samples and turns") can then reuse the expensive conversation body and only
 * re-encode the short varying framing at the very end. The empty framing
 * returns the messages untouched, exactly like `applyVariant`, so sample 0 is
 * still the request as the user sent it.
 *
 * The framing text is unchanged, so sample diversity is unchanged; only where
 * it sits moves. That relocation is still a prompt change the ADR-010
 * benchmark has not measured, which is why the gateway keeps this behind a
 * default-off config gate.
 */
export function applyVariantSuffix(messages: ChatMessage[], variant: string): ChatMessage[] {
  if (variant === "") return messages;
  if (messages.length === 0) return [{ role: "system", content: variant }];
  const last = messages[messages.length - 1] as ChatMessage;
  // Only a string tail can carry an appended suffix while keeping the prefix
  // stable; a structured (e.g. multimodal) last message gets the framing as a
  // fresh trailing turn instead, which leaves every prior message untouched.
  if (typeof last.content !== "string") return [...messages, { role: "user", content: variant }];
  const content = `${last.content}\n\n${variant}`;
  return messages.map((m, i) => (i === messages.length - 1 ? { ...m, content } : m));
}

/**
 * The ordered closed questions one Jev call asks about one candidate answer.
 * Deterministic aggregation preserves the historical 0..3 selector surface
 * while making contract vetoes and unknown evidence explicit.
 */
export const RANK_QUESTIONS: Record<string, JevQuestion> = {
  truth_contract: closedQuestion("Does the candidate contain a factual error or violate an explicit user contract?", true),
  task_completion: closedQuestion("Does the candidate complete the task the user asked for?"),
  regression_scope: closedQuestion("Does the candidate preserve stated constraints and stay within the requested scope?"),
  maintainability: closedQuestion("Is the candidate clear and maintainable enough to use without repair?"),
};

export type RankCriterion = { id: string; decision: "veto" | "required" | "preference"; question: JevQuestion };

function closedQuestion(instructions: string, adverse = false): JevQuestion {
  return {
    type: "choice",
    instructions,
    criteria: adverse
      ? {
          satisfied: "No factual or contract violation is present.",
          violated: "A factual or contract violation is present.",
          unknown: "The supplied task and candidate do not provide enough evidence to decide.",
        }
      : {
          satisfied: "The criterion is satisfied.",
          violated: "The criterion is violated.",
          unknown: "The supplied task and candidate do not provide enough evidence to decide.",
        },
  };
}

function taskSpecificCriteria(task: ChatMessage[]): RankCriterion[] {
  const text = task.filter((message) => message.role === "user").map((message) => messageText(message.content)).join("\n");
  const lines = text.split("\n").map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "").trim())
    .filter((line, index, all) => line.length > 0 && line.length <= 240 && all.indexOf(line) === index);
  return lines.filter((line) => /\b(ux|accessib|security|privacy|performance|latency|memory)\b/i.test(line)).slice(0, 4).map((line, index) => ({
    id: `task_preference_${index + 1}`,
    decision: /\b(security|privacy|must|required|never)\b/i.test(line) ? "veto" : "preference",
    question: closedQuestion(`Does the candidate satisfy this task-specific requirement: ${line}`),
  }));
}

export function compileRankingRubric(task: ChatMessage[]): RankCriterion[] {
  return [
    { id: "truth_contract", decision: "veto", question: RANK_QUESTIONS["truth_contract"] as JevQuestion },
    { id: "task_completion", decision: "required", question: RANK_QUESTIONS["task_completion"] as JevQuestion },
    { id: "regression_scope", decision: "required", question: RANK_QUESTIONS["regression_scope"] as JevQuestion },
    { id: "maintainability", decision: "preference", question: RANK_QUESTIONS["maintainability"] as JevQuestion },
    ...taskSpecificCriteria(task),
  ];
}

/** Cap on what one ranking call sends Jev, keeping the call cheap. */
export const RANK_STATE_MAX_CHARS = 12_000;
const TASK_CANDIDATE_MAX_CHARS = 4_000;

function taskCandidateSummary(answer: string): string {
  const value = answer.trim() === "" ? "(empty answer)" : answer;
  return value.length > TASK_CANDIDATE_MAX_CHARS
    ? `${value.slice(0, TASK_CANDIDATE_MAX_CHARS)}\n…[truncated]`
    : value;
}

/** Jev's view of one candidate: the task transcript and the answer, clipped. */
export function rankState(
  task: ChatMessage[],
  answer: string,
  maxChars = RANK_STATE_MAX_CHARS,
): Record<string, unknown> {
  const transcript = task.map((m) => `[${m.role}]\n${messageText(m.content)}`).join("\n\n");
  const clip = (s: string): string => (s.length > maxChars ? `${s.slice(0, maxChars)}\n…[truncated]` : s);
  return { task: clip(transcript), candidate_answer: clip(answer.trim() === "" ? "(empty answer)" : answer) };
}

export type RankScore = {
  /** Expected value of Jev's 0..3 quality score. */
  quality: number;
  /** Jev's probability that the answer is correct. */
  correct: number;
  /** Jev's own confidence on the score question. */
  confidence: number;
  latencyMs: number;
  outcome?: "accept" | "reject" | "abstain";
  criteria?: Record<string, "satisfied" | "violated" | "unknown">;
  criterionEvidence?: CriterionFinding[];
};

export type CriterionFinding = {
  criterionId: string;
  verdict: CriterionVerdict;
  confidence: number;
  /** Probability that the criterion is satisfied, when available. */
  satisfied: number;
  source: "evidence" | "jev" | "missing";
  sourceRef?: string;
};

export type TaskRankingContext = {
  record: TaskRecord;
  decisionId: string;
  candidateId: string;
  evidence?: CriterionEvidence[];
};

/** Total budget for one ranking call, ms. */
export const RANK_BUDGET_MS = 8_000;

/**
 * Asks Jev to decide a closed rubric for one candidate answer. Throws on a
 * Jev failure; the caller decides what a failed rank means.
 *
 * `apiKey` is the caller's forwarded OpenRouter key (ADR-022): under the
 * `"openrouter"` Jev transport it authenticates this call, so the user's own
 * key pays for the ranking and Milo's `JEV_API_KEY` is never used. The TypeSafe
 * transport ignores it and authenticates with Milo's key, so it can be passed
 * unconditionally. Omitted, the call falls back to the client's configured key.
 */
export async function rankAnswer(
  jev: JevClientLike,
  task: ChatMessage[],
  answer: string,
  budgetMs = RANK_BUDGET_MS,
  apiKey?: string,
  taskContext?: TaskRankingContext,
): Promise<RankScore> {
  if (taskContext !== undefined) {
    return rankTaskAnswer(jev, answer, taskContext, budgetMs, apiKey);
  }
  const rubric = compileRankingRubric(task);
  const questions = Object.fromEntries(rubric.map((criterion) => [criterion.id, criterion.question]));
  const result = await jev.systemone(
    { state: rankState(task, answer), questions },
    { budgetMs, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
  );
  const closed = rubric.map((criterion) => ({ criterion, answer: result.answers[criterion.id] }));
  if (closed.every(({ answer: finding }) => finding?.type === "choice")) {
    const criteria: Record<string, "satisfied" | "violated" | "unknown"> = {};
    let confidence = 1;
    let preference = 0;
    let preferenceCount = 0;
    let correct = 1;
    let veto = false;
    let unknownRequired = false;
    for (const { criterion, answer: finding } of closed) {
      if (finding?.type !== "choice" || !["satisfied", "violated", "unknown"].includes(finding.choice)) continue;
      const choice = finding.choice as "satisfied" | "violated" | "unknown";
      criteria[criterion.id] = choice;
      confidence = Math.min(confidence, finding.confidence);
      const pass = finding.probabilities["satisfied"] ?? (choice === "satisfied" ? finding.confidence : 0);
      if (criterion.decision !== "preference") correct = Math.min(correct, pass);
      else { preference += pass; preferenceCount += 1; }
      if (criterion.decision === "veto" && choice === "violated" && finding.confidence >= 0.6) veto = true;
      if (criterion.decision !== "preference" && choice === "unknown") unknownRequired = true;
    }
    const outcome = veto ? "reject" : unknownRequired ? "abstain" : "accept";
    const preferenceMean = preferenceCount === 0 ? 1 : preference / preferenceCount;
    const quality = outcome === "reject" ? 0 : outcome === "abstain" ? correct : 1.5 + correct + 0.5 * preferenceMean;
    return { quality, correct, confidence, latencyMs: result.latencyMs, outcome, criteria };
  }
  // Compatibility for old recorded fixtures while deployed Jev moves to the closed rubric.
  const quality = result.answers["quality"];
  const legacyCorrect = result.answers["correct"];
  if (quality?.type !== "score" || legacyCorrect?.type !== "noul") throw new Error("jev returned rank answers of the wrong type");
  const expected = Object.entries(quality.probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
  return {
    quality: Number.isFinite(expected) ? expected : quality.score,
    correct: legacyCorrect.noul,
    confidence: quality.confidence,
    latencyMs: result.latencyMs,
  };
}

function evidenceForCriterion(context: TaskRankingContext, criterionId: string): CriterionEvidence | undefined {
  const matching = (context.evidence ?? []).filter((entry) =>
    entry.criterionId === criterionId
      && (entry.candidateId === undefined || entry.candidateId === context.candidateId));
  return matching.find((entry) => entry.candidateId === context.candidateId) ?? matching[0];
}

function findingFromAnswer(
  criterionId: string,
  evaluation: TaskRecord["acceptanceCriteria"][number]["evaluation"],
  answer: JevAnswer | undefined,
): CriterionFinding {
  if (evaluation.type === "binary" && answer?.type === "noul") {
    const satisfied = Math.max(0, Math.min(1, answer.noul));
    const confidence = Math.max(satisfied, 1 - satisfied);
    return {
      criterionId,
      verdict: confidence < 0.6 ? "unknown" : satisfied >= 0.5 ? "satisfied" : "violated",
      confidence,
      satisfied,
      source: "jev",
    };
  }
  if (evaluation.type === "choice" && answer?.type === "choice") {
    const satisfied = evaluation.passingChoices.reduce((sum, choice) => sum + (answer.probabilities[choice] ?? 0), 0);
    const explicitUnknown = answer.choice === "unknown";
    return {
      criterionId,
      verdict: explicitUnknown || answer.confidence < 0.6
        ? "unknown"
        : evaluation.passingChoices.includes(answer.choice) ? "satisfied" : "violated",
      confidence: answer.confidence,
      satisfied: Math.max(0, Math.min(1, satisfied)),
      source: "jev",
    };
  }
  return { criterionId, verdict: "unknown", confidence: 0, satisfied: 0, source: "missing" };
}

function aggregateTaskFindings(
  record: TaskRecord,
  findings: CriterionFinding[],
  latencyMs: number,
): RankScore {
  const byId = new Map(findings.map((finding) => [finding.criterionId, finding]));
  let veto = false;
  let requiredViolation = false;
  let unknownRequired = false;
  let correctness = 1;
  let preference = 0;
  let preferenceCount = 0;
  let confidence = 1;
  const criteria: Record<string, CriterionVerdict> = {};
  for (const criterion of record.acceptanceCriteria) {
    const finding = byId.get(criterion.id)
      ?? { criterionId: criterion.id, verdict: "unknown" as const, confidence: 0, satisfied: 0, source: "missing" as const };
    const decision = criterion.decision ?? "required";
    criteria[criterion.id] = finding.verdict;
    confidence = Math.min(confidence, finding.confidence);
    if (decision === "preference") {
      preference += finding.satisfied;
      preferenceCount += 1;
      continue;
    }
    correctness = Math.min(correctness, finding.satisfied);
    if (finding.verdict === "violated" && finding.confidence >= 0.6) {
      if (decision === "veto") veto = true;
      else requiredViolation = true;
    }
    if (finding.verdict === "unknown" || finding.confidence < 0.6) unknownRequired = true;
  }
  const outcome = veto || requiredViolation ? "reject" : unknownRequired ? "abstain" : "accept";
  const preferenceMean = preferenceCount === 0 ? 1 : preference / preferenceCount;
  const quality = outcome === "reject" ? 0 : outcome === "abstain" ? correctness : 1.5 + correctness + 0.5 * preferenceMean;
  return { quality, correct: correctness, confidence, latencyMs, outcome, criteria, criterionEvidence: findings };
}

async function rankTaskAnswer(
  jev: JevClientLike,
  answer: string,
  context: TaskRankingContext,
  budgetMs: number,
  apiKey?: string,
): Promise<RankScore> {
  const relevantEvidence = context.evidence?.filter((entry) =>
    entry.candidateId === undefined || entry.candidateId === context.candidateId);
  const candidateRef = `candidate://${context.candidateId}`;
  const artifacts = compileTaskArtifacts(context.record, {
    decisionId: context.decisionId,
    ...(relevantEvidence === undefined ? {} : { criterionEvidence: relevantEvidence }),
    candidates: [{
      id: context.candidateId,
      candidateId: context.candidateId,
      summary: taskCandidateSummary(answer),
      sourceRef: candidateRef,
    }],
  });
  const findings: CriterionFinding[] = [];
  const questions: Record<string, JevQuestion> = {};
  for (const criterion of artifacts.rubric.criteria) {
    const supplied = evidenceForCriterion(context, criterion.id);
    if (supplied !== undefined) {
      findings.push({
        criterionId: criterion.id,
        verdict: supplied.verdict,
        confidence: supplied.confidence,
        satisfied: supplied.verdict === "satisfied" ? supplied.confidence : supplied.verdict === "violated" ? 1 - supplied.confidence : 0,
        source: "evidence",
        sourceRef: supplied.sourceRef,
      });
      continue;
    }
    if (criterion.questionKey === undefined) {
      findings.push({ criterionId: criterion.id, verdict: "unknown", confidence: 0, satisfied: 0, source: "missing" });
      continue;
    }
    const question = artifacts.rubric.questions[criterion.questionKey];
    if (question !== undefined) questions[criterion.questionKey] = question;
  }
  if (Object.keys(questions).length === 0) return aggregateTaskFindings(context.record, findings, 0);
  if (!artifacts.dossier.manifest.includedSourceRefs.includes(candidateRef)) {
    for (const criterion of artifacts.rubric.criteria) {
      if (!findings.some((finding) => finding.criterionId === criterion.id)) {
        findings.push({ criterionId: criterion.id, verdict: "unknown", confidence: 0, satisfied: 0, source: "missing" });
      }
    }
    return aggregateTaskFindings(context.record, findings, 0);
  }
  const result = await jev.systemone(
    { state: artifacts.dossier.state, questions },
    { budgetMs, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
  );
  for (const criterion of artifacts.rubric.criteria) {
    if (findings.some((finding) => finding.criterionId === criterion.id)) continue;
    findings.push(findingFromAnswer(criterion.id, criterion.evaluation, result.answers[criterion.questionKey ?? ""]));
  }
  return aggregateTaskFindings(context.record, findings, result.latencyMs);
}

export type PairwiseCandidate = {
  index: number;
  candidateId: string;
  answer: string;
  rank: RankScore;
};

/**
 * Ask Jev for one direct head-to-head between the two strongest viable
 * candidates. A tie, unknown answer, or low-confidence verdict abstains.
 */
export async function selectPairwise(
  jev: JevClientLike,
  context: Omit<TaskRankingContext, "candidateId">,
  a: PairwiseCandidate,
  b: PairwiseCandidate,
  budgetMs = RANK_BUDGET_MS,
  apiKey?: string,
): Promise<number | undefined> {
  const candidateRefs = [a, b].map((candidate) => `candidate://${candidate.candidateId}`);
  const artifacts = compileTaskArtifacts(context.record, {
    decisionId: context.decisionId,
    ...(context.evidence === undefined ? {} : { criterionEvidence: context.evidence }),
    candidates: [a, b].map((candidate) => ({
      id: candidate.candidateId,
      candidateId: candidate.candidateId,
      summary: taskCandidateSummary(candidate.answer),
      sourceRef: `candidate://${candidate.candidateId}`,
    })),
  });
  if (candidateRefs.some((sourceRef) => !artifacts.dossier.manifest.includedSourceRefs.includes(sourceRef))) {
    return undefined;
  }
  const state = {
    ...artifacts.dossier.state,
    candidateCriterionEvidence: {
      [a.candidateId]: a.rank.criterionEvidence ?? [],
      [b.candidateId]: b.rank.criterionEvidence ?? [],
    },
  };
  const result = await jev.systemone(
    {
      state,
      questions: {
        winner: {
          type: "choice",
          instructions:
            "Which candidate better satisfies the canonical task rubric? Honor vetoes before requirements and preferences. Choose unknown when the evidence cannot support a safe preference.",
          criteria: {
            candidate_a: `${a.candidateId} is better supported by the criterion evidence.`,
            candidate_b: `${b.candidateId} is better supported by the criterion evidence.`,
            equivalent: "The candidates are materially equivalent under the rubric.",
            unknown: "The available evidence cannot support a safe preference.",
          },
        },
      },
    },
    { budgetMs, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
  );
  const winner = result.answers["winner"];
  if (winner?.type !== "choice" || winner.confidence < 0.6) return undefined;
  if (winner.choice === "candidate_a") return a.index;
  if (winner.choice === "candidate_b") return b.index;
  return undefined;
}

/**
 * Orders two ranked samples, best first: higher expected quality wins, Jev's
 * correctness probability breaks ties, and the lower index (the less-framed
 * prompt) breaks anything left, so a pick is deterministic.
 */
export function compareRanked(
  a: { index: number; rank: RankScore },
  b: { index: number; rank: RankScore },
): number {
  const order = { accept: 0, abstain: 1, reject: 2 } as const;
  if (a.rank.outcome !== undefined && b.rank.outcome !== undefined && a.rank.outcome !== b.rank.outcome) {
    return order[a.rank.outcome] - order[b.rank.outcome];
  }
  if (a.rank.quality !== b.rank.quality) return b.rank.quality - a.rank.quality;
  if (a.rank.correct !== b.rank.correct) return b.rank.correct - a.rank.correct;
  return a.index - b.index;
}

/** The index of the sample Jev rates best, or undefined when nothing was ranked. */
export function pickBest(samples: Array<{ index: number; rank?: RankScore | undefined }>): number | undefined {
  const ranked = samples.filter((s): s is { index: number; rank: RankScore } =>
    s.rank !== undefined && (s.rank.outcome === undefined || s.rank.outcome === "accept"));
  if (ranked.length === 0) return undefined;
  return [...ranked].sort(compareRanked)[0]?.index;
}
