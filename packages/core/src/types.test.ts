import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER, ROUTER_LIMITS, TASK_TYPES, TIERS } from "./types.js";

describe("core contracts", () => {
  it("default roster covers every tier with at least one model", () => {
    for (const tier of TIERS) expect(DEFAULT_ROSTER[tier].length).toBeGreaterThan(0);
  });
  it("task types are unique", () => {
    expect(new Set(TASK_TYPES).size).toBe(TASK_TYPES.length);
  });
  it("jev budget is under half a second", () => {
    expect(ROUTER_LIMITS.jevTimeoutMs).toBeLessThanOrEqual(500);
  });
});
