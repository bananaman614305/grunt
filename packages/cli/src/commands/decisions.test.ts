import { DecisionLog } from "@milo/core";
import type { DecisionRecord } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./decisions.js";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-1",
    fingerprint: "fp-1",
    tier: "mid",
    model: "anthropic/claude-sonnet-5",
    reason: "chose anthropic/claude-sonnet-5",
    policyVersion: "v1",
    sticky: false,
    degraded: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("milo decisions", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("prints a compact table of recent decisions", async () => {
    await log.insert(
      record({
        id: "dec-a",
        createdAt: "2026-09-17T00:00:00.000Z",
        tier: "fast",
        model: "anthropic/claude-haiku-4.5",
        signals: {
          taskType: "chat",
          difficulty: 0.4,
          needsReasoning: 0.1,
          longOutput: 0.0,
          confidences: {},
          jevRequestId: "r1",
          jevModel: "jev-latest",
          latencyMs: 40,
        },
      }),
    );
    await log.insert(
      record({
        id: "dec-b",
        createdAt: "2026-09-17T00:01:00.000Z",
        tier: "mid",
        sticky: true,
      }),
    );
    await log.insert(
      record({
        id: "dec-c",
        createdAt: "2026-09-17T00:02:00.000Z",
        tier: "mid",
        reason: "forced to the mid tier by the request",
      }),
    );

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain("ID");
    expect(output).toContain("TIER");
    expect(output).toContain("dec-a");
    expect(output).toContain("chat");
    expect(output).toContain("0.40");
    expect(output).toContain("dec-b");
    expect(output).toContain("sticky");
    expect(output).toContain("dec-c");
    // Newest first.
    expect(output.indexOf("dec-c")).toBeLessThan(output.indexOf("dec-b"));
    expect(output.indexOf("dec-b")).toBeLessThan(output.indexOf("dec-a"));
  });

  it("respects --limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await log.insert(record({ id: `dec-${i}`, createdAt: `2026-09-17T00:0${i}:00.000Z` }));
    }

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["--limit", "2"], deps);

    const lines = stdout.toString().trim().split("\n");
    // One header row plus two data rows.
    expect(lines).toHaveLength(3);
  });

  it("rejects a non-positive --limit", async () => {
    const { deps, stderr } = createTestDeps({ openLog: async () => log });
    const code = await run(["--limit", "0"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--limit");
  });

  it("prints a message when there are no decisions", async () => {
    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("no decisions logged");
  });

  it("prints help with --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo decisions");
  });
});
