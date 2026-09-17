/**
 * Policy v1: signals plus cost posture to a tier.
 *
 * The table from docs/PLAN.md, read top to bottom, with the last row treated
 * as the override it is worded as:
 *
 * | difficulty | needs_reasoning | posture             | tier                        |
 * |------------|-----------------|---------------------|-----------------------------|
 * | < 1.0      | any             | any                 | fast                        |
 * | 1.0 to 2.0 | < 0.5           | low, balanced       | fast (low) / mid (balanced) |
 * | 1.0 to 2.0 | >= 0.5          | any                 | mid                         |
 * | >= 2.0     | any             | low                 | mid                         |
 * | >= 2.0     | any             | balanced, quality   | frontier                    |
 * | any        | any             | quality, diff >= 1.0| frontier                    |
 *
 * Reading notes, which the implementation follows exactly:
 *  - the bands are [0, 1.0), [1.0, 2.0), [2.0, 3]; "1.0 to 2.0" is closed at
 *    1.0 and open at 2.0 because ">= 2.0" has its own rows;
 *  - the final row is an override, so `quality` posture with difficulty >= 1.0
 *    goes to frontier even where rows two and three would say fast or mid.
 *    That is what "quality" means, and it makes row five's quality half
 *    redundant rather than contradictory;
 *  - difficulty < 1.0 is fast under every posture, since the final row is
 *    explicitly gated on difficulty >= 1.0.
 *
 * Then the cap: a `classify` or `chat` task never leaves the `mid` tier unless
 * difficulty is at least 2.5. Cheap-to-answer task shapes should not reach the
 * frontier tier just because the posture is expensive.
 *
 * Pure function, no I/O. Changing any threshold bumps POLICY_VERSION and needs
 * an eval run (ADR-002).
 */

import type { CostPosture, RouteSignals, Tier } from "../types.js";

export { POLICY_VERSION } from "../types.js";

/** Difficulty at or above this is "not trivial" and posture starts to matter. */
export const DIFFICULTY_MID = 1.0;
/** Difficulty at or above this reaches the frontier tier under balanced posture. */
export const DIFFICULTY_HIGH = 2.0;
/** Difficulty at or above this lifts the classify/chat cap. */
export const DIFFICULTY_CAP_OVERRIDE = 2.5;
/** needs_reasoning at or above this pulls the middle difficulty band up to mid. */
export const REASONING_THRESHOLD = 0.5;
/** Task types that cap at `mid` below DIFFICULTY_CAP_OVERRIDE. */
export const CAPPED_TASK_TYPES = ["classify", "chat"] as const;

/** Renders a signal for the reason sentence without trailing-zero noise. */
function num(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * Applies Policy v1. Returns the tier and one human-readable sentence citing
 * the numbers that decided it.
 */
export function chooseTier(signals: RouteSignals, posture: CostPosture): { tier: Tier; reason: string } {
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

  const isCapped = (CAPPED_TASK_TYPES as readonly string[]).includes(signals.taskType);
  if (isCapped && tier === "frontier" && difficulty < DIFFICULTY_CAP_OVERRIDE) {
    tier = "mid";
    reason = `${reason}, but a ${signals.taskType} task caps at mid below difficulty ${num(DIFFICULTY_CAP_OVERRIDE)}`;
  }

  return { tier, reason };
}
