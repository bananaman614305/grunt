/**
 * Token bucket over routed requests, keyed on a SHA-256 of the incoming
 * `Authorization` header value.
 *
 * Jev spend is Milo's, not the user's, so an open `milo/auto` endpoint is an
 * invitation (ADR-003). The bucket bounds it. The key is hashed because the
 * raw value is the user's OpenRouter key: hashing means the limiter's map,
 * and anything that ever dumps it, holds no key material.
 *
 * Exceeding the limit is not an error. The gateway degrades the request to
 * the `mid` tier and forwards it anyway; only the Jev call is skipped. So
 * `tryConsume` returns a boolean rather than throwing, and only routed
 * requests ever call it -- passthrough traffic costs Milo nothing.
 */

import { createHash } from "node:crypto";

export const DEFAULT_ROUTED_PER_MINUTE = 120;
/** Hard bound on tracked keys; the least recently seen are evicted first. */
export const DEFAULT_MAX_KEYS = 10_000;

const MINUTE_MS = 60_000;

/** The bucket key for an `Authorization` header value. Never reversible. */
export function hashKey(authorization: string): string {
  return createHash("sha256").update(authorization, "utf8").digest("hex");
}

export type RateLimiterOptions = {
  /** Bucket capacity and the per-minute refill rate. Default 120. */
  routedPerMinute?: number;
  maxKeys?: number;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
};

type Bucket = { tokens: number; updatedAt: number };

export class RateLimiter {
  /** Bucket capacity, which is also the sustained rate per minute. */
  readonly capacity: number;
  readonly maxKeys: number;
  private readonly clock: () => number;
  // A Map iterates in insertion order, and every touch re-inserts, so
  // iteration order is least-recently-used first: the eviction order.
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = Math.max(1, Math.floor(opts.routedPerMinute ?? DEFAULT_ROUTED_PER_MINUTE));
    this.maxKeys = Math.max(1, opts.maxKeys ?? DEFAULT_MAX_KEYS);
    this.clock = opts.clock ?? Date.now;
  }

  /** Spends one token for an `Authorization` value. False means over limit. */
  tryConsume(authorization: string): boolean {
    return this.tryConsumeHashed(hashKey(authorization));
  }

  /** As `tryConsume`, for a key that is already hashed. */
  tryConsumeHashed(key: string): boolean {
    const now = this.clock();
    const existing = this.buckets.get(key);

    if (existing === undefined) {
      this.evictIfFull(now);
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }

    const bucket: Bucket = { tokens: this.refilled(existing, now), updatedAt: now };
    // Re-insert so this key moves to the back of the eviction queue.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Tracked keys. Exposed for tests asserting the bound holds. */
  get size(): number {
    return this.buckets.size;
  }

  private refilled(bucket: Bucket, now: number): number {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    return Math.min(this.capacity, bucket.tokens + (elapsed * this.capacity) / MINUTE_MS);
  }

  /**
   * Makes room for one more key. Buckets that have refilled to capacity carry
   * no state worth keeping, so they go first; only if that is not enough does
   * the least recently used key get dropped (which forgives whatever it had
   * spent, the safe direction to be wrong in).
   */
  private evictIfFull(now: number): void {
    if (this.buckets.size < this.maxKeys) return;

    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.capacity) this.buckets.delete(key);
    }

    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) break;
      this.buckets.delete(oldest.value);
    }
  }
}
