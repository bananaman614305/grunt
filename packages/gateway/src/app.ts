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
import { POLICY_VERSION, ROUTED_MODEL_ID } from "@milo/core";
import type { DecisionRecord, DecisionLog, OpenRouterClient, RouteDecision, Roster, Router } from "@milo/core";
import type { AnthropicUpstream } from "./anthropic.js";
import { anthropicErrorResponse, errorResponse } from "./errors.js";
import type { RateLimiter } from "./rate-limit.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerDecisionsRoutes } from "./routes/decisions.js";
import { registerMessagesRoute } from "./routes/messages.js";
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
  /** Which decision backend the router is wired to. Reported by `/healthz`. */
  decisionBackend: string;
  openRouter: OpenRouterClient;
  /** OpenRouter's Anthropic-compatible surface, for `/v1/messages`. */
  anthropic: AnthropicUpstream;
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

/** The bearer token, or `""` if the header is missing or not bearer-shaped. */
function bearerToken(c: Context): string {
  return c.req.header("authorization")?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim() ?? "";
}

/**
 * The user's OpenRouter key, from whichever header carried it.
 *
 * The Anthropic SDK and Claude Code send a key as `x-api-key`; every other
 * client Milo serves sends `Authorization: Bearer`. Both name the same thing
 * -- the user's OpenRouter key -- so `/v1/messages` accepts either. Bearer
 * wins when both are present, since that is the one OpenRouter documents.
 */
export function credential(c: Context): string {
  const bearer = bearerToken(c);
  if (bearer !== "") return bearer;
  return c.req.header("x-api-key")?.trim() ?? "";
}

/**
 * The credential as OpenRouter wants it. Used both as the outgoing
 * `Authorization` header and as the rate limiter's bucket key, so one key
 * gets one bucket whichever header it arrived in.
 */
export function upstreamAuthorization(c: Context): string {
  return `Bearer ${credential(c)}`;
}

/** Whether a path is part of the Anthropic-dialect surface. */
function isAnthropicPath(pathname: string): boolean {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
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
 * checks that one is present -- validating it is OpenRouter's job, and Milo
 * has no way to do it without spending a call. The value is read here and
 * never logged, stored, or echoed back.
 *
 * Under `/v1/messages` a non-empty `x-api-key` counts, because that is where
 * the Anthropic SDK and Claude Code put the key (Claude Code's
 * `ANTHROPIC_API_KEY` sends `x-api-key`, `ANTHROPIC_AUTH_TOKEN` sends
 * `Authorization: Bearer`, and a user should not have to know which). Both
 * leave as one bearer token; see `routes/messages.ts`. The refusal wears the
 * dialect of the route it guards, so each client's error classes parse it.
 */
const requireKey: MiddlewareHandler = async (c, next) => {
  const anthropic = isAnthropicPath(new URL(c.req.url).pathname);

  if ((anthropic ? credential(c) : bearerToken(c)) === "") {
    return anthropic
      ? anthropicErrorResponse(
          c,
          401,
          "No OpenRouter API key provided. Send it as `x-api-key: <key>` or `Authorization: Bearer <key>`.",
          "authentication_error",
        )
      : errorResponse(
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
  app.get("/healthz", (c) =>
    c.json({ ok: true, policyVersion: POLICY_VERSION, decisionBackend: deps.decisionBackend }),
  );

  // A landing answer for people who open the bare address in a browser.
  app.get("/", (c) =>
    c.json({
      name: "milo",
      description:
        'OpenRouter with an actual routing mechanism. Point an OpenAI-compatible client at /v1 with your OpenRouter key and use model "milo/auto".',
      baseUrl: new URL("/v1", c.req.url).toString(),
      routedModel: ROUTED_MODEL_ID,
      policyVersion: POLICY_VERSION,
      decisionBackend: deps.decisionBackend,
      endpoints: ["/healthz", "/v1/chat/completions", "/v1/messages", "/v1/models", "/v1/decisions/:id"],
      docs: "https://github.com/bananaman614305/milo",
    }),
  );

  app.use("/v1/*", requireKey);

  registerChatRoute(app, deps);
  registerMessagesRoute(app, deps);
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
