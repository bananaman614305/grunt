import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTED_PER_MINUTE, RateLimiter, hashKey } from "./rate-limit.js";

const KEY = "Bearer sk-or-v1-rate-limit-test";

function at(times: { now: number }): () => number {
  return () => times.now;
}

describe("hashKey", () => {
  it("is the SHA-256 of the header value and never the value itself", () => {
    expect(hashKey(KEY)).toBe(createHash("sha256").update(KEY, "utf8").digest("hex"));
    expect(hashKey(KEY)).not.toContain("sk-or");
  });

  it("separates two keys", () => {
    expect(hashKey(KEY)).not.toBe(hashKey(`${KEY}-other`));
  });
});

describe("RateLimiter", () => {
  it("defaults to 120 routed requests a minute", () => {
    expect(new RateLimiter().capacity).toBe(DEFAULT_ROUTED_PER_MINUTE);
  });

  it("allows exactly `routedPerMinute` requests in a burst", () => {
    const limiter = new RateLimiter({ routedPerMinute: 3, clock: () => 0 });
    expect([limiter.tryConsume(KEY), limiter.tryConsume(KEY), limiter.tryConsume(KEY)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume(KEY)).toBe(false);
  });

  it("refills continuously rather than in steps", () => {
    const times = { now: 0 };
    const limiter = new RateLimiter({ routedPerMinute: 60, clock: at(times) });
    for (let i = 0; i < 60; i++) expect(limiter.tryConsume(KEY)).toBe(true);
    expect(limiter.tryConsume(KEY)).toBe(false);

    // 60 per minute is one per second, so half a second is half a token.
    times.now = 500;
    expect(limiter.tryConsume(KEY)).toBe(false);
    times.now = 1_000;
    expect(limiter.tryConsume(KEY)).toBe(true);
  });

  it("never refills past capacity", () => {
    const times = { now: 0 };
    const limiter = new RateLimiter({ routedPerMinute: 2, clock: at(times) });
    expect(limiter.tryConsume(KEY)).toBe(true);
    times.now = 60 * 60 * 1000;
    expect([limiter.tryConsume(KEY), limiter.tryConsume(KEY), limiter.tryConsume(KEY)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keys separately, so one noisy client does not limit another", () => {
    const limiter = new RateLimiter({ routedPerMinute: 1, clock: () => 0 });
    expect(limiter.tryConsume(KEY)).toBe(true);
    expect(limiter.tryConsume(KEY)).toBe(false);
    expect(limiter.tryConsume("Bearer sk-or-v1-someone-else")).toBe(true);
  });

  it("says how long a refused key must wait, and nothing for one that need not", () => {
    const times = { now: 0 };
    const limiter = new RateLimiter({ routedPerMinute: 2, clock: at(times) });

    // A key nobody has seen can spend right now.
    expect(limiter.retryAfterMs(KEY)).toBe(0);

    expect([limiter.tryConsume(KEY), limiter.tryConsume(KEY), limiter.tryConsume(KEY)]).toEqual([
      true,
      true,
      false,
    ]);
    // Two a minute is one every thirty seconds, and the bucket is empty.
    expect(limiter.retryAfterMs(KEY)).toBe(30_000);

    // Half a token in: half the wait left. (The answer is always rounded up,
    // so a client told to wait never comes back a millisecond too early.)
    times.now = 15_000;
    expect(limiter.retryAfterMs(KEY)).toBe(15_000);

    times.now = 30_000;
    expect(limiter.retryAfterMs(KEY)).toBe(0);
    expect(limiter.tryConsume(KEY)).toBe(true);
  });

  it("does not spend a token to answer the question", () => {
    const limiter = new RateLimiter({ routedPerMinute: 2, clock: () => 0 });
    expect(limiter.tryConsume(KEY)).toBe(true);

    for (let i = 0; i < 10; i++) limiter.retryAfterMs(KEY);

    // One token left, and reading the wait did not eat it.
    expect(limiter.tryConsume(KEY)).toBe(true);
    expect(limiter.tryConsume(KEY)).toBe(false);
  });

  it("holds the key bound under churn and keeps limiting the key still spending", () => {
    const limiter = new RateLimiter({ routedPerMinute: 1, maxKeys: 8, clock: () => 0 });
    expect(limiter.tryConsume(KEY)).toBe(true);

    for (let i = 0; i < 500; i++) {
      limiter.tryConsume(`Bearer key-${i}`);
      limiter.tryConsume(KEY);
    }

    expect(limiter.size).toBeLessThanOrEqual(8);
    // Eviction is least-recently-used, so the key still spending keeps its
    // empty bucket: churn from one-shot keys cannot reset a heavy caller.
    expect(limiter.tryConsume(KEY)).toBe(false);
  });
});
