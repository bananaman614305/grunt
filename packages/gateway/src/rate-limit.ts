/**
 * Token bucket over routed requests, keyed on a SHA-256 of the incoming
 * `Authorization` header value.
 *
 * Jev spend is Milo's, not the user's, so an open `milo/auto` endpoint is an
 * invitation (ADR-003). The bucket bounds it. The key is hashed because the
 * raw value is the user's OpenRouter key: hashing means the limiter's map,
 * and anything that ever dumps it, holds no key material.
 *
 * Exceeding the limit is a 429 in the client's own dialect: Milo has no
 * second decision backend to fall back to, so a routed request it cannot pay
 * to route is a refusal rather than a guess. `tryConsume` returns a boolean
 * rather than throwing, `retryAfterMs` says when the key may come back, and
 * only routed requests ever call either -- passthrough traffic costs Milo
 * nothing.
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
    return this.tryConsumeWeightedHashed(key, 1);
  }

  /**
   * As `tryConsumeHashed`, but spends `weight` tokens at once rather than
   * exactly one -- for a bucket whose unit is not "one request" (tokens/min,
   * say). `weight` over the bucket's whole capacity can never succeed, so it
   * is clamped so a single oversized request cannot wedge a key forever: it
   * still costs the bucket everything it has, but the caller gets a false
   * back eventually rather than a permanent refusal (the abuse-shape check
   * ahead of this one is what actually bounds a single request's size).
   */
  tryConsumeWeightedHashed(key: string, weight: number): boolean {
    const spend = Math.min(Math.max(0, weight), this.capacity);
    const now = this.clock();
    const existing = this.buckets.get(key);

    if (existing === undefined) {
      this.evictIfFull(now);
      if (spend > this.capacity) return false;
      this.buckets.set(key, { tokens: this.capacity - spend, updatedAt: now });
      return true;
    }

    const bucket: Bucket = { tokens: this.refilled(existing, now), updatedAt: now };
    // Re-insert so this key moves to the back of the eviction queue.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    if (bucket.tokens < spend) return false;
    bucket.tokens -= spend;
    return true;
  }

  /**
   * How long until this key's bucket holds a whole token again, in ms. 0 when
   * it already does (including for a key that has never been seen). Reading
   * it spends nothing, so a refused request can compute its own `Retry-After`.
   */
  retryAfterMs(authorization: string): number {
    return this.retryAfterMsHashed(hashKey(authorization));
  }

  /** As `retryAfterMs`, for a key that is already hashed. */
  retryAfterMsHashed(key: string): number {
    return this.retryAfterMsForWeightHashed(key, 1);
  }

  /** As `retryAfterMsHashed`, for the wait until `weight` tokens are free. */
  retryAfterMsForWeightHashed(key: string, weight: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return 0;
    const tokens = this.refilled(bucket, this.clock());
    if (tokens >= weight) return 0;
    // Tokens arrive at `capacity` a minute, so the wait for the missing
    // fraction is that fraction of a minute's worth of refill.
    return Math.ceil(((weight - tokens) * MINUTE_MS) / this.capacity);
  }

  /**
   * Tokens this key could spend right now, without spending any (a key never
   * seen reads as a full bucket). For disclosure headers only.
   */
  remainingHashed(key: string): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return this.capacity;
    return Math.floor(this.refilled(bucket, this.clock()));
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
