import { describe, expect, it } from "vitest";
import type { ChatMessage, JevClientLike } from "@milo/core";
import {
  applyVariant,
  auroc,
  pickByJev,
  pickByOracle,
  PROMPT_VARIANTS,
  randomPickPassRate,
  rankAnswer,
  rankKey,
  rankState,
  variantFor,
} from "./sampling.js";
import type { RankedSample } from "./sampling.js";

describe("prompt variation", () => {
  it("appends the variant to an existing system message and adds one when absent", () => {
    const withSys: ChatMessage[] = [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ];
    expect(applyVariant(withSys, "Think first.")[0]).toEqual({ role: "system", content: "You are terse.\n\nThink first." });
    const noSys: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = applyVariant(noSys, "Think first.");
    expect(out[0]).toEqual({ role: "system", content: "Think first." });
    expect(out).toHaveLength(2);
    expect(applyVariant(withSys, "")).toBe(withSys);
  });

  it("variantFor cycles only when varying", () => {
    expect(variantFor(0, false)).toBe("");
    expect(variantFor(3, false)).toBe("");
    expect(variantFor(0, true)).toBe(PROMPT_VARIANTS[0]);
    expect(variantFor(PROMPT_VARIANTS.length + 1, true)).toBe(PROMPT_VARIANTS[1]);
  });
});

describe("selection", () => {
  const s = (index: number, pass: boolean, quality: number, correct = 0.5): RankedSample => ({
    index,
    grade: { score: pass ? 1 : 0, pass, by: "mechanical" },
    rank: { quality, correct, confidence: 0.9, latencyMs: 100 },
  });

  it("rankKey orders by quality then correctness, and unranked sorts last", () => {
    expect(rankKey({ quality: 2, correct: 0.9, confidence: 1, latencyMs: 1 })).toBeGreaterThan(rankKey({ quality: 1.9, correct: 1, confidence: 1, latencyMs: 1 }));
    expect(rankKey(undefined)).toBeLessThan(rankKey({ quality: 0, correct: 0, confidence: 1, latencyMs: 1 }));
  });

  it("pickByJev takes the highest-ranked sample", () => {
    const chosen = pickByJev([s(0, false, 1.0), s(1, true, 2.8), s(2, false, 2.0)]);
    expect(chosen?.index).toBe(1);
  });

  it("pickByOracle takes a passing sample if any, else the first", () => {
    expect(pickByOracle([s(0, false, 3), s(1, true, 0.1)])?.index).toBe(1);
    expect(pickByOracle([s(0, false, 3), s(1, false, 2)])?.index).toBe(0);
  });

  it("randomPickPassRate is the mean pass rate over graded samples", () => {
    expect(randomPickPassRate([s(0, true, 1), s(1, false, 1), s(2, false, 1), s(3, true, 1)])).toBe(0.5);
    expect(randomPickPassRate([])).toBeNaN();
  });
});

describe("auroc", () => {
  it("is 1 for a perfect separator, 0 for an inverted one, 0.5 for ties", () => {
    expect(auroc([{ score: 2, pass: true }, { score: 1, pass: false }])).toBe(1);
    expect(auroc([{ score: 1, pass: true }, { score: 2, pass: false }])).toBe(0);
    expect(auroc([{ score: 1, pass: true }, { score: 1, pass: false }])).toBe(0.5);
    expect(auroc([{ score: 1, pass: true }])).toBeNaN();
  });
});

describe("rankState", () => {
  it("renders the transcript and clips long content", () => {
    const state = rankState([{ role: "user", content: "x".repeat(20) }], "y".repeat(20), 10);
    expect(state["task"]).toContain("[user]");
    expect(String(state["candidate_answer"])).toContain("…[truncated]");
  });
});

describe("rankAnswer", () => {
  it("asks Jev the rank questions and returns expected quality plus correctness", async () => {
    let sent: unknown;
    const jev: JevClientLike = {
      systemone: async (req) => {
        sent = req;
        return {
          model: "jev-latest",
          answers: {
            quality: { type: "score", score: 3, confidence: 0.8, legend: {}, probabilities: { "0": 0, "1": 0, "2": 0.25, "3": 0.75 } },
            correct: { type: "noul", noul: 0.9 },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
          requestId: "req-1",
          latencyMs: 150,
        };
      },
    };
    const score = await rankAnswer(jev, [{ role: "user", content: "task" }], "answer");
    expect(score.quality).toBeCloseTo(2.75, 6);
    expect(score.correct).toBe(0.9);
    expect(score.latencyMs).toBe(150);
    expect((sent as { questions: Record<string, unknown> }).questions).toHaveProperty("quality");
  });

  it("throws when Jev returns the wrong answer types", async () => {
    const jev: JevClientLike = {
      systemone: async () => ({
        model: "jev-latest",
        answers: { quality: { type: "noul", noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "r",
        latencyMs: 1,
      }),
    };
    await expect(rankAnswer(jev, [{ role: "user", content: "t" }], "a")).rejects.toThrow(/wrong type/);
  });
});
