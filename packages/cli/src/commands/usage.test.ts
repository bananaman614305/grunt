import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gateway, GatewayOptions } from "@milo/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { formatUsage, run } from "./usage.js";
import type { UsageReport } from "./usage.js";

const REPORT: UsageReport = {
  object: "usage",
  subscriptions: [
    {
      backend: "codex",
      label: "ChatGPT (codex)",
      capacity: {
        backend: "codex",
        usedPercent: 2,
        remainingPercent: 98,
        window: "weekly",
        resetsAt: "2026-11-14T23:27:42.000Z",
        limited: false,
        source: "cli",
      },
      last24h: {
        backend: "codex",
        calls: 3,
        failures: 0,
        rateLimited: 0,
        inputTokens: 900,
        cachedInputTokens: 0,
        outputTokens: 40,
        apiEquivalentUsd: 0,
        latencyMsTotal: 9000,
      },
      last7d: null,
    },
    {
      backend: "claude",
      label: "Claude (claude)",
      capacity: { backend: "claude", limited: true, limitedUntil: "2026-11-09T00:00:00.000Z", source: "estimated" },
      last24h: null,
      last7d: null,
    },
  ],
};

describe("milo usage", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-usage-"));
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints used, left, reset and source per subscription, and unknown when there is no number", () => {
    const text = formatUsage(REPORT);
    const [header, codex, claude] = text.trimEnd().split("\n");
    expect(header).toMatch(/^subscription\s+used\s+left\s+window\s+resets\s+source\s+status/);
    expect(codex).toMatch(/ChatGPT \(codex\)\s+2%\s+98%\s+weekly\s+2026-11-14 23:27 UTC\s+cli\s+ok\s+3\s+0\s+900 \/ 40/);
    expect(claude).toMatch(/Claude \(claude\)\s+unknown\s+unknown\s+-\s+-\s+estimated\s+limited until 2026-11-09 00:00 UTC/);
  });

  it("builds the gateway locally, reads /v1/usage, and closes it", async () => {
    const options: GatewayOptions[] = [];
    let closed = false;
    const { deps, stdout } = createTestDeps({
      createGateway: async (o) => {
        options.push(o);
        return {
          app: { request: async () => Response.json(REPORT) } as unknown as Gateway["app"],
          router: {} as Gateway["router"],
          close: async () => {
            closed = true;
          },
        };
      },
    });

    expect(await run([], deps)).toBe(0);
    expect(options[0]?.decisionLogUrl).toBe("file:./.milo/decisions.db");
    expect(closed).toBe(true);
    expect(stdout.toString()).toContain("ChatGPT (codex)");
  });

  it("asks a running server with --url and prints JSON with --json", async () => {
    const urls: string[] = [];
    const { deps, stdout } = createTestDeps({
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json(REPORT);
      },
    });

    expect(await run(["--url", "http://127.0.0.1:9999", "--json"], deps)).toBe(0);
    expect(urls).toEqual(["http://127.0.0.1:9999/v1/usage"]);
    expect(JSON.parse(stdout.toString())).toEqual(REPORT);
  });
});
