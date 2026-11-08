/**
 * `milo.config.json` schema and loader.
 *
 * Every field is optional; a missing file (when the caller did not ask for
 * one explicitly) means every default applies. An explicit `--config` path
 * that cannot be read, or a file that fails validation, is an error -- the
 * CLI never silently ignores a config the user pointed at.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z, type ZodError } from "zod";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_DECISION_LOG_URL = "file:./.milo/decisions.db";
export const DEFAULT_CONFIG_FILENAME = "milo.config.json";

const modelId = z.string().trim().min(1, "model id must not be empty");
const modelIdList = z.array(modelId).min(1, "must list at least one model id");

/**
 * Mirrors `Roster` from `@milo/core` (`Record<Tier, string[]>`). Written out
 * rather than derived from `TIERS` so every tier is a required key with its
 * own error path when it is missing.
 */
const rosterSchema = z
  .object({
    fast: modelIdList,
    mid: modelIdList,
    frontier: modelIdList,
  })
  .strict();

/** One subscription CLI. Every field optional; the CLI's own defaults apply. */
const backendSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Binary path or name; default `codex` / `claude` on PATH. */
    binary: z.string().trim().min(1).optional(),
    /** Default model for this CLI (`codex -m`, `claude --model`). */
    model: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * The local subscription router (ADR-031): which CLIs to run, where, and how
 * to trade task preference against remaining plan capacity.
 */
const subscriptionsSchema = z
  .object({
    /** Scratch directory the CLIs run in. Default `<tmpdir>/milo-work`. */
    workdir: z.string().trim().min(1).optional(),
    /** Per-call ceiling for one CLI run, in ms. Default 10 minutes. */
    timeoutMs: z.number().int().positive().optional(),
    /** How long a rate-limited subscription is skipped when its reset is unknown, in ms. Default 15 minutes. */
    cooldownMs: z.number().int().positive().optional(),
    /** Below this many percent left, a subscription yields to one with more. Default 10. */
    reservePercent: z.number().min(0).max(100).optional(),
    /** Move work off the preferred subscription when the other has this many more percent left. Default 30. */
    balanceMarginPercent: z.number().min(0).max(100).optional(),
    codex: backendSchema.optional(),
    claude: backendSchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    port: z.number().int().positive().default(DEFAULT_PORT),
    /** Interface to listen on. Default `127.0.0.1`: the gateway has no API key. */
    hostname: z.string().trim().min(1).default(DEFAULT_HOSTNAME),
    decisionLog: z.string().trim().min(1).default(DEFAULT_DECISION_LOG_URL),
    subscriptions: subscriptionsSchema.default({}),
    /** Tier roster for the Jev eval tooling (`milo roster`, `milo canary`). Not used to route. */
    roster: rosterSchema.optional(),
  })
  .strict();

export type MiloConfig = z.infer<typeof configSchema>;

export type ConfigSource = { kind: "file"; path: string } | { kind: "default" };

export type LoadedConfig = {
  config: MiloConfig;
  source: ConfigSource;
};

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Loads and validates `milo.config.json`.
 *
 * - `path` explicit and unreadable: throws.
 * - `path` explicit and present but invalid: throws with every issue listed.
 * - `path` omitted and no file at `<cwd>/milo.config.json`: returns defaults.
 * - `cwd` is injectable for tests; defaults to `process.cwd()`.
 */
export function loadConfig(path?: string, cwd: string = process.cwd()): LoadedConfig {
  const explicit = path !== undefined;
  const resolvedPath = resolve(cwd, path ?? DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if (!explicit) {
      return { config: configSchema.parse({}), source: { kind: "default" } };
    }
    throw new Error(
      `milo config: could not read "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `milo config: "${resolvedPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`milo config: "${resolvedPath}" is invalid:\n${formatZodError(result.error)}`);
  }

  return { config: result.data, source: { kind: "file", path: resolvedPath } };
}
