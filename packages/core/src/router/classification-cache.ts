/**
 * Short-TTL cache of a Jev classification result (ADR-023).
 *
 * `StickyCache` (`./sticky.ts`) pins a *whole decision* -- tier and model
 * included -- for the life of one conversation, so a tool loop never has its
 * model swapped out from under it. It only ever hits at the exact same
 * fingerprint *and* the exact same user-turn count, because a later turn is a
 * new ask that may be much harder or much easier (see `router.ts`'s header
 * comment).
 *
 * This cache is a different, complementary thing: it remembers only Jev's
 * *classification* (`RouteSignals`) for a caller's fingerprint, independent
 * of how many turns the conversation is now at, so a repeat or near-repeat
 * ask from the same caller skips the Jev round trip even when it is not a
 * sticky hit -- an eval harness re-sending the same fixed prompt, a client
 * retrying, or several fresh conversations that happen to open the same way.
 * Every hit still runs policy fresh against the reused signals (`decide()`
 * in `router.ts`), so a request-level knob that changed since -- candidates,
 * posture, roster, best-of-N -- is honoured exactly as it would be on a
 * genuine Jev answer; only the classification itself is reused. That is also
 * why its default TTL is short (five minutes, well under stickiness' thirty):
 * a stale *decision* pinned for a live conversation is a correctness bug, but
 * a stale *classification* replayed for a few minutes just costs the policy
 * an occasionally-outdated (never wrong-user, never wrong-conversation) guess
 * about a task's difficulty.
 *
 * Keying: the router passes the same NUL-joined `` `${fingerprint}\0${userTurns}` ``
 * string it already uses to key in-flight coalescing, so a hit here requires
 * the exact fingerprint (itself scoped to the caller by the gateway's
 * `callerScope`, ADR-008 -- never shared across two different keys) *and*
 * the exact user-turn count, matching the discipline stickiness already
 * established for "is this really the same ask" rather than inventing a
 * looser one.
 * Nothing about disabling or shortening `StickyCache`'s own TTL is required
 * for this cache to do useful work: it is a second, independently
 * configurable line of defence against a repeated Jev call, not a
 * replacement for the first.
 */

import type { RouteSignals } from "../types.js";

/** Hard bound on entries; the oldest are evicted first. */
export const CLASSIFICATION_CACHE_MAX_ENTRIES = 5_000;

/** Five minutes: long enough to catch a retry or a burst of repeats, short enough that a stale classification cannot linger. */
export const CLASSIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;

export type ClassificationCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  /** `false` turns the cache into a permanent miss without removing it from the wiring. Defaults to true. */
  enabled?: boolean;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
};

type Entry = { signals: RouteSignals; expiresAt: number };

export class ClassificationCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly enabled: boolean;
  private readonly clock: () => number;
  // A Map iterates in insertion order, which is the eviction order we want.
  private readonly entries = new Map<string, Entry>();

  constructor(opts: ClassificationCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? CLASSIFICATION_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? CLASSIFICATION_CACHE_MAX_ENTRIES;
    this.enabled = opts.enabled ?? true;
    this.clock = opts.clock ?? Date.now;
  }

  /** The live signals for a key, or undefined when disabled, absent, or expired. */
  get(key: string): RouteSignals | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.signals;
  }

  /** No-op when disabled, so a deployment can flip `enabled` without also clearing callers. */
  set(key: string, signals: RouteSignals): void {
    if (!this.enabled) return;
    // Delete first so a re-set moves the key to the back of the eviction queue.
    this.entries.delete(key);
    // Sweeping is O(n), so only do it when the bound is actually in the way.
    if (this.entries.size >= this.maxEntries) this.purgeExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { signals, expiresAt: this.clock() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
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
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
