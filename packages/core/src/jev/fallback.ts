/**
 * Circuit breaker + opt-in TypeSafe fallback around the `"openrouter"` Jev
 * transport (ADR-021 / ADR-022).
 *
 * The OpenRouter Decisions endpoint (`/api/alpha/decisions`) is alpha and can
 * change or flake without notice. `JevTransportFallbackClient` wraps the
 * openrouter-transport `JevClient` (the "primary") with `CircuitBreaker`
 * (`../router/breaker.js`, reused unchanged -- it already implements exactly
 * the closed/open/half-open state machine this needs, including the
 * single-probe-at-a-time half-open gate) so a run of failures stops
 * hammering a broken endpoint and gives it room to recover.
 *
 * ## The fallback decision
 *
 * ADR-022 made Milo's own `JEV_API_KEY` optional under the `"openrouter"`
 * transport and mandatory that it is NEVER used for a user request. This
 * wrapper does not weaken that guarantee -- it strengthens the case for it,
 * because a fallback that quietly slipped Milo's key back in on every alpha
 * hiccup would defeat the point of ADR-022 entirely:
 *
 *   - The constructor takes an OPTIONAL `fallback` client. When it is
 *     `undefined` -- the default, and every deployment that has not
 *     explicitly opted in -- there is NO code path in this class that can
 *     reach TypeSafe, structurally: there is simply no reference to a
 *     typesafe client anywhere in the instance to call. `createGateway` only
 *     ever constructs and passes a `fallback` when BOTH
 *     `jevFallbackToTypesafe: true` was set AND `JEV_API_KEY` is configured
 *     (see `gateway/src/index.ts`); an operator who sets the flag without a
 *     key gets a logged warning and still gets no fallback, never a silent
 *     no-op that looks like one.
 *   - Even with a `fallback` configured, it is used ONLY while the breaker is
 *     OPEN. A single failure while the breaker is still closed (fewer than
 *     `failureThreshold` consecutive failures) never touches the fallback --
 *     it is reported exactly as it would be with no wrapper at all, so the
 *     existing fail-open behaviour (an auxiliary feature degrades; the
 *     router's classification call surfaces as `RoutingUnavailableError`,
 *     ADR-005's 503) handles it unchanged. Only once the breaker has
 *     actually tripped does later traffic redirect to the safety net.
 *   - The half-open probe always runs against the primary (openrouter)
 *     transport, never the fallback: the whole point of the probe is finding
 *     out whether openrouter itself has recovered.
 *
 * Without an opt-in fallback, an open breaker fails the call immediately with
 * a `JevError` -- fail-open per call, the same shape of failure the caller
 * already has to handle, just returned without paying the alpha endpoint's
 * timeout for it.
 */

import { JevError } from "./client.js";
import type { JevErrorKind } from "./client.js";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "./types.js";
import { CircuitBreaker } from "../router/breaker.js";
import type { BreakerState, BreakerStatus } from "../router/breaker.js";
import type { RoutingUnavailableCause } from "../router/errors.js";

/** Minimal structured logger, structurally identical to the gateway's `Logger`. */
export type JevBreakerLogger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

const noopLogger: JevBreakerLogger = { info() {}, warn() {}, error() {} };

/**
 * Which transport actually carried the most recently completed (or
 * currently in-flight) call -- what `x-milo-jev-transport` discloses.
 *
 * This is best-effort and process-wide, not a strict per-call guarantee:
 * `JevTransportFallbackClient` is one long-lived instance shared by every
 * concurrent request (exactly like the plain `JevClient` it replaces), so a
 * caller reading `currentTransport()` a while after its own call -- rather
 * than synchronously in the same tick the call resolved -- gets "what the
 * deployment is doing right now" under concurrent traffic, not a hard
 * attribution to that one call. That is the same disclosure contract
 * `RouteDecision.sticky` already has, and it is enough for its purpose:
 * telling an operator or a client whether the safety net is currently
 * active. State transitions are also logged (see `transition`) for anyone
 * who needs exact timing.
 */
export type JevTransportState = "openrouter" | "typesafe-fallback";

export type JevTransportFallbackOptions = {
  /** The `"openrouter"`-transport Jev client this wraps. */
  primary: JevClientLike;
  /**
   * The `"typesafe"`-transport Jev client to use while the breaker is open --
   * ONLY when the operator opted in (`jevFallbackToTypesafe: true`) and
   * configured `JEV_API_KEY`. Omit it, the default, and this class can never
   * call TypeSafe, however the primary fails.
   */
  fallback?: JevClientLike;
  /** Defaults to a fresh `CircuitBreaker()` (3 failures, 30s cooldown). */
  breaker?: CircuitBreaker;
  logger?: JevBreakerLogger;
};

/**
 * Maps a failure from the primary transport to the breaker's cause
 * vocabulary (`CircuitBreaker.recordFailure`'s `isTransportFailure` gate).
 * Network and timeout failures, and an HTTP failure with a 5xx status
 * (429/503/529 included), always count.
 *
 * A malformed response -- Jev's own `"validation"` kind, e.g. an unparsable
 * or schema-invalid body -- also counts here. That differs from the router's
 * general Jev breaker, where a validation failure usually means Milo sent
 * Jev a bad question and tripping the breaker over it would take routing
 * down over one bad prompt. Here the question is fixed and known-good (the
 * same router question set on either transport); a validation failure
 * surfacing from the alpha OpenRouter endpoint specifically is far more
 * likely to mean the endpoint itself returned garbage, which is exactly the
 * kind of alpha-endpoint instability this breaker exists to catch. It is
 * reported to the breaker as an HTTP 502 (bad gateway) failure, which is
 * functionally what it is; the real `JevErrorKind` is still what gets
 * logged, in `transition`'s `cause` field.
 */
function breakerCause(err: unknown): { cause: RoutingUnavailableCause; status: number | undefined } {
  if (err instanceof JevError) {
    if (err.kind === "network") return { cause: "network", status: undefined };
    if (err.kind === "timeout") return { cause: "timeout", status: undefined };
    if (err.kind === "http") return { cause: "http", status: err.status };
    return { cause: "http", status: 502 }; // "validation": malformed alpha-endpoint response.
  }
  // Anything else escaping the client is unexpected; count it conservatively.
  return { cause: "network", status: undefined };
}

function jevErrorKind(err: unknown): JevErrorKind | "unknown" {
  return err instanceof JevError ? err.kind : "unknown";
}

export class JevTransportFallbackClient implements JevClientLike {
  private readonly primary: JevClientLike;
  private readonly fallback: JevClientLike | undefined;
  private readonly breaker: CircuitBreaker;
  private readonly logger: JevBreakerLogger;
  private lastTransport: JevTransportState = "openrouter";

  constructor(opts: JevTransportFallbackOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.logger = opts.logger ?? noopLogger;
  }

  /** Whether an operator-configured fallback is wired in at all. */
  get fallbackConfigured(): boolean {
    return this.fallback !== undefined;
  }

  /** The breaker's current state, for a health endpoint or diagnostics. */
  breakerStatus(): BreakerStatus {
    return this.breaker.state();
  }

  /** Best-effort transport disclosure; see `JevTransportState`. */
  currentTransport(): JevTransportState {
    return this.lastTransport;
  }

  async systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal; budgetMs?: number; apiKey?: string },
  ): Promise<SystemOneResult> {
    // `tryAcquire` resolving `"open"` to `"half_open"` once the cooldown has
    // elapsed is a pure function of the clock, not a mutation, so there is
    // nothing to log here: two reads back to back (as `onSuccess`/`onFailure`
    // do below) never disagree unless real time passed between them, which a
    // single call never does. Every LOGGED transition below comes from an
    // actual mutation (`recordSuccess`/`recordFailure`).
    const acquire = this.breaker.tryAcquire();
    if (!acquire.allowed) {
      return this.viaOpenBreaker(req, opts, acquire.retryAfterMs);
    }

    try {
      const result = await this.primary.systemone(req, opts);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      // This one call's failure is reported as-is: fallback only ever
      // answers a call made while the breaker is ALREADY open (see
      // `viaOpenBreaker`), never the call that trips it or a half-open probe
      // that fails (which re-opens the breaker for the NEXT caller instead).
      this.lastTransport = "openrouter";
      throw err;
    }
  }

  private async viaOpenBreaker(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts: { signal?: AbortSignal; budgetMs?: number; apiKey?: string } | undefined,
    retryAfterMs: number,
  ): Promise<SystemOneResult> {
    if (this.fallback !== undefined) {
      this.logger.warn("jev openrouter transport breaker open; using typesafe fallback (operator opt-in)", {
        retryAfterMs,
      });
      this.lastTransport = "typesafe-fallback";
      // The typesafe client ignores a forwarded `opts.apiKey` and always
      // authenticates with its own configured JEV_API_KEY (ADR-021/022), so
      // passing `opts` through unchanged cannot leak the caller's OpenRouter
      // key to TypeSafe.
      return this.fallback.systemone(req, opts);
    }
    this.lastTransport = "openrouter";
    this.logger.warn("jev openrouter transport breaker open; no fallback configured, failing open", {
      retryAfterMs,
    });
    throw new JevError(`jev openrouter transport circuit is open; retry after ${retryAfterMs}ms`, "network", {
      retryAfterMs,
    });
  }

  private onSuccess(): void {
    const before = this.breaker.state().state;
    this.breaker.recordSuccess();
    const after = this.breaker.state().state;
    if (after !== before) this.transition(before, after, undefined);
  }

  private onFailure(err: unknown): void {
    const before = this.breaker.state().state;
    const { cause, status } = breakerCause(err);
    this.breaker.recordFailure(cause, status);
    const after = this.breaker.state().state;
    if (after !== before) this.transition(before, after, jevErrorKind(err));
  }

  /** Structured log line for every breaker state change on this transport. */
  private transition(from: BreakerState, to: BreakerState, jevErrKind: JevErrorKind | "unknown" | undefined): void {
    this.logger.warn("jev openrouter transport breaker state changed", {
      from,
      to,
      ...(jevErrKind !== undefined ? { cause: jevErrKind } : {}),
      fallbackConfigured: this.fallbackConfigured,
    });
  }
}
