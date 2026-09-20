/**
 * `POST /v1/messages` -- the Anthropic-compatible surface, so Claude Code and
 * the `@anthropic-ai/sdk` can route through Milo on one base URL.
 *
 * Upstream is OpenRouter's Anthropic-compatible endpoint. Confirmed against
 * their OpenAPI document and the docs page below on 2026-09-17:
 *
 *   https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message
 *   https://openrouter.ai/openapi.json  (servers[0].url + the `/messages` path)
 *
 *   - path: `POST https://openrouter.ai/api/v1/messages`, `operationId:
 *     createMessages`, "Creates a message using the Anthropic Messages API
 *     format. Supports text, images, PDFs, tools, and extended thinking."
 *   - auth: the spec declares one scheme, HTTP bearer -- "API key as bearer
 *     token in Authorization header". `x-api-key` is also accepted on the wire
 *     but is undocumented, so Milo normalizes every credential to
 *     `Authorization: Bearer` on the way out and relies only on what is
 *     documented.
 *   - streaming: `stream: boolean` in the request schema; responses are
 *     `application/json` or `text/event-stream`.
 *   - limitations worth knowing: OpenRouter has no `/v1/messages/count_tokens`
 *     (it 404s), and `anthropic-version` / `anthropic-beta` appear nowhere in
 *     their schema, so treat them as ignored upstream rather than honoured.
 *     Milo forwards both anyway -- Claude Code's gateway contract asks proxies
 *     to pass them verbatim, and a header OpenRouter ignores costs nothing.
 *
 * The two paths through this route mirror `chat.ts` exactly, because the
 * routing decision has nothing to do with the dialect: `model: "milo/auto"`
 * routes, any other model id passes through untouched (bar the Milo-only
 * `milo` field). Everything between parsing and streaming is shared code in
 * `shared.ts`; what lives here is the translation from Anthropic's request
 * shape to the `ChatMessage[]` the router reads, and Anthropic's error and
 * usage shapes on the way back.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { extractMilo, fingerprint, isRoutingUnavailable, isStreaming, prepareBody } from "@milo/core";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { upstreamAuthorization } from "../app.js";
import {
  authOf,
  callerScope,
  chargeBuffered,
  chargeStream,
  creditGate,
  forwardedUpstreamKey,
  isMetered,
  noteDecisionAccount,
  rateLimitBucket,
} from "../billing.js";
import { passBackHeaders } from "../anthropic.js";
import { anthropicErrorResponse, errorMessage } from "../errors.js";
import {
  applyMiloHeaders,
  onFinished,
  rateLimitedMessage,
  readJsonObject,
  resolveRoster,
  retryAfterFromBucket,
  retryAfterSeconds,
  routingUnavailableMessage,
  applyProviderStrategy,
  applyReasoningExclusion,
} from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { readBodyUsage, toUpstreamRecord } from "./usage.js";

export function registerMessagesRoute(app: Hono, deps: AppDeps): void {
  app.post("/v1/messages", (c) => handleMessages(c, deps));
  // `/v1/messages/count_tokens` and anything else Anthropic adds under the
  // prefix. Generic passthrough, but through this route's client so the
  // `x-api-key` credential and the `anthropic-*` headers are handled the same
  // way they are on the main path.
  app.all("/v1/messages/*", (c) => passthroughPath(c, deps));
}

async function handleMessages(c: Context, deps: AppDeps): Promise<Response> {
  const body = await readJsonObject(c);
  if (body === undefined) {
    return anthropicErrorResponse(c, 400, "Request body must be a JSON object.", "invalid_request_error");
  }

  // A Milo key with no credit is refused before Jev and before OpenRouter
  // (ADR-007); a BYOK request never reaches the gate.
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
    upstream = await send(c, deps, forwarded);
  } catch (err) {
    deps.logger.error("openrouter messages request failed", { routed: false, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  // A Milo key pays for passthrough too -- the tokens went on Milo's sub-key
  // -- but without the decision fee, since no decision was made. A BYOK
  // caller takes the first branch, which is today's plain passthrough.
  const headers = passBackHeaders(upstream);
  const ctx = { surface: "messages" as const, model: String(body["model"] ?? "") };

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
  await chargeBuffered(c, deps, headers, ctx, readBodyUsage("messages", text));
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
  const messages = toChatMessages(body);
  // Scoped to the caller, as on the OpenAI surface: two keys running
  // different rosters (ADR-008) must not share a sticky decision.
  const conversation = fingerprint(messages, callerScope(c));
  const candidates = extension?.candidates;
  const forcedTier = extension?.tier;

  // The bucket is keyed on the credential -- the Milo key's hash for a Milo
  // key, the OpenRouter credential's otherwise -- and not on the header that
  // carried it, so one key gets one budget whichever dialect and whichever
  // header it arrives in. A forced tier never calls Jev, so it never spends
  // the budget the limiter bounds.
  const bucket = rateLimitBucket(c, upstreamAuthorization(c));
  if (forcedTier === undefined && !deps.rateLimiter.tryConsumeHashed(bucket)) {
    // No decision is made here, so no decision row is written.
    const retryAfter = retryAfterFromBucket(deps.rateLimiter.retryAfterMsHashed(bucket));
    deps.logger.warn("routed request rate limited", {
      fingerprint: conversation,
      status: 429,
      retryAfter,
    });
    return anthropicErrorResponse(c, 429, rateLimitedMessage(deps.rateLimiter.capacity), "rate_limit_error", {
      "retry-after": retryAfter,
    });
  }

  const request: RouteRequest = {
    messages,
    posture: (extension?.posture ?? "balanced") satisfies CostPosture,
    fingerprint: conversation,
    // Same precedence as the OpenAI surface: per-key roster, then the
    // deployment's, then the shipped default (ADR-008).
    roster: await resolveRoster(c, deps),
  };
  if (Array.isArray(body["tools"])) request.tools = body["tools"];
  if (candidates !== undefined) request.candidates = candidates;
  if (forcedTier !== undefined) request.forcedTier = forcedTier;
  // Best-of-N execution lives on the chat-completions surface only for now
  // (ADR-010): this dialect opts out at routing time, so its decisions keep
  // their single-model outcome instead of a sampled one it cannot run.
  request.samples = 1;
  // ADR-021: under the OpenRouter Jev transport, bill the classification call
  // to the caller's own forwarded OpenRouter key. Left unset otherwise.
  if (deps.forwardJevKey === true) {
    const jevKey = forwardedUpstreamKey(c);
    if (jevKey !== "") request.jevKey = jevKey;
  }

  let decision: RouteDecision;
  try {
    decision = await deps.router.route(request);
  } catch (err) {
    // Same refusal as the OpenAI surface, in Anthropic's envelope: no second
    // decision backend, no mid-tier guess, so an unroutable `milo/auto` is a
    // 503 the client can retry or answer by naming a model itself.
    if (isRoutingUnavailable(err)) {
      const retryAfter = retryAfterSeconds(err);
      deps.logger.warn("routing unavailable", {
        cause: err.cause_,
        status: 503,
        upstreamStatus: err.status,
        jevRequestId: err.requestId,
        retryAfter,
      });
      return anthropicErrorResponse(c, 503, routingUnavailableMessage(err.cause_), "api_error", {
        "retry-after": retryAfter,
      });
    }

    deps.logger.error("router threw", { error: errorMessage(err), status: 502 });
    return anthropicErrorResponse(c, 502, "Milo could not route this request.", "api_error");
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

  return forward(c, deps, body, decision, extension?.posture ?? "balanced");
}

async function forward(c: Context, deps: AppDeps, body: Body, decision: RouteDecision, posture: "low" | "balanced" | "quality" = "balanced"): Promise<Response> {
  const forwarded = applyReasoningExclusion(
    applyProviderStrategy(prepareBody(body, decision.model), posture, decision.model),
  );
  const startedAt = deps.now();

  let upstream: Response;
  try {
    upstream = await send(c, deps, forwarded);
  } catch (err) {
    deps.recordUpstream(decision.id, { status: 502, latencyMs: deps.now() - startedAt });
    deps.logger.error("openrouter messages request failed", { decisionId: decision.id, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  const headers = passBackHeaders(upstream);
  applyMiloHeaders(headers, decision);

  // A streamed success is the only case where the body must not be touched.
  // An upstream error is JSON however the request was made, so it takes the
  // buffered path and passes through with its own status.
  const ctx = { surface: "messages" as const, model: decision.model, decisionId: decision.id };

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const recorded = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, { status: upstream.status, latencyMs: deps.now() - startedAt });
      }),
    );
    // The charge settles from `message_start` and `message_delta`, after the
    // client already has every byte.
    return new Response(chargeStream(c, deps, headers, ctx, recorded), { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const usage = upstream.ok ? readBodyUsage("messages", text) : {};
  const record: Upstream = { status: upstream.status, latencyMs: deps.now() - startedAt };
  if (upstream.ok) Object.assign(record, toUpstreamRecord(usage));
  deps.recordUpstream(decision.id, record);
  if (upstream.ok) await chargeBuffered(c, deps, headers, ctx, usage);

  return new Response(text, { status: upstream.status, headers });
}

function send(c: Context, deps: AppDeps, body: Body): Promise<Response> {
  const url = new URL(c.req.url);
  return deps.anthropic.messages({
    authorization: authOf(c).openRouterAuthorization,
    headers: c.req.raw.headers,
    body,
    // Claude Code posts to `/v1/messages?beta=true`; keep the query string.
    search: url.search,
  });
}

// ---------------------------------------------------------------------------
// `/v1/messages/*`: generic passthrough
// ---------------------------------------------------------------------------

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

async function passthroughPath(c: Context, deps: AppDeps): Promise<Response> {
  // Gated like every other path that can reach OpenRouter, though nothing
  // under here is metered: these are Anthropic's own side endpoints, not
  // inference.
  const refusal = creditGate(c, deps);
  if (refusal !== undefined) return refusal;

  const url = new URL(c.req.url);
  // The client's base URL is `<milo>/v1` and OpenRouter's is
  // `https://openrouter.ai/api/v1`, so the `/v1` prefix is dropped here and
  // supplied again by the client's base URL.
  const path = `${url.pathname.slice("/v1".length)}${url.search}`;

  const opts: Parameters<AppDeps["anthropic"]["send"]>[0] = {
    method: c.req.method,
    path,
    authorization: authOf(c).openRouterAuthorization,
    headers: c.req.raw.headers,
  };
  if (!BODYLESS.has(c.req.method)) opts.body = await c.req.text();

  let upstream: Response;
  try {
    upstream = await deps.anthropic.send(opts);
  } catch (err) {
    deps.logger.error("openrouter messages proxy request failed", {
      path: url.pathname,
      error: errorMessage(err),
    });
    return upstreamUnavailable(c);
  }

  return new Response(upstream.body, { status: upstream.status, headers: passBackHeaders(upstream) });
}

// ---------------------------------------------------------------------------
// Anthropic request shape -> what the router reads
// ---------------------------------------------------------------------------

/**
 * Flattens an Anthropic Messages body into the OpenAI-shaped `ChatMessage[]`
 * the router's context builder and fingerprint read.
 *
 * Two shapes have to collapse into one. Anthropic puts the system prompt in a
 * top-level `system` field (a string, or an array of text blocks) rather than
 * a message, and message `content` is either a string or an array of typed
 * blocks. Text blocks contribute their text; a `tool_use` or `tool_result`
 * block contributes a short marker instead, because the router only needs to
 * know that a turn was a tool round-trip -- pasting a tool result's payload in
 * would blow the Jev context budget on data that says nothing about the task.
 */
export function toChatMessages(body: Body): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const system = blockText(body["system"]);
  if (system.length > 0) messages.push({ role: "system", content: system });

  const turns = Array.isArray(body["messages"]) ? body["messages"] : [];
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null) continue;
    const source = turn as Record<string, unknown>;
    // Anthropic has exactly two message roles; anything else is not a turn.
    // A user message made only of tool_result blocks is the tool loop
    // continuing, not a new ask, so the router must not count it as a user
    // turn: it maps to the "tool" role.
    const content = source["content"];
    const onlyToolResults =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_result");
    const role = source["role"] === "assistant" ? "assistant" : onlyToolResults ? "tool" : "user";
    messages.push({ role, content: blockText(content) });
  }

  return messages;
}

/** A string, or an array of Anthropic content blocks, rendered as text. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as Record<string, unknown>;
    const text = marker(block);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n").trim();
}

function marker(block: Record<string, unknown>): string {
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? block["text"] : "";
    case "tool_use":
      return typeof block["name"] === "string" ? `[tool_use: ${block["name"]}]` : "[tool_use]";
    case "tool_result":
      return block["is_error"] === true ? "[tool_result: error]" : "[tool_result]";
    case "thinking":
    case "redacted_thinking":
      return "[thinking]";
    case "image":
      return "[image]";
    case "document":
      return "[document]";
    default:
      // An unknown block type still happened, and the router should see that
      // the turn was not empty. `text` is read opportunistically in case a
      // future block type carries some.
      return typeof block["text"] === "string" ? block["text"] : "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upstreamUnavailable(c: Context): Response {
  return anthropicErrorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error");
}
