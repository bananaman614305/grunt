/**
 * Builds a `JevClientLike` for the eval runner in one of four modes, over one
 * of two decision backends (ADR-004). The real Jev key never comes from
 * anywhere but `process.env.JEV_API_KEY`, and it is never logged, returned, or
 * embedded in an error message.
 *
 * Modes:
 *
 * - `fixtures`: replays recorded fixtures with a dummy key. Never touches the
 *   network. A missing fixture makes the client reject (see `fixtureFetch` in
 *   `@milo/core`); the eval runner turns that rejection into an `unscored`
 *   example rather than aborting.
 * - `record`: replays a fixture when one exists and otherwise calls the real
 *   backend and records the exchange, so the fixture set can be grown.
 * - `live`: always calls the real Jev API. Needs `JEV_API_KEY`.
 * - `system-one-open`: always calls a system-one-open deployment. Needs no
 *   key; the deployment URL comes from `SYSTEM_ONE_OPEN_URL`, defaulting to
 *   the public demo.
 *
 * `fixtures` and `record` work over either backend. Which one they use is
 * chosen by the `backend` option or by `MILO_DECISION_BACKEND`, and each
 * backend keeps its own fixture directory, because the two speak different
 * wire formats and a fixture is keyed by a hash of the request.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevClientLike } from "@milo/core";
import {
  fixtureFetch,
  JevClient,
  recordingFetch,
  SystemOneOpenClient,
  SYSTEM_ONE_OPEN_DEMO_URL,
} from "@milo/core";
import type { SystemOneOpenClientOptions } from "@milo/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of committed/recorded Jev fixtures for the eval set. */
export const DEFAULT_FIXTURES_DIR = resolve(__dirname, "../fixtures/jev");

/** Default location of committed/recorded system-one-open fixtures. */
export const DEFAULT_SYSTEM_ONE_OPEN_FIXTURES_DIR = resolve(__dirname, "../fixtures/system-one-open");

/** Never a real credential: fixtures mode makes no network call. */
const FIXTURE_DUMMY_KEY = "fixture-mode-dummy-key";

export const JEV_SOURCE_MODES = ["fixtures", "record", "live", "system-one-open"] as const;
export type JevSourceMode = (typeof JEV_SOURCE_MODES)[number];

export const EVAL_BACKENDS = ["jev", "system-one-open"] as const;
export type EvalBackend = (typeof EVAL_BACKENDS)[number];

/** Env var naming the deployment to evaluate against. */
export const SYSTEM_ONE_OPEN_URL_ENV = "SYSTEM_ONE_OPEN_URL";
/** Env var choosing the backend for `fixtures` and `record` mode. */
export const DECISION_BACKEND_ENV = "MILO_DECISION_BACKEND";

/** The runner's normal concurrency. */
export const DEFAULT_EVAL_CONCURRENCY = 4;
/**
 * The demo runs on one GPU, so four in flight only queues up behind itself and
 * pushes tail latency past the router's budget. Two keeps it busy without
 * turning the eval into a timeout test.
 */
export const SYSTEM_ONE_OPEN_EVAL_CONCURRENCY = 2;

/**
 * A batch eval is not a request path: the demo runs on one GPU and queues, and
 * there is no user waiting. The router's 800 ms production budget would score
 * a whole run as timeouts.
 */
export const SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS = 30_000;

/** How long to wait for a scale-to-zero container to wake before a run. */
export const SYSTEM_ONE_OPEN_WARMUP_TIMEOUT_MS = 120_000;

export type MakeJevClientOptions = {
  /** Fixture directory for `fixtures`/`record` modes. Defaults per backend. */
  fixturesDir?: string;
  /** Jev model to request. Defaults to the client's own default (`jev-latest`). */
  model?: string;
  /** Injectable for tests; defaults to the global `fetch`. Used by record/live modes. */
  realFetch?: typeof fetch;
  /** Which backend `fixtures`/`record` mode should use. Defaults to the env, else `jev`. */
  backend?: EvalBackend;
  /** system-one-open deployment URL. Defaults to the env, else the public demo. */
  systemOneOpenUrl?: string;
  /** Per-call budget for the open backend. Defaults to `SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS`. */
  systemOneOpenTimeoutMs?: number;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/** Reads `JEV_API_KEY`, throwing a clear error (naming the variable, never a value) if absent. */
function requireApiKey(mode: "record" | "live", env: NodeJS.ProcessEnv): string {
  const key = env["JEV_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new Error(
      `${mode} mode needs a real Jev key: set the JEV_API_KEY environment variable ` +
        `(in development, fetch it through the Squire use_credential tool rather than exporting it directly). ` +
        `To record or replay the open backend instead, set ${DECISION_BACKEND_ENV}=system-one-open, which needs no key.`,
    );
  }
  return key;
}

/**
 * Which backend a mode runs over. `system-one-open` and `live` name their own;
 * `fixtures` and `record` take the `backend` option, then the environment,
 * then `jev`.
 */
export function backendForMode(mode: JevSourceMode, opts: MakeJevClientOptions = {}): EvalBackend {
  if (mode === "system-one-open") return "system-one-open";
  if (mode === "live") return "jev";
  if (opts.backend !== undefined) return opts.backend;
  const fromEnv = (opts.env ?? process.env)[DECISION_BACKEND_ENV]?.trim();
  return fromEnv === "system-one-open" ? "system-one-open" : "jev";
}

/** Max in-flight calls for a mode. Two against the single-GPU open demo. */
export function concurrencyForMode(mode: JevSourceMode, opts: MakeJevClientOptions = {}): number {
  if (mode === "fixtures") return DEFAULT_EVAL_CONCURRENCY;
  return backendForMode(mode, opts) === "system-one-open"
    ? SYSTEM_ONE_OPEN_EVAL_CONCURRENCY
    : DEFAULT_EVAL_CONCURRENCY;
}

/**
 * The router budget for a mode, or `undefined` to leave the router on its
 * production default.
 */
export function routerTimeoutForMode(
  mode: JevSourceMode,
  opts: MakeJevClientOptions = {},
): number | undefined {
  if (backendForMode(mode, opts) !== "system-one-open") return undefined;
  return (opts.systemOneOpenTimeoutMs ?? SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS) + 250;
}

function systemOneOpenUrl(opts: MakeJevClientOptions): string {
  const fromEnv = (opts.env ?? process.env)[SYSTEM_ONE_OPEN_URL_ENV]?.trim();
  return opts.systemOneOpenUrl ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : SYSTEM_ONE_OPEN_DEMO_URL);
}

function makeSystemOneOpen(opts: MakeJevClientOptions, fetchImpl?: typeof fetch): SystemOneOpenClient {
  const clientOptions: SystemOneOpenClientOptions = {
    baseUrl: systemOneOpenUrl(opts),
    timeoutMs: opts.systemOneOpenTimeoutMs ?? SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS,
  };
  if (fetchImpl !== undefined) clientOptions.fetch = fetchImpl;
  return new SystemOneOpenClient(clientOptions);
}

/**
 * Wakes a scale-to-zero backend before the run starts, so the first two
 * examples do not pay a 35 s cold start and score as timeouts. A no-op for
 * every other client, and never fatal.
 */
export async function warmupBackend(client: JevClientLike): Promise<void> {
  if (!(client instanceof SystemOneOpenClient)) return;
  await client.warmup({ timeoutMs: SYSTEM_ONE_OPEN_WARMUP_TIMEOUT_MS });
}

export function makeJevClient(mode: JevSourceMode, opts: MakeJevClientOptions = {}): JevClientLike {
  const env = opts.env ?? process.env;
  const backend = backendForMode(mode, opts);
  const fixturesDir =
    opts.fixturesDir ??
    (backend === "system-one-open" ? DEFAULT_SYSTEM_ONE_OPEN_FIXTURES_DIR : DEFAULT_FIXTURES_DIR);
  const envModel = env["JEV_MODEL"];
  const model = opts.model ?? (envModel !== undefined && envModel !== "" ? envModel : undefined);
  const modelOpt = model !== undefined ? { model } : {};
  // Optional override so live/record runs can go through a key-injecting proxy.
  const envBase = env["JEV_BASE_URL"];
  const baseOpt = envBase !== undefined && envBase !== "" ? { baseUrl: envBase } : {};
  const envTimeout = Number(env["JEV_TIMEOUT_MS"]);
  const timeoutOpt = Number.isFinite(envTimeout) && envTimeout > 0 ? { timeoutMs: envTimeout } : {};

  switch (mode) {
    case "fixtures":
      if (backend === "system-one-open") {
        return makeSystemOneOpen(opts, fixtureFetch(fixturesDir));
      }
      // A fixture is keyed by a hash of the whole request, base URL included,
      // so a replay must build the exact same URL the recording session
      // used (JEV_BASE_URL, when the recording went through a key-injecting
      // proxy) or every lookup misses and the run scores as all-unscored.
      return new JevClient({
        apiKey: FIXTURE_DUMMY_KEY,
        ...modelOpt,
        ...baseOpt,
        fetch: fixtureFetch(fixturesDir),
      });

    case "record": {
      const realFetch = opts.realFetch ?? fetch;
      if (backend === "system-one-open") {
        // No key: the open backend has no auth at all.
        return makeSystemOneOpen(opts, recordingFetch(fixturesDir, realFetch));
      }
      const apiKey = requireApiKey("record", env);
      return new JevClient({
        apiKey,
        ...modelOpt,
        ...baseOpt,
        ...timeoutOpt,
        fetch: recordingFetch(fixturesDir, realFetch),
      });
    }

    case "live": {
      const apiKey = requireApiKey("live", env);
      const fetchOpt = opts.realFetch !== undefined ? { fetch: opts.realFetch } : {};
      return new JevClient({ apiKey, ...modelOpt, ...baseOpt, ...timeoutOpt, ...fetchOpt });
    }

    case "system-one-open":
      return makeSystemOneOpen(opts, opts.realFetch);

    default: {
      const exhaustive: never = mode;
      throw new Error(`unknown jev source mode: ${String(exhaustive)}`);
    }
  }
}
