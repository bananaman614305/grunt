/**
 * Gateway entry point. This contract is fixed so the CLI (task 2.2) can be
 * built in parallel with the gateway (task 2.1). The gateway task replaces
 * the body of `createGateway`; the signature and option names stay.
 */
import type { Hono } from "hono";
import {
  DecisionLog,
  DEFAULT_ROSTER,
  FallbackDecisionClient,
  JevClient,
  OpenRouterClient,
  ROUTER_LIMITS,
  Router,
  StickyCache,
  SystemOneOpenClient,
  SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS,
  SYSTEM_ONE_OPEN_DEMO_URL,
} from "@milo/core";
import type {
  DecisionRecord,
  JevClientLike,
  JevClientOptions,
  OpenRouterClientOptions,
  RouteDecision,
  Roster,
  SystemOneOpenClientOptions,
} from "@milo/core";
import { createApp } from "./app.js";
import type { Logger } from "./app.js";
import { errorMessage } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import type { RateLimiterOptions } from "./rate-limit.js";

/** The decision backends the router can be wired to (ADR-004). */
export const DECISION_BACKEND_KINDS = ["jev", "system-one-open", "jev-with-fallback"] as const;
export type DecisionBackendKind = (typeof DECISION_BACKEND_KINDS)[number];

export type DecisionBackendOptions = {
  kind: DecisionBackendKind;
  /** Base URL of a system-one-open deployment. Defaults to the public demo. */
  systemOneOpenUrl?: string;
  /** Per-call budget for the open backend in ms. Default 1500. */
  systemOneOpenTimeoutMs?: number;
};

export type GatewayOptions = {
  /**
   * Milo's own Jev key. Read from JEV_API_KEY by the CLI. Never logged.
   *
   * Required by the `jev` and `jev-with-fallback` decision backends and
   * unused by `system-one-open`. The type stays non-optional because
   * `GatewayOptions` is a pinned contract, so an absent key is caught by a
   * runtime check in `createGateway` instead (ADR-004).
   */
  jevApiKey: string;
  /** Which decision backend the router asks. Defaults to `{ kind: "jev" }`. */
  decisionBackend?: DecisionBackendOptions;
  /** Tier to model mapping. Defaults to DEFAULT_ROSTER from core. */
  roster?: Roster;
  /** libsql URL for the decision log: ":memory:" or "file:/path/milo.db". Default ":memory:". */
  decisionLogUrl?: string;
  /** Upstream base URLs, overridable for tests. */
  openRouterBaseUrl?: string;
  jevBaseUrl?: string;
  /** Jev budget in ms per routed request. Default ROUTER_LIMITS.jevTimeoutMs (800). */
  jevTimeoutMs?: number;
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

/**
 * Builds the decision client for the configured backend, along with the
 * router deadline it needs and the label `/healthz` reports.
 *
 * The deadline matters: the router enforces its own budget with a race, and
 * the open backend answers in roughly 850 ms warm, so leaving the Jev budget
 * of 800 ms in place would degrade every request. An explicit `jevTimeoutMs`
 * stays the *Jev client's* per-call budget; the router's deadline is derived
 * from the shape of the backend so a fallback chain has room for both hops.
 */
export function buildDecisionBackend(options: GatewayOptions): {
  client: JevClientLike;
  kind: DecisionBackendKind;
  routerTimeoutMs: number;
  warmup: (() => Promise<unknown>) | undefined;
} {
  const kind = options.decisionBackend?.kind ?? "jev";
  const jevTimeoutMs = options.jevTimeoutMs ?? ROUTER_LIMITS.jevTimeoutMs;

  const needsKey = kind === "jev" || kind === "jev-with-fallback";
  if (needsKey && (options.jevApiKey === undefined || options.jevApiKey === "")) {
    throw new Error(
      `milo gateway: the "${kind}" decision backend needs Milo's Jev key. ` +
        `Set jevApiKey (JEV_API_KEY), or use the "system-one-open" backend, which needs no key.`,
    );
  }

  const makeJev = (): JevClient => {
    const jevOptions: JevClientOptions = { apiKey: options.jevApiKey };
    if (options.jevBaseUrl !== undefined) jevOptions.baseUrl = options.jevBaseUrl;
    if (options.jevTimeoutMs !== undefined) jevOptions.timeoutMs = options.jevTimeoutMs;
    if (options.fetch !== undefined) jevOptions.fetch = options.fetch;
    return new JevClient(jevOptions);
  };

  const openTimeoutMs =
    options.decisionBackend?.systemOneOpenTimeoutMs ?? SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS;

  const makeOpen = (): SystemOneOpenClient => {
    const openOptions: SystemOneOpenClientOptions = {
      baseUrl: options.decisionBackend?.systemOneOpenUrl ?? SYSTEM_ONE_OPEN_DEMO_URL,
      timeoutMs: openTimeoutMs,
    };
    if (options.fetch !== undefined) openOptions.fetch = options.fetch;
    return new SystemOneOpenClient(openOptions);
  };

  // A little slack on top of the client's own budget so the client's timeout
  // fires first and classifies the failure, rather than the router's race.
  const SLACK_MS = 250;

  switch (kind) {
    case "jev":
      return { client: makeJev(), kind, routerTimeoutMs: jevTimeoutMs, warmup: undefined };

    case "system-one-open": {
      const open = makeOpen();
      return {
        client: open,
        kind,
        routerTimeoutMs: openTimeoutMs + SLACK_MS,
        warmup: () => open.warmup({ timeoutMs: 60_000 }),
      };
    }

    case "jev-with-fallback": {
      const open = makeOpen();
      return {
        client: new FallbackDecisionClient({ primary: makeJev(), secondary: open }),
        kind,
        // Both hops run in sequence, so the router must allow both.
        routerTimeoutMs: jevTimeoutMs + openTimeoutMs + SLACK_MS,
        warmup: () => open.warmup({ timeoutMs: 60_000 }),
      };
    }

    default: {
      const exhaustive: never = kind;
      throw new Error(`milo gateway: unknown decision backend "${String(exhaustive)}"`);
    }
  }
}

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const logger = options.logger ?? consoleLogger();
  const roster = options.roster ?? DEFAULT_ROSTER;
  const decision = buildDecisionBackend(options);
  const log = await DecisionLog.open(options.decisionLogUrl ?? ":memory:");
  const writes = new WriteQueue(logger);

  // Fire and forget: the public demo scales to zero and takes about 35 s to
  // wake, so the first routed request should not be the one that pays for it.
  // A failed warmup is not a startup failure -- the router degrades on its own.
  if (decision.warmup !== undefined) {
    void decision.warmup().then(
      () => logger.info("decision backend warm", { decisionBackend: decision.kind }),
      () => undefined,
    );
  }

  const router = new Router({
    jev: decision.client,
    jevTimeoutMs: decision.routerTimeoutMs,
    roster,
    sticky: new StickyCache(),
    // Every decision the router makes is logged, degraded ones included: a
    // decision that never reaches the log cannot explain a response header.
    onDecision: (decision_: RouteDecision) => writes.remember(decision_.id, log.insert(decision_)),
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
    decisionBackend: decision.kind,
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
