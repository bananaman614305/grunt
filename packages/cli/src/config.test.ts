import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DECISION_LOG_URL, DEFAULT_HOSTNAME, DEFAULT_PORT, configSchema, loadConfig } from "./config.js";

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
      hostname: DEFAULT_HOSTNAME,
      decisionLog: DEFAULT_DECISION_LOG_URL,
      subscriptions: {},
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
        subscriptions: { reservePercent: 20, claude: { model: "sonnet" }, codex: { enabled: false } },
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
    expect(loaded.config.subscriptions).toEqual({
      reservePercent: 20,
      claude: { enabled: true, model: "sonnet" },
      codex: { enabled: false },
    });
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

  it("rejects invalid JSON with a clear message", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, "{ not json");

    expect(() => loadConfig(path, dir)).toThrow(/not valid JSON/);
  });

  it("accepts the shipped milo.config.example.json", () => {
    const example = new URL("../../../milo.config.example.json", import.meta.url);
    const parsed = configSchema.safeParse(JSON.parse(readFileSync(example, "utf8")));

    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown field inside subscriptions and a reserve over 100", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ subscriptions: { gemini: {} } }));
    expect(() => loadConfig(path, dir)).toThrow(/gemini/);

    writeFileSync(path, JSON.stringify({ subscriptions: { reservePercent: 150 } }));
    expect(() => loadConfig(path, dir)).toThrow(/reservePercent/);
  });

  it("refuses the hosted-version fields that no longer exist", () => {
    const path = join(dir, "milo.config.json");
    for (const field of ["tenantLimits", "sampling", "jevTransport", "mode"]) {
      writeFileSync(path, JSON.stringify({ [field]: {} }));
      expect(() => loadConfig(path, dir)).toThrow(new RegExp(field));
    }
  });
});
