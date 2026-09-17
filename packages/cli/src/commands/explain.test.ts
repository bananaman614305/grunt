import { DecisionLog, POLICY_VERSION } from "@milo/core";
import type { DecisionRecord } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./explain.js";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-1",
    fingerprint: "fp-1",
    tier: "mid",
    model: "anthropic/claude-sonnet-5",
    reason: "debug task, difficulty 1.40 with needs_reasoning 0.60 at or above 0.50 routes to mid; chose anthropic/claude-sonnet-5",
    policyVersion: POLICY_VERSION,
    sticky: false,
    degraded: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("milo explain", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("explains a routed decision in plain language", async () => {
    await log.insert(
      record({
        id: "dec-routed",
        signals: {
          taskType: "debug",
          difficulty: 1.4,
          difficultyLevels: [0.05, 0.55, 0.35, 0.05],
          needsReasoning: 0.6,
          longOutput: 0.1,
          confidences: { task_type: 0.9, difficulty: 0.75 },
          jevRequestId: "req-1",
          jevModel: "jev-latest",
          latencyMs: 88,
        },
      }),
    );

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run(["dec-routed"], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain("Decision dec-routed");
    expect(output).toContain("anthropic/claude-sonnet-5");
    expect(output).toContain("tier: mid");
    expect(output).toContain("Task type: debug");
    expect(output).toContain("Difficulty: 1.40");
    expect(output).toContain("confidence 75%");
    expect(output).toContain("Difficulty levels:");
    expect(output).toContain("1 routine");
    expect(output).toContain("2 substantial");
    expect(output).toContain("3 hard");
    // The level-2 mass policy v2 reads, rendered as a percentage next to its bar.
    expect(output).toMatch(/2 substantial\s+\[=+ *\] 35%/);
    expect(output).toContain("Needs reasoning: 60%");
    expect(output).toContain("Long output: 10%");
    expect(output).toContain("Sticky: no");
    expect(output).toContain("Degraded: no");
    expect(output).toContain("req-1");
    expect(output).toContain("88ms");
    expect(output).toContain("Upstream: not recorded");
  });

  it("prints upstream status, latency, tokens, and cost when recorded", async () => {
    await log.insert(
      record({
        id: "dec-upstream",
        upstream: { status: 200, latencyMs: 640, inputTokens: 512, outputTokens: 128, costUsd: 0.0031 },
      }),
    );

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["dec-upstream"], deps);

    expect(stdout.toString()).toContain("status 200, latency 640ms, tokens in/out 512/128, cost $0.0031");
  });

  it("says so when the backend reported no per-level distribution", async () => {
    await log.insert(
      record({
        id: "dec-no-levels",
        signals: {
          taskType: "debug",
          difficulty: 1.4,
          difficultyLevels: [],
          needsReasoning: 0.6,
          longOutput: 0.1,
          confidences: { task_type: 0.9, difficulty: 0.75 },
          jevRequestId: "req-2",
          jevModel: "jev-latest",
          latencyMs: 88,
        },
      }),
    );

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["dec-no-levels"], deps);

    expect(stdout.toString()).toContain("Difficulty levels: not reported by this decision backend");
  });

  it("explains a degraded decision without signals", async () => {
    await log.insert(
      record({
        id: "dec-degraded",
        degraded: true,
        reason: "routing signals unavailable (timeout), fell back to the mid tier",
      }),
    );

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run(["dec-degraded"], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain("Signals: unavailable");
    expect(output).toContain("Degraded: yes");
  });

  it("marks a sticky decision", async () => {
    await log.insert(record({ id: "dec-sticky", sticky: true }));

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["dec-sticky"], deps);

    expect(stdout.toString()).toContain("Sticky: yes");
  });

  it("prints the raw record as JSON with --json", async () => {
    await log.insert(record({ id: "dec-json" }));

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run(["dec-json", "--json"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.toString()) as DecisionRecord;
    expect(parsed.id).toBe("dec-json");
    expect(parsed.model).toBe("anthropic/claude-sonnet-5");
  });

  it("exits 1 with a clear message when the decision is not found", async () => {
    const { deps, stderr } = createTestDeps({ openLog: async () => log });
    const code = await run(["does-not-exist"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain('no decision found with id "does-not-exist"');
  });

  it("exits 1 when the decision id is missing", async () => {
    const { deps, stderr } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("missing <decision-id>");
  });

  it("prints help with --help and does not touch the log", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo explain");
  });
});
