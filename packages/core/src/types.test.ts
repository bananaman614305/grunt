import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER, ROUTER_LIMITS, TASK_TYPES, TIERS } from "./types.js";

describe("core contracts", () => {
  it("default roster covers every tier with at least one model", () => {
    for (const tier of TIERS) expect(DEFAULT_ROSTER[tier].length).toBeGreaterThan(0);
  });

  it("task types are unique", () => {
    expect(new Set(TASK_TYPES).size).toBe(TASK_TYPES.length);
  });

  it("the jev budget covers retries and stays inside a few seconds", () => {
    // It was 800 ms when a failure degraded to `mid` and cost the caller
    // nothing. With no fallback tier (ADR-002 revision 3) a failure is a 503,
    // so the budget has to leave room for the retries: one attempt plus three
    // backoffs of at most 200/400/800 ms. It is still short enough to sit in
    // front of a request a person is waiting on.
    expect(ROUTER_LIMITS.jevTimeoutMs).toBe(3_000);
    expect(ROUTER_LIMITS.jevTimeoutMs).toBeLessThanOrEqual(5_000);
    expect(ROUTER_LIMITS.jevRetries).toBe(3);
  });

  it("pins a decision for 30 minutes by default", () => {
    expect(ROUTER_LIMITS.stickyTtlMs).toBe(30 * 60 * 1000);
  });
});
