import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  JevClientLike,
  PolicyProfile,
  RouteSignals,
  SystemOneResult,
  TaskType,
} from "@milo/core";
import { buildJevState, chooseTier, SYSTEM_ONE_OPEN_PROFILE } from "@milo/core";
import type { EvalReport, ScoredExample } from "./report.js";
import { runRoutingEval } from "./run.js";
import { loadRoutingSet } from "./schema.js";
import type { RoutingExample } from "./schema.js";

const examples = loadRoutingSet();

/** A tool list of the same length the runner uses for `has_tools: true`, since
 * `buildJevState` only reads `tools.length`. */
const A_TOOL: unknown[] = [{}];

/** The exact Jev `state` the runner will send for `example`, used to map a
 * stub's incoming request back to the example that produced it. */
function stateKey(example: RoutingExample): string {
  const messages = example.messages as ChatMessage[];
  const tools = example.has_tools ? A_TOOL : undefined;
  return JSON.stringify(buildJevState(messages, tools).state);
}

function makeAnswers(opts: {
  taskType: TaskType;
  difficulty: number;
  needsReasoning: number;
}): SystemOneResult["answers"] {
  return {
    task_type: {
      type: "choice",
      choice: opts.taskType,
      confidence: 0.9,
      probabilities: { [opts.taskType]: 0.9 },
    },
    difficulty: { type: "score", score: opts.difficulty, confidence: 0.9, legend: {}, probabilities: {} },
    needs_reasoning: { type: "noul", noul: opts.needsReasoning },
    long_output: { type: "noul", noul: 0.1 },
  };
}

/** Derives a Jev answer straight from one example's own dataset labels: the
 * band becomes the difficulty score (offset so it lands mid-band, capped at
 * the top of the scale), a mention of "reason" in `notes` becomes a high
 * `needs_reasoning`, and the dataset's `task_type` label is echoed back. */
function labelDerivedAnswers(example: RoutingExample): SystemOneResult["answers"] {
  const needsReasoning = /reason/i.test(example.notes) ? 0.8 : 0.2;
  const difficulty = Math.min(example.difficulty_band + 0.4, 3);
  return makeAnswers({ taskType: example.task_type, difficulty, needsReasoning });
}

/** A stub `JevClientLike` over `exampleList`, answering via `derive`. Throws
 * if a request's state does not match any known example (it always should). */
function stubJevFor(
  exampleList: RoutingExample[],
  derive: (example: RoutingExample) => SystemOneResult["answers"],
): JevClientLike {
  const byState = new Map(exampleList.map((e) => [stateKey(e), e]));
  return {
    systemone: (req) => {
      const key = JSON.stringify(req.state);
      const example = byState.get(key);
      if (example === undefined) {
        return Promise.reject(new Error("stub: no example matches this Jev state"));
      }
      const result: SystemOneResult = {
        model: "jev-latest",
        requestId: `stub-${example.id}`,
        latencyMs: 42,
        usage: { input_tokens: 100, output_tokens: 10 },
        answers: derive(example),
      };
      return Promise.resolve(result);
    },
  };
}

describe("runRoutingEval: label-derived stub", () => {
  it("scores every example with a 4-row band breakdown and counts that add up", async () => {
    const jev = stubJevFor(examples, labelDerivedAnswers);
    const report = await runRoutingEval({ examples, jev });

    expect(report.scored.length).toBe(examples.length);
    expect(report.unscored.length).toBe(0);
    expect(report.scored.length + report.unscored.length).toBe(examples.length);

    const bandsPresent = new Set(report.scored.map((e) => e.difficultyBand));
    expect([...bandsPresent].sort()).toEqual([0, 1, 2, 3]);

    for (const band of [0, 1, 2, 3] as const) {
      const n = report.scored.filter((e) => e.difficultyBand === band).length;
      expect(n, `band ${band} should have scored examples`).toBeGreaterThan(0);
    }

    const agree = report.scored.filter((e) => e.agree).length;
    // Not asserted to be perfect: the stub's derivation is a simple, documented
    // heuristic, not a reimplementation of the policy. Logged so the resulting
    // agreement number is visible without re-deriving it by hand.
    console.log(`label-derived stub agreement: ${agree}/${report.scored.length}`);
    expect(agree).toBeGreaterThan(0);
  });
});

describe("runRoutingEval: intermittent Jev failures", () => {
  it("marks every third example unscored with an error class, and scores the rest", async () => {
    let calls = 0;
    const jev: JevClientLike = {
      systemone: () => {
        calls += 1;
        if (calls % 3 === 0) {
          return Promise.reject(new Error("simulated jev outage"));
        }
        const result: SystemOneResult = {
          model: "jev-latest",
          requestId: `req-${calls}`,
          latencyMs: 10,
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: makeAnswers({ taskType: "chat", difficulty: 0, needsReasoning: 0.1 }),
        };
        return Promise.resolve(result);
      },
    };

    // concurrency: 1 makes the "every third call fails" stub deterministic.
    const report = await runRoutingEval({ examples, jev, concurrency: 1 });

    expect(report.scored.length + report.unscored.length).toBe(examples.length);
    expect(report.unscored.length).toBe(Math.floor(examples.length / 3));
    expect(report.scored.length).toBe(examples.length - Math.floor(examples.length / 3));

    for (const example of report.unscored) {
      expect(example.errorClass.length).toBeGreaterThan(0);
    }
  });
});

describe("runRoutingEval: forced wrong tier for known ids", () => {
  it("lists the forced ids among the disagreements", async () => {
    const wrongIds = new Set(["r-001", "r-002"]);
    const jev = stubJevFor(examples, (example) => {
      if (wrongIds.has(example.id)) {
        // Both r-001 and r-002 are labeled "fast"; forcing a hard, uncapped
        // task type at top difficulty guarantees a frontier prediction.
        return makeAnswers({ taskType: "feature", difficulty: 3, needsReasoning: 0.9 });
      }
      return labelDerivedAnswers(example);
    });

    const report = await runRoutingEval({ examples, jev });

    const disagreeing = new Set(report.scored.filter((e) => !e.agree).map((e) => e.id));
    for (const id of wrongIds) {
      expect(disagreeing.has(id), `${id} should be a disagreement`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-validation of the policy v2 profile
// ---------------------------------------------------------------------------

/**
 * The committed replay of the recorded `system-one-open` fixtures under policy
 * v2. It carries each example's per-level difficulty distribution, which is
 * what the profile's thresholds were fitted on, so the fit can be re-derived
 * here instead of being taken on trust.
 */
const REPLAY: EvalReport = JSON.parse(
  readFileSync(new URL("../reports/system-one-open-v2.json", import.meta.url), "utf8"),
) as EvalReport;

/** The grid the thresholds are refit over. Wide enough to find a better fit if one exists. */
const FAST_GRID = [0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2];
const HARD_GRID = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3];
const UPPER_GRID = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

/** The lowest mean held-out agreement the profile may score before it counts as overfitted. */
const MIN_CROSS_VALIDATED_AGREEMENT = 0.78;

/** Rebuilds the signals the router saw, from what the report recorded. */
function signalsOf(example: ScoredExample): RouteSignals {
  return {
    taskType: example.predictedTaskType,
    difficulty: example.predictedDifficulty,
    difficultyLevels: example.difficultyLevels,
    needsReasoning: example.needsReasoning,
    longOutput: 0,
    confidences: {},
    jevRequestId: "",
    jevModel: "system-one-open/replay",
    latencyMs: example.latencyMs,
  };
}

function agreementUnder(fold: ScoredExample[], profile: PolicyProfile): number {
  if (fold.length === 0) return NaN;
  const hits = fold.filter(
    (example) => chooseTier(signalsOf(example), "balanced", profile).tier === example.expectedTier,
  ).length;
  return hits / fold.length;
}

/** The best (fastBelowMass, frontierHardMass, frontierUpperMass) on `train`. */
function fitProfile(train: ScoredExample[]): { profile: PolicyProfile; agreement: number } {
  let best = { profile: SYSTEM_ONE_OPEN_PROFILE, agreement: -1 };
  for (const fastBelowMass of FAST_GRID) {
    for (const frontierHardMass of HARD_GRID) {
      for (const frontierUpperMass of UPPER_GRID) {
        const profile: PolicyProfile = {
          fastBelowMass,
          frontierHardMass,
          frontierUpperMass,
          // Not refit: the cap is a product rule about cheap task shapes, not
          // a threshold fitted to this dataset.
          cappedFrontierHardMass: SYSTEM_ONE_OPEN_PROFILE.cappedFrontierHardMass,
        };
        const agreement = agreementUnder(train, profile);
        if (agreement > best.agreement) best = { profile, agreement };
      }
    }
  }
  return best;
}

/** `r-042` -> 42. The dataset's ids are `r-` plus a zero-padded number. */
function idNumber(example: ScoredExample): number {
  return Number.parseInt(example.id.replace(/^\D+/, ""), 10);
}

describe("policy v2 profile: the recorded replay", () => {
  it("is the committed system-one-open run under the current policy version", () => {
    expect(REPLAY.posture).toBe("balanced");
    expect(REPLAY.policyVersion).toBe("v2");
    expect(REPLAY.scored.length).toBeGreaterThan(100);
    expect(REPLAY.unscored).toHaveLength(0);
  });

  it("agrees with the labels at or above 0.80, the bar CI holds the open backend to", () => {
    const agreement = agreementUnder(REPLAY.scored, SYSTEM_ONE_OPEN_PROFILE);
    expect(agreement).toBeGreaterThanOrEqual(0.8);
    // The report's own recorded verdict must say the same thing.
    const recorded = REPLAY.scored.filter((e) => e.agree).length / REPLAY.scored.length;
    expect(recorded).toBeCloseTo(agreement, 10);
  });

  it("carries a per-level distribution for every scored example", () => {
    for (const example of REPLAY.scored) {
      expect(example.difficultyLevels).toHaveLength(4);
      const total = example.difficultyLevels.reduce((sum, p) => sum + p, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
    }
  });
});

describe("policy v2 profile: two-fold cross-validation", () => {
  it("holds up on examples it was not fitted on, so a later tuning cannot silently overfit", () => {
    const even = REPLAY.scored.filter((e) => idNumber(e) % 2 === 0);
    const odd = REPLAY.scored.filter((e) => idNumber(e) % 2 === 1);
    expect(even.length).toBeGreaterThan(40);
    expect(odd.length).toBeGreaterThan(40);

    const folds: Array<[ScoredExample[], ScoredExample[]]> = [
      [even, odd],
      [odd, even],
    ];
    const heldOut = folds.map(([train, test]) => {
      const fitted = fitProfile(train);
      const held = agreementUnder(test, fitted.profile);
      // Logged so a regression says what it actually measured.
      console.log(
        `fit on n=${train.length}: ${(fitted.agreement * 100).toFixed(1)}% in-sample, ` +
          `${(held * 100).toFixed(1)}% held out ` +
          `(fast<${fitted.profile.fastBelowMass}, hard>=${fitted.profile.frontierHardMass}, ` +
          `upper>=${fitted.profile.frontierUpperMass})`,
      );
      return held;
    });

    const mean = heldOut.reduce((sum, a) => sum + a, 0) / heldOut.length;
    expect(mean).toBeGreaterThanOrEqual(MIN_CROSS_VALIDATED_AGREEMENT);
  });

  it("leaves no large gap between the shipped profile and a refit on the whole set", () => {
    const shipped = agreementUnder(REPLAY.scored, SYSTEM_ONE_OPEN_PROFILE);
    const refit = fitProfile(REPLAY.scored);
    // The shipped thresholds should be one of the best fits on this data; a
    // wide gap would mean they had drifted away from what they were fitted on.
    expect(refit.agreement - shipped).toBeLessThan(0.05);
  });
});
