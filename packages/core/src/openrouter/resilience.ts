/**
 * Upstream rate-limit resilience for OpenRouter calls.
 *
 * OpenRouter (and the providers behind it) throttle under load: a busy
 * provider answers `429`, and a provider mid-incident answers `5xx`. Both are
 * transient and both are the wrong thing to hand a client that asked Milo to
 * route -- an empty or failed response where a short wait would have got a real
 * answer. This module holds the two pieces that make a throttled upstream a
 * retry rather than a failure, kept here in `core` so every call site (chat
 * completions, responses, the Anthropic surface, each best-of-N sample)
 * inherits the same behaviour from the one client it already goes through:
 *
 *   - `retryFetch` retries a fetch on `429` and `5xx` with exponential backoff
 *     and jitter, honouring a `Retry-After` header when the upstream sends one;
 *   - `ConcurrencyLimiter` bounds how many requests Milo has in flight for one
 *     upstream model at once, so a burst (the 500-run regeneration that drove
 *     DeepSeek to 429 in the first place) throttles itself in-process before it
 *     ever reaches the provider's limiter.
 *
 * Neither reads or transforms a response body: a retryable response is drained
 * and discarded, a returned response is handed back unread so a streamed body
 * still pipes straight through.
 */

/** Retry policy for {@link retryFetch}. All fields have safe defaults. */
export type RetryOptions = {
  /** Total attempts, including the first. `1` disables retrying. Default 4. */
  maxAttempts?: number;
  /** Base of the exponential backoff, in ms. Default 250. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff (and on a honoured `Retry-After`). Default 8000. */
  maxDelayMs?: number;
};

export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
};

/** Default per-model in-flight cap. Bounds burst without starving normal load. */
export const DEFAULT_MAX_CONCURRENT_PER_MODEL = 8;

/** Injectable clock/entropy, so tests need no real timers or randomness. */
export type ResilienceDeps = {
  /** Defaults to a real, abortable `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Defaults to `Math.random`. Returns a value in `[0, 1)`. */
  random?: () => number;
};

/** `429`, or any `5xx`: the upstream is throttled or briefly broken. */
export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Runs `fetchAttempt` and, on a retryable outcome, waits and runs it again up
 * to `maxAttempts` times. A retryable outcome is a `429`/`5xx` response or a
 * thrown network error; a non-retryable response (2xx, or a 4xx other than
 * 429) is returned immediately, and the last response is returned once the
 * attempts are spent so the caller still sees the real upstream status and
 * body. An abort -- the caller's `signal` firing, e.g. a sampling timeout --
 * is never retried: it propagates at once, and it interrupts a pending backoff.
 */
export async function retryFetch(
  fetchAttempt: () => Promise<Response>,
  opts: { retry?: RetryOptions; signal?: AbortSignal; deps?: ResilienceDeps } = {},
): Promise<Response> {
  const cfg = { ...DEFAULT_RETRY, ...opts.retry };
  const sleep = opts.deps?.sleep ?? defaultSleep;
  const random = opts.deps?.random ?? Math.random;
  const signal = opts.signal;
  const maxAttempts = Math.max(1, Math.floor(cfg.maxAttempts));

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetchAttempt();
    } catch (err) {
      // An abort is intentional and a spent budget is final; everything else
      // thrown here is a transient network failure worth another attempt.
      if (attempt >= maxAttempts || isAbortError(err, signal)) throw err;
      await sleep(backoffMs(attempt, cfg, random), signal);
      continue;
    }

    if (attempt >= maxAttempts || !isRetryableUpstreamStatus(response.status)) return response;

    // Free the socket before waiting: the body is discarded either way.
    await drain(response);
    const retryAfter = parseRetryAfter(response.headers, cfg.maxDelayMs);
    await sleep(retryAfter ?? backoffMs(attempt, cfg, random), signal);
  }
}

/**
 * A per-key semaphore. `run` acquires a slot for `key`, awaits the work, and
 * releases the slot to the next waiter -- so no more than `maxConcurrent`
 * calls for one key are ever in flight, and the rest queue rather than pile
 * onto the upstream. A non-positive or non-finite `maxConcurrent` means "no
 * limit": `run` then just calls the thunk.
 */
export class ConcurrencyLimiter {
  private readonly max: number;
  private readonly lanes = new Map<string, { active: number; waiters: Array<() => void> }>();

  constructor(maxConcurrent: number) {
    this.max = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : Infinity;
  }

  async run<T>(key: string | undefined, thunk: () => Promise<T>): Promise<T> {
    if (this.max === Infinity || key === undefined) return thunk();
    await this.acquire(key);
    try {
      return await thunk();
    } finally {
      this.release(key);
    }
  }

  /** Slots currently held for `key`. Exposed for tests asserting the cap. */
  activeFor(key: string): number {
    return this.lanes.get(key)?.active ?? 0;
  }

  private acquire(key: string): Promise<void> {
    const lane = this.lanes.get(key) ?? { active: 0, waiters: [] };
    this.lanes.set(key, lane);
    if (lane.active < this.max) {
      lane.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => lane.waiters.push(resolve));
  }

  private release(key: string): void {
    const lane = this.lanes.get(key);
    if (lane === undefined) return;
    const next = lane.waiters.shift();
    if (next !== undefined) {
      // Hand the slot straight to the next waiter: `active` stays put.
      next();
      return;
    }
    lane.active -= 1;
    if (lane.active <= 0) this.lanes.delete(key);
  }
}

/** Equal jitter: half the capped exponential, plus a random half. */
function backoffMs(attempt: number, cfg: Required<RetryOptions>, random: () => number): number {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * `Retry-After` as milliseconds, capped at `maxMs`, or `undefined` when the
 * header is absent or unparseable. Accepts both forms the spec allows: a
 * delta in whole seconds and an HTTP date. A non-positive value means "now".
 */
function parseRetryAfter(headers: Headers, maxMs: number): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  let ms: number;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - Date.now();
  }
  if (!(ms > 0)) return 0;
  return Math.min(ms, maxMs);
}

async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body already errored or consumed is nothing to clean up.
  }
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** The reason to reject/throw with when `signal` has fired. */
function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
