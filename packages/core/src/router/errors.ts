/**
 * Thrown by the router when Jev cannot answer and the request must not be
 * routed by guesswork. The gateway turns this into a 503 in the client's
 * own error dialect. There is no fallback tier: an explicit model name on
 * the request still passes through to OpenRouter untouched, but
 * `milo/auto` without a Jev answer is an error. See ADR-005.
 */
export type RoutingUnavailableCause = "timeout" | "network" | "http" | "validation" | "breaker_open" | "rate_limited";

export class RoutingUnavailableError extends Error {
  override readonly name = "RoutingUnavailableError";
  readonly cause_: RoutingUnavailableCause;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  /** Hint for the client's Retry-After header, when known. */
  readonly retryAfterMs: number | undefined;

  constructor(
    cause: RoutingUnavailableCause,
    message: string,
    opts: { status?: number; requestId?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.cause_ = cause;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isRoutingUnavailable(err: unknown): err is RoutingUnavailableError {
  return err instanceof RoutingUnavailableError || (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "RoutingUnavailableError");
}
