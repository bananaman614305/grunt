/**
 * A `JevClientLike` that tries one decision backend and falls back to
 * another, with a circuit breaker so a dead primary is not re-dialed on every
 * request (ADR-004).
 *
 * The rules, deliberately narrow:
 *
 * - Only a transport failure falls back: `JevError` of kind `http`,
 *   `network`, or `timeout`. A `validation` failure means a backend answered
 *   and the answer did not match the question; asking a different backend the
 *   same question would only hide a contract bug, so that rethrows.
 * - A caller abort is not a primary failure. It does not count toward the
 *   breaker and does not start a second attempt, because the caller has
 *   already stopped caring about the answer.
 * - After `breaker.failures` consecutive primary failures the primary is
 *   skipped entirely for `breaker.cooldownMs`. When the cooldown expires one
 *   request is let through as a probe; success closes the breaker, failure
 *   re-opens it for another cooldown.
 *
 * The `model` on the result is whatever the answering client reported, so a
 * decision log row already says which backend produced the signals.
 */

import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";

/** Failure kinds that are worth asking a different backend about. */
const FALLBACK_KINDS = new Set(["http", "network", "timeout"]);

export const DEFAULT_BREAKER_FAILURES = 3;
export const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;

/** The cause reported to `onFallback` when the breaker skipped the primary. */
export const BREAKER_OPEN_CAUSE = "breaker-open";

export type BreakerOptions = {
  /** Consecutive primary failures before the primary is skipped. Default 3. */
  failures?: number;
  /** How long the primary stays skipped. Default 60_000. */
  cooldownMs?: number;
};

export type FallbackInfo = {
  /** `http`, `network`, `timeout`, or `breaker-open`. Never upstream text. */
  cause: string;
  /** True when the secondary was asked. */
  usedSecondary: boolean;
  /** True when the breaker was open at the moment of the decision. */
  breakerOpen: boolean;
};

export type FallbackDecisionClientOptions = {
  primary: JevClientLike;
  secondary: JevClientLike;
  breaker?: BreakerOptions;
  /** Injectable for tests; defaults to `Date.now`. */
  clock?: () => number;
  /** Observability hook. Called before the secondary is asked. */
  onFallback?: (info: FallbackInfo) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns the failure class when a failure is worth falling back on, and
 * `undefined` when it is not. Mirrors `classifyFailure` in the router without
 * its "anything unknown is a network failure" default: an unrecognized error
 * here is a bug, not an outage, and must surface rather than silently double
 * the latency of every request.
 */
export function fallbackCause(error: unknown): string | undefined {
  const kind = isRecord(error) ? error["kind"] : undefined;
  if (typeof kind === "string" && FALLBACK_KINDS.has(kind)) return kind;

  const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  if (name === "TimeoutError") return "timeout";

  return undefined;
}

export class FallbackDecisionClient implements JevClientLike {
  private readonly primary: JevClientLike;
  private readonly secondary: JevClientLike;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly onFallback: ((info: FallbackInfo) => void) | undefined;

  /** Consecutive primary failures. Reset to 0 by any primary success. */
  private failures = 0;
  /** When the most recent primary failure happened. */
  private openedAt = 0;
  /** True while a half-open probe is in flight, so only one probe is sent. */
  private probing = false;

  constructor(options: FallbackDecisionClientOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.maxFailures = options.breaker?.failures ?? DEFAULT_BREAKER_FAILURES;
    this.cooldownMs = options.breaker?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
    this.onFallback = options.onFallback;
  }

  /** True while the primary is being skipped: tripped, and still in cooldown. */
  breakerOpen(): boolean {
    if (this.failures < this.maxFailures) return false;
    return this.clock() - this.openedAt < this.cooldownMs;
  }

  async systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<SystemOneResult> {
    // Tripped and still cooling down, or another request is already probing:
    // skip the primary entirely rather than spend its timeout again.
    if (this.breakerOpen() || (this.failures >= this.maxFailures && this.probing)) {
      this.onFallback?.({ cause: BREAKER_OPEN_CAUSE, usedSecondary: true, breakerOpen: true });
      return this.secondary.systemone(req, opts);
    }

    const halfOpen = this.failures >= this.maxFailures;
    if (halfOpen) this.probing = true;

    try {
      const result = await this.primary.systemone(req, opts);
      this.failures = 0;
      return result;
    } catch (error) {
      // The caller gave up. Not a primary fault, and a second attempt would
      // be spent on an answer nobody is waiting for.
      if (opts?.signal?.aborted === true) throw error;

      const cause = fallbackCause(error);
      if (cause === undefined) throw error;

      this.failures += 1;
      this.openedAt = this.clock();
      this.onFallback?.({ cause, usedSecondary: true, breakerOpen: this.breakerOpen() });
      return await this.secondary.systemone(req, opts);
    } finally {
      if (halfOpen) this.probing = false;
    }
  }
}
