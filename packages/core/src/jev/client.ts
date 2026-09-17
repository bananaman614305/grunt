/**
 * HTTP client for the TypeSafe Jev API. Implements `JevClientLike` from
 * `./types.ts`. Never logs or embeds the API key in any error message or
 * property; callers inject `fetch` for testing (see `./fixtures.ts`).
 *
 * ## Retries
 *
 * Jev is the only decision backend and there is no fallback tier (ADR-002
 * revision 3), so a transient failure here becomes a 503 for the caller.
 * A retry is therefore worth spending real time on, and the client retries
 * network errors and the statuses that mean "not now": 429 (rate limited),
 * 503 (unavailable), and 529 (overloaded). Every other 4xx is a request the
 * server has judged and will judge the same way again, so it is never
 * retried.
 *
 * Backoff is exponential with **full jitter**: attempt *n* waits a uniform
 * random delay in `[0, base * factor^n)` rather than exactly `base *
 * factor^n`. When Jev sheds load, every client that was mid-request retries
 * at once; equal delays reproduce that thundering herd on every round,
 * whereas full jitter spreads the retries evenly across the window and is
 * what actually drains a queue (AWS, "Exponential Backoff and Jitter").
 *
 * A `Retry-After` header wins over the computed backoff whenever the server
 * sends one -- it is the server saying how long it needs -- in both its
 * forms, delay-seconds and an HTTP date.
 *
 * All of it runs inside one **total budget** the caller passes per call, not
 * a per-attempt timeout: the router's promise to return within
 * `jevTimeoutMs` covers the retries too. The client will not start an attempt
 * it cannot finish and will not sleep past the deadline; when the budget runs
 * out mid-backoff it gives up with the failure it already has.
 */

import { ROUTER_LIMITS } from "../types.js";
import type {
  JevClientLike,
  JevModelMetadata,
  SystemOneRequest,
  SystemOneResponse,
  SystemOneResult,
} from "./types.js";
import { JEV_BASE_URL, JEV_DEFAULT_MODEL } from "./types.js";

const REQUEST_ID_HEADER = "x-typesafe-request-id";

export type JevErrorKind = "timeout" | "network" | "http" | "validation";

/** Error thrown by `JevClient`. Never carries the API key. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  /**
   * How long the server asked the caller to wait, in ms, when it sent a
   * `Retry-After` header on the response that ended the call. The router
   * passes this on as the `RoutingUnavailableError`'s `retryAfterMs` so the
   * gateway can put a truthful `Retry-After` on its 429 or 503 instead of
   * inventing one.
   */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    kind: JevErrorKind,
    opts?: { status?: number; requestId?: string; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JevError";
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.requestId !== undefined) this.requestId = opts.requestId;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export type JevClientOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * Default total budget for one logical call, retries and backoff included.
   * A per-call `budgetMs` overrides it; the router always passes one.
   */
  timeoutMs?: number;
  /** Retries after the first attempt. Defaults to `ROUTER_LIMITS.jevRetries`. */
  retries?: number;
  /** First backoff window in ms; doubles per attempt. */
  retryBaseMs?: number;
  /** Backoff growth factor. */
  retryFactor?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. Used for the backoff jitter. */
  random?: () => number;
};

/** First backoff window, in ms. Attempt n waits within `[0, base * factor^n)`. */
export const RETRY_BASE_MS = 200;
/** How fast the backoff window grows per attempt. */
export const RETRY_FACTOR = 2;

/**
 * Statuses worth sending the same request again for: rate limited, and the
 * two "I am overloaded, come back" codes. Everything else in the 4xx range is
 * a verdict on the request itself and will not change on a retry.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 529 || (status >= 500 && status < 600);
}

/**
 * Reads a `Retry-After` header in either form the HTTP spec allows: a
 * delay in seconds, or an absolute HTTP date. Returns ms, or undefined when
 * the header is absent or unparseable. A date already in the past reads as 0,
 * not as a negative wait.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // delay-seconds: a non-negative integer.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // An HTTP-date always names a weekday and a month, so it always has
  // letters. Requiring one keeps `Date.parse` away from junk it would
  // otherwise accept -- "-5" parses as a year, which would read as a wait of
  // zero and retry a rate-limited request immediately.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Sentinel thrown internally to distinguish our own timeout from other aborts. */
class TimeoutAbort extends Error {}
/** Sentinel thrown internally when the caller-supplied signal aborted the request. */
class CallerAbort extends Error {}

export class JevClient implements JevClientLike {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly retryFactor: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) {
      throw new JevError("apiKey is required", "validation");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? ROUTER_LIMITS.jevTimeoutMs;
    this.retries = options.retries ?? ROUTER_LIMITS.jevRetries;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryFactor = options.retryFactor ?? RETRY_FACTOR;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal; budgetMs?: number },
  ): Promise<SystemOneResult> {
    const body: SystemOneRequest = {
      model: req.model ?? this.model,
      state: req.state,
      questions: req.questions,
    };
    const start = this.now();
    const { response, requestId } = await this.send(
      "POST",
      `${this.baseUrl}/v1/systemone`,
      JSON.stringify(body),
      opts?.signal,
      opts?.budgetMs,
    );
    const latencyMs = this.now() - start;
    const parsed = await this.readJson<SystemOneResponse>(response, requestId);
    assertSystemOneResponse(parsed, requestId);
    return { ...parsed, requestId, latencyMs };
  }

  async listModels(opts?: { budgetMs?: number }): Promise<JevModelMetadata[]> {
    const { response, requestId } = await this.send(
      "GET",
      `${this.baseUrl}/v1/models`,
      undefined,
      undefined,
      opts?.budgetMs,
    );
    const parsed = await this.readJson<unknown>(response, requestId);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { models?: unknown }).models)
    ) {
      throw new JevError("expected a { models: [...] } response", "validation", { requestId });
    }
    return (parsed as { models: JevModelMetadata[] }).models;
  }

  /**
   * Sends one logical request: up to `retries + 1` attempts, backing off
   * between them, all inside `budgetMs` (defaulting to the client's
   * `timeoutMs`). Returns the first successful response, or throws the
   * `JevError` for the failure that ended the budget.
   */
  private async send(
    method: string,
    url: string,
    body: string | undefined,
    callerSignal?: AbortSignal,
    budgetMs?: number,
  ): Promise<{ response: Response; requestId: string }> {
    const budget = budgetMs ?? this.timeoutMs;
    const deadline = this.now() + budget;

    let attempt = 0;
    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new JevError(`jev request exceeded its ${budget}ms budget`, "timeout");
      }

      let failure: JevError;
      let retryAfterMs: number | undefined;

      try {
        // Never let one attempt outlive the whole budget.
        const response = await this.attempt(method, url, body, callerSignal, remaining);
        const requestId = response.headers.get(REQUEST_ID_HEADER) ?? "";
        if (response.ok) {
          return { response, requestId };
        }

        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
        // Drain the body so the connection can be reused, and drop it: an
        // upstream error body is not ours to propagate (ADR-003).
        await safeText(response);
        failure = new JevError(`jev request failed with status ${response.status}`, "http", {
          status: response.status,
          requestId,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
        if (!isRetryableStatus(response.status)) throw failure;
      } catch (err) {
        if (err instanceof JevError) {
          // Either the non-retryable HTTP failure just thrown, or a
          // validation error from deeper in; neither is worth repeating.
          if (err.kind !== "http" || !isRetryableStatus(err.status ?? 0)) throw err;
          failure = err;
          retryAfterMs = err.retryAfterMs;
        } else if (err instanceof CallerAbort) {
          // The caller gave up; retrying would outlive the request that asked.
          throw new JevError("jev request aborted by caller", "network", { cause: err });
        } else if (err instanceof TimeoutAbort) {
          // The attempt ran out of budget, so there is none left to retry in.
          throw new JevError(`jev request timed out after ${budget}ms`, "timeout", { cause: err });
        } else {
          // Unclassified network failure (DNS, connection reset, etc).
          failure = new JevError("jev network request failed", "network", { cause: err });
        }
      }

      if (attempt >= this.retries) throw failure;

      const wait = this.backoffMs(attempt, retryAfterMs);
      // Only sleep if there is budget left on the other side of it for an
      // attempt; otherwise the wait just burns the deadline.
      if (this.now() + wait >= deadline) throw failure;
      await this.sleep(wait);
      attempt += 1;
    }
  }

  /**
   * How long to wait before attempt `attempt + 1`. A server-supplied
   * `Retry-After` wins outright; otherwise it is full jitter over the
   * exponential window, `random() * base * factor^attempt`.
   */
  private backoffMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return retryAfterMs;
    const window = this.retryBaseMs * Math.pow(this.retryFactor, attempt);
    return Math.floor(this.random() * window);
  }

  /** Performs one HTTP attempt within `attemptBudgetMs`, honoring a caller signal too. */
  private async attempt(
    method: string,
    url: string,
    body: string | undefined,
    callerSignal: AbortSignal | undefined,
    attemptBudgetMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptBudgetMs);
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    if (callerSignal?.aborted) {
      callerAborted = true;
      controller.abort();
    } else {
      callerSignal?.addEventListener("abort", onCallerAbort);
    }
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (isAbortError(err)) {
        // A caller signal made with AbortSignal.timeout carries a TimeoutError
        // reason; report that as a timeout, not as a generic abort.
        const reason = callerSignal?.reason as { name?: unknown } | undefined;
        if (callerAborted && reason !== undefined && reason !== null && reason.name === "TimeoutError") {
          throw new TimeoutAbort();
        }
        if (callerAborted) throw new CallerAbort();
        if (timedOut) throw new TimeoutAbort();
      }
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async readJson<T>(response: Response, requestId: string): Promise<T> {
    const text = await safeText(response);
    if (text === undefined || text.length === 0) {
      throw new JevError("jev response body was empty or unreadable", "validation", { requestId });
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new JevError("jev response was not valid JSON", "validation", {
        requestId,
        cause: err,
      });
    }
  }
}

function assertSystemOneResponse(value: unknown, requestId: string): asserts value is SystemOneResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { model?: unknown }).model !== "string" ||
    typeof (value as { answers?: unknown }).answers !== "object" ||
    (value as { answers?: unknown }).answers === null
  ) {
    throw new JevError("jev response did not match the systemone schema", "validation", { requestId });
  }
  const usage = (value as { usage?: unknown }).usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    typeof (usage as { input_tokens?: unknown }).input_tokens !== "number" ||
    typeof (usage as { output_tokens?: unknown }).output_tokens !== "number"
  ) {
    throw new JevError("jev response was missing usage token counts", "validation", { requestId });
  }
}
