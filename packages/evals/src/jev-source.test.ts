import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ONE_OPEN_DEMO_URL } from "@milo/core";
import {
  backendForMode,
  concurrencyForMode,
  DEFAULT_EVAL_CONCURRENCY,
  JEV_SOURCE_MODES,
  makeJevClient,
  routerTimeoutForMode,
  SYSTEM_ONE_OPEN_EVAL_CONCURRENCY,
  SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS,
} from "./jev-source.js";

describe("makeJevClient", () => {
  const KEY = "JEV_API_KEY";
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY];
    else process.env[KEY] = savedKey;
  });

  it("fixtures mode over an empty directory rejects with a fixture-miss error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "milo-eval-fixtures-"));
    const client = makeJevClient("fixtures", { fixturesDir: dir });

    await expect(
      client.systemone({ state: { hello: "world" }, questions: {} }),
    ).rejects.toThrow();
  });

  it("record mode without JEV_API_KEY throws, naming the variable", () => {
    expect(() => makeJevClient("record")).toThrow(/JEV_API_KEY/);
  });

  it("live mode without JEV_API_KEY throws, naming the variable", () => {
    expect(() => makeJevClient("live")).toThrow(/JEV_API_KEY/);
  });

  it("record mode succeeds once JEV_API_KEY is set", async () => {
    process.env[KEY] = "test-only-not-a-real-key";
    const dir = await mkdtemp(path.join(tmpdir(), "milo-eval-fixtures-"));
    expect(() => makeJevClient("record", { fixturesDir: dir })).not.toThrow();
  });

  it("live mode succeeds once JEV_API_KEY is set", () => {
    process.env[KEY] = "test-only-not-a-real-key";
    expect(() => makeJevClient("live")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The system-one-open backend (ADR-004)
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit | undefined };

function capturingFetch(response: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof input === "string" ? input : String(input), init });
    return response();
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function decideResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "e2b-full",
      answers: [{ id: "needs_reasoning", type: "noul", noul: 0.5 }],
      latency_ms: 110,
      passes: 1,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const NOUL_QUESTIONS = { needs_reasoning: { type: "noul" as const, instructions: "Reasoning?" } };

describe("system-one-open mode", () => {
  it("is one of the advertised modes", () => {
    expect(JEV_SOURCE_MODES).toContain("system-one-open");
  });

  it("needs no Jev key and posts to the demo URL by default", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch(decideResponse);
    const client = makeJevClient("system-one-open", { realFetch: fetchImpl, env: {} });

    await client.systemone({ state: "s", questions: NOUL_QUESTIONS });

    expect(calls[0]?.url).toBe(`${SYSTEM_ONE_OPEN_DEMO_URL}/decide`);
  });

  it("uses SYSTEM_ONE_OPEN_URL when it is set", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch(decideResponse);
    const client = makeJevClient("system-one-open", {
      realFetch: fetchImpl,
      env: { SYSTEM_ONE_OPEN_URL: "https://mine.example.test" },
    });

    await client.systemone({ state: "s", questions: NOUL_QUESTIONS });

    expect(calls[0]?.url).toBe("https://mine.example.test/decide");
  });

  it("lets an explicit option beat the environment", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch(decideResponse);
    const client = makeJevClient("system-one-open", {
      realFetch: fetchImpl,
      systemOneOpenUrl: "https://explicit.example.test",
      env: { SYSTEM_ONE_OPEN_URL: "https://from-env.example.test" },
    });

    await client.systemone({ state: "s", questions: NOUL_QUESTIONS });

    expect(calls[0]?.url).toBe("https://explicit.example.test/decide");
  });

  it("reports the open backend as the answering model", async () => {
    const { fetch: fetchImpl } = capturingFetch(decideResponse);
    const client = makeJevClient("system-one-open", { realFetch: fetchImpl, env: {} });

    const result = await client.systemone({ state: "s", questions: NOUL_QUESTIONS });

    expect(result.model).toBe("system-one-open/e2b-full");
  });
});

describe("record mode over the open backend", () => {
  it("needs no JEV_API_KEY and records into the directory it was given", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "milo-eval-s1o-"));
    const { fetch: fetchImpl, calls } = capturingFetch(decideResponse);

    const client = makeJevClient("record", {
      backend: "system-one-open",
      fixturesDir: dir,
      realFetch: fetchImpl,
      systemOneOpenUrl: "https://open.example.test",
      env: {},
    });

    const first = await client.systemone({ state: "s", questions: NOUL_QUESTIONS });
    expect(first.model).toBe("system-one-open/e2b-full");
    expect(calls).toHaveLength(1);

    // The second identical call is served from the fixture just written.
    const second = await client.systemone({ state: "s", questions: NOUL_QUESTIONS });
    expect(second.model).toBe("system-one-open/e2b-full");
    expect(calls).toHaveLength(1);
  });

  it("MILO_DECISION_BACKEND selects the open backend for record mode", () => {
    expect(backendForMode("record", { env: { MILO_DECISION_BACKEND: "system-one-open" } })).toBe(
      "system-one-open",
    );
    // And without it, record mode is still Jev, so it still wants a key.
    expect(backendForMode("record", { env: {} })).toBe("jev");
    expect(() => makeJevClient("record", { env: {} })).toThrow(/JEV_API_KEY/);
  });

  it("replays open-backend fixtures in fixtures mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "milo-eval-s1o-"));
    const { fetch: fetchImpl } = capturingFetch(decideResponse);

    await makeJevClient("record", {
      backend: "system-one-open",
      fixturesDir: dir,
      realFetch: fetchImpl,
      systemOneOpenUrl: "https://open.example.test",
      env: {},
    }).systemone({ state: "s", questions: NOUL_QUESTIONS });

    const replay = makeJevClient("fixtures", {
      backend: "system-one-open",
      fixturesDir: dir,
      systemOneOpenUrl: "https://open.example.test",
      env: {},
    });

    await expect(replay.systemone({ state: "s", questions: NOUL_QUESTIONS })).resolves.toMatchObject({
      model: "system-one-open/e2b-full",
    });
  });
});

describe("runner settings per mode", () => {
  it("halves concurrency for the single-GPU open demo", () => {
    expect(concurrencyForMode("system-one-open")).toBe(SYSTEM_ONE_OPEN_EVAL_CONCURRENCY);
    expect(SYSTEM_ONE_OPEN_EVAL_CONCURRENCY).toBe(2);
    expect(concurrencyForMode("record", { env: { MILO_DECISION_BACKEND: "system-one-open" } })).toBe(2);
  });

  it("leaves the default concurrency alone for Jev and for fixtures", () => {
    expect(concurrencyForMode("live")).toBe(DEFAULT_EVAL_CONCURRENCY);
    expect(concurrencyForMode("record", { env: {} })).toBe(DEFAULT_EVAL_CONCURRENCY);
    // Fixtures never touch the network, so the GPU is irrelevant.
    expect(concurrencyForMode("fixtures", { env: { MILO_DECISION_BACKEND: "system-one-open" } })).toBe(
      DEFAULT_EVAL_CONCURRENCY,
    );
  });

  it("widens the router budget for the open backend and leaves it alone for Jev", () => {
    expect(routerTimeoutForMode("system-one-open")).toBe(SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS + 250);
    expect(routerTimeoutForMode("live")).toBeUndefined();
    expect(routerTimeoutForMode("fixtures", { env: {} })).toBeUndefined();
  });
});
