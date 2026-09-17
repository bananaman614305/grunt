/**
 * `/v1/roster` -- what Milo will pick, why, and (since ADR-007) what *this
 * caller* told it to pick.
 *
 * A user who points a client at `milo/auto` has handed the model choice to
 * Milo. `GET` is how they find out what they handed it to: the running roster
 * tier by tier, each entry's price, how much traffic it actually carries on
 * OpenRouter, where the default came from, and the ways to override it.
 *
 * `PUT` is the other half of that bargain. People who already use OpenRouter
 * know which models they like, so onboarding asks them (`/setup.md`, "Ask
 * before configuring") and posts the answer here: either a flat `models` list,
 * which is tiered by output price with the same bands that produced the
 * default roster, or explicit `tiers` for someone who wants to place them by
 * hand. Ids are checked against OpenRouter's own catalogue first, because a
 * typo that only surfaces as a 404 an hour later is a bad trade for one cached
 * call. `DELETE` puts the caller back on the deployment's roster.
 *
 * The stored row is keyed by the SHA-256 of the caller's credential and holds
 * nothing else about them -- no key, no id, no email (ADR-003).
 *
 * Entries are labelled by where they came from. An id that is not a shipped
 * default is `source: "user"` on a stored roster and `source: "config"` on a
 * deployment's own, and it carries prices only when the caller just supplied
 * the catalogue to look them up in: `GET` spends no OpenRouter call.
 *
 * Bearer-gated like every other `/v1` route, so it does not become an
 * unauthenticated description of a deployment -- and, now, so one caller
 * cannot read or overwrite another's roster.
 */

import type { Context, Hono } from "hono";
import {
  COST_POSTURES,
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  ROSTER_POSTURE_POLICY,
  TIERS,
  defaultRosterModel,
  describeRoster,
  tierByPrice,
} from "@milo/core";
import type { PricedModel, Roster, RosterModel, Tier } from "@milo/core";
import type { AppDeps } from "../app.js";
import { keyHash, upstreamAuthorization } from "../app.js";
import { errorMessage, errorResponse } from "../errors.js";
import { readJsonObject } from "./shared.js";

/** Where the table being described came from. */
export type RosterSourceKind = "default" | "config" | "user";

export type RosterEntryView = Partial<RosterModel> & {
  id: string;
  /**
   * `"default"` for a model Milo ships, `"config"` for one this deployment
   * added, `"user"` for one the caller stored with `PUT /v1/roster`.
   */
  source: RosterSourceKind;
  /** First in its tier: what this tier resolves to unless something excludes it. */
  isTierDefault: boolean;
  /** The tier this model sits in by default, when that is not the tier it is listed under. */
  defaultTier?: Tier;
};

export type RosterView = {
  version: string;
  source: RosterInfoSource;
  /**
   * Where the table below came from: `"user"` for this caller's stored
   * roster, `"config"` for the deployment's, `"default"` for the shipped one.
   */
  rosterSource: RosterSourceKind;
  /** ISO 8601, when this caller last stored a roster. Only on `"user"`. */
  storedAt?: string;
  topModels: number;
  bands: typeof DEFAULT_ROSTER_INFO.bands;
  excludedAbove: number;
  smallOutputBelowTokens: number;
  /** False when this deployment's config, or the caller, replaced the shipped roster. */
  usingDefaults: boolean;
  tiers: Record<Tier, RosterEntryView[]>;
  /** The same table as Markdown, for an agent that has to show a user once. */
  table: string;
  policy: { posture: Record<string, string>; longOutput: string };
  overrides: { perRequest: string; perDeployment: string; perKey: string };
  note: string;
  premium: string;
};

type RosterInfoSource = typeof DEFAULT_ROSTER_INFO.source;

/** What Milo learned about one id from OpenRouter's catalogue. */
export type CatalogueModel = PricedModel & {
  inputUsdPerM?: number;
  contextLength?: number;
};

export type RosterViewOptions = {
  rosterSource?: RosterSourceKind;
  storedAt?: string;
  /** Prices for ids Milo does not ship, when the caller has them in hand. */
  prices?: ReadonlyMap<string, CatalogueModel>;
};

/** The running roster, annotated with everything Milo knows about each id. */
export function rosterView(running: Roster, opts: RosterViewOptions = {}): RosterView {
  const rosterSource = opts.rosterSource ?? "default";
  const prices = opts.prices;
  const tiers = {} as Record<Tier, RosterEntryView[]>;
  let usingDefaults = true;

  for (const tier of TIERS) {
    const ids = running[tier] ?? [];
    tiers[tier] = ids.map((id, index) => {
      const known = defaultRosterModel(id);
      if (known === undefined) {
        usingDefaults = false;
        const priced = prices?.get(id);
        return {
          id,
          ...(priced === undefined ? {} : catalogueFields(priced)),
          source: rosterSource === "user" ? ("user" as const) : ("config" as const),
          isTierDefault: index === 0,
        };
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
    rosterSource,
    ...(opts.storedAt !== undefined ? { storedAt: opts.storedAt } : {}),
    topModels: DEFAULT_ROSTER_INFO.topModels,
    bands: DEFAULT_ROSTER_INFO.bands,
    excludedAbove: DEFAULT_ROSTER_INFO.excludedAbove,
    smallOutputBelowTokens: DEFAULT_ROSTER_INFO.smallOutputBelowTokens,
    usingDefaults,
    tiers,
    table: describeRoster(running, prices === undefined ? [] : [...prices.values()]),
    policy: {
      posture: Object.fromEntries(COST_POSTURES.map((p) => [p, ROSTER_POSTURE_POLICY[p]])),
      longOutput:
        `A request whose answer is expected to be long skips any model capping output below ` +
        `${DEFAULT_ROSTER_INFO.smallOutputBelowTokens} tokens, which is why those are listed last in their tier.`,
    },
    overrides: {
      perRequest: 'Send `"milo": { "candidates": ["<openrouter id>", ...] }` with a chat completion.',
      perDeployment: 'Set `roster` in `milo.config.json` (see docs/config.md) and restart `milo serve`.',
      perKey: 'PUT /v1/roster with `{ "models": ["<openrouter id>", ...] }` to store your own list against your key; DELETE /v1/roster reverts.',
    },
    note: ROSTER_NOTE,
    premium: ROSTER_OVERRIDE_NOTE,
  };
}

/** Only the fields a `RosterEntryView` shares with a catalogue entry. */
function catalogueFields(model: CatalogueModel): Partial<RosterModel> {
  return {
    ...(model.inputUsdPerM !== undefined ? { inputUsdPerM: model.inputUsdPerM } : {}),
    outputUsdPerM: model.outputUsdPerM,
    ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenRouter's catalogue
// ---------------------------------------------------------------------------

const USD_PER_TOKEN_TO_PER_M = 1_000_000;

function readPrice(value: unknown): number | undefined {
  const price = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  // OpenRouter prices in USD per token, as strings, and uses "-1" for its own
  // auto router. A negative or unreadable price is "unknown", not "free".
  if (!Number.isFinite(price) || price < 0) return undefined;
  return price * USD_PER_TOKEN_TO_PER_M;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * OpenRouter's `/models` payload, indexed by id. Everything is read
 * defensively: an entry Milo cannot price still counts as a *known* id (the
 * user may route to it), it just gets no price, and `tierByPrice` puts an
 * unpriced model on `frontier` rather than guessing it is cheap.
 */
export function catalogue(data: unknown[]): Map<string, CatalogueModel> {
  const models = new Map<string, CatalogueModel>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || id === "") continue;

    const pricing = (typeof row["pricing"] === "object" && row["pricing"] !== null ? row["pricing"] : {}) as Record<
      string,
      unknown
    >;
    const topProvider = (
      typeof row["top_provider"] === "object" && row["top_provider"] !== null ? row["top_provider"] : {}
    ) as Record<string, unknown>;
    const params = Array.isArray(row["supported_parameters"]) ? row["supported_parameters"] : undefined;

    const output = readPrice(pricing["completion"]);
    const input = readPrice(pricing["prompt"]);
    const maxOutput = readCount(topProvider["max_completion_tokens"]);
    const context = readCount(row["context_length"]) ?? readCount(topProvider["context_length"]);

    models.set(id, {
      id,
      outputUsdPerM: output ?? Number.POSITIVE_INFINITY,
      ...(input !== undefined ? { inputUsdPerM: input } : {}),
      ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
      ...(context !== undefined ? { contextLength: context } : {}),
      ...(params !== undefined ? { supportsTools: params.includes("tools") } : {}),
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// PUT body
// ---------------------------------------------------------------------------

type PutBody = { models?: string[]; tiers?: Partial<Record<Tier, string[]>> };

/** A parsed `PUT` body, or the message explaining why it is not one. */
function readPutBody(body: Record<string, unknown>): PutBody | string {
  const hasModels = body["models"] !== undefined;
  const hasTiers = body["tiers"] !== undefined;

  if (hasModels === hasTiers) {
    return 'Send exactly one of `models` (a flat list, tiered by price) or `tiers` (a model id list per tier).';
  }

  if (hasModels) {
    const ids = readIdList(body["models"]);
    if (ids === undefined) return "`models` must be an array of OpenRouter model ids.";
    if (ids.length === 0) return "`models` must name at least one model.";
    return { models: ids };
  }

  const source = body["tiers"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return "`tiers` must be an object with `fast`, `mid` and `frontier` model id lists.";
  }
  const tiers: Partial<Record<Tier, string[]>> = {};
  let total = 0;
  for (const tier of TIERS) {
    const value = (source as Record<string, unknown>)[tier];
    if (value === undefined) {
      tiers[tier] = [];
      continue;
    }
    const ids = readIdList(value);
    if (ids === undefined) return `\`tiers.${tier}\` must be an array of OpenRouter model ids.`;
    tiers[tier] = ids;
    total += ids.length;
  }
  if (total === 0) return "`tiers` must name at least one model.";
  return { tiers };
}

function readIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const id = entry.trim();
    if (id === "") return undefined;
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRosterRoute(app: Hono, deps: AppDeps): void {
  app.get("/v1/roster", (c) => getRoster(c, deps));
  app.put("/v1/roster", (c) => putRoster(c, deps));
  app.delete("/v1/roster", (c) => deleteRoster(c, deps));
}

/**
 * The caller's stored roster if they have one, else the deployment's, else
 * the shipped default -- the same precedence the routed path applies in
 * `routes/shared.ts`, so this route describes what a request would actually
 * get rather than what the deployment was started with.
 */
async function getRoster(c: Context, deps: AppDeps): Promise<Response> {
  const stored = await loadStored(c, deps);
  if (stored !== undefined) {
    return c.json(rosterView(stored.roster, { rosterSource: "user", storedAt: stored.updatedAt }));
  }
  return c.json(rosterView(deps.roster ?? DEFAULT_ROSTER, { rosterSource: deploymentSource(deps) }));
}

async function putRoster(c: Context, deps: AppDeps): Promise<Response> {
  const body = await readJsonObject(c);
  if (body === undefined) {
    return errorResponse(
      c,
      400,
      "Request body must be a JSON object.",
      "invalid_request_error",
      "invalid_request_body",
    );
  }

  const parsed = readPutBody(body);
  if (typeof parsed === "string") {
    return errorResponse(c, 400, parsed, "invalid_request_error", "invalid_roster");
  }

  // One cached OpenRouter call, with the caller's own key: the catalogue is
  // both the id check and the price table the tiering needs.
  let known: Map<string, CatalogueModel>;
  try {
    const { data } = await deps.openRouter.listModels(upstreamAuthorization(c));
    known = catalogue(data);
  } catch (err) {
    deps.logger.error("openrouter models request failed", { route: "PUT /v1/roster", error: errorMessage(err) });
    return errorResponse(
      c,
      502,
      "Milo could not reach OpenRouter to check those model ids. Retry shortly.",
      "api_error",
      "upstream_unavailable",
    );
  }

  const requested = parsed.models ?? TIERS.flatMap((tier) => parsed.tiers?.[tier] ?? []);
  const unknown = [...new Set(requested.filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    return errorResponse(
      c,
      400,
      `OpenRouter has no model with ${unknown.length === 1 ? "this id" : "these ids"}: ` +
        `${unknown.join(", ")}. Check GET /v1/models for the exact ids.`,
      "invalid_request_error",
      "unknown_model",
    );
  }

  const roster =
    parsed.models !== undefined
      ? tierByPrice(parsed.models.map((id) => known.get(id) as CatalogueModel))
      : ({
          fast: parsed.tiers?.fast ?? [],
          mid: parsed.tiers?.mid ?? [],
          frontier: parsed.tiers?.frontier ?? [],
        } satisfies Roster);

  const hash = keyHash(c);
  const stored = await deps.log.setRoster(hash, roster);
  // The hash, never the key -- and only at info level, so an operator can see
  // that a roster moved without learning whose.
  deps.logger.info("stored per-key roster", {
    keyHash: hash,
    models: requested.length,
    mode: parsed.models !== undefined ? "models" : "tiers",
  });

  return c.json(
    rosterView(stored.roster, { rosterSource: "user", storedAt: stored.updatedAt, prices: known }),
  );
}

async function deleteRoster(c: Context, deps: AppDeps): Promise<Response> {
  const deleted = await deps.log.deleteRoster(keyHash(c));
  const view = rosterView(deps.roster ?? DEFAULT_ROSTER, { rosterSource: deploymentSource(deps) });
  return c.json({ deleted, ...view });
}

/**
 * Whether the deployment's table is the shipped one. Compared by value rather
 * than by "was `roster` passed": `createGateway` fills the option in with
 * `DEFAULT_ROSTER`, and a deployment running exactly the shipped list is
 * running the defaults however it got there.
 */
function deploymentSource(deps: AppDeps): RosterSourceKind {
  const running = deps.roster;
  if (running === undefined) return "default";
  const same = TIERS.every(
    (tier) =>
      (running[tier] ?? []).length === DEFAULT_ROSTER[tier].length &&
      (running[tier] ?? []).every((id, i) => id === DEFAULT_ROSTER[tier][i]),
  );
  return same ? "default" : "config";
}

/**
 * This caller's stored roster, or undefined. A store that is down must not
 * take the route down with it: the deployment's roster is still a true
 * answer, and it is the one the routed path will use too.
 */
async function loadStored(
  c: Context,
  deps: AppDeps,
): Promise<{ roster: Roster; updatedAt: string } | undefined> {
  try {
    return await deps.log.getRoster(keyHash(c));
  } catch (err) {
    deps.logger.error("per-key roster read failed", { error: errorMessage(err) });
    return undefined;
  }
}
