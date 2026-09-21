/**
 * The pi coding agent harness for `milo on`.
 *
 * pi reads custom providers and models from `~/.pi/agent/models.json`
 * (docs/models.md in the pi docs): a `providers` map whose values are
 * OpenAI-compatible endpoints. `milo on pi` MERGES a `milo` provider into
 * that map additively: every provider the user already has and every other
 * top-level key -- including the user's chosen `default` model -- is left
 * untouched, and only the `milo` entry is set (or updated). The pre-merge
 * file is backed up to a sibling `models.json.milo-backup` by the runner.
 *
 * The provider block itself is the shared one from `@milo/core`
 * (`piProviderBlock`), the same shape `milo configure` and the gateway's
 * `GET /setup/pi.json` emit, so the onboarding surface cannot drift from the
 * deployment's own setup document. It references the caller's key by
 * environment-variable name (`$OPENROUTER_API_KEY`), never by value.
 */
import { join } from "node:path";
import { DEFAULT_ROSTER, PI_PROVIDER_ID, ROUTED_MODEL_ID, piProviderBlock } from "@milo/core";
import { apiBaseUrl } from "./paths.js";

export type PiEnableContext = {
  /** The bare origin of the gateway the provider points at. */
  gatewayRoot: string;
};

/** The config file within a pi config root (`~/.pi` by default). */
export const PI_CONFIG_REL = join("agent", "models.json");

/** pi's credential store: a map of provider name -> key, `~/.pi/agent/auth.json`. */
export const PI_KEY_STORE_REL = join("agent", "auth.json");

export function piDefaultRoot(home: string): string {
  return join(home, ".pi");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the existing models.json; a missing or empty file is an empty document. */
export function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

/**
 * The next models.json text: the existing document with only the `milo`
 * provider added (or updated). Everything else -- other providers, `default`,
 * any future keys -- survives byte-for-byte as far as JSON goes.
 */
export function enablePi(existing: string | undefined, ctx: PiEnableContext): string {
  const config = parseJsonObject(existing);
  const providers = isRecord(config["providers"]) ? { ...config["providers"] } : {};
  providers[PI_PROVIDER_ID] = piProviderBlock(apiBaseUrl(ctx.gatewayRoot), DEFAULT_ROSTER);
  const next = { ...config, providers };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The provider's `name` and `models` expose what status can report. */
export function statusPi(existing: string | undefined): { enabled: boolean; gateway?: string; model: string } {
  const config = parseJsonObject(existing);
  const providers = isRecord(config["providers"]) ? config["providers"] : {};
  const milo = isRecord(providers[PI_PROVIDER_ID]) ? (providers[PI_PROVIDER_ID] as Record<string, unknown>) : undefined;
  const baseUrl = milo !== undefined && typeof milo["baseUrl"] === "string" ? (milo["baseUrl"] as string) : undefined;
  if (baseUrl !== undefined) {
    return { enabled: true, gateway: baseUrl, model: ROUTED_MODEL_ID };
  }
  return { enabled: false, model: ROUTED_MODEL_ID };
}

/**
 * Renders `~/.pi/agent/auth.json`: the existing map plus the milo credential.
 *
 * pi's auth.json stores each provider's credential as an object carrying a
 * `type` (core/auth-storage.js): `{ [provider]: { type: "api_key", key } }`
 * (or an `oauth` object). A bare string is rejected by pi's loader --
 * "Invalid auth.json credential" -- which leaves the provider's models
 * unavailable, so the prompted key must be wrapped in the object shape.
 */
export function renderAuth(existing: string | undefined, key: string): string {
  const auth = parseJsonObject(existing);
  return `${JSON.stringify({ ...auth, [PI_PROVIDER_ID]: { type: "api_key", key } }, null, 2)}\n`;
}

export function nextSteps(ctx: PiEnableContext): string[] {
  return [
    `pi now has a "milo" provider at ${apiBaseUrl(ctx.gatewayRoot)} with model "${ROUTED_MODEL_ID}".`,
    `Your existing providers and default model were left untouched; pick ${ROUTED_MODEL_ID} in pi's /model to route through Milo.`,
    `The key is read from $OPENROUTER_API_KEY at call time, else from agent/auth.json; neither is written to models.json.`,
  ];
}