/**
 * The pi coding agent's provider shape, generated from the running roster.
 *
 * pi reads custom providers and models from `~/.pi/agent/models.json`
 * (docs/models.md in the pi docs): a `providers` map whose values are
 * OpenAI-compatible endpoints, one entry per provider. The gateway serves
 * this document at `GET /setup/pi.json` so an agent -- or a human -- can
 * point pi at Milo without hand-writing the shapes, and `milo configure`
 * uses the same builders to merge a `milo` provider into a local
 * `models.json` additively. One module owns the shape so the two surfaces
 * cannot drift apart.
 *
 * Nothing here is a server and nothing here touches a key: the provider
 * references the caller's OpenRouter key by environment-variable name
 * (`$OPENROUTER_API_KEY`), never by value, so the document is safe to serve
 * unauthenticated next to `/setup.md`.
 */
import { ROUTED_MODEL_ID, TIERS } from "../types.js";
import type { Roster } from "../types.js";
import { defaultRosterModel } from "../router/index.js";

/** The environment variable the pi provider reads the caller's OpenRouter key from. */
export const PI_API_KEY_ENV = "OPENROUTER_API_KEY";
/** The provider id the `milo` entry is stored under in `models.json`. */
export const PI_PROVIDER_ID = "milo";
/** pi's streaming dialect for an OpenAI-compatible completions endpoint. */
export const PI_API = "openai-completions" as const;

/** One model pi can pick from. `id` is all that is ever required. */
export type PiModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  /** USD per million tokens, as pi's model picker shows them. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** A `models.json` provider entry. */
export type PiProvider = {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: PiModel[];
};

/**
 * The whole `GET /setup/pi.json` document: what the deployment is, where pi
 * should point, and the ready-to-merge `providers` block.
 */
export type PiSetup = {
  title: string;
  /** The gateway's own origin, without `/v1`. */
  baseUrl: string;
  /** What pi should use as the provider's `baseUrl`: `<baseUrl>/v1`. */
  apiBaseUrl: string;
  /** The routed model id (`milo/auto`). */
  model: string;
  /** The environment variable pi's provider reads the key from. */
  apiKeyEnv: string;
  /** The id the `milo` provider is stored under. */
  providerId: string;
  /** Ready to be merged under `providers` in `~/.pi/agent/models.json`. */
  providers: Record<string, PiProvider>;
  /** The effective roster, tiers to ordered model ids, for the picker. */
  roster: Roster;
};

/** Fallbacks pi needs for a model Milo has no numbers for. */
// Room-verified known-good values for the routed entry (usemilo setup
// failure report): contextWindow 128000, maxTokens 32000.
const UNKNOWN_CONTEXT_WINDOW = 128_000;
const UNKNOWN_MAX_TOKENS = 32_000;

/**
 * The pi model list for a roster: `milo/auto` first, then every tier's
 * models in order. Default-roster models get their real context window, max
 * output and prices from `roster-default.json`; a model the deployment added
 * itself gets safe generic bounds and no cost, because Milo has no price for
 * an id it does not ship.
 */
export function piModels(roster: Roster): PiModel[] {
  const models: PiModel[] = [
    {
      id: ROUTED_MODEL_ID,
      name: "Milo (auto-routed)",
      reasoning: false,
      input: ["text"],
      contextWindow: UNKNOWN_CONTEXT_WINDOW,
      maxTokens: UNKNOWN_MAX_TOKENS,
    },
  ];

  for (const tier of TIERS) {
    for (const id of roster[tier] ?? []) {
      const known = defaultRosterModel(id);
      models.push({
        id,
        reasoning: false,
        input: ["text"],
        contextWindow: known?.contextLength ?? UNKNOWN_CONTEXT_WINDOW,
        maxTokens: known?.maxOutputTokens ?? UNKNOWN_MAX_TOKENS,
        ...(known !== undefined
          ? { cost: { input: known.inputUsdPerM, output: known.outputUsdPerM, cacheRead: 0, cacheWrite: 0 } }
          : {}),
      });
    }
  }

  return models;
}

/**
 * The `models.json` provider entry that points pi at Milo. `apiKey` names
 * the environment variable (pi resolves `$OPENROUTER_API_KEY` from its own
 * environment at request time) -- never a literal key, so this block can be
 * written to disk and committed.
 */
export function piProviderBlock(apiBaseUrl: string, roster: Roster): PiProvider {
  return {
    baseUrl: apiBaseUrl,
    api: PI_API,
    apiKey: `$${PI_API_KEY_ENV}`,
    models: piModels(roster),
  };
}

/**
 * The `GET /setup/pi.json` document, generated from the request's own origin
 * and the roster this deployment is actually running.
 */
export function piSetup(base: string, roster: Roster): PiSetup {
  const apiBaseUrl = `${base.replace(/\/+$/, "")}/v1`;
  return {
    title: "Milo setup for the pi coding agent",
    baseUrl: base,
    apiBaseUrl,
    model: ROUTED_MODEL_ID,
    apiKeyEnv: PI_API_KEY_ENV,
    providerId: PI_PROVIDER_ID,
    providers: { [PI_PROVIDER_ID]: piProviderBlock(apiBaseUrl, roster) },
    roster: Object.fromEntries(TIERS.map((tier) => [tier, [...(roster[tier] ?? [])]])) as Roster,
  };
}