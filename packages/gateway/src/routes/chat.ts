/**
 * `POST /v1/chat/completions` -- the surface the whole product hangs off.
 *
 * Two paths through it:
 *
 *   - `model` is anything but `milo/auto`: forward the body untouched (bar
 *     the Milo-only `milo` field) and hand the upstream response back. Milo
 *     is not in the way of a request that did not ask for it.
 *   - `model` is `milo/auto`: fingerprint the conversation, route it, rewrite
 *     `model`, forward, and answer with `x-milo-*` headers naming the choice.
 *
 * Invariants for both:
 *   - the response body is never rewritten. Non-streaming bodies are buffered
 *     only to read `usage` out of them and are re-sent verbatim; streaming
 *     bodies pass through an identity transform whose only job is to notice
 *     when the last byte went out.
 *   - the decision is in the log before the upstream call starts, so the
 *     `x-milo-decision-id` a client reads off the response is always
 *     resolvable at `/v1/decisions/:id`.
 *   - nothing derived from `Authorization` reaches a decision, a header, or a
 *     log line (ADR-003).
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { extractMilo, fingerprint, isRoutingUnavailable, isStreaming, prepareBody } from "@milo/core";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authorization, keyHash, passThroughHeaders } from "../app.js";
import { errorMessage, errorResponse } from "../errors.js";
import {
  applyMiloHeaders,
  onFinished,
  rateLimitedMessage,
  readJsonObject,
  resolveRoster,
  retryAfterFromBucket,
  retryAfterSeconds,
  routingUnavailableMessage,
} from "./shared.js";
import type { Body, Upstream } from "./shared.js";

export function registerChatRoute(app: Hono, deps: AppDeps): void {
  app.post("/v1/chat/completions", (c) => handleChat(c, deps));
}

async function handleChat(c: Context, deps: AppDeps): Promise<Response> {
  const body = await readJsonObject(c);
  if (body === undefined) {
    return errorResponse(
      c,
      400,
      "Request body must be a JSON object.",
      "invalid_request_error",
      "invalid_request_body",
    );
  }

  const { extension, isRouted } = extractMilo(body);
  return isRouted ? routed(c, deps, body, extension) : passthrough(c, deps, body);
}

// ---------------------------------------------------------------------------
// Passthrough: any model id but `milo/auto`
// ---------------------------------------------------------------------------

async function passthrough(c: Context, deps: AppDeps, body: Body): Promise<Response> {
  // `prepareBody` with the body's own model is a no-op except for dropping
  // `milo`, which OpenRouter would reject as an unknown field.
  const forwarded = "milo" in body ? prepareBody(body, body["model"] as string) : body;

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: c.req.raw.headers, body: forwarded });
  } catch (err) {
    deps.logger.error("openrouter chat completions failed", { routed: false, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  return new Response(upstream.body, { status: upstream.status, headers: passThroughHeaders(upstream) });
}

// ---------------------------------------------------------------------------
// Routed: `model: "milo/auto"`
// ---------------------------------------------------------------------------

async function routed(
  c: Context,
  deps: AppDeps,
  body: Body,
  extension: ReturnType<typeof extractMilo>["extension"],
): Promise<Response> {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  // Scoped to the caller: since a roster can be stored per key (ADR-007), a
  // sticky hit shared between two keys could hand one of them a model that is
  // not on their list.
  const conversation = fingerprint(messages, keyHash(c));
  const candidates = extension?.candidates;
  const forcedTier = extension?.tier;

  // A forced tier never calls Jev, so it never spends the budget the rate
  // limiter exists to bound; only an unforced request can be over the limit.
  if (forcedTier === undefined && !deps.rateLimiter.tryConsume(authorization(c))) {
    // No decision is made here, so no decision row is written: there is
    // nothing to explain but the refusal itself.
    const retryAfter = retryAfterFromBucket(deps.rateLimiter.retryAfterMs(authorization(c)));
    deps.logger.warn("routed request rate limited", {
      fingerprint: conversation,
      status: 429,
      retryAfter,
    });
    return errorResponse(
      c,
      429,
      rateLimitedMessage(deps.rateLimiter.capacity),
      "rate_limit_error",
      "rate_limit_exceeded",
      { "retry-after": retryAfter },
    );
  }

  const request: RouteRequest = {
    messages,
    posture: (extension?.posture ?? "balanced") satisfies CostPosture,
    fingerprint: conversation,
    // Per-key roster first, then the deployment's, then the shipped default
    // (ADR-007). `candidates` below still filters within whichever it is.
    roster: await resolveRoster(c, deps),
  };
  if (Array.isArray(body["tools"])) request.tools = body["tools"];
  if (candidates !== undefined) request.candidates = candidates;
  if (forcedTier !== undefined) request.forcedTier = forcedTier;

  let decision: RouteDecision;
  try {
    decision = await deps.router.route(request);
  } catch (err) {
    // Jev could not answer, and there is no second backend and no mid-tier
    // guess left to make: `milo/auto` without a decision is a 503, and the
    // client is told to retry or name a model itself.
    if (isRoutingUnavailable(err)) {
      const retryAfter = retryAfterSeconds(err);
      deps.logger.warn("routing unavailable", {
        cause: err.cause_,
        status: 503,
        upstreamStatus: err.status,
        jevRequestId: err.requestId,
        retryAfter,
      });
      return errorResponse(
        c,
        503,
        routingUnavailableMessage(err.cause_),
        "api_error",
        "routing_unavailable",
        { "retry-after": retryAfter },
      );
    }

    // Anything else is a bug or an unusable roster. Fail loudly rather than
    // fabricating a model on top of a broken configuration.
    deps.logger.error("router threw", { error: errorMessage(err), status: 502 });
    return errorResponse(c, 502, "Milo could not route this request.", "api_error", "routing_failed");
  }

  deps.logger.info("routed", {
    decisionId: decision.id,
    model: decision.model,
    tier: decision.tier,
    sticky: decision.sticky,
  });

  return forward(c, deps, body, decision);
}

async function forward(c: Context, deps: AppDeps, body: Body, decision: RouteDecision): Promise<Response> {
  const forwarded = prepareBody(body, decision.model);
  const startedAt = deps.now();

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: c.req.raw.headers, body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, { status: 502, latencyMs: deps.now() - startedAt });
    deps.logger.error("openrouter chat completions failed", { decisionId: decision.id, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);

  // A streamed success is the only case where the body must not be touched.
  // An upstream error is JSON however the request was made, so it takes the
  // buffered path and passes through with its own status.
  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const stream = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, { status: upstream.status, latencyMs: deps.now() - startedAt });
      }),
    );
    return new Response(stream, { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const record: Upstream = { status: upstream.status, latencyMs: deps.now() - startedAt };
  if (upstream.ok) Object.assign(record, readUsage(text));
  deps.recordUpstream(decision.id, record);

  return new Response(text, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Token counts and OpenRouter's cost, when the body carries them. */
function readUsage(text: string): Partial<Upstream> {
  let usage: unknown;
  try {
    usage = (JSON.parse(text) as { usage?: unknown }).usage;
  } catch {
    return {};
  }
  if (typeof usage !== "object" || usage === null) return {};

  const source = usage as Record<string, unknown>;
  const result: Partial<Upstream> = {};
  if (typeof source["prompt_tokens"] === "number") result.inputTokens = source["prompt_tokens"];
  if (typeof source["completion_tokens"] === "number") result.outputTokens = source["completion_tokens"];
  // OpenRouter adds `usage.cost` in credits; absent unless the request asked.
  if (typeof source["cost"] === "number") result.costUsd = source["cost"];
  return result;
}

function upstreamUnavailable(c: Context): Response {
  return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
}
