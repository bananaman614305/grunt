/**
 * Gateway entry point. This contract is fixed so the CLI (task 2.2) can be
 * built in parallel with the gateway (task 2.1). The gateway task replaces
 * the body of `createGateway`; the signature and option names stay.
 */
import type { Hono } from "hono";
import {
  DecisionLog,
  DEFAULT_ROSTER,
  JevClient,
  OpenRouterClient,
  Router,
  StickyCache,
} from "@milo/core";
import type { DecisionRecord, JevClientOptions, OpenRouterClientOptions, RouteDecision, Roster } from "@milo/core";
import { createApp } from "./app.js";
import type { Logger } from "./app.js";
import { errorMessage } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import type { RateLimiterOptions } from "./rate-limit.js";

export type GatewayOptions = {
  /** Milo's own Jev key. Read from JEV_API_KEY by the CLI. Never logged. */
  jevApiKey: string;
  /** Tier to model mapping. Defaults to DEFAULT_ROSTER from core. */
  roster?: Roster;
  /** libsql URL for the decision log: ":memory:" or "file:/path/milo.db". Default ":memory:". */
  decisionLogUrl?: string;
  /** Upstream base URLs, overridable for tests. */
  openRouterBaseUrl?: string;
  jevBaseUrl?: string;
  /** Routed requests allowed per minute per OpenRouter-key hash. Default 120. */
  rateLimit?: { routedPerMinute: number };
  /** OpenRouter app attribution headers. */
  referer?: string;
  title?: string;
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
  const log = await DecisionLog.open(options.decisionLogUrl ?? ":memory:");
  const writes = new WriteQueue(logger);

  const jevOptions: JevClientOptions = { apiKey: options.jevApiKey };
  if (options.jevBaseUrl !== undefined) jevOptions.baseUrl = options.jevBaseUrl;
  if (options.fetch !== undefined) jevOptions.fetch = options.fetch;

  const router = new Router({
    jev: new JevClient(jevOptions),
    roster,
    sticky: new StickyCache(),
    // Every decision the router makes is logged, degraded ones included: a
    // decision that never reaches the log cannot explain a response header.
    onDecision: (decision: RouteDecision) => writes.remember(decision.id, log.insert(decision)),
  });

  const openRouterOptions: OpenRouterClientOptions = {};
  if (options.openRouterBaseUrl !== undefined) openRouterOptions.baseUrl = options.openRouterBaseUrl;
  if (options.fetch !== undefined) openRouterOptions.fetch = options.fetch;
  if (options.referer !== undefined) openRouterOptions.referer = options.referer;
  if (options.title !== undefined) openRouterOptions.title = options.title;

  const rateLimitOptions: RateLimiterOptions = {};
  if (options.rateLimit !== undefined) rateLimitOptions.routedPerMinute = options.rateLimit.routedPerMinute;

  const app = createApp({
    router,
    openRouter: new OpenRouterClient(openRouterOptions),
    log,
    rateLimiter: new RateLimiter(rateLimitOptions),
    roster,
    logger,
    now: Date.now,
    insertDecision: (decision) => writes.track(log.insert(decision)),
    decisionSettled: (id) => writes.settled(id),
    recordUpstream: (id, upstream: NonNullable<DecisionRecord["upstream"]>) => {
      void writes.track(log.setUpstream(id, upstream));
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
 * Tracks decision-log writes that outlive the request that started them.
 *
 * Two problems it solves. A decision id goes out on a response header, so its
 * row has to exist before the response does -- `settled` is how a handler
 * waits for the write the router's `onDecision` hook started. And a streamed
 * response records its upstream outcome after the handler has returned, so
 * `drain` is how `close()` avoids shutting the database under it.
 *
 * A failed write is logged and swallowed. Losing an audit row is bad; failing
 * a user's completion because SQLite was busy is worse.
 */
class WriteQueue {
  private readonly pending = new Set<Promise<void>>();
  private readonly byDecision = new Map<string, Promise<void>>();

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

  remember(id: string, write: Promise<unknown>): void {
    const guarded = this.track(write);
    this.byDecision.set(id, guarded);
    void guarded.then(() => {
      this.byDecision.delete(id);
    });
  }

  /** Resolves once the write for `id` has landed, or immediately if it has. */
  settled(id: string): Promise<void> {
    return this.byDecision.get(id) ?? Promise.resolve();
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
