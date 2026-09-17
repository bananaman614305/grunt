/**
 * Builds a `JevClientLike` for the eval runner in one of three modes. The
 * real Jev key never comes from anywhere but `process.env.JEV_API_KEY`, and
 * it is never logged, returned, or embedded in an error message.
 *
 * - `fixtures`: replays recorded fixtures under `packages/evals/fixtures/jev`
 *   with a dummy key. Never touches the network. A missing fixture makes the
 *   underlying `JevClient` reject (see `fixtureFetch` in `@milo/core`); the
 *   eval runner turns that rejection into an `unscored` example rather than
 *   aborting.
 * - `record`: replays a fixture when one exists and otherwise calls the real
 *   Jev API and records the exchange, so the fixture set can be grown.
 *   Needs `JEV_API_KEY`.
 * - `live`: always calls the real Jev API. Needs `JEV_API_KEY`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevClientLike } from "@milo/core";
import { fixtureFetch, JevClient, recordingFetch } from "@milo/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of committed/recorded Jev fixtures for the eval set. */
export const DEFAULT_FIXTURES_DIR = resolve(__dirname, "../fixtures/jev");

/** Never a real credential: fixtures mode makes no network call. */
const FIXTURE_DUMMY_KEY = "fixture-mode-dummy-key";

export const JEV_SOURCE_MODES = ["fixtures", "record", "live"] as const;
export type JevSourceMode = (typeof JEV_SOURCE_MODES)[number];

export type MakeJevClientOptions = {
  /** Fixture directory for `fixtures`/`record` modes. Defaults to `DEFAULT_FIXTURES_DIR`. */
  fixturesDir?: string;
  /** Jev model to request. Defaults to the client's own default (`jev-latest`). */
  model?: string;
  /** Injectable for tests; defaults to the global `fetch`. Used by `record`/`live`. */
  realFetch?: typeof fetch;
};

/** Reads `JEV_API_KEY`, throwing a clear error (naming the variable, never a value) if absent. */
function requireApiKey(mode: "record" | "live"): string {
  const key = process.env["JEV_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new Error(
      `${mode} mode needs a real Jev key: set the JEV_API_KEY environment variable ` +
        `(in development, fetch it through the Squire use_credential tool rather than exporting it directly)`,
    );
  }
  return key;
}

export function makeJevClient(mode: JevSourceMode, opts: MakeJevClientOptions = {}): JevClientLike {
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const modelOpt = opts.model !== undefined ? { model: opts.model } : {};

  switch (mode) {
    case "fixtures":
      return new JevClient({
        apiKey: FIXTURE_DUMMY_KEY,
        ...modelOpt,
        fetch: fixtureFetch(fixturesDir),
      });

    case "record": {
      const apiKey = requireApiKey("record");
      const realFetch = opts.realFetch ?? fetch;
      return new JevClient({
        apiKey,
        ...modelOpt,
        fetch: recordingFetch(fixturesDir, realFetch),
      });
    }

    case "live": {
      const apiKey = requireApiKey("live");
      const fetchOpt = opts.realFetch !== undefined ? { fetch: opts.realFetch } : {};
      return new JevClient({ apiKey, ...modelOpt, ...fetchOpt });
    }

    default: {
      const exhaustive: never = mode;
      throw new Error(`unknown jev source mode: ${String(exhaustive)}`);
    }
  }
}
