/**
 * Best-of-N sampling for the benchmark: draw N answers from one cheap model,
 * grade each, and pick one with Jev acting as the verifier.
 *
 * Brown et al. (2024, "Large Language Monkeys") show coverage, the chance
 * that at least one of N samples solves a task, climbs log-linearly with N,
 * and that the gain only transfers to accuracy when something can pick the
 * right sample. Jev is a calibrated classifier that answers questions about
 * arbitrary text for a fraction of a cent, so this module asks it to score
 * every candidate and takes the best. The benchmark then measures three
 * things: how well Jev's score predicts the grader's verdict, how often its
 * pick passes when the samples disagree, and how close that lands to the
 * oracle that picks a passing sample whenever one exists.
 */

import type { ChatMessage, JevClientLike, JevQuestion } from "@milo/core";
import type { Grade } from "./types.js";

/** Framings appended to the system prompt, cycled by sample index when `vary` is on. */
export const PROMPT_VARIANTS: readonly string[] = [
  "",
  "Think the problem through step by step before you answer, then give the final answer.",
  "Give your answer, then re-check it for mistakes and correct any you find before finishing.",
  "Be precise and concise. Prefer a direct answer over discussion.",
  "Consider two different approaches, then commit to the better one and answer.",
];

/** Returns the task with the variant's framing appended to (or added as) the system message. */
export function applyVariant(messages: ChatMessage[], variant: string): ChatMessage[] {
  if (variant === "") return messages;
  const index = messages.findIndex((m) => m.role === "system");
  if (index === -1) return [{ role: "system", content: variant }, ...messages];
  const system = messages[index] as ChatMessage;
  const content = typeof system.content === "string" ? `${system.content}\n\n${variant}` : variant;
  return messages.map((m, i) => (i === index ? { ...m, content } : m));
}

/** The variant for sample `i`; `""` (no framing) for every sample when `vary` is off. */
export function variantFor(index: number, vary: boolean): string {
  if (!vary) return "";
  return PROMPT_VARIANTS[index % PROMPT_VARIANTS.length] as string;
}

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

function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  return "";
}

/** Jev's view of one candidate: the task transcript and the answer, trimmed to keep the call cheap. */
export function rankState(task: ChatMessage[], answer: string, maxChars = 12_000): Record<string, unknown> {
  const transcript = task.map((m) => `[${m.role}]\n${messageText(m)}`).join("\n\n");
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

/** Asks Jev to score one candidate answer. Throws on a Jev failure; the caller decides what that means. */
export async function rankAnswer(jev: JevClientLike, task: ChatMessage[], answer: string, budgetMs = 8_000): Promise<RankScore> {
  const result = await jev.systemone({ state: rankState(task, answer), questions: RANK_QUESTIONS }, { budgetMs });
  const quality = result.answers["quality"];
  const correct = result.answers["correct"];
  if (quality?.type !== "score" || correct?.type !== "noul") throw new Error("jev returned answers of the wrong type");
  const expected = Object.entries(quality.probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
  return { quality: Number.isFinite(expected) ? expected : quality.score, correct: correct.noul, confidence: quality.confidence, latencyMs: result.latencyMs };
}

/** A single ranked sample. */
export type RankedSample = { index: number; grade?: Grade | undefined; rank?: RankScore | undefined };

/** Higher is better: Jev's expected quality, with its correctness probability breaking ties. */
export function rankKey(rank: RankScore | undefined): number {
  if (rank === undefined) return -1;
  return rank.quality + rank.correct / 10;
}

/** The sample Jev rates highest; the first sample when nothing was ranked. */
export function pickByJev(samples: RankedSample[]): RankedSample | undefined {
  let best: RankedSample | undefined;
  for (const s of samples) {
    if (best === undefined || rankKey(s.rank) > rankKey(best.rank)) best = s;
  }
  return best;
}

/** A passing sample if any exists, else the first: the coverage ceiling. */
export function pickByOracle(samples: RankedSample[]): RankedSample | undefined {
  return samples.find((s) => s.grade?.pass === true) ?? samples[0];
}

/** Mean pass rate across samples: what a random pick would score in expectation. */
export function randomPickPassRate(samples: RankedSample[]): number {
  const graded = samples.filter((s) => s.grade !== undefined);
  if (graded.length === 0) return NaN;
  return graded.filter((s) => s.grade?.pass).length / graded.length;
}

/**
 * Area under the ROC curve of `score` against `pass`, over every graded
 * sample: the chance a random passing sample outranks a random failing one.
 * 0.5 is no better than chance; `NaN` when either class is empty.
 */
export function auroc(pairs: Array<{ score: number; pass: boolean }>): number {
  const pos = pairs.filter((p) => p.pass).map((p) => p.score);
  const neg = pairs.filter((p) => !p.pass).map((p) => p.score);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
