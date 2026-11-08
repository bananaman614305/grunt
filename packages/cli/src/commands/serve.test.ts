import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapacitySnapshot } from "@milo/core";
import type { Gateway, GatewayOptions } from "@milo/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "../config.js";
import type { ServeFn, ServeOptions } from "../deps.js";
import { createTestDeps } from "../test-support.js";
import { run } from "./serve.js";

function fakeGateway(capacity: CapacitySnapshot[] = []): {
  createGateway: (options: GatewayOptions) => Promise<Gateway>;
  calls: GatewayOptions[];
  refreshed: number[];
} {
  const calls: GatewayOptions[] = [];
  const refreshed: number[] = [];
  return {
    calls,
    refreshed,
    createGateway: async (options: GatewayOptions) => {
      calls.push(options);
      const router = {
        available: ["codex", "claude"],
        capacity: () => capacity,
        refreshLimits: async (maxAgeMs?: number) => {
          refreshed.push(maxAgeMs ?? -1);
        },
      };
      return {
        app: { fetch: async () => new Response("ok") } as unknown as Gateway["app"],
        router: router as unknown as Gateway["router"],
        close: async () => {},
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
  let originalCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-serve-"));
    // An empty cwd so the default-config lookup never finds the repo's file.
    mkdirSync(join(dir, "cwd"));
    originalCwd = process.cwd();
    process.chdir(join(dir, "cwd"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("starts with no API key at all, on loopback, using the local heuristic", async () => {
    const gateway = fakeGateway();
    const server = fakeServe();
    const { deps, stdout } = createTestDeps({ createGateway: gateway.createGateway, serve: server.serve });

    const code = await run([], deps);

    expect(code).toBeUndefined();
    expect(server.calls[0]).toMatchObject({ port: DEFAULT_PORT, hostname: "127.0.0.1" });
    expect(gateway.calls[0]?.jevApiKey).toBeUndefined();
    expect(stdout.toString()).toContain("classifier: local heuristic");
    expect(stdout.toString()).toContain('OPENAI_BASE_URL=http://127.0.0.1:8787/v1 and use model: "milo/auto"');
  });

  it("uses Jev when JEV_API_KEY is set", async () => {
    const gateway = fakeGateway();
    const { deps, stdout } = createTestDeps({
      createGateway: gateway.createGateway,
      serve: fakeServe().serve,
      env: { JEV_API_KEY: "jev-test" },
    });

    await run([], deps);

    expect(gateway.calls[0]?.jevApiKey).toBe("jev-test");
    expect(stdout.toString()).toContain("classifier: jev");
  });

  it("reads plan limits before taking traffic and prints what each subscription has left", async () => {
    const gateway = fakeGateway([
      { backend: "codex", usedPercent: 2, remainingPercent: 98, window: "weekly", limited: false, source: "cli" },
      { backend: "claude", limited: false, source: "unknown" },
    ]);
    const { deps, stdout } = createTestDeps({ createGateway: gateway.createGateway, serve: fakeServe().serve });

    await run([], deps);

    expect(gateway.refreshed).toEqual([0]);
    expect(stdout.toString()).toContain("codex: 98% left (weekly)");
    expect(stdout.toString()).toContain("claude: capacity unknown");
  });

  it("passes the subscriptions config through to the gateway", async () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        subscriptions: {
          workdir: "/tmp/somewhere",
          reservePercent: 15,
          balanceMarginPercent: 40,
          timeoutMs: 1000,
          codex: { model: "gpt-5.5" },
          claude: { enabled: false },
        },
      }),
    );
    const gateway = fakeGateway();
    const { deps } = createTestDeps({ createGateway: gateway.createGateway, serve: fakeServe().serve });

    await run(["--config", path], deps);

    expect(gateway.calls[0]).toMatchObject({
      workdir: "/tmp/somewhere",
      timeoutMs: 1000,
      policy: { reservePercent: 15, balanceMarginPercent: 40 },
      backends: { codex: { enabled: true, model: "gpt-5.5" }, claude: { enabled: false } },
    });
  });

  it("flag beats PORT beats config for the port, and --host overrides the config hostname", async () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ port: 1111 }));
    const server = fakeServe();
    const { deps } = createTestDeps({ createGateway: fakeGateway().createGateway, serve: server.serve, env: { PORT: "2222" } });

    await run(["--config", path], deps);
    expect(server.calls[0]?.port).toBe(2222);

    await run(["--config", path, "--port", "3333", "--host", "0.0.0.0"], deps);
    expect(server.calls[1]).toMatchObject({ port: 3333, hostname: "0.0.0.0" });
  });

  it("warns when listening beyond loopback", async () => {
    const { deps, stderr } = createTestDeps({ createGateway: fakeGateway().createGateway, serve: fakeServe().serve });

    await run(["--host", "0.0.0.0"], deps);

    expect(stderr.toString()).toContain("anyone who can reach it can spend your subscriptions");
  });

  it("flag beats MILO_DB beats config for the decision log, and creates its directory", async () => {
    const gateway = fakeGateway();
    const dbPath = join(dir, "nested", "log", "decisions.db");
    const { deps } = createTestDeps({
      createGateway: gateway.createGateway,
      serve: fakeServe().serve,
      env: { MILO_DB: "file:/nowhere/env.db" },
    });

    await run(["--db", `file:${dbPath}`], deps);

    expect(gateway.calls[0]?.decisionLogUrl).toBe(`file:${dbPath}`);
    expect(statSync(join(dir, "nested", "log")).isDirectory()).toBe(true);
  });

  it("rejects a bad port and a bad PORT", async () => {
    const one = createTestDeps({ createGateway: fakeGateway().createGateway, serve: fakeServe().serve });
    expect(await run(["--port", "abc"], one.deps)).toBe(1);
    expect(one.stderr.toString()).toContain("--port must be a positive integer");

    const two = createTestDeps({ createGateway: fakeGateway().createGateway, serve: fakeServe().serve, env: { PORT: "-1" } });
    expect(await run([], two.deps)).toBe(1);
    expect(two.stderr.toString()).toContain("PORT must be a positive integer");
  });

  it("exits 1 with the gateway's message when it cannot start", async () => {
    const { deps, stderr } = createTestDeps({
      createGateway: async () => {
        throw new Error("No subscription backend is enabled.");
      },
      serve: fakeServe().serve,
    });

    expect(await run([], deps)).toBe(1);
    expect(stderr.toString()).toContain("No subscription backend is enabled.");
  });

  it("prints help", async () => {
    const { deps, stdout } = createTestDeps();
    expect(await run(["--help"], deps)).toBe(0);
    expect(stdout.toString()).toContain("Milo never reads your Claude or ChatGPT login");
  });
});
