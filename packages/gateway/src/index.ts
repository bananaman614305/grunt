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
import { DecisionLog, DEFAULT_PRICING, DEFAULT_ROSTER, JevClient, OpenRouterClient, Router, StickyCache } from "@milo/core";
import type {
  DecisionRecord,
  JevClientOptions,
  OpenRouterClientOptions,
  RouteDecision,
  Roster,
  RouterOptions,
  StickyStore,
} from "@milo/core";
import type { BillingStore, PricingConfig } from "@milo/core";
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

export type GatewayOptions = {
  /**
   * Milo's own Jev key. Read from JEV_API_KEY by the CLI. Never logged.
   *
   * Required: Jev is the only decision backend. The type is non-optional, but
   * `GatewayOptions` is a pinned contract a JavaScript caller can ignore, so
   * an absent or empty key is also caught by a runtime check in
   * `createGateway` with a message that names the environment variable.
   */
  jevApiKey: string;
  /** Tier to model mapping. Defaults to DEFAULT_ROSTER from core. */
  roster?: Roster;
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
   * 60,000). The cells themselves are fixed in code for now (`policy.ts`).
   */
  sampling?: { enabled?: boolean; sampleTimeoutMs?: number };
  /** Routed requests allowed per minute per OpenRouter-key hash. Default 120. */
  rateLimit?: { routedPerMinute: number };
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

  if (options.jevApiKey === undefined || options.jevApiKey === "") {
    throw new Error(
      "milo gateway: Milo's own Jev key is required, because Jev is the only decision backend. " +
        "Set jevApiKey (JEV_API_KEY in the server environment).",
    );
  }

  const jevOptions: JevClientOptions = { apiKey: options.jevApiKey };
  if (options.jevBaseUrl !== undefined) jevOptions.baseUrl = options.jevBaseUrl;
  if (options.jevTimeoutMs !== undefined) jevOptions.timeoutMs = options.jevTimeoutMs;
  if (options.fetch !== undefined) jevOptions.fetch = options.fetch;
  // One client for the router's questions, the gateway's sample ranking
  // (ADR-010), and the preference-capture resolution call (ADR-011): same
  // key, same base URL, same injected fetch, one retry discipline.
  const jev = new JevClient(jevOptions);
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

  const routerOptions = {
    jev,
    roster,
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

  const openRouterOptions: OpenRouterClientOptions = {};
  if (options.openRouterBaseUrl !== undefined) openRouterOptions.baseUrl = options.openRouterBaseUrl;
  if (options.fetch !== undefined) openRouterOptions.fetch = options.fetch;
  if (options.referer !== undefined) openRouterOptions.referer = options.referer;
  if (options.title !== undefined) openRouterOptions.title = options.title;

  // The Anthropic dialect goes to the same OpenRouter deployment over its
  // `/messages` endpoint, so it takes the same base URL and the same fetch.
  const anthropicOptions: AnthropicUpstreamOptions = { ...openRouterOptions };

  const rateLimitOptions: RateLimiterOptions = {};
  if (options.rateLimit !== undefined) rateLimitOptions.routedPerMinute = options.rateLimit.routedPerMinute;

  const app = createApp({
    router,
    roster,
    jev,
    ...(options.sampling?.sampleTimeoutMs !== undefined
      ? { sampling: { sampleTimeoutMs: options.sampling.sampleTimeoutMs } }
      : {}),
    ...(billing !== undefined ? { billing } : {}),
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
