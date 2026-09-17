/**
 * Building a roster out of a list of models a *user* named.
 *
 * The shipped roster (`roster-default.json`) answers "what should Milo pick
 * when nobody said?". This module answers the other half: a user who already
 * runs OpenRouter knows which models they like, and onboarding asks them
 * (`/setup.md`, "Ask before configuring"). What comes back is a flat list of
 * ids with no tiers on it, and the router needs tiers.
 *
 * So the same rule that produced the default roster is applied to the user's
 * own list: tier by output price, using the bands in `roster-default.json`
 * (ADR-006 step 5) rather than a second set of numbers that could drift from
 * them. Two deliberate differences from the default-roster rule:
 *
 *   - **No ceiling.** `excludedAbove` keeps Opus and Fable out of a roster
 *     nobody chose. A user who types "anthropic/claude-opus-5" chose it, so
 *     it lands on `frontier` rather than being dropped (ADR-008).
 *   - **No re-ordering by usage.** The user's order is their preference
 *     order, which is what a tier list means. The one exception is the
 *     demotion the router already relies on: a model that cannot hold a long
 *     answer, or cannot call a tool, sorts last inside its tier so it is
 *     never the tier's default.
 */

import type { Roster, Tier } from "../types.js";
import { TIERS } from "../types.js";
import {
  DEFAULT_ROSTER_INFO,
  SMALL_OUTPUT_BELOW_TOKENS,
  defaultRosterModel,
} from "./roster-default.js";
import type { RosterBand } from "./roster-default.js";

/** What `tierByPrice` needs to know about one model. */
export type PricedModel = {
  /** OpenRouter model id. */
  id: string;
  /** Output price in USD per million tokens; the field the bands are cut on. */
  outputUsdPerM: number;
  /** Provider cap on output tokens, when there is one. */
  maxOutputTokens?: number;
  /** False for a model that cannot call a tool. */
  supportsTools?: boolean;
};

/** The output-price ceiling per tier: `DEFAULT_ROSTER_INFO.bands` by default. */
export type TierBands = Record<Tier, RosterBand>;

/**
 * The tier a price falls in: the first band whose ceiling it does not exceed.
 * A price above every band is still `frontier` -- there is no ceiling here,
 * because a model in this list is one the user asked for by name.
 *
 * A price that is not a finite number is treated as above every band for the
 * same reason a missing price disqualifies a default (ADR-006 step 2): Milo
 * will not put a model it cannot price on a cheap tier.
 */
export function tierForPrice(outputUsdPerM: number, rules: TierBands = DEFAULT_ROSTER_INFO.bands): Tier {
  const price = Number.isFinite(outputUsdPerM) ? outputUsdPerM : Number.POSITIVE_INFINITY;
  for (const tier of TIERS) {
    if (price <= rules[tier].maxOutputUsdPerM) return tier;
  }
  return "frontier";
}

/**
 * True for a model that must not be a tier's default: one whose output cap is
 * below `SMALL_OUTPUT_BELOW_TOKENS` (the router skips it outright on a
 * long-output request), or one that cannot call a tool (Milo's traffic is
 * agent sub-tasks). Both sort last in their tier instead of being dropped --
 * the user named them, so they stay reachable through the fallback search.
 */
export function isDemoted(model: PricedModel, belowTokens = SMALL_OUTPUT_BELOW_TOKENS): boolean {
  if (model.supportsTools === false) return true;
  return model.maxOutputTokens !== undefined && model.maxOutputTokens < belowTokens;
}

/**
 * Splits a user's model list into tiers by output price.
 *
 * Order within a tier is the order the models arrived in -- the user's own
 * preference order -- except that demoted models (see `isDemoted`) are moved
 * to the end of their tier, keeping their relative order. A duplicate id is
 * kept once, at its first position.
 */
export function tierByPrice(models: PricedModel[], rules: TierBands = DEFAULT_ROSTER_INFO.bands): Roster {
  const kept = { fast: [], mid: [], frontier: [] } as Roster;
  const last = { fast: [], mid: [], frontier: [] } as Roster;
  const seen = new Set<string>();

  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const tier = tierForPrice(model.outputUsdPerM, rules);
    (isDemoted(model) ? last : kept)[tier].push(model.id);
  }

  for (const tier of TIERS) kept[tier].push(...last[tier]);
  return kept;
}

/** What `describeRoster` prints per model, when it knows it. */
export type RosterPriceInfo = {
  id: string;
  inputUsdPerM?: number;
  outputUsdPerM?: number;
  maxOutputTokens?: number;
};

const DASH = "-";

function usd(value: number | undefined): string {
  return value === undefined ? DASH : `${value}`;
}

/**
 * The tier table, as Markdown, from whatever prices the caller has in hand.
 *
 * One renderer so every surface that shows a user their roster -- the
 * `PUT`/`GET /v1/roster` response an agent is told to print during
 * onboarding, and `milo roster --key-hash` -- prints the same columns in the
 * same order. Ids `info` does not cover fall back to the shipped roster's own
 * numbers, so a user list that happens to name a default still shows prices;
 * an id nothing knows the price of prints a dash rather than a guess.
 */
export function describeRoster(roster: Roster, info: Iterable<RosterPriceInfo> = []): string {
  const known = new Map<string, RosterPriceInfo>();
  for (const entry of info) known.set(entry.id, entry);

  const rows = TIERS.flatMap((tier) =>
    (roster[tier] ?? []).map((id) => {
      const entry = known.get(id) ?? defaultRosterModel(id);
      const maxOut = entry?.maxOutputTokens;
      return (
        `| ${tier} | \`${id}\` | ${usd(entry?.inputUsdPerM)} | ${usd(entry?.outputUsdPerM)} | ` +
        `${maxOut === undefined ? DASH : maxOut} |`
      );
    }),
  );

  return ["| Tier | Model | In $/M | Out $/M | Max output |", "|---|---|---|---|---|", ...rows].join("\n");
}
