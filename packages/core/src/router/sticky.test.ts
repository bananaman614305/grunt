import { describe, expect, it } from "vitest";
import type { RouteDecision } from "../types.js";
import { POLICY_VERSION, ROUTER_LIMITS } from "../types.js";
import { StickyCache, STICKY_MAX_ENTRIES } from "./sticky.js";

function decision(fingerprint: string, model = "anthropic/claude-sonnet-5"): RouteDecision {
  return {
    id: `id-${fingerprint}`,
    fingerprint,
    tier: "mid",
    model,
    reason: "test",
    policyVersion: POLICY_VERSION,
    sticky: false,
    degraded: false,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("StickyCache", () => {
  it("returns what was stored", () => {
    const cache = new StickyCache();
    cache.set("fp", decision("fp"));
    expect(cache.get("fp")?.model).toBe("anthropic/claude-sonnet-5");
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("defaults to the TTL and bound from the contracts", () => {
    const cache = new StickyCache();
    expect(cache.ttlMs).toBe(ROUTER_LIMITS.stickyTtlMs);
    expect(cache.maxEntries).toBe(STICKY_MAX_ENTRIES);
    expect(STICKY_MAX_ENTRIES).toBe(10_000);
  });

  it("expires an entry once the TTL has passed", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ clock: clock.now });
    cache.set("fp", decision("fp"));

    clock.advance(ROUTER_LIMITS.stickyTtlMs - 1);
    expect(cache.get("fp")).toBeDefined();

    clock.advance(1);
    expect(cache.get("fp")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("counts only live entries in size", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, clock: clock.now });
    cache.set("a", decision("a"));
    clock.advance(60);
    cache.set("b", decision("b"));
    expect(cache.size).toBe(2);

    clock.advance(50); // a is 110ms old, b is 50ms old
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("restarts the TTL when a fingerprint is re-set", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, clock: clock.now });
    cache.set("fp", decision("fp", "first"));
    clock.advance(90);
    cache.set("fp", decision("fp", "second"));
    clock.advance(90);

    expect(cache.get("fp")?.model).toBe("second");
    expect(cache.size).toBe(1);
  });

  it("evicts oldest first at the bound", () => {
    const cache = new StickyCache({ maxEntries: 3 });
    cache.set("a", decision("a"));
    cache.set("b", decision("b"));
    cache.set("c", decision("c"));
    expect(cache.size).toBe(3);

    cache.set("d", decision("d"));
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
  });

  it("a re-set moves a fingerprint to the back of the eviction queue", () => {
    const cache = new StickyCache({ maxEntries: 3 });
    cache.set("a", decision("a"));
    cache.set("b", decision("b"));
    cache.set("c", decision("c"));
    cache.set("a", decision("a", "refreshed"));

    cache.set("d", decision("d"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.model).toBe("refreshed");
  });

  it("evicts expired entries before live ones at the bound", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, maxEntries: 2, clock: clock.now });
    cache.set("old", decision("old"));
    clock.advance(150);
    cache.set("fresh", decision("fresh"));
    cache.set("newest", decision("newest"));

    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("fresh")).toBeDefined();
    expect(cache.get("newest")).toBeDefined();
  });

  it("stays at the bound over many writes", () => {
    const cache = new StickyCache({ maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) cache.set(`fp-${i}`, decision(`fp-${i}`));

    expect(cache.size).toBe(50);
    expect(cache.get("fp-0")).toBeUndefined();
    expect(cache.get("fp-499")).toBeDefined();
  });

  it("clears", () => {
    const cache = new StickyCache();
    cache.set("fp", decision("fp"));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
