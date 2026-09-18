/**
 * Best-of-N sampling primitives (ADR-010): the varied prompt framings the
 * gateway fans out with, and the Jev questions that rank the answers.
 *
 * Sampling is a routing outcome, not a mode: policy v4 resolves some cells to
 * `{ tier: "fast", samples: N }` (see `policy.ts`), and the gateway executes
 * that by drawing N answers from the fast tier -- each with one of these
 * framings appended to the system prompt -- then asking Jev to score every
 * answer and returning the best. The framings and question shapes were
 * validated by the benchmark in `packages/evals/src/bench` (two live runs,
 * AUROC 0.87/0.91 against the graders); this module is their production home,
 * next to the router questions they run alongside. Do not edit one copy
 * without re-running the benchmark.
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
 * The two questions one Jev call asks about one candidate answer: an expected
 * quality score (0..3) and a correctness probability. Benchmarked shapes
 * (ADR-010); the wording is the ranking prompt, so changing it changes picks.
 */
export const RANK_QUESTIONS: Record<string, JevQuestion> = {
  quality: {
    type: "score",
    instructions:
      "A user sent the task below to an AI assistant and got the candidate answer. Rate how well the candidate answer resolves the task. Judge correctness and completeness against what the task actually asked, not length or tone.",
    criteria: [
      "Wrong or off-task: the answer misreads the task, gives an incorrect result, or does not do what was asked.",
      "Partly right: the main idea is there but a substantive error or omission remains that the user would have to fix.",
      "Right in substance with a minor flaw: a small mistake, a missing edge case, or unnecessary material, but the user could use it as is.",
      "Right and complete: correct, does everything the task asked, and nothing needs fixing.",
    ],
  },
  correct: {
    type: "noul",
    instructions: "Is the candidate answer correct for the task as asked?",
    criteria: {
      true: "The answer is correct and does what the task asked.",
      false: "The answer is wrong, incomplete, or answers a different question.",
    },
  },
};

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
};

/** Total budget for one ranking call, ms. */
export const RANK_BUDGET_MS = 8_000;

/**
 * Asks Jev (on Milo's key) to score one candidate answer. Throws on a Jev
 * failure; the caller decides what a failed rank means.
 */
export async function rankAnswer(
  jev: JevClientLike,
  task: ChatMessage[],
  answer: string,
  budgetMs = RANK_BUDGET_MS,
): Promise<RankScore> {
  const result = await jev.systemone({ state: rankState(task, answer), questions: RANK_QUESTIONS }, { budgetMs });
  const quality = result.answers["quality"];
  const correct = result.answers["correct"];
  if (quality?.type !== "score" || correct?.type !== "noul") {
    throw new Error("jev returned rank answers of the wrong type");
  }
  const expected = Object.entries(quality.probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
  return {
    quality: Number.isFinite(expected) ? expected : quality.score,
    correct: correct.noul,
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
  if (a.rank.quality !== b.rank.quality) return b.rank.quality - a.rank.quality;
  if (a.rank.correct !== b.rank.correct) return b.rank.correct - a.rank.correct;
  return a.index - b.index;
}

/** The index of the sample Jev rates best, or undefined when nothing was ranked. */
export function pickBest(samples: Array<{ index: number; rank?: RankScore | undefined }>): number | undefined {
  const ranked = samples.filter((s): s is { index: number; rank: RankScore } => s.rank !== undefined);
  if (ranked.length === 0) return undefined;
  return [...ranked].sort(compareRanked)[0]?.index;
}
