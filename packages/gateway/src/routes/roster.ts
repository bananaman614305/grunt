/**
 * `GET /v1/roster` -- what Milo will pick, and why.
 *
 * A user who points a client at `milo/auto` has handed the model choice to
 * Milo. This route is how they find out what they handed it to: the running
 * roster tier by tier, each entry's price, how much traffic it actually
 * carries on OpenRouter, where the default came from, and the two ways to
 * override it.
 *
 * Entries are labelled by where they came from. An id the deployment's
 * `milo.config.json` put there that is not a shipped default is
 * `source: "config"` and carries no prices, because Milo does not know what
 * an operator's own choice costs without asking OpenRouter -- and this route
 * does not spend a call to find out.
 *
 * Bearer-gated like every other `/v1` route, so it does not become an
 * unauthenticated description of a deployment.
 */

import type { Hono } from "hono";
import {
  COST_POSTURES,
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  ROSTER_POSTURE_POLICY,
  TIERS,
  defaultRosterModel,
} from "@milo/core";
import type { Roster, RosterModel, Tier } from "@milo/core";
import type { AppDeps } from "../app.js";

export type RosterEntryView = Partial<RosterModel> & {
  id: string;
  /** `"default"` for a model Milo ships; `"config"` for one this deployment added. */
  source: "default" | "config";
  /** First in its tier: what this tier resolves to unless something excludes it. */
  isTierDefault: boolean;
  /** The tier this model sits in by default, when that is not the tier it is listed under. */
  defaultTier?: Tier;
};

export type RosterView = {
  version: string;
  source: RosterInfoSource;
  topModels: number;
  bands: typeof DEFAULT_ROSTER_INFO.bands;
  excludedAbove: number;
  smallOutputBelowTokens: number;
  /** False when this deployment's config replaced the shipped roster. */
  usingDefaults: boolean;
  tiers: Record<Tier, RosterEntryView[]>;
  policy: { posture: Record<string, string>; longOutput: string };
  overrides: { perRequest: string; perDeployment: string };
  note: string;
  premium: string;
};

type RosterInfoSource = typeof DEFAULT_ROSTER_INFO.source;

/** The running roster, annotated with everything Milo knows about each id. */
export function rosterView(running: Roster): RosterView {
  const tiers = {} as Record<Tier, RosterEntryView[]>;
  let usingDefaults = true;

  for (const tier of TIERS) {
    const ids = running[tier] ?? [];
    tiers[tier] = ids.map((id, index) => {
      const known = defaultRosterModel(id);
      if (known === undefined) {
        usingDefaults = false;
        return { id, source: "config" as const, isTierDefault: index === 0 };
      }
      const { tier: defaultTier, ...model } = known;
      if (defaultTier !== tier) usingDefaults = false;
      return {
        ...model,
        source: "default" as const,
        isTierDefault: index === 0,
        ...(defaultTier !== tier ? { defaultTier } : {}),
      };
    });
    if (tiers[tier].length !== DEFAULT_ROSTER_INFO.tiers[tier].length) usingDefaults = false;
  }

  return {
    version: DEFAULT_ROSTER_INFO.version,
    source: DEFAULT_ROSTER_INFO.source,
    topModels: DEFAULT_ROSTER_INFO.topModels,
    bands: DEFAULT_ROSTER_INFO.bands,
    excludedAbove: DEFAULT_ROSTER_INFO.excludedAbove,
    smallOutputBelowTokens: DEFAULT_ROSTER_INFO.smallOutputBelowTokens,
    usingDefaults,
    tiers,
    policy: {
      posture: Object.fromEntries(COST_POSTURES.map((p) => [p, ROSTER_POSTURE_POLICY[p]])),
      longOutput:
        `A request whose answer is expected to be long skips any model capping output below ` +
        `${DEFAULT_ROSTER_INFO.smallOutputBelowTokens} tokens, which is why those are listed last in their tier.`,
    },
    overrides: {
      perRequest: 'Send `"milo": { "candidates": ["<openrouter id>", ...] }` with a chat completion.',
      perDeployment: 'Set `roster` in `milo.config.json` (see docs/config.md) and restart `milo serve`.',
    },
    note: ROSTER_NOTE,
    premium: ROSTER_OVERRIDE_NOTE,
  };
}

export function registerRosterRoute(app: Hono, deps: AppDeps): void {
  app.get("/v1/roster", (c) => c.json(rosterView(deps.roster ?? DEFAULT_ROSTER)));
}
