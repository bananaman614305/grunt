import { describe, expect, it } from "vitest";
import type { RouteSignals } from "../types.js";
import { fingerprint } from "./fingerprint.js";
import {
  ClassificationCache,
  CLASSIFICATION_CACHE_MAX_ENTRIES,
  CLASSIFICATION_CACHE_TTL_MS,
} from "./classification-cache.js";

function signals(overrides: Partial<RouteSignals> = {}): RouteSignals {
  return {
    taskType: "debug",
    difficulty: 1.5,
    difficultyLevels: [0.1, 0.4, 0.4, 0.1],
    needsReasoning: 0.3,
    longOutput: 0.1,
    confidences: { task_type: 0.9, difficulty: 0.8 },
    jevRequestId: "req_1",
    jevModel: "jev-latest",
    latencyMs: 250,
    ...overrides,
  };
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("ClassificationCache", () => {
  it("returns undefined on a miss and the stored signals on a hit", () => {
    const cache = new ClassificationCache();
    expect(cache.get("key")).toBeUndefined();

    const s = signals();
    cache.set("key", s);

    expect(cache.get("key")).toEqual(s);
    expect(cache.size).toBe(1);
  });

  it("defaults to a short TTL and a bounded size, distinct from stickiness' 30-minute window", () => {
    const cache = new ClassificationCache();
    expect(cache.ttlMs).toBe(CLASSIFICATION_CACHE_TTL_MS);
    expect(CLASSIFICATION_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(cache.maxEntries).toBe(CLASSIFICATION_CACHE_MAX_ENTRIES);
    expect(CLASSIFICATION_CACHE_MAX_ENTRIES).toBe(5_000);
  });

  it("takes a TTL and a max-entries option", () => {
    const clock = fakeClock();
    const cache = new ClassificationCache({ ttlMs: 1_000, maxEntries: 2, clock: clock.now });
    expect(cache.ttlMs).toBe(1_000);
    expect(cache.maxEntries).toBe(2);
  });

  it("expires an entry once its TTL has passed", () => {
    const clock = fakeClock();
    const cache = new ClassificationCache({ ttlMs: 100, clock: clock.now });
    cache.set("key", signals());

    clock.advance(99);
    expect(cache.get("key")).toBeDefined();

    clock.advance(1);
    expect(cache.get("key")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry once the bound is reached (LRU by insertion/re-insertion order)", () => {
    const cache = new ClassificationCache({ maxEntries: 2 });
    cache.set("a", signals({ jevRequestId: "req_a" }));
    cache.set("b", signals({ jevRequestId: "req_b" }));
    cache.set("c", signals({ jevRequestId: "req_c" }));

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.jevRequestId).toBe("req_b");
    expect(cache.get("c")?.jevRequestId).toBe("req_c");
    expect(cache.size).toBe(2);
  });

  it("re-setting a key moves it to the back of the eviction queue", () => {
    const cache = new ClassificationCache({ maxEntries: 2 });
    cache.set("a", signals({ jevRequestId: "req_a" }));
    cache.set("b", signals({ jevRequestId: "req_b" }));
    // Touching "a" again should spare it from the next eviction.
    cache.set("a", signals({ jevRequestId: "req_a2" }));
    cache.set("c", signals({ jevRequestId: "req_c" }));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.jevRequestId).toBe("req_a2");
    expect(cache.get("c")?.jevRequestId).toBe("req_c");
  });

  it("disabled: get and set are permanent no-ops", () => {
    const cache = new ClassificationCache({ enabled: false });
    cache.set("key", signals());

    expect(cache.get("key")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("delete removes a live entry", () => {
    const cache = new ClassificationCache();
    cache.set("key", signals());
    cache.delete("key");
    expect(cache.get("key")).toBeUndefined();
  });

  it("clear drops every entry", () => {
    const cache = new ClassificationCache();
    cache.set("a", signals());
    cache.set("b", signals());
    cache.clear();
    expect(cache.size).toBe(0);
  });

  // Isolation: the router keys this cache on the request's own `fingerprint`,
  // which the gateway already scopes to the caller (`fingerprint(messages,
  // callerScope(c))`, ADR-008) -- the same trust boundary `StickyCache` and
  // in-flight coalescing already rely on. Two callers who happen to send the
  // identical conversation never collide, because their fingerprints never
  // collide: prove that with the real `fingerprint()` function rather than
  // asserting it in isolation.
  it("never serves one caller's classification to another, because their scoped fingerprints differ", () => {
    const cache = new ClassificationCache();
    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Summarize this document." },
    ];

    const fpUserA = fingerprint(messages, "key-hash-for-user-a");
    const fpUserB = fingerprint(messages, "key-hash-for-user-b");
    expect(fpUserA).not.toBe(fpUserB);

    cache.set(`${fpUserA}\0${1}`, signals({ jevRequestId: "req_a" }));

    // The identical conversation, from a different caller, is a miss.
    expect(cache.get(`${fpUserB}\0${1}`)).toBeUndefined();
    // The same caller's own key is still a hit.
    expect(cache.get(`${fpUserA}\0${1}`)?.jevRequestId).toBe("req_a");
  });
});
