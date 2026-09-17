/**
 * Builds a `JevClientLike` for the eval runner in one of three modes. The
 * real Jev key never comes from anywhere but `process.env.JEV_API_KEY`, and
 * it is never logged, returned, or embedded in an error message.
 *
 * Modes:
 *
 * - `fixtures`: replays recorded fixtures with a dummy key. Never touches the
 *   network. A missing fixture makes the client reject (see `fixtureFetch` in
 *   `@milo/core`); the eval runner turns that rejection into an `unscored`
 *   example rather than aborting.
 * - `record`: replays a fixture when one exists and otherwise calls the real
 *   Jev API and records the exchange, so the fixture set can be grown.
 * - `live`: always calls the real Jev API. Needs `JEV_API_KEY`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevClientLike } from "@milo/core";
import { fixtureFetch, JevClient, recordingFetch } from "@milo/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of committed/recorded Jev fixtures for the eval set. */
export const DEFAULT_FIXTURES_DIR = resolve(__dirname, "../fixtures/jev");

/** Suffix `JevClient` appends to its base URL for `systemone`. */
const SYSTEMONE_PATH = "/v1/systemone";

/**
 * A fixture is looked up by a hash of method + url + body (`@milo/core`'s
 * `fixtureFetch`), so replaying one requires calling the exact URL it was
 * recorded against. `record` mode may go through a Squire egress proxy
 * rather than Jev's own host (`JEV_BASE_URL`), so the committed fixtures
 * under `packages/evals/fixtures/jev` carry whatever proxy URL was current
 * when they were recorded, not `JEV_BASE_URL`. Rather than pin that URL (an
 * egress grant is not a stable identifier), `fixtures` mode infers it once
 * from any fixture already on disk.
 */
function inferFixturesBaseUrl(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const raw = readFileSync(resolve(dir, name), "utf8");
      const fixture = JSON.parse(raw) as { request?: { url?: unknown } };
      const url = fixture.request?.url;
      if (typeof url === "string" && url.endsWith(SYSTEMONE_PATH)) {
        return url.slice(0, -SYSTEMONE_PATH.length);
      }
    } catch {
      // Not a systemone fixture, or unreadable; try the next file.
    }
  }
  return undefined;
}

/** Never a real credential: fixtures mode makes no network call. */
const FIXTURE_DUMMY_KEY = "fixture-mode-dummy-key";

export const JEV_SOURCE_MODES = ["fixtures", "record", "live"] as const;
export type JevSourceMode = (typeof JEV_SOURCE_MODES)[number];

/** The runner's normal concurrency. */
export const DEFAULT_EVAL_CONCURRENCY = 4;

export type MakeJevClientOptions = {
  /** Fixture directory for `fixtures`/`record` modes. Defaults to `DEFAULT_FIXTURES_DIR`. */
  fixturesDir?: string;
  /** Jev model to request. Defaults to the client's own default (`jev-latest`). */
  model?: string;
  /** Injectable for tests; defaults to the global `fetch`. Used by record/live modes. */
  realFetch?: typeof fetch;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/** Reads `JEV_API_KEY`, throwing a clear error (naming the variable, never a value) if absent. */
function requireApiKey(mode: "record" | "live", env: NodeJS.ProcessEnv): string {
  const key = env["JEV_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new Error(
      `${mode} mode needs a real Jev key: set the JEV_API_KEY environment variable ` +
        `(in development, fetch it through the Squire use_credential tool rather than exporting it directly).`,
    );
  }
  return key;
}

/** Max in-flight calls for a mode. */
export function concurrencyForMode(mode: JevSourceMode): number {
  void mode;
  return DEFAULT_EVAL_CONCURRENCY;
}

export function makeJevClient(mode: JevSourceMode, opts: MakeJevClientOptions = {}): JevClientLike {
  const env = opts.env ?? process.env;
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const envModel = env["JEV_MODEL"];
  const model = opts.model ?? (envModel !== undefined && envModel !== "" ? envModel : undefined);
  const modelOpt = model !== undefined ? { model } : {};
  // Optional override so live/record runs can go through a key-injecting proxy.
  const envBase = env["JEV_BASE_URL"];
  const baseOpt = envBase !== undefined && envBase !== "" ? { baseUrl: envBase } : {};
  const envTimeout = Number(env["JEV_TIMEOUT_MS"]);
  const timeoutOpt = Number.isFinite(envTimeout) && envTimeout > 0 ? { timeoutMs: envTimeout } : {};

  switch (mode) {
    case "fixtures": {
      const inferredBaseUrl = envBase !== undefined && envBase !== "" ? envBase : inferFixturesBaseUrl(fixturesDir);
      return new JevClient({
        apiKey: FIXTURE_DUMMY_KEY,
        ...modelOpt,
        ...(inferredBaseUrl !== undefined ? { baseUrl: inferredBaseUrl } : {}),
        fetch: fixtureFetch(fixturesDir),
      });
    }

    case "record": {
      const realFetch = opts.realFetch ?? fetch;
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

    default: {
      const exhaustive: never = mode;
      throw new Error(`unknown jev source mode: ${String(exhaustive)}`);
    }
  }
}
