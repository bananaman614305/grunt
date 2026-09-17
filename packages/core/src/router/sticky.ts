/**
 * In-memory fingerprint to decision cache.
 *
 * One Jev call per conversation instead of one per turn, and, more importantly,
 * a stable model for the life of a sub-agent's task: switching models mid-task
 * breaks tool-call continuity and throws away the provider's prompt cache
 * (ADR-002).
 *
 * Process-local on purpose. A hosted Milo with several instances will see a
 * conversation land on a cold instance and pay one extra Jev call; that costs
 * about $0.00002 and is cheaper than the shared store it would take to avoid.
 */

import type { RouteDecision } from "../types.js";
import { ROUTER_LIMITS } from "../types.js";

/** Hard bound on entries; the oldest are evicted first. */
export const STICKY_MAX_ENTRIES = 10_000;

export type StickyCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
};

type Entry = { decision: RouteDecision; expiresAt: number };

export class StickyCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly clock: () => number;
  // A Map iterates in insertion order, which is the eviction order we want.
  private readonly entries = new Map<string, Entry>();

  constructor(opts: StickyCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? ROUTER_LIMITS.stickyTtlMs;
    this.maxEntries = opts.maxEntries ?? STICKY_MAX_ENTRIES;
    this.clock = opts.clock ?? Date.now;
  }

  /** The live decision for a fingerprint, or undefined if absent or expired. */
  get(fingerprint: string): RouteDecision | undefined {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(fingerprint);
      return undefined;
    }
    return entry.decision;
  }

  /** Pins a decision to a fingerprint for `ttlMs`. Re-setting restarts the TTL. */
  set(fingerprint: string, decision: RouteDecision): void {
    // Delete first so a re-set moves the key to the back of the eviction queue.
    this.entries.delete(fingerprint);
    // Sweeping is O(n), so only do it when the bound is actually in the way.
    if (this.entries.size >= this.maxEntries) this.purgeExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(fingerprint, { decision, expiresAt: this.clock() + this.ttlMs });
  }

  /** Live entries, expired ones excluded. */
  get size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private purgeExpired(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      // Insertion order is not expiry order once a key is re-set, so scan all.
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
