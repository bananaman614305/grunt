/**
 * Per-tenant guardrails: request/token rate limits, a rolling-window spend
 * cap, and sane request-shape bounds -- all keyed on the caller's key hash
 * (never the raw key, ADR-003), all off by default so an unconfigured
 * deployment behaves exactly as it did before this file existed.
 *
 * Why this exists, and why it is a second limiter rather than a bigger
 * `RateLimiter` (`rate-limit.ts`): that limiter bounds Milo's own Jev spend
 * on the routed path only (ADR-003) and its semantics are pinned by its own
 * tests. Since ADR-021/022, both Jev *and* inference bill to the caller's own
 * forwarded OpenRouter key on every surface, routed or not -- so a caller can
 * now hammer Milo's server or run up their own OpenRouter bill without ever
 * tripping the Jev-spend limiter. This file is the general-purpose answer:
 * requests/min and tokens/min over every metered surface, plus a spend cap
 * read from the decision log's own cost figures.
 *
 * Everything here mirrors the Squire `grant_app_access` shape on purpose
 * (`rate_limit_per_hour`, `spend_cap_usd`): limits are opt-in and unbounded
 * unless configured, a violation is revocable/retryable rather than a hard
 * failure, and the caller is always told where it stands.
 */

import type { DecisionLog } from "@milo/core";
import type { Context } from "hono";
import { RateLimiter } from "./rate-limit.js";

export type TenantLimitsConfig = {
  /** Requests allowed per minute per key hash, across every metered surface. Unset = unlimited. */
  requestsPerMinute?: number;
  /** Estimated request tokens allowed per minute per key hash. Unset = unlimited. */
  tokensPerMinute?: number;
  /** `Content-Length` ceiling in bytes. Unset = unlimited. */
  maxBodyBytes?: number;
  /** Ceiling on `messages`/`input` array length. Unset = unlimited. */
  maxMessages?: number;
  /** Ceiling on the request's estimated token count (see `estimateRequestTokens`). Unset = unlimited. */
  maxRequestTokens?: number;
  /** USD spend cap over the rolling window, from the decision log's own `costUsd`. Unset = unlimited. */
  spendCapUsd?: number;
  /** Rolling window for the spend cap, in hours. Default 24. */
  spendWindowHours?: number;
};

export const DEFAULT_SPEND_WINDOW_HOURS = 24;
/** How long a key's cached spend total is trusted before it is re-read from the log. */
export const DEFAULT_SPEND_CACHE_TTL_MS = 5_000;

export type RateStatus = {
  limit: number;
  remaining: number;
  /** 0 when `allowed`. */
  retryAfterMs: number;
  allowed: boolean;
};

export type SpendStatus = {
  capUsd: number;
  spendUsd: number;
  allowed: boolean;
};

/** What ran during one request's guard check, for the disclosure headers. */
export type TenantStatus = {
  requests?: RateStatus;
  tokens?: RateStatus;
  spend?: SpendStatus;
};

// ---------------------------------------------------------------------------
// Shape checks: pure, synchronous, no I/O
// ---------------------------------------------------------------------------

/** True when `Content-Length` names a size over `maxBytes`. A missing or non-numeric header never trips it (a body that lies about its length is caught by the parser, not here). */
export function bodyTooLarge(contentLength: string | null | undefined, maxBytes: number): boolean {
  if (contentLength === null || contentLength === undefined) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > maxBytes;
}

/** The length of `body.messages` (chat/messages dialects) or `body.input` (responses), else 0. */
export function messageCount(body: Record<string, unknown>): number {
  const messages = body["messages"];
  if (Array.isArray(messages)) return messages.length;
  const input = body["input"];
  if (Array.isArray(input)) return input.length;
  return 0;
}

/**
 * A cheap, dialect-agnostic token estimate: every string leaf in the parsed
 * body, divided by four (the same characters-per-token rule of thumb the
 * context-pruning estimate uses elsewhere in this codebase). It is not a
 * tokenizer -- it exists to bound abuse, not to bill -- so it counts every
 * string field (including e.g. `model`) rather than parsing each dialect's
 * message shape; the overcount from non-content fields is a few tokens
 * against a limit meant to catch requests orders of magnitude over it.
 */
export function estimateRequestTokens(body: unknown): number {
  return Math.ceil(sumStringLength(body, 0) / 4);
}

const MAX_WALK_DEPTH = 16;

function sumStringLength(value: unknown, depth: number): number {
  if (depth > MAX_WALK_DEPTH) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += sumStringLength(item, depth + 1);
    return total;
  }
  if (value !== null && typeof value === "object") {
    let total = 0;
    for (const item of Object.values(value)) total += sumStringLength(item, depth + 1);
    return total;
  }
  return 0;
}

export type ShapeViolation = { limit: "messages" | "tokens"; count: number; max: number };

/** The first shape limit a body violates, or undefined when it is within every configured bound. */
export function checkShape(
  body: Record<string, unknown>,
  limits: Pick<TenantLimitsConfig, "maxMessages" | "maxRequestTokens">,
): ShapeViolation | undefined {
  if (limits.maxMessages !== undefined) {
    const count = messageCount(body);
    if (count > limits.maxMessages) return { limit: "messages", count, max: limits.maxMessages };
  }
  if (limits.maxRequestTokens !== undefined) {
    const count = estimateRequestTokens(body);
    if (count > limits.maxRequestTokens) return { limit: "tokens", count, max: limits.maxRequestTokens };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TenantLimits: the stateful guard a gateway instance holds
// ---------------------------------------------------------------------------

type SpendCacheEntry = { spendUsd: number; fetchedAt: number };

export type TenantLimitsOptions = {
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
  /** How long a cached spend total is trusted. Default `DEFAULT_SPEND_CACHE_TTL_MS`. */
  spendCacheTtlMs?: number;
};

/**
 * Holds the token buckets and spend cache for one gateway instance. Every
 * limit is independently optional: a deployment can turn on only a spend
 * cap, only a request rate, all three, or (the default) none of them, and
 * whichever are off cost nothing per request -- `check*` returns `undefined`
 * rather than doing any work.
 */
export class TenantLimits {
  readonly config: Readonly<TenantLimitsConfig>;
  private readonly requestBucket?: RateLimiter;
  private readonly tokenBucket?: RateLimiter;
  private readonly spendWindowMs: number;
  private readonly spendCacheTtlMs: number;
  private readonly clock: () => number;
  private readonly spendCache = new Map<string, SpendCacheEntry>();

  constructor(config: TenantLimitsConfig, opts: TenantLimitsOptions = {}) {
    this.config = config;
    this.clock = opts.clock ?? Date.now;
    this.spendCacheTtlMs = opts.spendCacheTtlMs ?? DEFAULT_SPEND_CACHE_TTL_MS;
    if (config.requestsPerMinute !== undefined) {
      this.requestBucket = new RateLimiter({ routedPerMinute: config.requestsPerMinute, clock: this.clock });
    }
    if (config.tokensPerMinute !== undefined) {
      this.tokenBucket = new RateLimiter({ routedPerMinute: config.tokensPerMinute, clock: this.clock });
    }
    this.spendWindowMs = (config.spendWindowHours ?? DEFAULT_SPEND_WINDOW_HOURS) * 60 * 60 * 1000;
  }

  get spendCapEnabled(): boolean {
    return this.config.spendCapUsd !== undefined;
  }

  /** Spends one request from `keyHash`'s bucket. `undefined` when unconfigured. */
  checkRequestRate(keyHash: string): RateStatus | undefined {
    const limit = this.config.requestsPerMinute;
    if (this.requestBucket === undefined || limit === undefined) return undefined;
    const allowed = this.requestBucket.tryConsumeHashed(keyHash);
    return {
      limit,
      remaining: this.requestBucket.remainingHashed(keyHash),
      retryAfterMs: allowed ? 0 : this.requestBucket.retryAfterMsHashed(keyHash),
      allowed,
    };
  }

  /** Spends `tokens` from `keyHash`'s bucket. `undefined` when unconfigured. */
  checkTokenRate(keyHash: string, tokens: number): RateStatus | undefined {
    const limit = this.config.tokensPerMinute;
    if (this.tokenBucket === undefined || limit === undefined) return undefined;
    const allowed = this.tokenBucket.tryConsumeWeightedHashed(keyHash, tokens);
    return {
      limit,
      remaining: this.tokenBucket.remainingHashed(keyHash),
      retryAfterMs: allowed ? 0 : this.tokenBucket.retryAfterMsForWeightHashed(keyHash, tokens),
      allowed,
    };
  }

  /**
   * This key's spend against the cap, over the rolling window. The total is
   * cached per key for `spendCacheTtlMs`: a spend cap that ran the decision
   * log's aggregate query on every request would turn a database read into
   * the cost of routing, so a request inside the TTL reads the cached total
   * instead. That trades a bounded amount of cap overrun (at most the
   * window's worth of spend a key could place inside one TTL) for a check
   * that costs nothing most of the time -- the same trade a token bucket
   * makes by refilling continuously rather than checking a ledger. `undefined`
   * when no cap is configured, so an unconfigured deployment never queries
   * the log for this.
   */
  async checkSpend(log: DecisionLog, keyHash: string): Promise<SpendStatus | undefined> {
    const capUsd = this.config.spendCapUsd;
    if (capUsd === undefined) return undefined;

    const now = this.clock();
    const cached = this.spendCache.get(keyHash);
    let spendUsd: number;
    if (cached !== undefined && now - cached.fetchedAt < this.spendCacheTtlMs) {
      spendUsd = cached.spendUsd;
    } else {
      const sinceIso = new Date(now - this.spendWindowMs).toISOString();
      spendUsd = await log.spendSince(keyHash, sinceIso);
      this.spendCache.set(keyHash, { spendUsd, fetchedAt: now });
    }
    return { capUsd, spendUsd, allowed: spendUsd < capUsd };
  }

  /** Forgets a key's cached spend total, so the next check re-reads the log. Exposed for tests. */
  clearSpendCache(keyHash?: string): void {
    if (keyHash === undefined) this.spendCache.clear();
    else this.spendCache.delete(keyHash);
  }
}

// ---------------------------------------------------------------------------
// Per-request status, threaded through Hono's context
// ---------------------------------------------------------------------------

const TENANT_STATUS_CONTEXT_KEY = "miloTenantStatus";

/**
 * Records what the tenant-limits guard found for this request, so the
 * response-header middleware (`app.ts`) can disclose it once the route
 * handler has produced a response -- headers are written after `next()`
 * resolves, by which point the guard that ran inside the route already knows
 * more than the middleware that wraps it ever could on its own.
 */
export function setTenantStatus(c: Context, status: TenantStatus): void {
  c.set(TENANT_STATUS_CONTEXT_KEY, status);
}

/** The status `setTenantStatus` recorded for this request, if any ran. */
export function getTenantStatus(c: Context): TenantStatus | undefined {
  return c.get(TENANT_STATUS_CONTEXT_KEY) as TenantStatus | undefined;
}

// ---------------------------------------------------------------------------
// Header disclosure
// ---------------------------------------------------------------------------

/** `x-milo-ratelimit-*` / `x-milo-spend-*`, for whichever checks in `status` ran. */
export function applyTenantHeaders(headers: Headers, status: TenantStatus): void {
  if (status.requests !== undefined) {
    headers.set("x-milo-ratelimit-limit", String(status.requests.limit));
    headers.set("x-milo-ratelimit-remaining", String(status.requests.remaining));
    if (!status.requests.allowed) {
      headers.set("x-milo-ratelimit-reset", String(Math.max(1, Math.ceil(status.requests.retryAfterMs / 1000))));
    }
  }
  if (status.tokens !== undefined) {
    headers.set("x-milo-ratelimit-tokens-limit", String(status.tokens.limit));
    headers.set("x-milo-ratelimit-tokens-remaining", String(status.tokens.remaining));
    if (!status.tokens.allowed) {
      headers.set(
        "x-milo-ratelimit-tokens-reset",
        String(Math.max(1, Math.ceil(status.tokens.retryAfterMs / 1000))),
      );
    }
  }
  if (status.spend !== undefined) {
    headers.set("x-milo-spend-usd", status.spend.spendUsd.toFixed(6));
    headers.set("x-milo-spend-cap-usd", status.spend.capUsd.toFixed(6));
  }
}
