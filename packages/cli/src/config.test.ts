import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_BACKEND_ENV,
  DEFAULT_DECISION_LOG_URL,
  DEFAULT_PORT,
  SYSTEM_ONE_OPEN_URL_ENV,
  configSchema,
  loadConfig,
  resolveDecisionBackend,
} from "./config.js";

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

  it("loads an explicit jevTimeoutMs", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ jevTimeoutMs: 500 }));

    const loaded = loadConfig(path, dir);

    expect(loaded.config.jevTimeoutMs).toBe(500);
  });

  it("rejects a non-positive jevTimeoutMs", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ jevTimeoutMs: 0 }));

    expect(() => loadConfig(path, dir)).toThrow(/jevTimeoutMs/);
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

  it("loads a decisionBackend block", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        decisionBackend: {
          kind: "jev-with-fallback",
          systemOneOpenUrl: "https://open.example.test",
          systemOneOpenTimeoutMs: 2000,
        },
      }),
    );

    expect(loadConfig(path, dir).config.decisionBackend).toEqual({
      kind: "jev-with-fallback",
      systemOneOpenUrl: "https://open.example.test",
      systemOneOpenTimeoutMs: 2000,
    });
  });

  it("rejects an unknown decisionBackend kind", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ decisionBackend: { kind: "gpt-oracle" } }));

    expect(() => loadConfig(path, dir)).toThrow(/decisionBackend\.kind/);
  });

  it("rejects an unknown field inside decisionBackend", () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ decisionBackend: { kind: "jev", apiKey: "nope" } }));

    expect(() => loadConfig(path, dir)).toThrow(/apiKey/);
  });

  it("accepts the shipped milo.config.example.json", () => {
    const example = new URL("../../../milo.config.example.json", import.meta.url);
    const parsed = configSchema.safeParse(JSON.parse(readFileSync(example, "utf8")));

    expect(parsed.success).toBe(true);
  });
});

describe("resolveDecisionBackend", () => {
  const empty = configSchema.parse({});

  function withBackend(backend: unknown): ReturnType<typeof configSchema.parse> {
    return configSchema.parse({ decisionBackend: backend });
  }

  it("returns undefined when nothing is configured anywhere", () => {
    expect(resolveDecisionBackend(empty, {})).toBeUndefined();
  });

  it("uses the config block as given", () => {
    const config = withBackend({ kind: "system-one-open", systemOneOpenUrl: "https://a.test" });

    expect(resolveDecisionBackend(config, {})).toEqual({
      kind: "system-one-open",
      systemOneOpenUrl: "https://a.test",
    });
  });

  it("falls back to MILO_DECISION_BACKEND for the kind", () => {
    expect(resolveDecisionBackend(empty, { [DECISION_BACKEND_ENV]: "system-one-open" })).toEqual({
      kind: "system-one-open",
    });
  });

  it("falls back to SYSTEM_ONE_OPEN_URL for the deployment URL", () => {
    expect(
      resolveDecisionBackend(empty, {
        [DECISION_BACKEND_ENV]: "jev-with-fallback",
        [SYSTEM_ONE_OPEN_URL_ENV]: "https://from-env.test",
      }),
    ).toEqual({ kind: "jev-with-fallback", systemOneOpenUrl: "https://from-env.test" });
  });

  it("defaults the kind to jev when only a URL is in the environment", () => {
    expect(resolveDecisionBackend(empty, { [SYSTEM_ONE_OPEN_URL_ENV]: "https://from-env.test" })).toEqual({
      kind: "jev",
      systemOneOpenUrl: "https://from-env.test",
    });
  });

  it("lets the config file win over the environment, field by field", () => {
    const config = withBackend({ kind: "jev", systemOneOpenUrl: "https://from-file.test" });

    expect(
      resolveDecisionBackend(config, {
        [DECISION_BACKEND_ENV]: "system-one-open",
        [SYSTEM_ONE_OPEN_URL_ENV]: "https://from-env.test",
      }),
    ).toEqual({ kind: "jev", systemOneOpenUrl: "https://from-file.test" });
  });

  it("fills only the field the config file left out", () => {
    const config = withBackend({ kind: "system-one-open" });

    expect(
      resolveDecisionBackend(config, { [SYSTEM_ONE_OPEN_URL_ENV]: "https://from-env.test" }),
    ).toEqual({ kind: "system-one-open", systemOneOpenUrl: "https://from-env.test" });
  });

  it("ignores blank environment values", () => {
    expect(
      resolveDecisionBackend(empty, { [DECISION_BACKEND_ENV]: "  ", [SYSTEM_ONE_OPEN_URL_ENV]: "" }),
    ).toBeUndefined();
  });

  it("rejects an unknown MILO_DECISION_BACKEND value, naming the variable", () => {
    expect(() => resolveDecisionBackend(empty, { [DECISION_BACKEND_ENV]: "gpt-oracle" })).toThrow(
      /MILO_DECISION_BACKEND must be one of/,
    );
  });
});
