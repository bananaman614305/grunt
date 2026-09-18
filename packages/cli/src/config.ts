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

const rateLimitSchema = z
  .object({
    routedPerMinute: z.number().int().positive(),
  })
  .strict();

/**
 * Best-of-N sampling (ADR-010). `enabled` defaults to true -- sampling is a
 * routing outcome, on by default for the cells the policy names; the cells
 * themselves are fixed in code for now. `sampleTimeoutMs` caps each sample's
 * wall clock (gateway default: 60,000 ms). `minRanked` is how many ranked
 * samples the fan-out waits for before returning a clear winner early and
 * aborting the still-streaming rest (gateway default: 3).
 */
const samplingSchema = z
  .object({
    enabled: z.boolean().default(true),
    sampleTimeoutMs: z.number().int().positive().optional(),
    minRanked: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    port: z.number().int().positive().default(DEFAULT_PORT),
    hostname: z.string().trim().min(1).optional(),
    roster: rosterSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
    decisionLog: z.string().trim().min(1).default(DEFAULT_DECISION_LOG_URL),
    referer: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    /** Jev budget in ms per routed request. Default ROUTER_LIMITS.jevTimeoutMs (800). */
    jevTimeoutMs: z.number().int().positive().optional(),
    sampling: samplingSchema.optional(),
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
