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
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("StickyCache", () => {
  it("returns what was stored, with its user-turn count", () => {
    const cache = new StickyCache();
    cache.set("fp", cache.entryFor(decision("fp"), 2));

    const hit = cache.get("fp");
    expect(hit?.decision.model).toBe("anthropic/claude-sonnet-5");
    expect(hit?.userTurns).toBe(2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("defaults to the TTL and bound from the contracts", () => {
    const cache = new StickyCache();
    expect(cache.ttlMs).toBe(ROUTER_LIMITS.stickyTtlMs);
    expect(ROUTER_LIMITS.stickyTtlMs).toBe(30 * 60 * 1000);
    expect(cache.maxEntries).toBe(STICKY_MAX_ENTRIES);
    expect(STICKY_MAX_ENTRIES).toBe(10_000);
  });

  it("takes a TTL option, so the pin window can be tuned without a code change", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 90 * 60 * 1000, clock: clock.now });
    expect(cache.ttlMs).toBe(90 * 60 * 1000);
    expect(cache.entryFor(decision("fp"), 1).expiresAt).toBe(clock.now() + 90 * 60 * 1000);
  });

  it("entryFor stamps the expiry from the cache's own clock and TTL", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, clock: clock.now });
    expect(cache.entryFor(decision("fp"), 3)).toEqual({
      decision: decision("fp"),
      userTurns: 3,
      expiresAt: clock.now() + 100,
    });
  });

  it("expires an entry once the TTL has passed", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ clock: clock.now });
    cache.set("fp", cache.entryFor(decision("fp"), 1));

    clock.advance(ROUTER_LIMITS.stickyTtlMs - 1);
    expect(cache.get("fp")).toBeDefined();

    clock.advance(1);
    expect(cache.get("fp")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("honours an entry's own expiry, not the cache's TTL, when one is handed in", () => {
    // This is how a store fill works: the entry was stamped elsewhere and
    // must keep the expiry it was written with.
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 10_000, clock: clock.now });
    cache.set("fp", { decision: decision("fp"), userTurns: 1, expiresAt: clock.now() + 50 });

    clock.advance(50);
    expect(cache.get("fp")).toBeUndefined();
  });

  it("counts only live entries in size", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, clock: clock.now });
    cache.set("a", cache.entryFor(decision("a"), 1));
    clock.advance(60);
    cache.set("b", cache.entryFor(decision("b"), 1));
    expect(cache.size).toBe(2);

    clock.advance(50); // a is 110ms old, b is 50ms old
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("restarts the TTL when a fingerprint is re-set", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, clock: clock.now });
    cache.set("fp", cache.entryFor(decision("fp", "first"), 1));
    clock.advance(90);
    cache.set("fp", cache.entryFor(decision("fp", "second"), 2));
    clock.advance(90);

    const hit = cache.get("fp");
    expect(hit?.decision.model).toBe("second");
    expect(hit?.userTurns).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("evicts oldest first at the bound", () => {
    const cache = new StickyCache({ maxEntries: 3 });
    for (const fp of ["a", "b", "c"]) cache.set(fp, cache.entryFor(decision(fp), 1));
    expect(cache.size).toBe(3);

    cache.set("d", cache.entryFor(decision("d"), 1));
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
  });

  it("a re-set moves a fingerprint to the back of the eviction queue", () => {
    const cache = new StickyCache({ maxEntries: 3 });
    for (const fp of ["a", "b", "c"]) cache.set(fp, cache.entryFor(decision(fp), 1));
    cache.set("a", cache.entryFor(decision("a", "refreshed"), 1));

    cache.set("d", cache.entryFor(decision("d"), 1));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.decision.model).toBe("refreshed");
  });

  it("evicts expired entries before live ones at the bound", () => {
    const clock = fakeClock();
    const cache = new StickyCache({ ttlMs: 100, maxEntries: 2, clock: clock.now });
    cache.set("old", cache.entryFor(decision("old"), 1));
    clock.advance(150);
    cache.set("fresh", cache.entryFor(decision("fresh"), 1));
    cache.set("newest", cache.entryFor(decision("newest"), 1));

    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("fresh")).toBeDefined();
    expect(cache.get("newest")).toBeDefined();
  });

  it("stays at the bound over many writes", () => {
    const cache = new StickyCache({ maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) cache.set(`fp-${i}`, cache.entryFor(decision(`fp-${i}`), 1));

    expect(cache.size).toBe(50);
    expect(cache.get("fp-0")).toBeUndefined();
    expect(cache.get("fp-499")).toBeDefined();
  });

  it("deletes and clears", () => {
    const cache = new StickyCache();
    cache.set("fp", cache.entryFor(decision("fp"), 1));
    cache.delete("fp");
    expect(cache.get("fp")).toBeUndefined();

    cache.set("fp", cache.entryFor(decision("fp"), 1));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
