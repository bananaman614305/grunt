import { describe, expect, it } from "vitest";
import type { CostPosture, RouteSignals, TaskType } from "../types.js";
import type { PolicyProfile } from "./policy.js";
import {
  CAPPED_TASK_TYPES,
  chooseTier,
  chooseTierFromExpectedScore,
  DEFAULT_PROFILE,
  fastGateMass,
  hardMass,
  JEV_PROFILE,
  LOW_POSTURE_FAST_MASS,
  postureProfile,
  QUALITY_MIN_FRONTIER_HARD_MASS,
  QUALITY_MIN_FRONTIER_UPPER_MASS,
  QUALITY_POSTURE_FRONTIER_MASS,
  QUALITY_POSTURE_FRONTIER_SHIFT,
  upperMass,
  upperMassFromLevel1,
} from "./policy.js";

const POSTURES: CostPosture[] = ["low", "balanced", "quality"];

/**
 * Signals carrying a per-level distribution. `levels` is ordered 0..3; the
 * expected score is derived from it so the two never disagree, which is what a
 * real backend returns.
 */
function signals(levels: number[], taskType: TaskType = "feature", needsReasoning = 0.5): RouteSignals {
  const difficulty = levels.reduce((sum, p, level) => sum + p * level, 0);
  return {
    taskType,
    difficulty,
    difficultyLevels: levels,
    needsReasoning,
    longOutput: 0,
    confidences: { task_type: 0.9, difficulty: 0.8 },
    jevRequestId: "req_test",
    jevModel: "jev-latest",
    latencyMs: 61,
  };
}

/** Signals with no distribution at all: the v1 expected-score path. */
function scoreOnly(difficulty: number, needsReasoning: number, taskType: TaskType = "feature"): RouteSignals {
  return { ...signals([], taskType, needsReasoning), difficulty };
}

// Distributions chosen against JEV_PROFILE: fast gate on level 1+ below 0.35,
// frontier at P3 >= 0.05 or P2+P3 >= 0.65, cap lifting at P3 >= 0.25.
const FAST = [0.8, 0.15, 0.03, 0.02]; //  P1+ 0.20, P3 0.02, P2+ 0.05
const NEARLY_FAST = [0.6, 0.36, 0.03, 0.01]; //  P1+ 0.40, P3 0.01, P2+ 0.04
const MID = [0.5, 0.35, 0.11, 0.04]; //  P1+ 0.50, P3 0.04, P2+ 0.15
const HARD = [0.3, 0.4, 0.2, 0.1]; //  P1+ 0.70, P3 0.10, P2+ 0.30
const UPPER = [0.1, 0.2, 0.66, 0.04]; //  P1+ 0.90, P3 0.04, P2+ 0.70
const VERY_HARD = [0.01, 0.04, 0.35, 0.6]; //  P1+ 0.99, P3 0.60, P2+ 0.95

describe("masses", () => {
  it("reads P(hard), P(level 2+) and P(level 1+) off the distribution", () => {
    expect(hardMass([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.4);
    expect(upperMass([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.7);
    expect(upperMassFromLevel1([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.9);
  });

  it("treats a missing level as zero mass", () => {
    expect(hardMass([0.5, 0.5])).toBe(0);
    expect(upperMass([0.5, 0.5])).toBe(0);
    expect(upperMassFromLevel1([0.5, 0.5])).toBe(0.5);
  });

  it("the fast gate reads the level the profile names", () => {
    const levels = [0.1, 0.2, 0.3, 0.4];
    expect(fastGateMass(levels, 1)).toBeCloseTo(0.9);
    expect(fastGateMass(levels, 2)).toBeCloseTo(0.7);
  });
});

describe("the one profile", () => {
  it("is Jev's, fitted and validated, and is the default", () => {
    expect(DEFAULT_PROFILE).toBe(JEV_PROFILE);
    expect(JEV_PROFILE).toEqual({
      fastMassFromLevel: 1,
      fastBelowMass: 0.35,
      frontierHardMass: 0.05,
      frontierUpperMass: 0.65,
      cappedFrontierHardMass: 0.25,
    });
  });

  it("is what chooseTier uses when no profile is passed", () => {
    for (const posture of POSTURES) {
      for (const levels of [FAST, MID, HARD, UPPER, VERY_HARD]) {
        expect(chooseTier(signals(levels), posture)).toEqual(
          chooseTier(signals(levels), posture, JEV_PROFILE),
        );
      }
    }
  });

  it("still accepts a candidate profile, so a tuning run needs no code edit", () => {
    // Same distribution, two threshold sets, two answers.
    const candidate: PolicyProfile = { ...JEV_PROFILE, fastBelowMass: 0.9 };
    expect(chooseTier(signals(MID), "balanced", JEV_PROFILE).tier).toBe("mid");
    expect(chooseTier(signals(MID), "balanced", candidate).tier).toBe("fast");
  });
});

describe("posture adjusts the thresholds", () => {
  it("low leaves Jev's fast bar alone, because it already sits above 0.10", () => {
    const low = postureProfile(JEV_PROFILE, "low");
    expect(JEV_PROFILE.fastBelowMass).toBeGreaterThan(LOW_POSTURE_FAST_MASS);
    expect(low.fastBelowMass).toBe(JEV_PROFILE.fastBelowMass);
  });

  it("low raises a fast bar that sits below 0.10, and leaves the frontier bars alone", () => {
    const timid: PolicyProfile = { ...JEV_PROFILE, fastBelowMass: 0.05 };
    const low = postureProfile(timid, "low");
    expect(low.fastBelowMass).toBe(LOW_POSTURE_FAST_MASS);
    expect(low.frontierHardMass).toBe(timid.frontierHardMass);
    expect(low.frontierUpperMass).toBe(timid.frontierUpperMass);
  });

  it("quality lowers the upper frontier bar and floors the hard one", () => {
    const quality = postureProfile(JEV_PROFILE, "quality");
    expect(quality.frontierUpperMass).toBeCloseTo(
      JEV_PROFILE.frontierUpperMass - QUALITY_POSTURE_FRONTIER_SHIFT,
    );
    // 0.05 - 0.10 would be negative without the floor.
    expect(quality.frontierHardMass).toBe(QUALITY_MIN_FRONTIER_HARD_MASS);
    expect(quality.frontierHardMass).toBeGreaterThan(0);
    expect(quality.fastBelowMass).toBe(JEV_PROFILE.fastBelowMass);
  });

  it("quality floors the upper bar too, so a reason never quotes 0.00", () => {
    const tiny: PolicyProfile = { ...JEV_PROFILE, frontierUpperMass: 0.05 };
    expect(postureProfile(tiny, "quality").frontierUpperMass).toBe(QUALITY_MIN_FRONTIER_UPPER_MASS);
  });

  it("balanced changes nothing", () => {
    expect(postureProfile(JEV_PROFILE, "balanced")).toBe(JEV_PROFILE);
  });
});

describe("policy v2", () => {
  it("fast when the level 1+ mass is below the fast bar", () => {
    expect(upperMassFromLevel1(FAST)).toBeLessThan(JEV_PROFILE.fastBelowMass);
    expect(chooseTier(signals(FAST), "balanced").tier).toBe("fast");
  });

  it("gates fast on level 1+, not level 2+: Jev puts mid work on level 1", () => {
    // P2+ is only 0.04, so a level-2 gate would wave this through to fast.
    // The level-1 gate sees 0.40 of mass above trivial and keeps it at mid.
    expect(upperMass(NEARLY_FAST)).toBeLessThan(JEV_PROFILE.fastBelowMass);
    expect(upperMassFromLevel1(NEARLY_FAST)).toBeGreaterThanOrEqual(JEV_PROFILE.fastBelowMass);
    expect(chooseTier(signals(NEARLY_FAST), "balanced").tier).toBe("mid");
    expect(chooseTier(signals(NEARLY_FAST), "balanced", { ...JEV_PROFILE, fastMassFromLevel: 2 }).tier).toBe(
      "fast",
    );
  });

  it("mid when neither frontier bar is reached", () => {
    expect(chooseTier(signals(MID), "balanced").tier).toBe("mid");
  });

  it("frontier on the hard mass alone", () => {
    expect(upperMass(HARD)).toBeLessThan(JEV_PROFILE.frontierUpperMass);
    expect(chooseTier(signals(HARD), "balanced").tier).toBe("frontier");
  });

  it("frontier on the upper mass alone, with the hard mass below its bar", () => {
    expect(hardMass(UPPER)).toBeLessThan(JEV_PROFILE.frontierHardMass);
    expect(chooseTier(signals(UPPER), "balanced").tier).toBe("frontier");
  });

  it("low posture pulls every balanced frontier back to mid", () => {
    for (const levels of [HARD, UPPER, VERY_HARD]) {
      expect(chooseTier(signals(levels), "balanced").tier).toBe("frontier");
      expect(chooseTier(signals(levels), "low").tier).toBe("mid");
    }
  });

  it("low posture caps at mid even for work that is unambiguously hard", () => {
    expect(chooseTier(signals([0, 0, 0, 1]), "low").tier).toBe("mid");
  });

  it("low posture still routes trivial work to fast", () => {
    expect(chooseTier(signals(FAST), "low").tier).toBe("fast");
  });

  it("quality posture's mass rule lifts a balanced mid to frontier", () => {
    // P2+ 0.45 clears QUALITY_POSTURE_FRONTIER_MASS but neither balanced bar.
    const levels = [0.2, 0.35, 0.44, 0.01];
    expect(chooseTier(signals(levels), "balanced").tier).toBe("mid");
    const quality = chooseTier(signals(levels), "quality");
    expect(quality.tier).toBe("frontier");
    expect(quality.reason).toContain(`at or above ${QUALITY_POSTURE_FRONTIER_MASS.toFixed(2)}`);
  });

  it("quality posture's lowered hard bar lifts a narrow, hard-tailed mid", () => {
    // P2+ 0.15 stays under the quality mass rule, but P3 0.04 clears 0.02.
    expect(upperMass(MID)).toBeLessThan(QUALITY_POSTURE_FRONTIER_MASS);
    expect(chooseTier(signals(MID), "balanced").tier).toBe("mid");
    expect(chooseTier(signals(MID), "quality").tier).toBe("frontier");
  });

  it("quality posture still routes trivial work to fast", () => {
    expect(chooseTier(signals(FAST), "quality").tier).toBe("fast");
  });
});

describe("the classify and chat cap", () => {
  for (const taskType of CAPPED_TASK_TYPES) {
    it(`${taskType} caps at mid while P(hard) is below the cap bar`, () => {
      // P3 0.10 clears the 0.05 frontier bar but not the 0.25 cap bar.
      expect(hardMass(HARD)).toBeGreaterThanOrEqual(JEV_PROFILE.frontierHardMass);
      expect(hardMass(HARD)).toBeLessThan(JEV_PROFILE.cappedFrontierHardMass);
      expect(chooseTier(signals(HARD, taskType), "balanced").tier).toBe("mid");
      expect(chooseTier(signals(UPPER, taskType), "balanced").tier).toBe("mid");
      expect(chooseTier(signals(MID, taskType), "quality").tier).toBe("mid");
    });

    it(`${taskType} reaches frontier once P(hard) clears the cap bar`, () => {
      expect(chooseTier(signals(VERY_HARD, taskType), "balanced").tier).toBe("frontier");
    });

    it(`${taskType} never has the cap raise a tier`, () => {
      expect(chooseTier(signals(FAST, taskType), "balanced").tier).toBe("fast");
      expect(chooseTier(signals(MID, taskType), "balanced").tier).toBe("mid");
    });
  }

  it("leaves other task types alone on the same distribution", () => {
    expect(chooseTier(signals(HARD, "debug"), "balanced").tier).toBe("frontier");
  });
});

describe("boundaries", () => {
  it("the fast bar is exclusive: strictly below is fast, exactly at it is not", () => {
    expect(chooseTier(signals([0.651, 0.349, 0, 0]), "balanced").tier).toBe("fast");
    expect(chooseTier(signals([0.65, 0.35, 0, 0]), "balanced").tier).toBe("mid");
  });

  it("the hard bar is inclusive: exactly at it is frontier", () => {
    expect(chooseTier(signals([0.3, 0.45, 0.2, 0.05]), "balanced").tier).toBe("frontier");
    expect(chooseTier(signals([0.3, 0.46, 0.2, 0.04]), "balanced").tier).toBe("mid");
  });

  it("the upper bar is inclusive: exactly at it is frontier", () => {
    expect(chooseTier(signals([0.15, 0.2, 0.61, 0.04]), "balanced").tier).toBe("frontier");
    expect(chooseTier(signals([0.16, 0.2, 0.6, 0.04]), "balanced").tier).toBe("mid");
  });

  it("the cap bar is inclusive: exactly at it reaches frontier", () => {
    expect(chooseTier(signals([0.2, 0.3, 0.25, 0.25], "chat"), "balanced").tier).toBe("frontier");
    expect(chooseTier(signals([0.2, 0.3, 0.251, 0.249], "chat"), "balanced").tier).toBe("mid");
  });

  it("a distribution that is all level 0 is fast under every posture", () => {
    for (const posture of POSTURES) {
      expect(chooseTier(signals([1, 0, 0, 0]), posture).tier).toBe("fast");
    }
  });

  it("a distribution that is all level 3 is frontier under every posture but low", () => {
    for (const posture of POSTURES) {
      const { tier } = chooseTier(signals([0, 0, 0, 1]), posture);
      expect(tier).toBe(posture === "low" ? "mid" : "frontier");
    }
  });
});

describe("reason text", () => {
  it("cites the hard mass and the bar it cleared", () => {
    expect(chooseTier(signals(HARD), "balanced").reason).toBe(
      "P(hard) 0.10 at or above 0.05 with balanced posture routes to frontier",
    );
  });

  it("cites the upper mass when that is what decided it", () => {
    expect(chooseTier(signals(UPPER), "balanced").reason).toBe(
      "P(level 2+) 0.70 at or above 0.65 with balanced posture routes to frontier",
    );
  });

  it("cites both bars when the answer is mid", () => {
    expect(chooseTier(signals(MID), "balanced").reason).toBe(
      "P(hard) 0.04 below 0.05 and P(level 2+) 0.15 below 0.65 with balanced posture routes to mid",
    );
  });

  it("names the level the fast gate actually read", () => {
    expect(chooseTier(signals(FAST), "balanced").reason).toBe(
      "P(level 1+) 0.20 below 0.35 with balanced posture routes to fast",
    );
    expect(chooseTier(signals(FAST), "balanced", { ...JEV_PROFILE, fastMassFromLevel: 2 }).reason).toBe(
      "P(level 2+) 0.05 below 0.35 with balanced posture routes to fast",
    );
  });

  it("says so when the task-type cap pulled the tier down", () => {
    expect(chooseTier(signals(HARD, "chat"), "balanced").reason).toContain(
      "but a chat task caps at mid below P(hard) 0.25",
    );
  });

  it("says that low posture is what capped it, and still cites the mass", () => {
    expect(chooseTier(signals(VERY_HARD), "low").reason).toBe(
      "P(level 1+) 0.99 at or above 0.35 routes above fast, but low posture caps at mid",
    );
  });

  it("never quotes a 0.00 threshold under quality posture", () => {
    for (const levels of [MID, HARD, UPPER, VERY_HARD]) {
      expect(chooseTier(signals(levels), "quality").reason).not.toContain("0.00");
    }
  });

  it("never spans more than one sentence", () => {
    for (const posture of POSTURES) {
      for (const levels of [FAST, NEARLY_FAST, MID, HARD, UPPER, VERY_HARD]) {
        for (const taskType of ["chat", "debug"] as const) {
          const { reason } = chooseTier(signals(levels, taskType), posture);
          expect(reason).not.toContain(". ");
          expect(reason.length).toBeGreaterThan(10);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The v1 expected-score rule, still reached when an answer carries no
// distribution. These are the policy v1 table tests, unchanged in substance.
// ---------------------------------------------------------------------------

describe("the v1 expected-score rule when there are no levels", () => {
  it("row 1: difficulty below 1.0 is fast under every posture and every needs_reasoning", () => {
    for (const posture of POSTURES) {
      for (const reasoning of [0, 0.49, 0.5, 1]) {
        expect(chooseTier(scoreOnly(0.4, reasoning), posture).tier).toBe("fast");
      }
    }
  });

  it("row 2: difficulty 1.0 to 2.0 with needs_reasoning below 0.5 is fast on low and mid on balanced", () => {
    expect(chooseTier(scoreOnly(1.5, 0.2), "low").tier).toBe("fast");
    expect(chooseTier(scoreOnly(1.5, 0.2), "balanced").tier).toBe("mid");
  });

  it("row 3: difficulty 1.0 to 2.0 with needs_reasoning at or above 0.5 is mid", () => {
    expect(chooseTier(scoreOnly(1.5, 0.5), "low").tier).toBe("mid");
    expect(chooseTier(scoreOnly(1.5, 0.9), "balanced").tier).toBe("mid");
    expect(chooseTier(scoreOnly(1.5, 0.9), "quality").tier).toBe("frontier");
  });

  it("row 4: difficulty at or above 2.0 with low posture is mid", () => {
    expect(chooseTier(scoreOnly(2.4, 0.9), "low").tier).toBe("mid");
    expect(chooseTier(scoreOnly(3, 1), "low").tier).toBe("mid");
  });

  it("row 5: difficulty at or above 2.0 with balanced or quality posture is frontier", () => {
    expect(chooseTier(scoreOnly(2.4, 0.2), "balanced").tier).toBe("frontier");
    expect(chooseTier(scoreOnly(2.4, 0.2), "quality").tier).toBe("frontier");
  });

  it("row 6: quality posture at difficulty 1.0 or above is frontier even where rows 2 and 3 say less", () => {
    expect(chooseTier(scoreOnly(1.0, 0), "quality").tier).toBe("frontier");
    expect(chooseTier(scoreOnly(1.9, 0.1), "quality").tier).toBe("frontier");
    expect(chooseTier(scoreOnly(0.99, 1), "quality").tier).toBe("fast");
  });

  it("keeps the v1 classify/chat cap at difficulty 2.5", () => {
    for (const taskType of CAPPED_TASK_TYPES) {
      expect(chooseTier(scoreOnly(2.4, 0.9, taskType), "balanced").tier).toBe("mid");
      expect(chooseTier(scoreOnly(1.2, 0.1, taskType), "quality").tier).toBe("mid");
      expect(chooseTier(scoreOnly(2.5, 0.9, taskType), "balanced").tier).toBe("frontier");
    }
  });

  it("keeps the v1 boundaries", () => {
    expect(chooseTier(scoreOnly(0.99, 0.9), "balanced").tier).toBe("fast");
    expect(chooseTier(scoreOnly(1.0, 0.9), "balanced").tier).toBe("mid");
    expect(chooseTier(scoreOnly(1.99, 0.2), "balanced").tier).toBe("mid");
    expect(chooseTier(scoreOnly(2.0, 0.2), "balanced").tier).toBe("frontier");
    expect(chooseTier(scoreOnly(1.5, 0.49), "low").tier).toBe("fast");
    expect(chooseTier(scoreOnly(1.5, 0.5), "low").tier).toBe("mid");
  });

  it("keeps the v1 reason text, which cites the expected score", () => {
    expect(chooseTier(scoreOnly(2.4, 0.2), "balanced").reason).toBe(
      "difficulty 2.4 with balanced posture routes to frontier",
    );
  });

  it("ignores the profile entirely, since there are no masses to compare", () => {
    const candidate: PolicyProfile = { ...JEV_PROFILE, fastBelowMass: 0.99, frontierHardMass: 0.99 };
    expect(chooseTier(scoreOnly(2.4, 0.2), "balanced", candidate).tier).toBe("frontier");
  });

  it("is the same function the policy calls directly", () => {
    expect(chooseTier(scoreOnly(1.5, 0.9), "balanced")).toEqual(
      chooseTierFromExpectedScore(scoreOnly(1.5, 0.9), "balanced"),
    );
  });
});
