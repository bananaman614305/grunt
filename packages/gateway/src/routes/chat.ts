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
 *   - a caller paying with a Milo key is gated before the call and charged
 *     after it (`billing.ts`, ADR-007); a bring-your-own-key caller takes
 *     exactly the path it always did, with no gate, no charge and no extra
 *     buffering.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { extractMilo, fingerprint, isRoutingUnavailable, isStreaming, prepareBody } from "@milo/core";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authorization, passThroughHeaders } from "../app.js";
import {
  callerScope,
  chargeBuffered,
  chargeStream,
  creditGate,
  isMetered,
  noteDecisionAccount,
  rateLimitBucket,
  upstreamHeadersFor,
} from "../billing.js";
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
import { readBodyUsage, toUpstreamRecord } from "./usage.js";

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

  // A Milo key with no credit is refused here, before Jev and before
  // OpenRouter: a request that cannot be paid for should not cost Milo a
  // decision either. A BYOK request never reaches the gate (ADR-007).
  const refusal = creditGate(c, deps);
  if (refusal !== undefined) return refusal;

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
    upstream = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.logger.error("openrouter chat completions failed", { routed: false, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  // A Milo key pays for passthrough too: the tokens were spent on Milo's
  // sub-key either way. No decision fee, because no decision was made. For a
  // BYOK caller every branch below is today's one-line passthrough.
  const headers = passThroughHeaders(upstream);
  const ctx = { surface: "chat" as const, model: String(body["model"] ?? "") };

  if (!isMetered(c) || !upstream.ok || upstream.body === null) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  if (isStreaming(body)) {
    return new Response(chargeStream(c, deps, headers, ctx, upstream.body), {
      status: upstream.status,
      headers,
    });
  }

  const text = await upstream.text();
  await chargeBuffered(c, deps, headers, ctx, readBodyUsage("chat", text));
  return new Response(text, { status: upstream.status, headers });
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
  // Scoped to the caller: since a roster can be stored per key (ADR-008), a
  // sticky hit shared between two keys could hand one of them a model that is
  // not on their list.
  const conversation = fingerprint(messages, callerScope(c));
  const candidates = extension?.candidates;
  const forcedTier = extension?.tier;

  // A forced tier never calls Jev, so it never spends the budget the rate
  // limiter exists to bound; only an unforced request can be over the limit.
  // The bucket is the Milo key's hash for a Milo key and the OpenRouter
  // credential's for a BYOK caller, so rotating either gets a fresh bucket.
  const bucket = rateLimitBucket(c, authorization(c));
  if (forcedTier === undefined && !deps.rateLimiter.tryConsumeHashed(bucket)) {
    // No decision is made here, so no decision row is written: there is
    // nothing to explain but the refusal itself.
    const retryAfter = retryAfterFromBucket(deps.rateLimiter.retryAfterMsHashed(bucket));
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
    // (ADR-008). `candidates` below still filters within whichever it is.
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

  // Stamps the account on the row the router just wrote, so this decision
  // shows up in that account's `/v1/decisions` and nobody else's.
  await noteDecisionAccount(c, deps, decision.id);

  return forward(c, deps, body, decision);
}

async function forward(c: Context, deps: AppDeps, body: Body, decision: RouteDecision): Promise<Response> {
  const forwarded = prepareBody(body, decision.model);
  const startedAt = deps.now();

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
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
  const ctx = { surface: "chat" as const, model: decision.model, decisionId: decision.id };

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const recorded = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, { status: upstream.status, latencyMs: deps.now() - startedAt });
      }),
    );
    // The charge settles from the usage in the stream's final frames, after
    // the client already has every byte.
    return new Response(chargeStream(c, deps, headers, ctx, recorded), { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const usage = upstream.ok ? readBodyUsage("chat", text) : {};
  const record: Upstream = { status: upstream.status, latencyMs: deps.now() - startedAt };
  if (upstream.ok) Object.assign(record, toUpstreamRecord(usage));
  deps.recordUpstream(decision.id, record);
  if (upstream.ok) await chargeBuffered(c, deps, headers, ctx, usage);

  return new Response(text, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upstreamUnavailable(c: Context): Response {
  return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
}
