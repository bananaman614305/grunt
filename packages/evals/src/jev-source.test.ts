import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { concurrencyForMode, DEFAULT_EVAL_CONCURRENCY, makeJevClient } from "./jev-source.js";

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

describe("concurrencyForMode", () => {
  it("is the default concurrency for every mode", () => {
    expect(concurrencyForMode("fixtures")).toBe(DEFAULT_EVAL_CONCURRENCY);
    expect(concurrencyForMode("record")).toBe(DEFAULT_EVAL_CONCURRENCY);
    expect(concurrencyForMode("live")).toBe(DEFAULT_EVAL_CONCURRENCY);
  });
});
