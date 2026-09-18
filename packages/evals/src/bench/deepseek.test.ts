import { describe, expect, it } from "vitest";
import type { JevClientLike, RouteSignals, SystemOneResult } from "@milo/core";
import { JEV_PROFILE } from "@milo/core";
import {
  computeBand,
  computeBudget,
  DEEPSEEK_BRANCH_MODEL,
  DEEPSEEK_ORCHESTRATOR_MODEL,
  sizeCompute,
} from "./deepseek.js";

function signals(over: Partial<RouteSignals>): RouteSignals {
  return {
    taskType: "edit",
    difficulty: 1,
    difficultyLevels: [],
    needsReasoning: 0.5,
    longOutput: 0.2,
    confidences: {},
    jevRequestId: "req",
    jevModel: "jev-latest",
    latencyMs: 10,
    ...over,
  };
}

describe("computeBand", () => {
  it("reads the policy's gates in order: fast gate, hard mass, upper mass, mid", () => {
    // Fast gate: P1+ well below the threshold.
    expect(computeBand(signals({ difficultyLevels: [0.9, 0.1, 0, 0] }))).toBe(0);
    // Above the fast gate, no frontier mass: the mid cell.
    expect(computeBand(signals({ difficultyLevels: [0.5, 0.5, 0, 0] }))).toBe(1);
    // Upper mass clears its gate with a hard tail below its own.
    expect(computeBand(signals({ difficultyLevels: [0.1, 0.2, 0.66, 0.04] }))).toBe(2);
    // A hard tail at or above the hard gate wins over the upper gate.
    expect(computeBand(signals({ difficultyLevels: [0.5, 0.3, 0.1, 0.1] }))).toBe(3);
  });

  it("sits exactly on the imported thresholds, not on copies", () => {
    const { fastBelowMass, frontierHardMass, frontierUpperMass } = JEV_PROFILE;
    // Exactly at the fast threshold is not fast (the gate is strict-below).
    expect(computeBand(signals({ difficultyLevels: [1 - fastBelowMass, fastBelowMass, 0, 0] }))).toBe(1);
    // Exactly at the hard threshold is band 3.
    expect(computeBand(signals({ difficultyLevels: [0.3, 1 - 0.3 - frontierHardMass, 0, frontierHardMass] }))).toBe(3);
    // Exactly at the upper threshold (hard mass zero) is band 2.
    expect(computeBand(signals({ difficultyLevels: [0, 1 - frontierUpperMass, frontierUpperMass, 0] }))).toBe(2);
  });

  it("falls back to the expected-score thresholds when no distribution came back", () => {
    expect(computeBand(signals({ difficultyLevels: [], difficulty: 0.4 }))).toBe(0);
    expect(computeBand(signals({ difficultyLevels: [], difficulty: 1.5 }))).toBe(1);
    expect(computeBand(signals({ difficultyLevels: [], difficulty: 2.2 }))).toBe(2);
    expect(computeBand(signals({ difficultyLevels: [], difficulty: 2.8 }))).toBe(3);
  });
});

describe("computeBudget", () => {
  it("maps bands to the ADR-012 phase 1 budgets", () => {
    expect(computeBudget(0)).toEqual({ band: 0, model: DEEPSEEK_BRANCH_MODEL, samples: 1 });
    expect(computeBudget(1)).toEqual({ band: 1, model: DEEPSEEK_BRANCH_MODEL, samples: 1 });
    expect(computeBudget(2)).toEqual({ band: 2, model: DEEPSEEK_BRANCH_MODEL, samples: 5 });
    expect(computeBudget(3)).toEqual({ band: 3, model: DEEPSEEK_ORCHESTRATOR_MODEL, samples: 5 });
  });
});

describe("sizeCompute", () => {
  const sizingResult = (levels: Record<string, number>): SystemOneResult => ({
    model: "jev-latest",
    requestId: "req-1",
    latencyMs: 42,
    usage: { input_tokens: 100, output_tokens: 10 },
    answers: {
      task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: { edit: 0.9 } },
      difficulty: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: levels },
      needs_reasoning: { type: "noul", noul: 0.5 },
      long_output: { type: "noul", noul: 0.2 },
    },
  });

  it("asks Jev the router's questions over the router's state and returns the band's budget", async () => {
    const asked: Array<{ questions: string[]; state: unknown }> = [];
    const jev: JevClientLike = {
      systemone: async (req) => {
        asked.push({ questions: Object.keys(req.questions), state: req.state });
        return sizingResult({ "0": 0.1, "1": 0.2, "2": 0.66, "3": 0.04 });
      },
    };
    const { signals: got, budget } = await sizeCompute(jev, [{ role: "user", content: "refactor the module" }]);
    expect(asked[0]?.questions.sort()).toEqual(["difficulty", "long_output", "needs_reasoning", "task_type"]);
    expect(got.taskType).toBe("edit");
    expect(got.difficultyLevels).toEqual([0.1, 0.2, 0.66, 0.04]);
    expect(budget).toEqual({ band: 2, model: DEEPSEEK_BRANCH_MODEL, samples: 5 });
  });

  it("propagates a Jev failure instead of guessing a budget", async () => {
    const jev: JevClientLike = {
      systemone: async () => {
        throw new Error("boom");
      },
    };
    await expect(sizeCompute(jev, [{ role: "user", content: "x" }])).rejects.toThrow("boom");
  });
});
