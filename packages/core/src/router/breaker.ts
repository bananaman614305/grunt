/**
 * A circuit breaker around the Jev call.
 *
 * With no fallback tier (ADR-002 revision 3) a Jev outage turns every routed
 * request into a `RoutingUnavailableError`. Without a breaker each of those
 * requests first spends its whole `jevTimeoutMs` budget discovering the
 * outage for itself, so a dead backend costs every caller three seconds
 * before it costs them a 503, and the retry loop keeps hammering a service
 * that is already struggling. The breaker turns the second and later failures
 * into an immediate, cheap answer and gives the backend room to recover.
 *
 * Three states:
 *
 *   closed     normal. Consecutive transport failures are counted; the count
 *              resets on any success.
 *   open       `failureThreshold` consecutive failures were counted. Every
 *              call is refused immediately, with the remaining cooldown as
 *              `retryAfterMs`, until `cooldownMs` has passed.
 *   half_open  the cooldown has passed. Exactly one call is let through to
 *              probe the backend; everything else is still refused. The probe
 *              closes the breaker if it succeeds and re-opens it for a full
 *              cooldown if it fails.
 *
 * Only *transport* failures count: `network`, `timeout`, and `http` at 5xx
 * (529 included). A `validation` failure or a 4xx means Jev answered and Milo
 * did not like the answer -- that is a bug in the question or the request,
 * not an outage, and tripping the breaker on it would take routing down for
 * thirty seconds over a malformed prompt.
 */

import type { RoutingUnavailableCause } from "./errors.js";

/** Consecutive transport failures that open the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;
/** How long the breaker stays open before it half-opens to probe. */
export const BREAKER_COOLDOWN_MS = 30_000;

export type BreakerState = "closed" | "open" | "half_open";

/** What the breaker is doing right now. Shaped for a health endpoint. */
export type BreakerStatus = {
  state: BreakerState;
  /** Consecutive transport failures counted while closed. */
  failures: number;
  /** Epoch ms the breaker opened, when it is open or half-open. */
  openedAt?: number;
  /** Cooldown left before the next probe, 0 once half-open. */
  retryAfterMs?: number;
};

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
};

/**
 * True when a failure of this cause should count toward opening the breaker:
 * the backend could not be reached or did not answer, as opposed to answering
 * something Milo rejected.
 */
export function isTransportFailure(cause: RoutingUnavailableCause, status?: number): boolean {
  if (cause === "network" || cause === "timeout") return true;
  if (cause === "http") return status !== undefined && status >= 500;
  return false;
}

export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  private readonly clock: () => number;

  private failures = 0;
  private openedAt: number | undefined;
  /** Set while a half-open probe is in flight, so only one gets through. */
  private probing = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? BREAKER_COOLDOWN_MS;
    this.clock = opts.clock ?? Date.now;
  }

  /** The current state, resolving an expired cooldown to `half_open`. */
  state(): BreakerStatus {
    const state = this.resolveState();
    if (state === "closed") return { state, failures: this.failures };
    return {
      state,
      failures: this.failures,
      openedAt: this.openedAt as number,
      retryAfterMs: this.remainingCooldownMs(),
    };
  }

  /**
   * Whether a call may proceed, and if not, how long the caller should wait.
   * Claims the single half-open probe slot as a side effect, so two concurrent
   * callers cannot both probe.
   */
  tryAcquire(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const state = this.resolveState();
    if (state === "closed") return { allowed: true };
    if (state === "open") return { allowed: false, retryAfterMs: this.remainingCooldownMs() };
    // half_open: exactly one probe at a time.
    if (this.probing) return { allowed: false, retryAfterMs: this.cooldownMs };
    this.probing = true;
    return { allowed: true };
  }

  /** A Jev call answered. Closes the breaker and forgets the failure run. */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /**
   * A Jev call failed. Counts only transport failures; a half-open probe that
   * fails re-opens the breaker for a full cooldown however it failed to
   * connect, because the probe was the test and it did not pass.
   */
  recordFailure(cause: RoutingUnavailableCause, status?: number): void {
    const wasProbing = this.probing;
    this.probing = false;

    if (!isTransportFailure(cause, status)) {
      // Jev answered; the circuit is fine. A probe that reached the backend
      // proves exactly what the breaker wanted to know, so close it.
      if (wasProbing) this.recordSuccess();
      return;
    }

    if (wasProbing) {
      this.openedAt = this.clock();
      this.failures = this.failureThreshold;
      return;
    }

    this.failures += 1;
    if (this.failures >= this.failureThreshold && this.openedAt === undefined) {
      this.openedAt = this.clock();
    }
  }

  /** Forgets everything. For tests and for an operator-triggered reset. */
  reset(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  private resolveState(): BreakerState {
    if (this.openedAt === undefined) return "closed";
    return this.remainingCooldownMs() > 0 ? "open" : "half_open";
  }

  private remainingCooldownMs(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - this.clock());
  }
}
