/**
 * The Hono app: auth, routes, and the small dependency bundle the route
 * modules share.
 *
 * `createApp` takes everything it needs as `AppDeps` and constructs nothing
 * itself, so a test can drive the whole surface with a stub router, a stub
 * OpenRouter client and an in-memory decision log without a server socket.
 * `createGateway` in `index.ts` is the only place that wires real objects.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { POLICY_VERSION } from "@milo/core";
import type { DecisionRecord, DecisionLog, OpenRouterClient, RouteDecision, Roster, Router } from "@milo/core";
import { errorResponse } from "./errors.js";
import type { RateLimiter } from "./rate-limit.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerDecisionsRoutes } from "./routes/decisions.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerProxyRoute } from "./routes/proxy.js";

/** Structurally identical to `GatewayOptions["logger"]`, which is pinned. */
export type Logger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

export type AppDeps = {
  router: Router;
  openRouter: OpenRouterClient;
  log: DecisionLog;
  rateLimiter: RateLimiter;
  roster: Roster;
  logger: Logger;
  /** Injectable clock for upstream latency. */
  now: () => number;
  /**
   * Writes a decision the gateway minted itself (rate limited, or the router
   * throwing), awaited before the response goes out. Decisions the router
   * produced are written by its own `onDecision` hook instead, which the
   * router awaits internally -- by the time `route()` resolves, that row
   * already exists.
   */
  insertDecision(decision: RouteDecision): Promise<void>;
  /** Fire and forget, but tracked so `close()` can drain it. */
  recordUpstream(id: string, upstream: NonNullable<DecisionRecord["upstream"]>): void;
};

/** The raw `Authorization` header. Valid by the time any route runs. */
export function authorization(c: Context): string {
  return c.req.header("authorization") ?? "";
}

/**
 * The upstream headers worth handing to the client: the content type (so an
 * SSE stream still reads as one) and OpenRouter's request id (so a user can
 * quote it in a support thread). Everything else -- lengths and encodings
 * that may no longer hold, cookies, CORS -- is dropped by omission.
 */
export function passThroughHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const requestId = upstream.headers.get("x-request-id");
  if (requestId !== null) headers.set("x-request-id", requestId);
  return headers;
}

/**
 * Every `/v1/*` request carries the user's OpenRouter key. The gateway only
 * checks that one is present and bearer-shaped -- validating it is
 * OpenRouter's job, and Milo has no way to do it without spending a call.
 * The value is read here and never logged, stored, or echoed back.
 */
const requireBearer: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.match(/^Bearer\s+(\S.*)$/i)?.[1];

  if (token === undefined || token.trim() === "") {
    return errorResponse(
      c,
      401,
      "No OpenRouter API key provided. Send it as `Authorization: Bearer <key>`.",
      "authentication_error",
      "missing_authorization",
    );
  }

  await next();
  return;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // No auth: a health probe must work before anyone has a key.
  app.get("/healthz", (c) => c.json({ ok: true, policyVersion: POLICY_VERSION }));

  app.use("/v1/*", requireBearer);

  registerChatRoute(app, deps);
  registerModelsRoute(app, deps);
  registerDecisionsRoutes(app, deps);
  // Last: it claims every `/v1/*` method and path the routes above did not.
  registerProxyRoute(app, deps);

  app.onError((err, c) => {
    deps.logger.error("unhandled gateway error", { error: err.message });
    return errorResponse(c, 500, "Milo failed to handle this request.", "api_error", "internal_error");
  });

  return app;
}
