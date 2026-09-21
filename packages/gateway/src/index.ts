/**
 * Gateway entry point. This contract is fixed so the CLI can be built against
 * it in parallel; option names only ever leave, never change meaning.
 *
 * Jev is the only decision backend (ADR-005). There is no open replica, no
 * fallback chain, and no mid-tier guess: `createGateway` builds one
 * `JevClient` from Milo's own key and hands it to the router, and a request
 * the router cannot decide fails loudly in the route that asked.
 */
import type { Hono } from "hono";
import { DecisionLog, DEFAULT_MAX_CONCURRENT_PER_MODEL, DEFAULT_PRICING, DEFAULT_RETRY, DEFAULT_ROSTER, JevClient, OPENROUTER_BASE_URL, OpenRouterClient, Router, StickyCache } from "@milo/core";
import type {
  DecisionRecord,
  JevClientOptions,
  JevTransport,
  OpenRouterClientOptions,
  RetryOptions,
  RouteDecision,
  Roster,
  RouterOptions,
  RoutingMode,
  StickyStore,
} from "@milo/core";
import type { BillingStore, Encryptor, PricingConfig } from "@milo/core";
import { DEFAULT_EMBED_MODEL } from "./embed.js";
import { decryptSecret as decryptBillingEnvelope, encryptSecret as encryptBillingEnvelope } from "@milo/billing";
import type { OpenRouterProvisioningClient } from "@milo/provisioning";
import type { StripeClient } from "@milo/stripe";
import { AnthropicUpstream } from "./anthropic.js";
import type { AnthropicUpstreamOptions } from "./anthropic.js";
import { createApp } from "./app.js";
import type { Logger } from "./app.js";
import type { BillingRuntime, UsageListing } from "./billing.js";
import { errorMessage } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import type { RateLimiterOptions } from "./rate-limit.js";
import { TenantLimits } from "./tenant-limits.js";
import type { TenantLimitsConfig } from "./tenant-limits.js";

export type GatewayOptions = {
  /**
   * Milo's own Jev key. Read from JEV_API_KEY by the CLI. Never logged.
   *
   * Required under the default `"typesafe"` transport: Jev is the only decision
   * backend, and every Jev call then runs on Milo's key. An absent or empty key
   * is caught by a runtime check in `createGateway` with a message that names
   * the environment variable.
   *
   * OPTIONAL under the `"openrouter"` transport (ADR-022): there every Jev call
   * -- classification and every auxiliary feature -- authenticates with the
   * caller's own forwarded OpenRouter key, so Milo's key is never used for a
   * user-facing call and need not be set.
   */
  jevApiKey?: string;
  /**
   * Which transport carries the router's Jev classification call (ADR-021).
   * `"typesafe"` (the default) calls `api.typesafe.ai/v1/systemone` with
   * Milo's own `jevApiKey`, unchanged. `"openrouter"` routes the
   * classification call through OpenRouter's Decisions endpoint
   * (`~typesafe/jev-latest`) on the caller's own forwarded OpenRouter key, so
   * Jev spend lands on the user's single key and a Milo-key outage cannot stop
   * routing. `jevApiKey` is still required in either mode: the gateway's
   * non-routing Jev uses -- best-of-N ranking (ADR-010) and preference capture
   * (ADR-011) -- keep running on Milo's key regardless of the transport.
   * Set from `milo.config.json`'s `jevTransport`, overridable with
   * `MILO_JEV_TRANSPORT`.
   */
  jevTransport?: JevTransport;
  /** Tier to model mapping. Defaults to DEFAULT_ROSTER from core. */
  roster?: Roster;
  /**
   * Routing mode (ADR-012). `"roster"` (the default) is the shipped policy
   * v4 over the roster, unchanged. `"deepseek"` routes every `milo/auto`
   * request through the measured compute controller instead: the same one
   * Jev call, but the difficulty band buys a budget over the DeepSeek
   * family (bands 0-1 one v4-flash call, band 2 best-of-5 on v4-flash,
   * band 3 best-of-5 on v4.1-flash). Per-key rosters (ADR-008) are ignored
   * in this mode. Set from `milo.config.json`'s `mode`, overridable with
   * `MILO_MODE`.
   */
  mode?: RoutingMode;
  /** libsql URL for the decision log: ":memory:" or "file:/path/milo.db". Default ":memory:". */
  decisionLogUrl?: string;
  /** Upstream base URLs, overridable for tests. */
  openRouterBaseUrl?: string;
  jevBaseUrl?: string;
  /** Jev budget in ms per routed request. Default ROUTER_LIMITS.jevTimeoutMs. */
  jevTimeoutMs?: number;
  /**
   * Best-of-N sampling (ADR-010). `enabled` (default true) lets policy v4's
   * sampled cells resolve; false and every cell keeps its single-model
   * outcome. `sampleTimeoutMs` caps each sample's wall clock (default
   * 60,000). `minRanked` (default 3) is how many ranked samples the fan-out
   * waits for before returning a clear winner early and aborting the rest.
   * The cells themselves are fixed in code for now (`policy.ts`).
   */
  sampling?: { enabled?: boolean; sampleTimeoutMs?: number; minRanked?: number };
  /**
   * Context pruning (ADR-014, ADR-013 phase C). Off by default: `enabled`
   * (default false) lets the gate run on every routed request over the token
   * floor; even off, a request opts in per call with `milo: { prune: true }`.
   * `minContextTokens` (default 40,000) is the floor a conversation must
   * exceed before pruning is considered; `contextWindowTokens` (default
   * 128,000) is the fill-ratio denominator for a model whose context window
   * is unknown. Set from `milo.config.json`'s `pruning`.
   */
  pruning?: { enabled?: boolean; minContextTokens?: number; contextWindowTokens?: number };
  /**
   * Two-stage fact retrieval (ADR-018). `enabled` (default true) turns on the
   * embedding pre-filter that narrows a caller's facts before the Jev
   * relevance gate; it only ever runs when fact memory is on (billing/an
   * encryption key present). `model` is the OpenAI-compatible embeddings model
   * (default `openai/text-embedding-3-small`); `baseUrl` is the embeddings
   * endpoint (default: the OpenRouter completions base URL). The caller's
   * forwarded key pays for the embedding, so no server-side embedding key is
   * needed. Set from `milo.config.json`'s `factRetrieval`.
   */
  factRetrieval?: { enabled?: boolean; model?: string; baseUrl?: string };
  /** Routed requests allowed per minute per OpenRouter-key hash. Default 120. */
  rateLimit?: { routedPerMinute: number };
  /**
   * Tenant guardrails: per-key request/token rate limits, a rolling-window
   * USD spend cap read from the decision log's own cost figures, and sane
   * request-shape bounds (message count, an estimated token ceiling, and a
   * `Content-Length` ceiling). Every field is independently optional and
   * unset (unlimited/off) by default, so an unconfigured deployment's
   * behaviour is unchanged: set only the fields a deployment wants bounded.
   * Set from `milo.config.json`'s `tenantLimits`.
   */
  tenantLimits?: TenantLimitsConfig;
  /**
   * Upstream rate-limit resilience for OpenRouter calls. `maxConcurrentPerModel`
   * bounds concurrent in-flight requests per upstream model so a burst cannot
   * self-inflict a 429 (default `DEFAULT_MAX_CONCURRENT_PER_MODEL`; a
   * non-positive value means no limit). `retry` retries a throttled or briefly
   * broken upstream (429/5xx) with exponential backoff and jitter, honouring a
   * `Retry-After` header (defaults from `DEFAULT_RETRY`). Set from
   * `milo.config.json`'s `upstream`.
   */
  upstream?: { maxConcurrentPerModel?: number; retry?: RetryOptions };
  /**
   * Persistence for sticky decisions, so a redeploy does not re-ask Jev for
   * every live conversation. Defaults to memory only.
   */
  stickyStore?: StickyStore;
  /** OpenRouter app attribution headers. */
  referer?: string;
  title?: string;
  /**
   * Milo-issued keys and prepaid credits (ADR-007). Omit it and the
   * deployment is bring-your-own-key only, exactly as before: an `mk_` bearer
   * is refused with 401 and nothing else about the gateway changes.
   */
  billing?: {
    /** Where accounts, keys, the ledger and usage live. */
    store: BillingStore & Partial<UsageListing>;
    /** Credit purchases and the customer portal. Without it, both 503. */
    stripe?: StripeClient;
    /** Mints the per-account OpenRouter sub-key and keeps its limit current. */
    provisioning?: OpenRouterProvisioningClient;
    /** Base64 of 32 bytes (`MILO_ENCRYPTION_KEY`); decrypts the sub-key. */
    encryptionKey: string;
    /** Margin, decision fee and reserve. Defaults to `DEFAULT_PRICING`. */
    pricing?: PricingConfig;
    /** Where a 402 tells the user to add credits. Defaults to `/account`. */
    accountUrl?: string;
  };
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Minimal logger; defaults to console with keys never included. */
  logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };
};

export type Gateway = {
  app: Hono;
  log: DecisionLog;
  close(): Promise<void>;
};

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const logger = options.logger ?? consoleLogger();
  const roster = options.roster ?? DEFAULT_ROSTER;

  const jevTransport: JevTransport = options.jevTransport ?? "typesafe";

  // `JEV_API_KEY` is Milo's own TypeSafe Jev key. It is required ONLY under the
  // default `"typesafe"` transport. Under `"openrouter"` (ADR-022) EVERY Jev
  // call this gateway makes -- the router's classification call AND every
  // auxiliary feature (best-of-N ranking, the completeness gate and its
  // ranking/verification, context pruning, personal-fact capture and
  // relevance, preference capture) -- authenticates per request with the
  // caller's own forwarded OpenRouter key, so Milo's key is never used for a
  // user-facing call and need not be set at all.
  if (jevTransport === "typesafe" && (options.jevApiKey === undefined || options.jevApiKey === "")) {
    throw new Error(
      'milo gateway: Milo\'s own Jev key is required under the "typesafe" transport, because Jev is the ' +
        "only decision backend. Set jevApiKey (JEV_API_KEY in the server environment), or select the " +
        '"openrouter" Jev transport, under which every Jev call bills to the caller\'s forwarded key (ADR-022).',
    );
  }

  // One transport-selected Jev client, used BOTH as the router's
  // classification client and (as `AppDeps.jev`) by every auxiliary Jev
  // feature. Under `"openrouter"` (ADR-021, ADR-022) it talks to OpenRouter's
  // Decisions endpoint, holds no configured key, and is authenticated per
  // request with the caller's forwarded OpenRouter key -- threaded as
  // `RouteRequest.jevKey` for the classification call and as each feature's
  // `jevKey` for the rest. Under the default `"typesafe"` transport it is
  // Milo's own key, exactly as before.
  const jevOptions: JevClientOptions =
    jevTransport === "openrouter"
      ? { apiKey: "", transport: "openrouter" }
      : { apiKey: options.jevApiKey ?? "" };
  if (options.jevBaseUrl !== undefined) jevOptions.baseUrl = options.jevBaseUrl;
  if (options.jevTimeoutMs !== undefined) jevOptions.timeoutMs = options.jevTimeoutMs;
  if (options.fetch !== undefined) jevOptions.fetch = options.fetch;
  const jev = new JevClient(jevOptions);
  const jevRouter = jev;
  const samplingEnabled = options.sampling?.enabled ?? true;

  // Normalised once: the pricing default lives here rather than at every
  // call site that reads a margin or a reserve.
  const billing: BillingRuntime | undefined =
    options.billing === undefined
      ? undefined
      : {
          store: options.billing.store,
          ...(options.billing.stripe !== undefined ? { stripe: options.billing.stripe } : {}),
          ...(options.billing.provisioning !== undefined ? { provisioning: options.billing.provisioning } : {}),
          encryptionKey: options.billing.encryptionKey,
          pricing: options.billing.pricing ?? DEFAULT_PRICING,
          ...(options.billing.accountUrl !== undefined ? { accountUrl: options.billing.accountUrl } : {}),
        };

  const log = await DecisionLog.open(options.decisionLogUrl ?? ":memory:");
  const writes = new WriteQueue(logger);

  // Personal-fact memory (ADR-017) rides the billing encryption envelope: the
  // fact text is sealed with the same AES-256-GCM key (MILO_ENCRYPTION_KEY)
  // that protects the account's OpenRouter sub-key. No key -> no envelope ->
  // the feature is disabled, exactly as documented.
  const factMemory: { encryptor: Encryptor } | undefined =
    billing === undefined
      ? undefined
      : {
          encryptor: {
            encrypt: (plain: string): string => encryptBillingEnvelope(plain, billing.encryptionKey),
            decrypt: (stored: string): string => decryptBillingEnvelope(stored, billing.encryptionKey),
          },
        };

  // Two-stage fact retrieval (ADR-018): the embedding pre-filter for the
  // relevance gate. Only meaningful when fact memory is on, and default-on
  // when it is -- the caller's forwarded key pays for the embedding, so it
  // adds no server-side key. `baseUrl` defaults to the completions endpoint,
  // `model` to a small, widely-hosted embeddings model; a failed embedding
  // falls open to the ADR-017 all-facts gate, so this can never break a call.
  const factRetrievalEnabled = options.factRetrieval?.enabled ?? true;
  const factRetrieval: { model: string; baseUrl: string; fetch?: typeof fetch } | undefined =
    factMemory === undefined || !factRetrievalEnabled
      ? undefined
      : {
          model: options.factRetrieval?.model ?? DEFAULT_EMBED_MODEL,
          baseUrl: options.factRetrieval?.baseUrl ?? options.openRouterBaseUrl ?? OPENROUTER_BASE_URL,
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        };

  const mode: RoutingMode = options.mode ?? "roster";

  const routerOptions = {
    jev: jevRouter,
    roster,
    mode,
    samplingEnabled,
    ...(options.jevTimeoutMs !== undefined ? { jevTimeoutMs: options.jevTimeoutMs } : {}),
    sticky: new StickyCache(),
    // `stickyStore` arrives in core's RouterOptions with the persistent sticky
    // store; the cast keeps this compiling on either side of that change.
    ...(options.stickyStore !== undefined ? { stickyStore: options.stickyStore } : {}),
    // Every decision the router makes is logged: a decision that never reaches
    // the log cannot explain a response header. The router awaits this itself,
    // so `route()` does not resolve until the row exists -- no separate wait is
    // needed before a response header goes out.
    onDecision: async (decision: RouteDecision) => {
      await log.insert(decision);
    },
    onError: (err: unknown) => {
      logger.error("decision log write failed", { error: errorMessage(err) });
    },
  } as RouterOptions;

  const router = new Router(routerOptions);

  const openRouterOptions: OpenRouterClientOptions = {
    // Resilience is on by default in a real deployment (the bare client is
    // still a single-attempt pass-through). A burst is bounded per upstream
    // model, and a throttled or briefly broken upstream is retried with
    // backoff before it becomes a failed response. Both are overridable.
    maxConcurrentPerModel: options.upstream?.maxConcurrentPerModel ?? DEFAULT_MAX_CONCURRENT_PER_MODEL,
    retry: options.upstream?.retry ?? DEFAULT_RETRY,
  };
  if (options.openRouterBaseUrl !== undefined) openRouterOptions.baseUrl = options.openRouterBaseUrl;
  if (options.fetch !== undefined) openRouterOptions.fetch = options.fetch;
  if (options.referer !== undefined) openRouterOptions.referer = options.referer;
  if (options.title !== undefined) openRouterOptions.title = options.title;

  // The Anthropic dialect goes to the same OpenRouter deployment over its
  // `/messages` endpoint, so it takes the same base URL and the same fetch.
  const anthropicOptions: AnthropicUpstreamOptions = { ...openRouterOptions };

  const rateLimitOptions: RateLimiterOptions = {};
  if (options.rateLimit !== undefined) rateLimitOptions.routedPerMinute = options.rateLimit.routedPerMinute;

  // Execution knobs for the fan-out only; `enabled` was consumed above by
  // the router and never reaches the executor.
  const samplingOptions = options.sampling;
  const samplingKnobs =
    samplingOptions !== undefined && (samplingOptions.sampleTimeoutMs !== undefined || samplingOptions.minRanked !== undefined)
      ? {
          ...(samplingOptions.sampleTimeoutMs !== undefined
            ? { sampleTimeoutMs: samplingOptions.sampleTimeoutMs }
            : {}),
          ...(samplingOptions.minRanked !== undefined ? { minRanked: samplingOptions.minRanked } : {}),
        }
      : undefined;

  // Tenant guardrails (request/token rate, spend cap, request-shape bounds):
  // absent entirely unless `options.tenantLimits` sets at least one field, so
  // an unconfigured deployment neither builds nor consults this at all.
  const tenantLimits = options.tenantLimits !== undefined ? new TenantLimits(options.tenantLimits) : undefined;

  const app = createApp({
    router,
    roster,
    mode,
    jev,
    ...(jevTransport === "openrouter" ? { forwardJevKey: true } : {}),
    ...(factMemory !== undefined ? { factMemory } : {}),
    ...(factRetrieval !== undefined ? { factRetrieval } : {}),
    ...(samplingKnobs !== undefined ? { sampling: samplingKnobs } : {}),
    ...(options.pruning !== undefined ? { pruning: options.pruning } : {}),
    ...(billing !== undefined ? { billing } : {}),
    ...(tenantLimits !== undefined ? { tenantLimits } : {}),
    openRouter: new OpenRouterClient(openRouterOptions),
    anthropic: new AnthropicUpstream(anthropicOptions),
    log,
    rateLimiter: new RateLimiter(rateLimitOptions),
    logger,
    now: Date.now,
    recordUpstream: (id, upstream: NonNullable<DecisionRecord["upstream"]>) => {
      void writes.track(log.setUpstream(id, upstream));
    },
    // A streamed response settles its charge after the handler has returned,
    // so the same queue that drains late decision-log writes drains these.
    track: (work: Promise<unknown>) => {
      void writes.track(work);
    },
  });

  return {
    app,
    log,
    close: async () => {
      // Drain first: an upstream outcome recorded after a streamed response
      // is still in flight when the process decides to shut down.
      await writes.drain();
      await log.close();
    },
  };
}

/**
 * Tracks decision-log writes that outlive the request that started them, so
 * `close()` can wait for them before shutting the database down: a streamed
 * response records its upstream outcome after the handler has already
 * returned. Decisions themselves are written by the router's own `onDecision`
 * hook, which the router awaits inline, so a decision needs no separate wait
 * here before a response header goes out.
 *
 * A failed write is logged and swallowed. Losing an audit row is bad; failing
 * a user's completion because SQLite was busy is worse.
 */
class WriteQueue {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  track(write: Promise<unknown>): Promise<void> {
    const guarded = write.then(
      () => undefined,
      (err: unknown) => {
        this.logger.error("decision log write failed", { error: errorMessage(err) });
      },
    );
    this.pending.add(guarded);
    void guarded.then(() => {
      this.pending.delete(guarded);
    });
    return guarded;
  }

  async drain(): Promise<void> {
    // A write can enqueue while we wait on the previous batch, so loop.
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}

/**
 * Default logger: one JSON object per line on stdout/stderr. It prints only
 * what a call site passes, and no call site passes a header or a key.
 */
function consoleLogger(): Logger {
  const emit =
    (level: "info" | "warn" | "error") =>
    (msg: string, meta?: Record<string, unknown>): void => {
      const line = JSON.stringify({ level, msg, ...meta });
      if (level === "error") console.error(line);
      else console.log(line);
    };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
