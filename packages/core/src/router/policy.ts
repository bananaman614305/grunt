/**
 * Policy v2: the difficulty distribution plus cost posture to a tier.
 *
 * v1 read the *expected* difficulty score and compared it to fixed thresholds
 * at 1.0 and 2.0. The first live eval (120 examples, `system-one-open`
 * backend, balanced posture) showed why that scores only 69.2%: the open
 * backend's expected score is compressed toward the middle. Expected-fast
 * examples average 0.41, expected-mid 1.11, expected-frontier 2.05, so almost
 * nothing clears 2.0 and the mid and frontier bands collapse into each other.
 * The per-level probabilities separate far better, because a hedged
 * distribution still puts its tail where the work actually is.
 *
 * So v2 reads masses off `signals.difficultyLevels`:
 *
 *   P3            = probability the work is level 3 ("hard")
 *   P2 + P3       = probability the work is level 2 or above ("substantial or more")
 *   P1 + P2 + P3  = probability the work is level 1 or above ("routine or more")
 *
 * and applies, under balanced posture:
 *
 *   fast      when the fast-gate mass <  fastBelowMass
 *   frontier  when P3 >= frontierHardMass  or  P2 + P3 >= frontierUpperMass
 *   mid       otherwise
 *
 * The fast gate reads `P2 + P3` or `P1 + P2 + P3`, per the profile's
 * `fastMassFromLevel` (2 or 1). A backend whose mid-difficulty work actually
 * sits on level 1 -- Jev does (ADR-002 revision 3) -- needs the gate to start
 * there, or most of that work is waved through to fast on an empty level-2
 * mass. The frontier gates always read `P3` and `P2 + P3`, whichever level the
 * fast gate starts from.
 *
 * The thresholds are a `PolicyProfile` rather than constants, because they are
 * a property of the *backend's* calibration, not of the routing question. A
 * backend that hedges needs a low bar; a sharp one needs a high bar. See
 * `PROFILES` below and ADR-002 revisions 2 and 3.
 *
 * Posture adjusts the rule at both ends:
 *
 *   low      raises the fast threshold to at least 0.10, and caps the outcome
 *            at mid -- the frontier conditions are never evaluated, because
 *            "cheap" is the promise a caller makes when they pick it
 *   quality  lowers both frontier thresholds by 0.10 (floored at 0.02 and 0.10
 *            so a threshold is always worth quoting) and sends anything that
 *            is not fast to frontier once P2 + P3 >= 0.40
 *
 * Then the v1 cap survives: a `classify` or `chat` task is pulled back to
 * `mid` unless the frontier signal is strong on its own terms
 * (P3 >= `cappedFrontierHardMass`). A label or small talk should not reach the
 * frontier tier just because the posture is expensive.
 *
 * When `difficultyLevels` is empty -- an older fixture, or a backend that
 * reports no distribution -- the v1 expected-score rule runs instead, so those
 * requests still route rather than all landing on one tier.
 *
 * Pure function, no I/O. Changing any threshold bumps POLICY_VERSION and needs
 * an eval run (ADR-002).
 */

import type { CostPosture, RouteSignals, Tier } from "../types.js";

export { POLICY_VERSION } from "../types.js";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * The five thresholds policy v2 reads. One set per decision backend: they
 * describe how that backend spreads its probability mass, so they are not
 * transferable between backends and must be refit from an eval run.
 */
export type PolicyProfile = {
  /**
   * Which level the fast gate's mass starts at: `2` reads `P2 + P3`
   * ("substantial or more"), `1` reads `P1 + P2 + P3` ("routine or more").
   * A backend that hedges puts real mid-difficulty work on level 1 as often
   * as level 2, so gating fast on level 2+ alone waves most of it through; a
   * sharper backend that actually concentrates mid work on level 1 needs the
   * gate to start there instead (Jev, ADR-002 revision 3).
   */
  fastMassFromLevel: 1 | 2;
  /** The fast gate's mass (from `fastMassFromLevel`) strictly below this routes to fast. */
  fastBelowMass: number;
  /** `P3` at or above this routes to frontier. */
  frontierHardMass: number;
  /** `P2 + P3` at or above this routes to frontier. */
  frontierUpperMass: number;
  /** `P3` at or above this lets a `classify`/`chat` task reach frontier anyway. */
  cappedFrontierHardMass: number;
};

/**
 * Fitted on the first live eval: 120 recorded `system-one-open` answers,
 * balanced posture, 83.5% in-sample tier agreement and 81.8% under two-fold
 * cross-validation, against 69.2% for policy v1 on the same signals. A
 * composite rule over expected score plus `needs_reasoning` reached only
 * 75.8% cross-validated and was dropped.
 *
 * The bars are low because the open backend hedges: a genuinely hard example
 * often carries only 0.10 to 0.20 of mass on level 3, and a trivial one still
 * carries a percent or two above level 1.
 */
export const SYSTEM_ONE_OPEN_PROFILE: PolicyProfile = {
  fastMassFromLevel: 2,
  fastBelowMass: 0.05,
  frontierHardMass: 0.1,
  frontierUpperMass: 0.65,
  cappedFrontierHardMass: 0.3,
};

/**
 * Fitted and VALIDATED on the first live Jev run (ADR-002 revision 3): 120
 * examples, provisional profile, 75.0% tier agreement. Jev's mean per-level
 * mass by expected band showed why: expected-mid examples average P0 0.17 /
 * P1 0.62 / P2 0.18 / P3 0.03 -- Jev puts real mid-difficulty work squarely on
 * level 1, not level 2 -- so gating fast on `P2 + P3` (the open backend's
 * gate) waved most mid work through to fast. `fastMassFromLevel: 1` moves the
 * fast gate to `P1 + P2 + P3` instead, which is where Jev's mid mass actually
 * sits.
 *
 * Grid search with two-fold cross-validation over `fastBelowMass` (gated on
 * level 1+), `frontierHardMass`, and `frontierUpperMass` found:
 *
 *   - `fastBelowMass` 0.35: expected-fast examples average P1+ 0.26, so 0.35
 *     clears real fast work while still catching most of what should not be.
 *   - `frontierHardMass` 0.05 and `frontierUpperMass` 0.65: unchanged from the
 *     provisional profile's shape -- Jev's expected-frontier mass (P2+P3 0.89
 *     mean) already clears 0.65 comfortably, and a hard tail as thin as 0.05
 *     is still a real signal on this sharper backend.
 *   - `cappedFrontierHardMass` 0.05, level with `frontierHardMass`: the
 *     replay with the inherited 0.50 cap pulled two genuinely-hard
 *     `classify`/`chat` examples (hard mass 0.05-0.07, comfortably over the
 *     lowered frontier bar) straight back down to `mid` -- the cap
 *     re-litigating a decision the hard bar already made, not screening out
 *     noise. Lining the cap up with the hard bar recovers both without
 *     reopening frontier to a `classify`/`chat` task the hard bar itself
 *     would reject.
 *
 * That scores 84.2% in-sample and 80.8% under two-fold cross-validation
 * (folds 75.0% and 86.7% -- the fast/mid boundary is the noisy one); per band
 * 96.3% / 62.9% / 84.8% / 100.0%. Confusion: frontier 41/42 correct, mid
 * 26/31, fast 34/47 (13 fast-labeled examples predicted mid). Replay:
 * `packages/evals/reports/jev-latest-v3.md`.
 */
export const JEV_PROFILE: PolicyProfile = {
  fastMassFromLevel: 1,
  fastBelowMass: 0.35,
  frontierHardMass: 0.05,
  frontierUpperMass: 0.65,
  cappedFrontierHardMass: 0.05,
};

/** Profiles by decision-backend name. */
export const PROFILES = {
  "system-one-open": SYSTEM_ONE_OPEN_PROFILE,
  jev: JEV_PROFILE,
} as const satisfies Record<string, PolicyProfile>;

export type PolicyProfileName = keyof typeof PROFILES;

/** Used when nothing names a profile. Jev is still Milo's default backend. */
export const DEFAULT_PROFILE: PolicyProfile = JEV_PROFILE;

/** Resolves a profile name, or a profile passed through unchanged. */
export function resolveProfile(profile: PolicyProfile | PolicyProfileName | undefined): PolicyProfile {
  if (profile === undefined) return DEFAULT_PROFILE;
  return typeof profile === "string" ? PROFILES[profile] : profile;
}

/** Model-name prefix that means the open backend answered (ADR-004). */
export const SYSTEM_ONE_OPEN_MODEL_MARKER = "system-one-open/";

/**
 * Picks a profile from the model name the decision backend reported. The open
 * backend always prefixes its model with `system-one-open/`; anything else is
 * Jev or a Jev-shaped client.
 */
export function profileForModel(jevModel: string): PolicyProfile {
  return jevModel.startsWith(SYSTEM_ONE_OPEN_MODEL_MARKER) ? SYSTEM_ONE_OPEN_PROFILE : JEV_PROFILE;
}

// ---------------------------------------------------------------------------
// Posture adjustments
// ---------------------------------------------------------------------------

/** `low` posture raises the fast threshold to at least this. */
export const LOW_POSTURE_FAST_MASS = 0.1;
/** `quality` posture lowers both frontier thresholds by this much. */
export const QUALITY_POSTURE_FRONTIER_SHIFT = 0.1;
/** However far `quality` lowers it, the hard threshold never drops below this. */
export const QUALITY_MIN_FRONTIER_HARD_MASS = 0.02;
/** However far `quality` lowers it, the upper threshold never drops below this. */
export const QUALITY_MIN_FRONTIER_UPPER_MASS = 0.1;
/** Under `quality`, this much mass at level 2 or above is enough for frontier. */
export const QUALITY_POSTURE_FRONTIER_MASS = 0.4;

/** Task types that cap at `mid` unless the hard mass is strong on its own. */
export const CAPPED_TASK_TYPES = ["classify", "chat"] as const;

/**
 * The profile a posture actually applies.
 *
 * `low` only moves the fast threshold. Its frontier thresholds are left alone
 * because they are never consulted: `low` posture cannot return `frontier` at
 * all (see `chooseTierFromMasses`), which is the promise a caller makes when
 * they pick it.
 *
 * `quality` lowers both frontier thresholds but floors them, so a threshold is
 * always a number the reason sentence can quote meaningfully. Without the
 * floor, the open profile's 0.10 hard threshold would land on 0.00 and every
 * reason would read "P(hard) 0.03 at or above 0.00".
 */
export function postureProfile(profile: PolicyProfile, posture: CostPosture): PolicyProfile {
  switch (posture) {
    case "low":
      return { ...profile, fastBelowMass: Math.max(profile.fastBelowMass, LOW_POSTURE_FAST_MASS) };
    case "quality":
      return {
        fastMassFromLevel: profile.fastMassFromLevel,
        fastBelowMass: profile.fastBelowMass,
        frontierHardMass: Math.max(
          QUALITY_MIN_FRONTIER_HARD_MASS,
          profile.frontierHardMass - QUALITY_POSTURE_FRONTIER_SHIFT,
        ),
        frontierUpperMass: Math.max(
          QUALITY_MIN_FRONTIER_UPPER_MASS,
          profile.frontierUpperMass - QUALITY_POSTURE_FRONTIER_SHIFT,
        ),
        cappedFrontierHardMass: profile.cappedFrontierHardMass,
      };
    case "balanced":
      return profile;
    default: {
      const exhaustive: never = posture;
      throw new Error(`unknown cost posture: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// v1 fallback thresholds (expected score)
// ---------------------------------------------------------------------------

/** Difficulty at or above this is "not trivial" and posture starts to matter. */
export const DIFFICULTY_MID = 1.0;
/** Difficulty at or above this reaches the frontier tier under balanced posture. */
export const DIFFICULTY_HIGH = 2.0;
/** Difficulty at or above this lifts the classify/chat cap. */
export const DIFFICULTY_CAP_OVERRIDE = 2.5;
/** needs_reasoning at or above this pulls the middle difficulty band up to mid. */
export const REASONING_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Masses
// ---------------------------------------------------------------------------

/** Probability the work is level 3. Missing levels read as 0. */
export function hardMass(levels: readonly number[]): number {
  return levels[3] ?? 0;
}

/** Probability the work is level 2 or above. */
export function upperMass(levels: readonly number[]): number {
  return (levels[2] ?? 0) + (levels[3] ?? 0);
}

/** Probability the work is level 1 or above. */
export function upperMassFromLevel1(levels: readonly number[]): number {
  return (levels[1] ?? 0) + (levels[2] ?? 0) + (levels[3] ?? 0);
}

/**
 * The mass the fast gate reads, per `PolicyProfile.fastMassFromLevel`: `P1 +
 * P2 + P3` when the gate starts at level 1, `P2 + P3` (same as `upperMass`)
 * when it starts at level 2.
 */
export function fastGateMass(levels: readonly number[], fastMassFromLevel: 1 | 2): number {
  return fastMassFromLevel === 1 ? upperMassFromLevel1(levels) : upperMass(levels);
}

/** The reason-sentence label for the fast gate's mass: "level 1+" or "level 2+". */
function fastGateLabel(fastMassFromLevel: 1 | 2): string {
  return `level ${fastMassFromLevel}+`;
}

/** Renders a signal for the reason sentence without trailing-zero noise. */
function num(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Renders a probability mass with the two decimals the thresholds are written in. */
function mass(value: number): string {
  return value.toFixed(2);
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

type TierAndReason = { tier: Tier; reason: string };

/**
 * Policy v1, kept as the fallback for signals that carry no per-level
 * distribution. Reads the expected difficulty score against fixed thresholds.
 */
export function chooseTierFromExpectedScore(signals: RouteSignals, posture: CostPosture): TierAndReason {
  const difficulty = signals.difficulty;
  const reasoning = signals.needsReasoning;

  let tier: Tier;
  let reason: string;

  if (difficulty < DIFFICULTY_MID) {
    tier = "fast";
    reason = `difficulty ${num(difficulty)} is below ${num(DIFFICULTY_MID)}, so any posture routes to fast`;
  } else if (posture === "quality") {
    tier = "frontier";
    reason = `difficulty ${num(difficulty)} with quality posture routes to frontier`;
  } else if (difficulty >= DIFFICULTY_HIGH) {
    tier = posture === "low" ? "mid" : "frontier";
    reason = `difficulty ${num(difficulty)} with ${posture} posture routes to ${tier}`;
  } else if (reasoning >= REASONING_THRESHOLD) {
    tier = "mid";
    reason = `difficulty ${num(difficulty)} with needs_reasoning ${num(reasoning)} at or above ${num(REASONING_THRESHOLD)} routes to mid`;
  } else {
    tier = posture === "low" ? "fast" : "mid";
    reason = `difficulty ${num(difficulty)} with needs_reasoning ${num(reasoning)} below ${num(REASONING_THRESHOLD)} and ${posture} posture routes to ${tier}`;
  }

  if (isCapped(signals) && tier === "frontier" && difficulty < DIFFICULTY_CAP_OVERRIDE) {
    return {
      tier: "mid",
      reason: `${reason}, but a ${signals.taskType} task caps at mid below difficulty ${num(DIFFICULTY_CAP_OVERRIDE)}`,
    };
  }
  return { tier, reason };
}

function isCapped(signals: RouteSignals): boolean {
  return (CAPPED_TASK_TYPES as readonly string[]).includes(signals.taskType);
}

/** The probability-mass rule, before the task-type cap. */
function chooseTierFromMasses(
  signals: RouteSignals,
  posture: CostPosture,
  thresholds: PolicyProfile,
): TierAndReason {
  const p3 = hardMass(signals.difficultyLevels);
  const upper = upperMass(signals.difficultyLevels);
  const fastMass = fastGateMass(signals.difficultyLevels, thresholds.fastMassFromLevel);
  const fastLabel = fastGateLabel(thresholds.fastMassFromLevel);

  if (fastMass < thresholds.fastBelowMass) {
    return {
      tier: "fast",
      reason: `P(${fastLabel}) ${mass(fastMass)} below ${mass(thresholds.fastBelowMass)} with ${posture} posture routes to fast`,
    };
  }

  // `low` never reaches frontier, whatever the masses say. The frontier
  // conditions below are not evaluated at all: a caller who asked for cheap
  // gets at most the mid tier, and the reason says so plainly.
  if (posture === "low") {
    return {
      tier: "mid",
      reason: `P(${fastLabel}) ${mass(fastMass)} at or above ${mass(thresholds.fastBelowMass)} routes above fast, but low posture caps at mid`,
    };
  }

  if (posture === "quality" && upper >= QUALITY_POSTURE_FRONTIER_MASS) {
    return {
      tier: "frontier",
      reason: `P(level 2+) ${mass(upper)} at or above ${mass(QUALITY_POSTURE_FRONTIER_MASS)} with quality posture routes to frontier`,
    };
  }

  if (p3 >= thresholds.frontierHardMass) {
    return {
      tier: "frontier",
      reason: `P(hard) ${mass(p3)} at or above ${mass(thresholds.frontierHardMass)} with ${posture} posture routes to frontier`,
    };
  }

  if (upper >= thresholds.frontierUpperMass) {
    return {
      tier: "frontier",
      reason: `P(level 2+) ${mass(upper)} at or above ${mass(thresholds.frontierUpperMass)} with ${posture} posture routes to frontier`,
    };
  }

  return {
    tier: "mid",
    reason:
      `P(hard) ${mass(p3)} below ${mass(thresholds.frontierHardMass)} and ` +
      `P(level 2+) ${mass(upper)} below ${mass(thresholds.frontierUpperMass)} with ${posture} posture routes to mid`,
  };
}

/**
 * Applies Policy v2. Returns the tier and one human-readable sentence citing
 * the masses that decided it.
 *
 * `profile` is the decision backend's threshold set; omit it and Jev's is
 * used. Signals with no per-level distribution fall back to the v1
 * expected-score rule.
 */
export function chooseTier(
  signals: RouteSignals,
  posture: CostPosture,
  profile?: PolicyProfile | PolicyProfileName,
): TierAndReason {
  if (signals.difficultyLevels.length === 0) {
    return chooseTierFromExpectedScore(signals, posture);
  }

  const thresholds = postureProfile(resolveProfile(profile), posture);
  const { tier, reason } = chooseTierFromMasses(signals, posture, thresholds);

  if (tier === "frontier" && isCapped(signals)) {
    const p3 = hardMass(signals.difficultyLevels);
    if (p3 < thresholds.cappedFrontierHardMass) {
      return {
        tier: "mid",
        reason: `${reason}, but a ${signals.taskType} task caps at mid below P(hard) ${mass(thresholds.cappedFrontierHardMass)}`,
      };
    }
  }

  return { tier, reason };
}
