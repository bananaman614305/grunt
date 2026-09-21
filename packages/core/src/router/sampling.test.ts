import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "../jev/types.js";
import type { ChatMessage } from "../types.js";
import {
  applyVariant,
  compareRanked,
  pickBest,
  PROMPT_VARIANTS,
  RANK_QUESTIONS,
  rankAnswer,
  rankState,
  variantFor,
} from "./sampling.js";
import type { RankScore } from "./sampling.js";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "Fix the typo in the README." },
];

describe("prompt variants", () => {
  it("cycles the framings by sample index, starting with the plain prompt", () => {
    expect(variantFor(0)).toBe("");
    expect(variantFor(1)).toBe(PROMPT_VARIANTS[1]);
    expect(variantFor(PROMPT_VARIANTS.length)).toBe("");
  });

  it("leaves the messages untouched for the empty framing", () => {
    expect(applyVariant(MESSAGES, "")).toBe(MESSAGES);
  });

  it("appends the framing to an existing system message", () => {
    const varied = applyVariant(MESSAGES, "Check your work.");
    expect(varied[0]?.content).toBe("You are a sub-agent.\n\nCheck your work.");
    // The original is not mutated.
    expect(MESSAGES[0]?.content).toBe("You are a sub-agent.");
    expect(varied[1]).toBe(MESSAGES[1]);
  });

  it("adds a system message when there is none", () => {
    const varied = applyVariant([{ role: "user", content: "hi" }], "Check your work.");
    expect(varied[0]).toEqual({ role: "system", content: "Check your work." });
    expect(varied).toHaveLength(2);
  });
});

describe("rankState", () => {
  it("renders the transcript and the candidate, clipped", () => {
    const state = rankState(MESSAGES, "Done.", 10_000);
    expect(state["task"]).toContain("[system]\nYou are a sub-agent.");
    expect(state["task"]).toContain("[user]\nFix the typo in the README.");
    expect(state["candidate_answer"]).toBe("Done.");
  });

  it("marks an empty answer rather than sending an empty string", () => {
    expect(rankState(MESSAGES, "  ")["candidate_answer"]).toBe("(empty answer)");
  });

  it("truncates an oversized answer", () => {
    const state = rankState(MESSAGES, "x".repeat(50), 10);
    expect(state["candidate_answer"]).toContain("[truncated]");
  });
});

function jevRanking(probabilities: Record<string, number>, noul: number): JevClientLike & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    systemone: (req): Promise<SystemOneResult> => {
      calls.push(req.state as Record<string, unknown>);
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities },
          correct: { type: "noul", noul },
        },
        usage: { input_tokens: 400, output_tokens: 8 },
        requestId: "req_rank",
        latencyMs: 55,
      });
    },
  };
}

/** A stub that records the per-call `apiKey` opt each systemone call saw. */
function keyCapturingRanker(): JevClientLike & { keys: Array<string | undefined> } {
  const keys: Array<string | undefined> = [];
  return {
    keys,
    systemone: (_req, opts): Promise<SystemOneResult> => {
      keys.push(opts?.apiKey);
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities: { "2": 1 } },
          correct: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 400, output_tokens: 8 },
        requestId: "req_rank",
        latencyMs: 55,
      });
    },
  };
}

describe("rankAnswer: forwarded Jev key (ADR-022)", () => {
  it("threads the forwarded key to the systemone call as opts.apiKey", async () => {
    const jev = keyCapturingRanker();
    await rankAnswer(jev, MESSAGES, "Done.", undefined, "sk-or-v1-forwarded");
    expect(jev.keys).toEqual(["sk-or-v1-forwarded"]);
  });

  it("passes no apiKey when none is threaded (TypeSafe default: Milo's key)", async () => {
    const jev = keyCapturingRanker();
    await rankAnswer(jev, MESSAGES, "Done.");
    expect(jev.keys).toEqual([undefined]);
  });

  it("passes no apiKey for an empty forwarded key (no unauthenticated call)", async () => {
    const jev = keyCapturingRanker();
    await rankAnswer(jev, MESSAGES, "Done.", undefined, "");
    expect(jev.keys).toEqual([undefined]);
  });
});

describe("rankAnswer", () => {
  it("returns the expected quality from the probabilities, plus correctness", async () => {
    const jev = jevRanking({ "0": 0.1, "1": 0.1, "2": 0.3, "3": 0.5 }, 0.9);
    const rank = await rankAnswer(jev, MESSAGES, "Done.");
    expect(rank.quality).toBeCloseTo(0.1 + 0.6 + 1.5);
    expect(rank.correct).toBe(0.9);
    expect(rank.confidence).toBe(0.8);
    // The call sent the rank questions, not the router's.
    expect(Object.keys(RANK_QUESTIONS)).toEqual(["quality", "correct"]);
  });

  it("throws when Jev answers with the wrong shapes", async () => {
    const jev: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: { quality: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "req_bad",
          latencyMs: 5,
        } as SystemOneResult),
    };
    await expect(rankAnswer(jev, MESSAGES, "Done.")).rejects.toThrow(/wrong type/);
  });
});

describe("picking", () => {
  const rank = (quality: number, correct: number): RankScore => ({
    quality,
    correct,
    confidence: 0.8,
    latencyMs: 10,
  });

  it("orders by expected quality, then correctness, then index", () => {
    expect(compareRanked({ index: 0, rank: rank(1, 0.9) }, { index: 1, rank: rank(2, 0.1) })).toBeGreaterThan(0);
    expect(compareRanked({ index: 0, rank: rank(2, 0.2) }, { index: 1, rank: rank(2, 0.9) })).toBeGreaterThan(0);
    expect(compareRanked({ index: 0, rank: rank(2, 0.5) }, { index: 1, rank: rank(2, 0.5) })).toBeLessThan(0);
  });

  it("picks the best-ranked sample and ignores unranked ones", () => {
    const pick = pickBest([
      { index: 0, rank: rank(1.2, 0.4) },
      { index: 1 },
      { index: 2, rank: rank(2.4, 0.9) },
      { index: 3, rank: rank(2.4, 0.7) },
    ]);
    expect(pick).toBe(2);
  });

  it("returns undefined when nothing was ranked", () => {
    expect(pickBest([{ index: 0 }, { index: 1 }])).toBeUndefined();
  });
});
