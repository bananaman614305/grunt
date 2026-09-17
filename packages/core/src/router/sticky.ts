/**
 * In-memory fingerprint to decision cache.
 *
 * One Jev call per conversation instead of one per turn, and, more importantly,
 * a stable model for the life of a sub-agent's task: switching models mid-task
 * breaks tool-call continuity and throws away the provider's prompt cache
 * (ADR-002).
 *
 * An entry is keyed by fingerprint but qualified by `userTurns`, the number of
 * user messages the decision was made for. A later request on the same
 * fingerprint with the *same* user-turn count is the same ask coming back --
 * a tool-result continuation, where the model must not change mid-tool-loop.
 * A request with *more* user turns is a new ask in an old conversation: the
 * user has said something else, and that something else may be much harder or
 * much easier than what was routed before. Reusing the pinned tier there was
 * the old behaviour and it silently mis-routed every follow-up turn for half
 * an hour. See `StickyStore` in `./sticky-store.ts`.
 *
 * This cache is process-local. A `StickyStore` behind it (the decision log
 * implements one) is what survives a redeploy or a second instance; the
 * router consults the store on a miss here and writes through on every set.
 */

import type { RouteDecision } from "../types.js";
import { ROUTER_LIMITS } from "../types.js";
import type { StickyEntry } from "./sticky-store.js";

/** Hard bound on entries; the oldest are evicted first. */
export const STICKY_MAX_ENTRIES = 10_000;

export type StickyCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
};

export class StickyCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly clock: () => number;
  // A Map iterates in insertion order, which is the eviction order we want.
  private readonly entries = new Map<string, StickyEntry>();

  constructor(opts: StickyCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? ROUTER_LIMITS.stickyTtlMs;
    this.maxEntries = opts.maxEntries ?? STICKY_MAX_ENTRIES;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Builds the entry a decision made at `userTurns` should be stored under,
   * with this cache's TTL applied. The router hands the same value to the
   * cache and to the store, so the two cannot disagree about when it expires.
   */
  entryFor(decision: RouteDecision, userTurns: number): StickyEntry {
    return { decision, userTurns, expiresAt: this.clock() + this.ttlMs };
  }

  /** The live entry for a fingerprint, or undefined if absent or expired. */
  get(fingerprint: string): StickyEntry | undefined {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(fingerprint);
      return undefined;
    }
    return entry;
  }

  /**
   * Pins an entry to a fingerprint until its own `expiresAt`. Re-setting
   * replaces the entry outright, which is how a new user turn takes over a
   * fingerprint from the decision that preceded it.
   */
  set(fingerprint: string, entry: StickyEntry): void {
    // Delete first so a re-set moves the key to the back of the eviction queue.
    this.entries.delete(fingerprint);
    // Sweeping is O(n), so only do it when the bound is actually in the way.
    if (this.entries.size >= this.maxEntries) this.purgeExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(fingerprint, entry);
  }

  delete(fingerprint: string): void {
    this.entries.delete(fingerprint);
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
