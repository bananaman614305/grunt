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
import { extractMilo, fingerprint, isStreaming, prepareBody } from "@milo/core";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authorization, passThroughHeaders } from "../app.js";
import { errorMessage, errorResponse } from "../errors.js";
import { applyMiloHeaders, degradedDecision, onFinished, readJsonObject } from "./shared.js";
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
  const conversation = fingerprint(messages);
  const candidates = extension?.candidates;

  let decision: RouteDecision;

  if (!deps.rateLimiter.tryConsume(authorization(c))) {
    // Over the limit is not a rejection: the user's OpenRouter spend is
    // theirs, only Milo's Jev spend is capped. Skip Jev, take `mid`, say so.
    decision = degradedDecision(
      deps,
      conversation,
      candidates,
      `rate limited: routed requests exceeded ${deps.rateLimiter.capacity} per minute for this key`,
    );
    deps.logger.warn("routed request rate limited", { decisionId: decision.id, fingerprint: conversation });
    await deps.insertDecision(decision);
  } else {
    const request: RouteRequest = {
      messages,
      posture: (extension?.posture ?? "balanced") satisfies CostPosture,
      fingerprint: conversation,
    };
    if (Array.isArray(body["tools"])) request.tools = body["tools"];
    if (candidates !== undefined) request.candidates = candidates;
    if (extension?.tier !== undefined) request.forcedTier = extension.tier;

    try {
      decision = await deps.router.route(request);
    } catch (err) {
      // The router degrades rather than throwing, so reaching here means a
      // bug or an unusable roster. Record why, then fail loudly: guessing a
      // model on top of a broken configuration would hide it.
      deps.logger.error("router threw", { error: errorMessage(err) });
      const failed = degradedDecision(
        deps,
        conversation,
        candidates,
        "routing failed unexpectedly, fell back to the mid tier",
      );
      await deps.insertDecision(failed);
      return errorResponse(c, 502, "Milo could not route this request.", "api_error", "routing_failed");
    }

    // The router wrote this decision through its `onDecision` hook; make sure
    // that write landed before the id goes out on a response header.
    await deps.decisionSettled(decision.id);
  }

  deps.logger.info("routed", {
    decisionId: decision.id,
    model: decision.model,
    tier: decision.tier,
    sticky: decision.sticky,
    degraded: decision.degraded,
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
