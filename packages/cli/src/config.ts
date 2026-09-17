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

/** Mirrors `DecisionBackendOptions` from `@milo/gateway` (ADR-004). */
export const DECISION_BACKEND_KINDS = ["jev", "system-one-open", "jev-with-fallback"] as const;
export type DecisionBackendKind = (typeof DECISION_BACKEND_KINDS)[number];

export const DEFAULT_DECISION_BACKEND_KIND: DecisionBackendKind = "jev";

/** Env vars that stand in for the config block when it is absent. */
export const DECISION_BACKEND_ENV = "MILO_DECISION_BACKEND";
export const SYSTEM_ONE_OPEN_URL_ENV = "SYSTEM_ONE_OPEN_URL";

const decisionBackendSchema = z
  .object({
    kind: z.enum(DECISION_BACKEND_KINDS),
    systemOneOpenUrl: z.string().trim().min(1).optional(),
    systemOneOpenTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Written out rather than inferred from the schema: `exactOptionalPropertyTypes`
 * makes Zod's `?: T | undefined` incompatible with the gateway's `?: T`, and
 * this is the shape that is handed to `GatewayOptions.decisionBackend`.
 */
export type DecisionBackendConfig = {
  kind: DecisionBackendKind;
  systemOneOpenUrl?: string;
  systemOneOpenTimeoutMs?: number;
};

export const configSchema = z
  .object({
    port: z.number().int().positive().default(DEFAULT_PORT),
    hostname: z.string().trim().min(1).optional(),
    roster: rosterSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
    decisionLog: z.string().trim().min(1).default(DEFAULT_DECISION_LOG_URL),
    decisionBackend: decisionBackendSchema.optional(),
    referer: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    /** Jev budget in ms per routed request. Default ROUTER_LIMITS.jevTimeoutMs (800). */
    jevTimeoutMs: z.number().int().positive().optional(),
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

function isDecisionBackendKind(value: string): value is DecisionBackendKind {
  return (DECISION_BACKEND_KINDS as readonly string[]).includes(value);
}

/**
 * Resolves the decision backend from the config file, falling back to the
 * environment field by field: `MILO_DECISION_BACKEND` for the kind and
 * `SYSTEM_ONE_OPEN_URL` for the deployment URL. The config file wins wherever
 * it sets a field, so a checked-in config is not silently overridden by a
 * stray variable in someone's shell.
 *
 * Returns `undefined` when nothing is configured anywhere, which leaves the
 * gateway on its own default (`jev`).
 */
export function resolveDecisionBackend(
  config: MiloConfig,
  env: NodeJS.ProcessEnv = process.env,
): DecisionBackendConfig | undefined {
  const fromFile = config.decisionBackend;
  const envKind = env[DECISION_BACKEND_ENV]?.trim();
  const envUrl = env[SYSTEM_ONE_OPEN_URL_ENV]?.trim();

  if (envKind !== undefined && envKind !== "" && !isDecisionBackendKind(envKind)) {
    throw new Error(
      `milo config: ${DECISION_BACKEND_ENV} must be one of ${DECISION_BACKEND_KINDS.join(", ")}, ` +
        `got "${envKind}"`,
    );
  }

  const kind: DecisionBackendKind | undefined =
    fromFile?.kind ?? (envKind !== undefined && envKind !== "" ? envKind : undefined);
  const url = fromFile?.systemOneOpenUrl ?? (envUrl !== undefined && envUrl !== "" ? envUrl : undefined);
  const timeoutMs = fromFile?.systemOneOpenTimeoutMs;

  if (kind === undefined && url === undefined && timeoutMs === undefined) return undefined;

  return {
    kind: kind ?? DEFAULT_DECISION_BACKEND_KIND,
    ...(url !== undefined ? { systemOneOpenUrl: url } : {}),
    ...(timeoutMs !== undefined ? { systemOneOpenTimeoutMs: timeoutMs } : {}),
  };
}
