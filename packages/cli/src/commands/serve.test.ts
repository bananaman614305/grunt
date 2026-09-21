import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_VERSION } from "@milo/core";
import type { Gateway, GatewayOptions } from "@milo/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "../config.js";
import type { ServeFn, ServeOptions } from "../deps.js";
import { createTestDeps } from "../test-support.js";
import { run } from "./serve.js";

function fakeGateway(): { createGateway: (options: GatewayOptions) => Promise<Gateway>; calls: GatewayOptions[] } {
  const calls: GatewayOptions[] = [];
  return {
    calls,
    createGateway: async (options: GatewayOptions) => {
      calls.push(options);
      return {
        app: { fetch: async () => new Response("ok") } as unknown as Gateway["app"],
        log: {} as Gateway["log"],
        close: async () => undefined,
      };
    },
  };
}

function fakeServe(): { serve: ServeFn; calls: ServeOptions[] } {
  const calls: ServeOptions[] = [];
  const serve: ServeFn = (options) => {
    calls.push(options);
    return { close: (cb) => cb?.() };
  };
  return { serve, calls };
}

describe("milo serve", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-serve-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("exits 1 and prints nothing to stdout when JEV_API_KEY is missing", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stdout, stderr } = createTestDeps({ env: {}, createGateway, serve });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("JEV_API_KEY");
    expect(stdout.toString()).toBe("");
  });

  it("never prints the JEV_API_KEY value, even on a successful start", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const secret = "sk-should-never-appear-in-cli-output";
    const { deps, stdout, stderr } = createTestDeps({ env: { JEV_API_KEY: secret }, createGateway, serve });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBeUndefined();
    expect(stdout.toString()).not.toContain(secret);
    expect(stderr.toString()).not.toContain(secret);
  });

  it("passes JEV_API_KEY through to createGateway", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "the-real-key" }, createGateway, serve });

    await run(["--db", ":memory:"], deps);

    expect(calls[0]?.jevApiKey).toBe("the-real-key");
  });

  it("prints a startup line containing the port and the OPENAI_BASE_URL hint", async () => {
    const { createGateway } = fakeGateway();
    const { serve, calls } = fakeServe();
    const { deps, stdout } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    const code = await run(["--port", "5555", "--db", ":memory:"], deps);

    expect(code).toBeUndefined();
    const output = stdout.toString();
    expect(output).toContain("5555");
    expect(output).toContain("OPENAI_BASE_URL=http://localhost:5555/v1");
    expect(output).toContain('model: "milo/auto"');
    expect(calls[0]?.port).toBe(5555);
  });

  it("prefers --port over the config file's port, and the file over the default", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ port: 9000 }));

    const flagFakes = fakeServe();
    const flagGateway = fakeGateway();
    await run(
      ["--config", configPath, "--port", "1234", "--db", ":memory:"],
      createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway: flagGateway.createGateway, serve: flagFakes.serve })
        .deps,
    );
    expect(flagFakes.calls[0]?.port).toBe(1234);

    const fileFakes = fakeServe();
    const fileGateway = fakeGateway();
    await run(
      ["--config", configPath, "--db", ":memory:"],
      createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway: fileGateway.createGateway, serve: fileFakes.serve })
        .deps,
    );
    expect(fileFakes.calls[0]?.port).toBe(9000);

    const defaultFakes = fakeServe();
    const defaultGateway = fakeGateway();
    // No --config: loadConfig looks for milo.config.json relative to
    // process.cwd(), which the repo does not keep, so this is the default.
    await run(
      ["--db", ":memory:"],
      createTestDeps({
        env: { JEV_API_KEY: "k" },
        createGateway: defaultGateway.createGateway,
        serve: defaultFakes.serve,
      }).deps,
    );
    expect(defaultFakes.calls[0]?.port).toBe(DEFAULT_PORT);
  });

  // -------------------------------------------------------------------------
  // Routing mode (ADR-012)
  // -------------------------------------------------------------------------

  it("passes the config's mode to createGateway, defaulting to roster", async () => {
    const defaults = fakeGateway();
    await run(
      ["--db", ":memory:"],
      createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway: defaults.createGateway, serve: fakeServe().serve })
        .deps,
    );
    expect(defaults.calls[0]?.mode).toBe("roster");

    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ mode: "deepseek" }));
    const configured = fakeGateway();
    const { deps, stdout } = createTestDeps({
      env: { JEV_API_KEY: "k" },
      createGateway: configured.createGateway,
      serve: fakeServe().serve,
    });
    await run(["--config", configPath, "--db", ":memory:"], deps);
    expect(configured.calls[0]?.mode).toBe("deepseek");
    expect(stdout.toString()).toContain("mode deepseek");
  });

  it("prefers MILO_MODE over the config file's mode, and rejects an unknown value", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ mode: "roster" }));

    const overridden = fakeGateway();
    await run(
      ["--config", configPath, "--db", ":memory:"],
      createTestDeps({
        env: { JEV_API_KEY: "k", MILO_MODE: "deepseek" },
        createGateway: overridden.createGateway,
        serve: fakeServe().serve,
      }).deps,
    );
    expect(overridden.calls[0]?.mode).toBe("deepseek");

    const invalid = fakeGateway();
    const { deps, stderr } = createTestDeps({
      env: { JEV_API_KEY: "k", MILO_MODE: "banana" },
      createGateway: invalid.createGateway,
      serve: fakeServe().serve,
    });
    const code = await run(["--db", ":memory:"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("MILO_MODE");
    expect(invalid.calls).toHaveLength(0);
  });

  it("prefers MILO_JEV_TRANSPORT over the config file, and rejects an unknown value (ADR-021)", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ jevTransport: "typesafe" }));

    const overridden = fakeGateway();
    await run(
      ["--config", configPath, "--db", ":memory:"],
      createTestDeps({
        env: { JEV_API_KEY: "k", MILO_JEV_TRANSPORT: "openrouter" },
        createGateway: overridden.createGateway,
        serve: fakeServe().serve,
      }).deps,
    );
    expect(overridden.calls[0]?.jevTransport).toBe("openrouter");

    const invalid = fakeGateway();
    const { deps, stderr } = createTestDeps({
      env: { JEV_API_KEY: "k", MILO_JEV_TRANSPORT: "banana" },
      createGateway: invalid.createGateway,
      serve: fakeServe().serve,
    });
    const code = await run(["--db", ":memory:"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("MILO_JEV_TRANSPORT");
    expect(invalid.calls).toHaveLength(0);
  });

  it("defaults jevTransport to typesafe when neither env nor config sets it", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });
    await run(["--db", ":memory:"], deps);
    expect(calls[0]?.jevTransport).toBe("typesafe");
  });

  it("starts WITHOUT JEV_API_KEY under the openrouter transport (ADR-022)", async () => {
    // Under openrouter, every Jev call bills to the caller's forwarded key, so
    // Milo's own key is unused and need not be set. The gateway starts anyway.
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({
      env: { MILO_JEV_TRANSPORT: "openrouter" },
      createGateway,
      serve,
    });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBeUndefined();
    expect(stderr.toString()).toBe("");
    expect(calls[0]?.jevTransport).toBe("openrouter");
    expect(calls[0]?.jevApiKey ?? "").toBe("");
  });

  it("still requires JEV_API_KEY under the typesafe transport (ADR-022)", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({
      env: { MILO_JEV_TRANSPORT: "typesafe" },
      createGateway,
      serve,
    });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("JEV_API_KEY");
    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // PORT / MILO_DB environment fallbacks
  // -------------------------------------------------------------------------

  it("falls back to the PORT environment variable when no --port is given", async () => {
    const { createGateway } = fakeGateway();
    const { serve, calls } = fakeServe();
    const { deps, stdout } = createTestDeps({ env: { JEV_API_KEY: "k", PORT: "6001" }, createGateway, serve });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBeUndefined();
    expect(calls[0]?.port).toBe(6001);
    expect(stdout.toString()).toContain("http://localhost:6001");
  });

  it("prefers --port over the PORT environment variable", async () => {
    const { createGateway } = fakeGateway();
    const { serve, calls } = fakeServe();
    const { deps } = createTestDeps({
      env: { JEV_API_KEY: "k", PORT: "6001" },
      createGateway,
      serve,
    });

    await run(["--port", "7002", "--db", ":memory:"], deps);

    expect(calls[0]?.port).toBe(7002);
  });

  it("prefers the PORT environment variable over the config file's port", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ port: 9000 }));
    const { createGateway } = fakeGateway();
    const { serve, calls } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k", PORT: "6001" }, createGateway, serve });

    await run(["--config", configPath, "--db", ":memory:"], deps);

    expect(calls[0]?.port).toBe(6001);
  });

  it("rejects a non-numeric PORT environment variable", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({
      env: { JEV_API_KEY: "k", PORT: "not-a-number" },
      createGateway,
      serve,
    });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("PORT");
  });

  it("ignores a blank PORT environment variable", async () => {
    const { createGateway } = fakeGateway();
    const { serve, calls } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k", PORT: "  " }, createGateway, serve });

    const code = await run(["--db", ":memory:"], deps);

    expect(code).toBeUndefined();
    expect(calls[0]?.port).toBe(DEFAULT_PORT);
  });

  it("falls back to the MILO_DB environment variable when no --db is given", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k", MILO_DB: ":memory:" }, createGateway, serve });

    const code = await run([], deps);

    expect(code).toBeUndefined();
    expect(calls[0]?.decisionLogUrl).toBe(":memory:");
  });

  it("prefers --db over the MILO_DB environment variable", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({
      env: { JEV_API_KEY: "k", MILO_DB: "file:./should-not-be-used.db" },
      createGateway,
      serve,
    });

    await run(["--db", ":memory:"], deps);

    expect(calls[0]?.decisionLogUrl).toBe(":memory:");
  });

  it("prefers the MILO_DB environment variable over the config file's decisionLog", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ decisionLog: "file:./from-file.db" }));
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k", MILO_DB: ":memory:" }, createGateway, serve });

    await run(["--config", configPath], deps);

    expect(calls[0]?.decisionLogUrl).toBe(":memory:");
  });

  it("creates the parent directory of an absolute MILO_DB file: path", async () => {
    const dataDir = join(dir, "data-subdir");
    const dbPath = join(dataDir, "decisions.db");
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({
      env: { JEV_API_KEY: "k", MILO_DB: `file:${dbPath}` },
      createGateway,
      serve,
    });

    const code = await run([], deps);

    expect(code).toBeUndefined();
    expect(calls[0]?.decisionLogUrl).toBe(`file:${dbPath}`);
    expect(statSync(dataDir).isDirectory()).toBe(true);
  });

  it("passes the decision log URL from --db through to createGateway", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    await run(["--db", ":memory:"], deps);

    expect(calls[0]?.decisionLogUrl).toBe(":memory:");
  });

  it("passes jevTimeoutMs from the config file through to createGateway", async () => {
    const configPath = join(dir, "milo.config.json");
    writeFileSync(configPath, JSON.stringify({ jevTimeoutMs: 500 }));
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    await run(["--config", configPath, "--db", ":memory:"], deps);

    expect(calls[0]?.jevTimeoutMs).toBe(500);
  });

  it("omits jevTimeoutMs from createGateway options when the config does not set it", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { deps } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    await run(["--db", ":memory:"], deps);

    expect(calls[0]).not.toHaveProperty("jevTimeoutMs");
  });

  it("rejects a non-numeric --port", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    const code = await run(["--port", "not-a-number", "--db", ":memory:"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--port");
  });

  it("reports a clear error when an explicit --config path does not exist", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    const code = await run(["--config", join(dir, "missing.json"), "--db", ":memory:"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("could not read");
  });

  it("prints help with --help and touches nothing else", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo serve");
  });

  it("names the policy version on the startup line, with no backend named", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stdout } = createTestDeps({ env: { JEV_API_KEY: "k" }, createGateway, serve });

    await run(["--db", ":memory:"], deps);

    expect(stdout.toString()).toContain(`(policy ${POLICY_VERSION}, mode roster)`);
    expect(stdout.toString()).not.toContain("decisions via");
  });
});
