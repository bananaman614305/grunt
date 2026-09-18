/**
 * The compute controller behind the composed `deepseek` benchmark arm
 * (ADR-012 phase 1). One Jev systemone call with the router's own
 * `ROUTER_QUESTIONS` sizes each example, the signals are read through the
 * same band-mass machinery the core policy runs (imported, not copied), and
 * the band buys a compute budget over the DeepSeek family:
 *
 *   band 0 -> one `deepseek/deepseek-v4-flash` call
 *   band 1 -> best-of-3 on v4-flash
 *   band 2 -> best-of-5 on v4-flash
 *   band 3 -> best-of-5 on `deepseek/deepseek-v4.1-flash`
 *
 * The bands are the policy's own gates in order: band 0 is the fast gate,
 * band 3 the hard-mass gate, band 2 the upper-mass gate, band 1 what is
 * left (the mid cell). Signals with no per-level distribution fall back to
 * the v1 expected-score thresholds, same as `chooseTier` does.
 *
 * Drawing, ranking, and the adaptive stop live in `run.ts` next to the
 * best-of-N machinery they reuse; this module is pure apart from the one
 * sizing call.
 */

import type { ChatMessage, JevClientLike, RouteSignals } from "@milo/core";
import {
  buildJevState,
  DIFFICULTY_CAP_OVERRIDE,
  DIFFICULTY_HIGH,
  DIFFICULTY_MID,
  fastGateMass,
  hardMass,
  JEV_PROFILE,
  ROUTER_QUESTIONS,
  toSignals,
  upperMass,
} from "@milo/core";
import type { PolicyProfile } from "@milo/core";

/** The branch model: every band below 3 samples this (ADR-012). */
export const DEEPSEEK_BRANCH_MODEL = "deepseek/deepseek-v4-flash";
/** The orchestrator/hard-task model band 3 samples instead. */
export const DEEPSEEK_ORCHESTRATOR_MODEL = "deepseek/deepseek-v4.1-flash";

/** Total budget for the sizing call, retries included: the router's own habit. */
export const SIZING_BUDGET_MS = 8_000;

export type ComputeBand = 0 | 1 | 2 | 3;

/** What a band buys: which DeepSeek model, and how many samples of it. */
export type ComputeBudget = { band: ComputeBand; model: string; samples: number };

/**
 * The difficulty band, read off the signals with the same masses and
 * thresholds `chooseTier` reads (`JEV_PROFILE` by default): the fast gate is
 * band 0, the hard-mass gate band 3, the upper-mass gate band 2, and the mid
 * cell band 1. Signals without a per-level distribution use the v1
 * expected-score thresholds instead.
 */
export function computeBand(signals: RouteSignals, profile: PolicyProfile = JEV_PROFILE): ComputeBand {
  const levels = signals.difficultyLevels;
  if (levels.length === 0) {
    if (signals.difficulty < DIFFICULTY_MID) return 0;
    if (signals.difficulty < DIFFICULTY_HIGH) return 1;
    if (signals.difficulty < DIFFICULTY_CAP_OVERRIDE) return 2;
    return 3;
  }
  if (fastGateMass(levels, profile.fastMassFromLevel) < profile.fastBelowMass) return 0;
  if (hardMass(levels) >= profile.frontierHardMass) return 3;
  if (upperMass(levels) >= profile.frontierUpperMass) return 2;
  return 1;
}

/** The budget a band buys (ADR-012 phase 1). */
export function computeBudget(band: ComputeBand): ComputeBudget {
  switch (band) {
    case 0:
      return { band, model: DEEPSEEK_BRANCH_MODEL, samples: 1 };
    case 1:
      return { band, model: DEEPSEEK_BRANCH_MODEL, samples: 3 };
    case 2:
      return { band, model: DEEPSEEK_BRANCH_MODEL, samples: 5 };
    case 3:
      return { band, model: DEEPSEEK_ORCHESTRATOR_MODEL, samples: 5 };
  }
}

export type ComputeSizing = { signals: RouteSignals; budget: ComputeBudget; latencyMs: number };

/**
 * Sizes one example: the router's state builder, the router's question set,
 * one systemone call, `toSignals`, and the band. Throws on a Jev failure;
 * the caller decides what a failed sizing means (the bench arm records an
 * error rather than guessing a budget).
 */
export async function sizeCompute(
  jev: JevClientLike,
  messages: ChatMessage[],
  tools?: unknown[],
  budgetMs = SIZING_BUDGET_MS,
): Promise<ComputeSizing> {
  const { state } = buildJevState(messages, tools);
  const started = performance.now();
  const result = await jev.systemone({ state, questions: ROUTER_QUESTIONS }, { budgetMs });
  const latencyMs = performance.now() - started;
  const signals = toSignals(result, latencyMs);
  return { signals, budget: computeBudget(computeBand(signals)), latencyMs };
}
