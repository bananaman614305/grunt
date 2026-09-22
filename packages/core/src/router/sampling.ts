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

import type { JevClientLike, JevQuestion } from "../jev/types.js";
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
): Promise<RankScore> {
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
