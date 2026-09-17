import { describe, expect, it } from "vitest";
import type { CostPosture, RouteSignals, TaskType } from "../types.js";
import { chooseTier } from "./policy.js";

function signals(difficulty: number, needsReasoning: number, taskType: TaskType = "feature"): RouteSignals {
  return {
    taskType,
    difficulty,
    needsReasoning,
    longOutput: 0,
    confidences: { task_type: 0.9, difficulty: 0.8 },
    jevRequestId: "req_test",
    jevModel: "jev-latest",
    latencyMs: 61,
  };
}

const POSTURES: CostPosture[] = ["low", "balanced", "quality"];

describe("policy v1 table", () => {
  it("row 1: difficulty below 1.0 is fast under every posture and every needs_reasoning", () => {
    for (const posture of POSTURES) {
      for (const reasoning of [0, 0.49, 0.5, 1]) {
        expect(chooseTier(signals(0.4, reasoning), posture).tier).toBe("fast");
      }
    }
  });

  it("row 2: difficulty 1.0 to 2.0 with needs_reasoning below 0.5 is fast on low and mid on balanced", () => {
    expect(chooseTier(signals(1.5, 0.2), "low").tier).toBe("fast");
    expect(chooseTier(signals(1.5, 0.2), "balanced").tier).toBe("mid");
  });

  it("row 3: difficulty 1.0 to 2.0 with needs_reasoning at or above 0.5 is mid", () => {
    expect(chooseTier(signals(1.5, 0.5), "low").tier).toBe("mid");
    expect(chooseTier(signals(1.5, 0.9), "balanced").tier).toBe("mid");
    // "any posture" in row 3 yields to the last row, which is worded as an
    // override: quality posture at difficulty >= 1.0 goes to frontier.
    expect(chooseTier(signals(1.5, 0.9), "quality").tier).toBe("frontier");
  });

  it("row 4: difficulty at or above 2.0 with low posture is mid", () => {
    expect(chooseTier(signals(2.4, 0.9), "low").tier).toBe("mid");
    expect(chooseTier(signals(3, 1), "low").tier).toBe("mid");
  });

  it("row 5: difficulty at or above 2.0 with balanced or quality posture is frontier", () => {
    expect(chooseTier(signals(2.4, 0.2), "balanced").tier).toBe("frontier");
    expect(chooseTier(signals(2.4, 0.2), "quality").tier).toBe("frontier");
  });

  it("row 6: quality posture at difficulty 1.0 or above is frontier even where rows 2 and 3 say less", () => {
    expect(chooseTier(signals(1.0, 0), "quality").tier).toBe("frontier");
    expect(chooseTier(signals(1.9, 0.1), "quality").tier).toBe("frontier");
    // ...but row 6 is gated on difficulty >= 1.0, so row 1 still wins below it.
    expect(chooseTier(signals(0.99, 1), "quality").tier).toBe("fast");
  });
});

describe("classify and chat cap", () => {
  for (const taskType of ["classify", "chat"] as const) {
    it(`${taskType} caps at mid below difficulty 2.5`, () => {
      expect(chooseTier(signals(2.4, 0.9, taskType), "balanced").tier).toBe("mid");
      expect(chooseTier(signals(1.2, 0.1, taskType), "quality").tier).toBe("mid");
    });

    it(`${taskType} reaches frontier at difficulty 2.5`, () => {
      expect(chooseTier(signals(2.5, 0.9, taskType), "balanced").tier).toBe("frontier");
      expect(chooseTier(signals(2.5, 0.1, taskType), "quality").tier).toBe("frontier");
    });

    it(`${taskType} does not have the cap raise a tier`, () => {
      // The cap only lowers frontier to mid; it never promotes fast.
      expect(chooseTier(signals(0.5, 0.9, taskType), "balanced").tier).toBe("fast");
      expect(chooseTier(signals(2.6, 0.9, taskType), "low").tier).toBe("mid");
    });
  }

  it("leaves other task types alone at the same numbers", () => {
    expect(chooseTier(signals(2.4, 0.9, "debug"), "balanced").tier).toBe("frontier");
  });
});

describe("boundaries", () => {
  it("0.99 is fast, 1.0 is not", () => {
    expect(chooseTier(signals(0.99, 0.9), "balanced").tier).toBe("fast");
    expect(chooseTier(signals(1.0, 0.9), "balanced").tier).toBe("mid");
    expect(chooseTier(signals(0.99, 0.9), "quality").tier).toBe("fast");
    expect(chooseTier(signals(1.0, 0.9), "quality").tier).toBe("frontier");
  });

  it("1.99 is the middle band, 2.0 is the high band", () => {
    expect(chooseTier(signals(1.99, 0.2), "balanced").tier).toBe("mid");
    expect(chooseTier(signals(2.0, 0.2), "balanced").tier).toBe("frontier");
    expect(chooseTier(signals(1.99, 0.2), "low").tier).toBe("fast");
    expect(chooseTier(signals(2.0, 0.2), "low").tier).toBe("mid");
  });

  it("2.49 is capped for chat, 2.5 is not", () => {
    expect(chooseTier(signals(2.49, 0.9, "chat"), "balanced").tier).toBe("mid");
    expect(chooseTier(signals(2.5, 0.9, "chat"), "balanced").tier).toBe("frontier");
  });

  it("needs_reasoning 0.49 versus 0.5 in the middle band under low posture", () => {
    expect(chooseTier(signals(1.5, 0.49), "low").tier).toBe("fast");
    expect(chooseTier(signals(1.5, 0.5), "low").tier).toBe("mid");
  });
});

describe("reason text", () => {
  it("is one sentence citing the numbers it used", () => {
    const { reason } = chooseTier(signals(2.4, 0.2), "balanced");
    expect(reason).toBe("difficulty 2.4 with balanced posture routes to frontier");
  });

  it("names needs_reasoning when it decided the tier", () => {
    const { reason } = chooseTier(signals(1.5, 0.8), "balanced");
    expect(reason).toContain("difficulty 1.5");
    expect(reason).toContain("needs_reasoning 0.8");
    expect(reason).toContain("mid");
  });

  it("says so when the task-type cap pulled the tier down", () => {
    const { reason } = chooseTier(signals(2.4, 0.2, "chat"), "balanced");
    expect(reason).toContain("chat task caps at mid below difficulty 2.5");
  });

  it("never spans more than one sentence", () => {
    for (const posture of POSTURES) {
      for (const difficulty of [0.2, 1.4, 2.7]) {
        for (const taskType of ["chat", "debug"] as const) {
          const { reason } = chooseTier(signals(difficulty, 0.6, taskType), posture);
          expect(reason).not.toContain(". ");
          expect(reason.length).toBeGreaterThan(10);
        }
      }
    }
  });
});
