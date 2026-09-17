import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PolicyProfile, RouteSignals } from "@milo/core";
import { chooseTier, JEV_PROFILE } from "@milo/core";
import type { EvalReport, ScoredExample } from "./report.js";

/**
 * Two-fold cross-validation of the Jev policy profile over the committed
 * replay, so a later tuning cannot silently overfit the 120 labeled prompts.
 * Fit the three masses on even-numbered ids, test on odd, and vice versa.
 */
const REPLAY = JSON.parse(
  readFileSync(new URL("../reports/jev-latest-v3.json", import.meta.url), "utf8"),
) as EvalReport;

const FAST_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const HARD_GRID = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25];
const UPPER_GRID = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
const MIN_CROSS_VALIDATED_AGREEMENT = 0.78;

function signalsOf(x: ScoredExample): RouteSignals {
  return {
    taskType: x.predictedTaskType,
    difficulty: x.predictedDifficulty,
    difficultyLevels: x.difficultyLevels,
    needsReasoning: x.needsReasoning,
    longOutput: 0,
    confidences: {},
    jevRequestId: "",
    jevModel: "jev-latest/replay",
    latencyMs: x.latencyMs,
  };
}

function agreement(fold: ScoredExample[], profile: PolicyProfile): number {
  const hits = fold.filter((x) => chooseTier(signalsOf(x), "balanced", profile).tier === x.expectedTier).length;
  return hits / fold.length;
}

function fit(train: ScoredExample[]): PolicyProfile {
  let best: { profile: PolicyProfile; score: number } = { profile: JEV_PROFILE, score: -1 };
  for (const fastBelowMass of FAST_GRID) {
    for (const frontierHardMass of HARD_GRID) {
      for (const frontierUpperMass of UPPER_GRID) {
        const profile: PolicyProfile = { ...JEV_PROFILE, fastBelowMass, frontierHardMass, frontierUpperMass };
        const score = agreement(train, profile);
        if (score > best.score) best = { profile, score };
      }
    }
  }
  return best.profile;
}

describe("policy profile cross-validation (Jev)", () => {
  const scored = REPLAY.scored.filter((x): x is ScoredExample => x.kind === "scored" && x.difficultyLevels.length === 4);
  const idNumber = (x: ScoredExample): number => Number(x.id.replace(/^r-/, ""));
  const even = scored.filter((x) => idNumber(x) % 2 === 0);
  const odd = scored.filter((x) => idNumber(x) % 2 === 1);

  it("replays every example with level probabilities", () => {
    expect(scored.length).toBe(120);
  });

  it("holds up out of sample", () => {
    const a = agreement(odd, fit(even));
    const b = agreement(even, fit(odd));
    const mean = (a + b) / 2;
    console.log(`jev CV: even->odd ${(a * 100).toFixed(1)}%, odd->even ${(b * 100).toFixed(1)}%, mean ${(mean * 100).toFixed(1)}%`);
    expect(mean).toBeGreaterThanOrEqual(MIN_CROSS_VALIDATED_AGREEMENT);
  });

  it("ships a profile close to the refit on all data", () => {
    const shipped = agreement(scored, JEV_PROFILE);
    const refit = agreement(scored, fit(scored));
    expect(refit - shipped).toBeLessThanOrEqual(0.03);
  });
});
