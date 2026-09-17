import { describe, expect, it } from "vitest";
import type { CostPosture, RouteSignals, TaskType } from "../types.js";
import {
  CAPPED_TASK_TYPES,
  chooseTier,
  chooseTierFromExpectedScore,
  DEFAULT_PROFILE,
  hardMass,
  JEV_PROFILE,
  LOW_POSTURE_FAST_MASS,
  LOW_POSTURE_FRONTIER_SHIFT,
  postureProfile,
  profileForModel,
  PROFILES,
  QUALITY_POSTURE_FRONTIER_MASS,
  QUALITY_POSTURE_FRONTIER_SHIFT,
  resolveProfile,
  SYSTEM_ONE_OPEN_PROFILE,
  upperMass,
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

/** Signals with no distribution at all: the v1 expected-score fallback path. */
function scoreOnly(difficulty: number, needsReasoning: number, taskType: TaskType = "feature"): RouteSignals {
  return { ...signals([], taskType, needsReasoning), difficulty };
}

// Distributions chosen against SYSTEM_ONE_OPEN_PROFILE (0.05 / 0.10 / 0.65 / 0.30).
const OPEN_FAST = [0.6, 0.37, 0.02, 0.01]; //  P3 0.01, P2+ 0.03
const OPEN_NEARLY_FAST = [0.3, 0.63, 0.06, 0.01]; //  P3 0.01, P2+ 0.07
const OPEN_MID = [0.2, 0.5, 0.25, 0.05]; //  P3 0.05, P2+ 0.30
const OPEN_HARD = [0.1, 0.4, 0.32, 0.18]; //  P3 0.18, P2+ 0.50
const OPEN_UPPER = [0.05, 0.25, 0.65, 0.05]; //  P3 0.05, P2+ 0.70
const OPEN_VERY_HARD = [0.02, 0.08, 0.5, 0.4]; //  P3 0.40, P2+ 0.90

// Distributions chosen against JEV_PROFILE (0.10 / 0.25 / 0.50 / 0.50).
const JEV_FAST = [0.75, 0.18, 0.05, 0.02]; //  P3 0.02, P2+ 0.07
const JEV_MID = [0.1, 0.6, 0.25, 0.05]; //  P3 0.05, P2+ 0.30
const JEV_HARD = [0.05, 0.25, 0.4, 0.3]; //  P3 0.30, P2+ 0.70
const JEV_UPPER = [0.05, 0.35, 0.45, 0.15]; //  P3 0.15, P2+ 0.60
const JEV_VERY_HARD = [0.01, 0.04, 0.35, 0.6]; //  P3 0.60, P2+ 0.95

describe("masses", () => {
  it("reads P(hard) and P(level 2+) off the distribution", () => {
    expect(hardMass([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.4);
    expect(upperMass([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.7);
  });

  it("treats a missing level as zero mass", () => {
    expect(hardMass([0.5, 0.5])).toBe(0);
    expect(upperMass([0.5, 0.5])).toBe(0);
  });
});

describe("profiles", () => {
  it("maps each backend name to its own thresholds", () => {
    expect(PROFILES["system-one-open"]).toBe(SYSTEM_ONE_OPEN_PROFILE);
    expect(PROFILES.jev).toBe(JEV_PROFILE);
    expect(DEFAULT_PROFILE).toBe(JEV_PROFILE);
  });

  it("the open backend's bars sit below Jev's, because it hedges", () => {
    expect(SYSTEM_ONE_OPEN_PROFILE.frontierHardMass).toBeLessThan(JEV_PROFILE.frontierHardMass);
    expect(SYSTEM_ONE_OPEN_PROFILE.fastBelowMass).toBeLessThan(JEV_PROFILE.fastBelowMass);
  });

  it("resolves a name, a profile, or nothing at all", () => {
    expect(resolveProfile("system-one-open")).toBe(SYSTEM_ONE_OPEN_PROFILE);
    expect(resolveProfile(JEV_PROFILE)).toBe(JEV_PROFILE);
    expect(resolveProfile(undefined)).toBe(DEFAULT_PROFILE);
  });

  it("picks the open profile from the model-name prefix and Jev's otherwise", () => {
    expect(profileForModel("system-one-open/e2b-full")).toBe(SYSTEM_ONE_OPEN_PROFILE);
    expect(profileForModel("jev-latest")).toBe(JEV_PROFILE);
    expect(profileForModel("")).toBe(JEV_PROFILE);
    // A name that merely contains the marker is not the open backend.
    expect(profileForModel("jev/system-one-open/thing")).toBe(JEV_PROFILE);
  });
});

describe("posture shifts the thresholds", () => {
  it("low raises both frontier bars and the fast bar", () => {
    const low = postureProfile(SYSTEM_ONE_OPEN_PROFILE, "low");
    expect(low.frontierHardMass).toBeCloseTo(SYSTEM_ONE_OPEN_PROFILE.frontierHardMass + LOW_POSTURE_FRONTIER_SHIFT);
    expect(low.frontierUpperMass).toBeCloseTo(SYSTEM_ONE_OPEN_PROFILE.frontierUpperMass + LOW_POSTURE_FRONTIER_SHIFT);
    expect(low.fastBelowMass).toBe(LOW_POSTURE_FAST_MASS);
  });

  it("low never lowers a fast bar that already sits above 0.10", () => {
    expect(postureProfile(JEV_PROFILE, "low").fastBelowMass).toBe(JEV_PROFILE.fastBelowMass);
  });

  it("quality lowers both frontier bars and floors them at zero", () => {
    const quality = postureProfile(JEV_PROFILE, "quality");
    expect(quality.frontierHardMass).toBeCloseTo(JEV_PROFILE.frontierHardMass - QUALITY_POSTURE_FRONTIER_SHIFT);
    expect(quality.frontierUpperMass).toBeCloseTo(JEV_PROFILE.frontierUpperMass - QUALITY_POSTURE_FRONTIER_SHIFT);
    expect(quality.fastBelowMass).toBe(JEV_PROFILE.fastBelowMass);
    expect(postureProfile(SYSTEM_ONE_OPEN_PROFILE, "quality").frontierHardMass).toBe(0);
  });

  it("balanced changes nothing", () => {
    expect(postureProfile(SYSTEM_ONE_OPEN_PROFILE, "balanced")).toBe(SYSTEM_ONE_OPEN_PROFILE);
  });
});

describe("policy v2, system-one-open profile", () => {
  const p = "system-one-open" as const;

  it("fast when P2 + P3 is below the fast bar", () => {
    expect(chooseTier(signals(OPEN_FAST), "balanced", p).tier).toBe("fast");
  });

  it("mid when neither frontier bar is reached", () => {
    expect(chooseTier(signals(OPEN_MID), "balanced", p).tier).toBe("mid");
  });

  it("frontier on the hard mass alone", () => {
    expect(chooseTier(signals(OPEN_HARD), "balanced", p).tier).toBe("frontier");
  });

  it("frontier on the upper mass alone, with the hard mass below its bar", () => {
    expect(hardMass(OPEN_UPPER)).toBeLessThan(SYSTEM_ONE_OPEN_PROFILE.frontierHardMass);
    expect(chooseTier(signals(OPEN_UPPER), "balanced", p).tier).toBe("frontier");
  });

  it("low posture pulls a balanced frontier back to mid", () => {
    expect(chooseTier(signals(OPEN_HARD), "low", p).tier).toBe("mid");
    expect(chooseTier(signals(OPEN_UPPER), "low", p).tier).toBe("mid");
  });

  it("low posture still routes genuinely hard work to frontier", () => {
    expect(chooseTier(signals(OPEN_VERY_HARD), "low", p).tier).toBe("frontier");
  });

  it("low posture's raised fast bar takes borderline work to fast", () => {
    expect(chooseTier(signals(OPEN_NEARLY_FAST), "balanced", p).tier).toBe("mid");
    expect(chooseTier(signals(OPEN_NEARLY_FAST), "low", p).tier).toBe("fast");
  });

  it("quality posture lifts a balanced mid to frontier", () => {
    expect(chooseTier(signals(OPEN_MID), "quality", p).tier).toBe("frontier");
  });

  it("quality posture still routes trivial work to fast", () => {
    expect(chooseTier(signals(OPEN_FAST), "quality", p).tier).toBe("fast");
  });
});

describe("policy v2, jev profile", () => {
  const p = "jev" as const;

  it("fast when P2 + P3 is below the fast bar", () => {
    expect(chooseTier(signals(JEV_FAST), "balanced", p).tier).toBe("fast");
  });

  it("mid when neither frontier bar is reached", () => {
    expect(chooseTier(signals(JEV_MID), "balanced", p).tier).toBe("mid");
  });

  it("frontier on the hard mass alone", () => {
    expect(chooseTier(signals(JEV_HARD), "balanced", p).tier).toBe("frontier");
  });

  it("frontier on the upper mass alone", () => {
    expect(hardMass(JEV_UPPER)).toBeLessThan(JEV_PROFILE.frontierHardMass);
    expect(chooseTier(signals(JEV_UPPER), "balanced", p).tier).toBe("frontier");
  });

  it("low posture pulls a balanced frontier back to mid", () => {
    // P3 0.27 clears the balanced hard bar (0.25) but not the low one (0.40),
    // and P2+ 0.35 clears neither upper bar.
    expect(chooseTier(signals([0.2, 0.45, 0.08, 0.27]), "balanced", p).tier).toBe("frontier");
    expect(chooseTier(signals([0.2, 0.45, 0.08, 0.27]), "low", p).tier).toBe("mid");
    expect(chooseTier(signals(JEV_UPPER), "low", p).tier).toBe("mid");
  });

  it("low posture still routes genuinely hard work to frontier", () => {
    expect(chooseTier(signals(JEV_VERY_HARD), "low", p).tier).toBe("frontier");
    // P2+ 0.70 clears even the low posture's raised upper bar.
    expect(chooseTier(signals(JEV_HARD), "low", p).tier).toBe("frontier");
  });

  it("quality posture's mass rule lifts a balanced mid to frontier", () => {
    // P2+ 0.42 clears QUALITY_POSTURE_FRONTIER_MASS but neither balanced bar.
    const levels = [0.18, 0.4, 0.34, 0.08];
    expect(chooseTier(signals(levels), "balanced", p).tier).toBe("mid");
    const quality = chooseTier(signals(levels), "quality", p);
    expect(quality.tier).toBe("frontier");
    expect(quality.reason).toContain(`at or above ${QUALITY_POSTURE_FRONTIER_MASS.toFixed(2)}`);
  });

  it("quality posture's lowered hard bar lifts a narrow, hard-tailed mid", () => {
    // P2+ 0.30 stays under the quality mass rule, but P3 0.20 clears 0.15.
    const levels = [0.3, 0.4, 0.1, 0.2];
    expect(chooseTier(signals(levels), "balanced", p).tier).toBe("mid");
    expect(chooseTier(signals(levels), "quality", p).tier).toBe("frontier");
  });

  it("quality posture still routes trivial work to fast", () => {
    expect(chooseTier(signals(JEV_FAST), "quality", p).tier).toBe("fast");
  });
});

describe("the classify and chat cap", () => {
  for (const taskType of CAPPED_TASK_TYPES) {
    it(`${taskType} caps at mid while P(hard) is below the profile's cap bar`, () => {
      // P3 0.18 clears the open profile's frontier bar but not its 0.30 cap bar.
      expect(chooseTier(signals(OPEN_HARD, taskType), "balanced", "system-one-open").tier).toBe("mid");
      expect(chooseTier(signals(OPEN_UPPER, taskType), "balanced", "system-one-open").tier).toBe("mid");
      expect(chooseTier(signals(OPEN_MID, taskType), "quality", "system-one-open").tier).toBe("mid");
    });

    it(`${taskType} reaches frontier once P(hard) clears the cap bar`, () => {
      expect(chooseTier(signals(OPEN_VERY_HARD, taskType), "balanced", "system-one-open").tier).toBe("frontier");
      expect(chooseTier(signals(JEV_VERY_HARD, taskType), "balanced", "jev").tier).toBe("frontier");
    });

    it(`${taskType} is capped at Jev's higher bar too`, () => {
      // P3 0.30 is frontier under the jev profile but below its 0.50 cap bar.
      expect(chooseTier(signals(JEV_HARD), "balanced", "jev").tier).toBe("frontier");
      expect(chooseTier(signals(JEV_HARD, taskType), "balanced", "jev").tier).toBe("mid");
    });

    it(`${taskType} never has the cap raise a tier`, () => {
      expect(chooseTier(signals(OPEN_FAST, taskType), "balanced", "system-one-open").tier).toBe("fast");
      expect(chooseTier(signals(OPEN_MID, taskType), "balanced", "system-one-open").tier).toBe("mid");
    });
  }

  it("leaves other task types alone on the same distribution", () => {
    expect(chooseTier(signals(OPEN_HARD, "debug"), "balanced", "system-one-open").tier).toBe("frontier");
  });
});

describe("boundaries", () => {
  it("the fast bar is exclusive: strictly below is fast, exactly at it is not", () => {
    expect(chooseTier(signals([0.5, 0.451, 0.03, 0.019]), "balanced", "system-one-open").tier).toBe("fast");
    expect(chooseTier(signals([0.5, 0.45, 0.03, 0.02]), "balanced", "system-one-open").tier).toBe("mid");
  });

  it("the hard bar is inclusive: exactly at it is frontier", () => {
    expect(chooseTier(signals([0.4, 0.42, 0.08, 0.1]), "balanced", "system-one-open").tier).toBe("frontier");
    expect(chooseTier(signals([0.4, 0.41, 0.09, 0.1 - 0.001]), "balanced", "system-one-open").tier).toBe("mid");
  });

  it("the upper bar is inclusive: exactly at it is frontier", () => {
    expect(chooseTier(signals([0.3, 0.05, 0.6, 0.05]), "balanced", "system-one-open").tier).toBe("frontier");
    expect(chooseTier(signals([0.31, 0.05, 0.59, 0.05]), "balanced", "system-one-open").tier).toBe("mid");
  });

  it("the cap bar is inclusive: exactly at it reaches frontier", () => {
    expect(chooseTier(signals([0.2, 0.2, 0.3, 0.3], "chat"), "balanced", "system-one-open").tier).toBe("frontier");
    expect(chooseTier(signals([0.2, 0.2, 0.301, 0.299], "chat"), "balanced", "system-one-open").tier).toBe("mid");
  });

  it("a distribution that is all level 0 is fast under every posture and profile", () => {
    for (const posture of POSTURES) {
      for (const profile of ["jev", "system-one-open"] as const) {
        expect(chooseTier(signals([1, 0, 0, 0]), posture, profile).tier).toBe("fast");
      }
    }
  });

  it("a distribution that is all level 3 is frontier under every posture and profile", () => {
    for (const posture of POSTURES) {
      for (const profile of ["jev", "system-one-open"] as const) {
        expect(chooseTier(signals([0, 0, 0, 1]), posture, profile).tier).toBe("frontier");
      }
    }
  });
});

describe("reason text", () => {
  it("cites the hard mass and the bar it cleared", () => {
    const { reason } = chooseTier(signals(OPEN_HARD), "balanced", "system-one-open");
    expect(reason).toBe("P(hard) 0.18 at or above 0.10 with balanced posture routes to frontier");
  });

  it("cites the upper mass when that is what decided it", () => {
    const { reason } = chooseTier(signals(OPEN_UPPER), "balanced", "system-one-open");
    expect(reason).toBe("P(level 2+) 0.70 at or above 0.65 with balanced posture routes to frontier");
  });

  it("cites both bars when the answer is mid", () => {
    const { reason } = chooseTier(signals(OPEN_MID), "balanced", "system-one-open");
    expect(reason).toBe(
      "P(hard) 0.05 below 0.10 and P(level 2+) 0.30 below 0.65 with balanced posture routes to mid",
    );
  });

  it("cites the fast bar and the posture", () => {
    const { reason } = chooseTier(signals(OPEN_NEARLY_FAST), "low", "system-one-open");
    expect(reason).toBe("P(level 2+) 0.07 below 0.10 with low posture routes to fast");
  });

  it("says so when the task-type cap pulled the tier down", () => {
    const { reason } = chooseTier(signals(OPEN_HARD, "chat"), "balanced", "system-one-open");
    expect(reason).toContain("but a chat task caps at mid below P(hard) 0.30");
  });

  it("names the posture-shifted bar, not the profile's own", () => {
    const { reason } = chooseTier(signals(OPEN_VERY_HARD), "low", "system-one-open");
    expect(reason).toContain("at or above 0.25");
  });

  it("never spans more than one sentence", () => {
    for (const posture of POSTURES) {
      for (const levels of [OPEN_FAST, OPEN_MID, OPEN_HARD, OPEN_UPPER, OPEN_VERY_HARD]) {
        for (const taskType of ["chat", "debug"] as const) {
          for (const profile of ["jev", "system-one-open"] as const) {
            const { reason } = chooseTier(signals(levels, taskType), posture, profile);
            expect(reason).not.toContain(". ");
            expect(reason.length).toBeGreaterThan(10);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The v1 expected-score rule, still reached when a backend reports no
// distribution. These are the policy v1 table tests, unchanged in substance.
// ---------------------------------------------------------------------------

describe("fallback to the v1 expected-score rule when there are no levels", () => {
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
    for (const profile of ["jev", "system-one-open"] as const) {
      expect(chooseTier(scoreOnly(2.4, 0.2), "balanced", profile).tier).toBe("frontier");
    }
  });

  it("is the same function the policy calls directly", () => {
    expect(chooseTier(scoreOnly(1.5, 0.9), "balanced")).toEqual(
      chooseTierFromExpectedScore(scoreOnly(1.5, 0.9), "balanced"),
    );
  });
});
