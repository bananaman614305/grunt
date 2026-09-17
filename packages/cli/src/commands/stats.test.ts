import { DecisionLog } from "@milo/core";
import type { DecisionRecord } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./stats.js";

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

describe("milo stats", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("summarizes totals, tiers, models, degraded, sticky, and average Jev latency", async () => {
    await log.insert(
      record({
        id: "dec-a",
        tier: "fast",
        model: "anthropic/claude-haiku-4.5",
        signals: {
          taskType: "chat",
          difficulty: 0.2,
          needsReasoning: 0.1,
          longOutput: 0,
          confidences: {},
          jevRequestId: "r1",
          jevModel: "jev-latest",
          latencyMs: 50,
        },
      }),
    );
    await log.insert(
      record({
        id: "dec-b",
        tier: "mid",
        sticky: true,
        signals: {
          taskType: "feature",
          difficulty: 1.5,
          needsReasoning: 0.6,
          longOutput: 0.2,
          confidences: {},
          jevRequestId: "r2",
          jevModel: "jev-latest",
          latencyMs: 150,
        },
      }),
    );
    await log.insert(record({ id: "dec-c", tier: "mid", degraded: true }));

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain("Total decisions: 3");
    expect(output).toContain("fast: 1");
    expect(output).toContain("mid: 2");
    expect(output).toContain("anthropic/claude-haiku-4.5: 1");
    expect(output).toContain("anthropic/claude-sonnet-5: 2");
    expect(output).toContain("Degraded: 1");
    expect(output).toContain("Sticky: 1");
    expect(output).toContain("Average Jev latency: 100.0ms");
  });

  it("prints n/a for average Jev latency when no signals were recorded", async () => {
    await log.insert(record({ id: "dec-degraded", degraded: true }));

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run([], deps);

    expect(stdout.toString()).toContain("Average Jev latency: n/a");
  });

  it("filters with --since", async () => {
    await log.insert(record({ id: "dec-old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await log.insert(record({ id: "dec-new", createdAt: "2026-09-17T00:00:00.000Z" }));

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["--since", "2026-06-01T00:00:00.000Z"], deps);

    expect(stdout.toString()).toContain("Total decisions: 1");
  });

  it("rejects an invalid --since", async () => {
    const { deps, stderr } = createTestDeps({ openLog: async () => log });
    const code = await run(["--since", "not-a-date"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--since");
  });

  it("prints help with --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo stats");
  });
});
