/**
 * Turns a tier into a concrete OpenRouter model id.
 *
 * The roster lists model ids per tier in preference order; the first eligible
 * entry wins. A request may restrict the roster with `milo.candidates`, and a
 * long expected output excludes models whose max output is too small.
 *
 * If the chosen tier has nothing eligible, the search widens rather than
 * failing: the next tier up first (better to overpay than to not answer), then
 * back down. Only a roster with nothing eligible anywhere throws.
 */

import type { Roster, Tier } from "../types.js";
import { TIERS } from "../types.js";

/**
 * Models excluded when `long_output` is high. Empty by default: every model in
 * DEFAULT_ROSTER has a large max output today. Operators who add a
 * short-output model to their roster list it here (or pass it per call) so a
 * long answer is not truncated.
 */
export const DEFAULT_SMALL_OUTPUT_MODELS: string[] = [];

/** `long_output` at or above this excludes small-output models. */
export const LONG_OUTPUT_THRESHOLD = 0.7;

export type ResolveModelOptions = {
  /** The `long_output` noul from Jev; defaults to 0 (no exclusion). */
  longOutput?: number;
  /** Model ids with a max output too small for a long answer. */
  smallOutputModels?: string[];
};

/**
 * Search order for a tier: the tier itself, then every higher tier in
 * ascending order, then every lower tier in descending order.
 */
export function tierSearchOrder(tier: Tier): Tier[] {
  const index = TIERS.indexOf(tier);
  const up = TIERS.slice(index + 1);
  const down = TIERS.slice(0, index).reverse();
  return [tier, ...up, ...down];
}

/** Picks the first roster entry for `tier` that passes every filter. */
export function resolveModel(
  tier: Tier,
  roster: Roster,
  candidates?: string[],
  opts?: ResolveModelOptions,
): string {
  const allowed = candidates && candidates.length > 0 ? new Set(candidates) : undefined;
  const longOutput = opts?.longOutput ?? 0;
  const excluded =
    longOutput >= LONG_OUTPUT_THRESHOLD
      ? new Set(opts?.smallOutputModels ?? DEFAULT_SMALL_OUTPUT_MODELS)
      : new Set<string>();

  for (const candidateTier of tierSearchOrder(tier)) {
    for (const model of roster[candidateTier] ?? []) {
      if (allowed && !allowed.has(model)) continue;
      if (excluded.has(model)) continue;
      return model;
    }
  }

  const why = [
    allowed ? `candidates [${[...allowed].join(", ")}]` : undefined,
    excluded.size > 0 ? `long_output ${longOutput} excluding [${[...excluded].join(", ")}]` : undefined,
  ].filter((part): part is string => part !== undefined);

  throw new Error(
    `no eligible model for tier ${tier} or any fallback tier` +
      (why.length > 0 ? ` under ${why.join(" and ")}` : "") +
      `; roster has ${TIERS.map((t) => `${t}=[${(roster[t] ?? []).join(", ")}]`).join(" ")}`,
  );
}
