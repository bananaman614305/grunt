import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DECISION_LOG_URL, DEFAULT_PORT, loadConfig } from "./config.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns every default when no file exists and none was requested", () => {
    const loaded = loadConfig(undefined, dir);

    expect(loaded.source).toEqual({ kind: "default" });
    expect(loaded.config).toEqual({
      port: DEFAULT_PORT,
      decisionLog: DEFAULT_DECISION_LOG_URL,
    });
  });

  it("throws a clear error when an explicit --config path does not exist", () => {
    expect(() => loadConfig(join(dir, "missing.json"), dir)).toThrow(/could not read/);
  });

  it("loads and validates a well-formed file, filling in defaults for the rest", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        port: 9000,
        hostname: "0.0.0.0",
        roster: {
          fast: ["anthropic/claude-haiku-4.5"],
          mid: ["anthropic/claude-sonnet-5"],
          frontier: ["anthropic/claude-opus-5"],
        },
        rateLimit: { routedPerMinute: 60 },
        referer: "https://example.com",
        title: "Example",
      }),
    );

    const loaded = loadConfig(path, dir);

    expect(loaded.source).toEqual({ kind: "file", path });
    expect(loaded.config.port).toBe(9000);
    expect(loaded.config.hostname).toBe("0.0.0.0");
    expect(loaded.config.roster).toEqual({
      fast: ["anthropic/claude-haiku-4.5"],
      mid: ["anthropic/claude-sonnet-5"],
      frontier: ["anthropic/claude-opus-5"],
    });
    expect(loaded.config.rateLimit).toEqual({ routedPerMinute: 60 });
    expect(loaded.config.decisionLog).toBe(DEFAULT_DECISION_LOG_URL);
  });

  it("resolves a relative --config path against the given cwd, defaulting to milo.config.json", () => {
    writeFileSync(join(dir, "milo.config.json"), JSON.stringify({ port: 4242 }));

    const loaded = loadConfig(undefined, dir);

    expect(loaded.source).toEqual({ kind: "file", path: join(dir, "milo.config.json") });
    expect(loaded.config.port).toBe(4242);
  });

  it("rejects a roster missing a tier, with a message naming the missing tier", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        roster: {
          fast: ["anthropic/claude-haiku-4.5"],
          mid: ["anthropic/claude-sonnet-5"],
          // frontier missing
        },
      }),
    );

    expect(() => loadConfig(path, dir)).toThrow(/roster\.frontier/);
  });

  it("rejects a roster tier with an empty model list", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        roster: { fast: [], mid: ["anthropic/claude-sonnet-5"], frontier: ["anthropic/claude-opus-5"] },
      }),
    );

    expect(() => loadConfig(path, dir)).toThrow(/roster\.fast/);
  });

  it("rejects an unknown top-level field", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ port: 8787, nonsense: true }));

    expect(() => loadConfig(path, dir)).toThrow(/nonsense/);
  });

  it("rejects an unknown field inside rateLimit", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ rateLimit: { routedPerMinute: 10, burst: 5 } }));

    expect(() => loadConfig(path, dir)).toThrow(/burst/);
  });

  it("rejects invalid JSON with a clear message", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, "{ not json");

    expect(() => loadConfig(path, dir)).toThrow(/not valid JSON/);
  });
});
