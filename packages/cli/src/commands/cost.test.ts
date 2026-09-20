import { DecisionLog } from "@milo/core";
import type { DecisionRecord } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { formatCost, run } from "./cost.js";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-1",
    fingerprint: "fp-1",
    tier: "mid",
    model: "anthropic/claude-sonnet-5",
    reason: "chose anthropic/claude-sonnet-5",
    policyVersion: "v1",
    sticky: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("milo cost", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("prints total, by-tier, by-model, average, and the sampling tax", async () => {
    await log.insert(record({ id: "a", tier: "fast", model: "anthropic/claude-haiku-4.5" }));
    await log.setUpstream("a", { status: 200, latencyMs: 100, costUsd: 0.0002 });
    await log.insert(record({ id: "b", tier: "frontier", model: "anthropic/claude-opus-4.8" }));
    await log.setUpstream("b", { status: 200, latencyMs: 900, costUsd: 0.02 });
    await log.insert(record({ id: "c", tier: "fast", model: "anthropic/claude-haiku-4.5", samples: 3 }));
    await log.setUpstream("c", { status: 200, latencyMs: 300, costUsd: 0.0009 });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("Total spend:      $0.021100");
    expect(out).toContain("Priced requests:  3");
    expect(out).toContain("Sampling tax:     $0.000600");
    expect(out).toContain("frontier");
    expect(out).toContain("$0.020000");
    expect(out).toContain("anthropic/claude-opus-4.8");
  });

  it("filters with --since", async () => {
    await log.insert(record({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await log.setUpstream("old", { status: 200, latencyMs: 100, costUsd: 0.5 });
    await log.insert(record({ id: "new", createdAt: "2026-09-17T00:00:00.000Z" }));
    await log.setUpstream("new", { status: 200, latencyMs: 100, costUsd: 0.001 });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    await run(["--since", "2026-06-01T00:00:00.000Z"], deps);

    const out = stdout.toString();
    expect(out).toContain("Total spend:      $0.001000");
    expect(out).not.toContain("$0.500000");
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
    expect(stdout.toString()).toContain("Usage: milo cost");
  });

  it("formatCost shows n/a and empty tables when nothing was priced", () => {
    const out = formatCost({ total: 0, byTier: {}, byModel: {}, avgPerRequest: null, samplingTax: 0, withCost: 0 });
    expect(out).toContain("Avg per request:  n/a");
    expect(out).toContain("(no priced requests)");
  });
});
