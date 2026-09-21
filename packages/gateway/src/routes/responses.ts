/**
 * `POST /v1/responses` -- the OpenAI Responses dialect, so OpenAI's Codex CLI
 * (and anything else that speaks `wire_api = "responses"`) can route through
 * Milo on one base URL.
 *
 * Upstream is OpenRouter's own Responses endpoint. Confirmed against their
 * OpenAPI document on 2026-09-17 (`https://openrouter.ai/openapi.json`,
 * `servers[0].url` + the `/responses` path) and read alongside OpenAI's
 * Responses reference at
 * `https://developers.openai.com/api/reference/resources/responses`:
 *
 *   - path: `POST https://openrouter.ai/api/v1/responses`, `operationId:
 *     createResponses`, summary "Create a response", description "Creates a
 *     streaming or non-streaming response using OpenResponses API format".
 *   - auth: one scheme, HTTP bearer -- "API key as bearer token in
 *     Authorization header". Codex sends exactly that, from `env_key`.
 *   - `input` is `string | Array<ReasoningItem | EasyInputMessage |
 *     InputMessageItem | FunctionCallItem | FunctionCallOutputItem |
 *     OutputMessageItem | ApplyPatchCall*>`; `instructions` is a nullable
 *     string. That union is what `toChatMessages` below flattens.
 *   - responses: `200` is `application/json` **or** `text/event-stream`, so
 *     one endpoint serves both modes off `stream: boolean`.
 *   - usage (non-streaming): `usage.input_tokens`, `usage.output_tokens`,
 *     `usage.total_tokens`, plus `input_tokens_details.cached_tokens` and
 *     `output_tokens_details.reasoning_tokens`. OpenRouter extends the OpenAI
 *     shape with `usage.cost` (credits) and `usage.cost_details`. Note these
 *     are Anthropic's field *names* and not the chat dialect's
 *     `prompt_tokens` / `completion_tokens`, which is why `usage.ts` reads
 *     each dialect's numbers with its own field names.
 *   - streaming: SSE frames whose `data` is the `StreamEvents` union,
 *     discriminated on a `type` field. The event names OpenRouter declares
 *     are `response.created`, `response.in_progress`,
 *     `response.output_item.added` / `.done`, `response.content_part.added` /
 *     `.done`, `response.output_text.delta` / `.done`,
 *     `response.output_text.annotation.added`,
 *     `response.function_call_arguments.delta` / `.done`,
 *     `response.reasoning_text.delta` / `.done`,
 *     `response.reasoning_summary_part.*`, `response.reasoning_summary_text.*`,
 *     `response.refusal.delta` / `.done`, `response.completed`,
 *     `response.incomplete`, `response.failed`, `error`, plus server-tool
 *     events (`response.web_search_call.*`, `response.code_interpreter_call.*`,
 *     `response.image_generation_call.*`, `response.apply_patch_*`,
 *     `response.fusion_call.*`) and `response.debug`.
 *   - **usage in a stream arrives on `response.completed`**, inside that
 *     event's `response.usage` -- there is no per-chunk `usage` and no
 *     `[DONE]` sentinel like the chat dialect's. A streamed call records
 *     status and latency in the decision log, exactly as `chat.ts` does; when
 *     the caller is paying with a Milo key, `usage.ts` also reads that one
 *     event off a tee of the stream so the charge can be settled (ADR-007).
 *   - `previous_response_id`: documented as **not supported** -- "The
 *     Responses API is stateless: no responses are stored, so a previous
 *     response cannot be referenced. Requests with a non-null value are
 *     rejected with a 400 error. Send the full conversation history in
 *     `input` instead." `store` is declared `const false`. Milo forwards both
 *     untouched either way: refusing them here would only hide OpenRouter's
 *     own, clearer 400.
 *
 * Stickiness does **not** use `previous_response_id`. The router pins a model
 * to a conversation *fingerprint* (system prompt plus first user message), so
 * a stateless client that resends its whole history each turn is exactly the
 * case the fingerprint was built for -- and it is Codex's case: Codex sends
 * the full `input` every turn with `store: false`, which is what
 * `responses.test.ts` exercises.
 *
 * The two paths through this route mirror `chat.ts` and `messages.ts`: a
 * `milo/auto` model routes, any other model id passes through untouched (bar
 * the Milo-only `milo` field). Everything between parsing and streaming is
 * shared code in `shared.ts`; what lives here is the translation from the
 * Responses request shape to the `ChatMessage[]` the router reads, and the
 * Responses usage shape on the way back.
 *
 * Only `POST /v1/responses` is claimed. Every other `/v1/responses/*` path --
 * retrieve, cancel, delete, input items -- falls through to the generic
 * proxy in `proxy.ts`, which is registered last.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { extractMilo, fingerprint, isRoutingUnavailable, isStreaming, prepareBody } from "@milo/core";
import type { ChatMessage, ChatRole, CostPosture, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authorization, passThroughHeaders } from "../app.js";
import {
  callerScope,
  chargeBuffered,
  chargeStream,
  creditGate,
  forwardedUpstreamKey,
  isMetered,
  noteDecisionAccount,
  rateLimitBucket,
  upstreamHeadersFor,
} from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";
import {
  applyJevTransportHeader,
  applyMiloHeaders,
  onFinished,
  rateLimitedMessage,
  readJsonObject,
  retryAfterFromBucket,
  retryAfterSeconds,
  routingUnavailableMessage, resolveRoster, applyProviderStrategy, applyReasoningExclusion } from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { readBodyUsage, toUpstreamRecord } from "./usage.js";

export function registerResponsesRoute(app: Hono, deps: AppDeps): void {
  app.post("/v1/responses", (c) => handleResponses(c, deps));
}

async function handleResponses(c: Context, deps: AppDeps): Promise<Response> {
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
    upstream = await deps.openRouter.responses({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.logger.error("openrouter responses request failed", { routed: false, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  // A Milo key pays for passthrough too -- the tokens went on Milo's sub-key
  // -- but without the decision fee, since no decision was made. A BYOK
  // caller takes the first branch, which is today's plain passthrough.
  const headers = passThroughHeaders(upstream);
  const ctx = { surface: "responses" as const, model: String(body["model"] ?? "") };

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
  await chargeBuffered(c, deps, headers, ctx, readBodyUsage("responses", text));
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
    // (ADR-008), exactly as the chat route does.
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
    // Same refusal as the chat surface, in the same OpenAI error envelope:
    // no second decision backend and no mid-tier guess, so an unroutable
    // `milo/auto` is a 503 the client can retry or answer by naming a model.
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

  return forward(c, deps, body, decision, extension?.posture ?? "balanced");
}

async function forward(c: Context, deps: AppDeps, body: Body, decision: RouteDecision, posture: "low" | "balanced" | "quality" = "balanced"): Promise<Response> {
  // Only `model` is rewritten and only `milo` is dropped. `previous_response_id`
  // and `store` travel exactly as they arrived: Milo has no opinion about a
  // client's conversation state, and OpenRouter's refusal of a stored
  // conversation is clearer than one invented here.
  const forwarded = applyReasoningExclusion(
    applyProviderStrategy(prepareBody(body, decision.model), posture, decision.model),
  );
  const startedAt = deps.now();

  let upstream: Response;
  try {
    upstream = await deps.openRouter.responses({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, { status: 502, latencyMs: deps.now() - startedAt });
    deps.logger.error("openrouter responses request failed", { decisionId: decision.id, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);
  applyJevTransportHeader(headers, deps);

  // A streamed success is the only case where the body must not be touched.
  // An upstream error is JSON however the request was made, so it takes the
  // buffered path and passes through with its own status.
  const ctx = { surface: "responses" as const, model: decision.model, decisionId: decision.id };

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const recorded = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, { status: upstream.status, latencyMs: deps.now() - startedAt });
      }),
    );
    // The charge settles from the usage on `response.completed`, after the
    // client already has every byte.
    return new Response(chargeStream(c, deps, headers, ctx, recorded), { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const usage = upstream.ok ? readBodyUsage("responses", text) : {};
  const record: Upstream = { status: upstream.status, latencyMs: deps.now() - startedAt };
  if (upstream.ok) Object.assign(record, toUpstreamRecord(usage));
  deps.recordUpstream(decision.id, record);
  if (upstream.ok) await chargeBuffered(c, deps, headers, ctx, usage);

  return new Response(text, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// Responses request shape -> what the router reads
// ---------------------------------------------------------------------------

/**
 * Flattens a Responses body into the OpenAI-shaped `ChatMessage[]` the
 * router's context builder and fingerprint read.
 *
 * Three shapes have to collapse into one. The system prompt is a top-level
 * `instructions` string rather than a message. `input` is either a bare
 * string -- the whole request, one user turn -- or a list of items, of which
 * only four kinds say anything about the task:
 *
 *   - a message item (`type: "message"`, or an `EasyInputMessage` with a
 *     `role` and no `type` at all): its role carries over, and its content is
 *     a string or a list of parts whose `input_text` / `output_text` / `text`
 *     entries contribute their text;
 *   - `function_call`: an assistant marker line naming the tool;
 *   - `function_call_output`: the tool loop *continuing*, so it maps to
 *     `role: "tool"` and not to a user turn. This is the load-bearing case:
 *     `countUserTurns` in core counts `role: "user"` only, so a tool result
 *     leaves the count where it was and the pinned decision still applies --
 *     which is what keeps a model from changing mid-tool-loop;
 *   - everything else -- `reasoning`, `apply_patch_call`, image and file
 *     parts, item types OpenRouter has not shipped yet -- is skipped.
 *
 * A tool call and its result contribute a marker rather than their payload,
 * as on the Anthropic surface: the router needs to know a tool round-trip
 * happened, and pasting a tool result's bytes in would spend the Jev context
 * budget on data that says nothing about the task.
 */
export function toChatMessages(body: Body): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const instructions = body["instructions"];
  if (typeof instructions === "string" && instructions.trim().length > 0) {
    messages.push({ role: "system", content: instructions.trim() });
  }

  const input = body["input"];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input.trim() });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const message = toMessage(item);
    if (message !== undefined) messages.push(message);
  }

  return messages;
}

function toMessage(item: Record<string, unknown>): ChatMessage | undefined {
  const type = item["type"];

  // An `EasyInputMessage` carries a role and no `type`; an `InputMessageItem`
  // and an output message carry `type: "message"`. Both are turns.
  if (type === "message" || (type === undefined && typeof item["role"] === "string")) {
    return { role: inputRole(item["role"]), content: contentText(item["content"]) };
  }

  if (type === "function_call") {
    const name = typeof item["name"] === "string" ? item["name"] : "";
    return { role: "assistant", content: name === "" ? "[function_call]" : `[function_call: ${name}]` };
  }

  // A tool result is a continuation, never a new user turn.
  if (type === "function_call_output") {
    return { role: "tool", content: "[function_call_output]" };
  }

  // `reasoning`, `apply_patch_call`, and anything OpenRouter adds next say
  // nothing about what the task is, so they never reach Jev.
  return undefined;
}

/** Responses roles map one to one onto the router's; anything else is a user. */
function inputRole(role: unknown): ChatRole {
  switch (role) {
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "developer":
      return "developer";
    default:
      return "user";
  }
}

/** A string, or a list of Responses content parts, rendered as text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const part = entry as Record<string, unknown>;
    const text = partText(part);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n").trim();
}

function partText(part: Record<string, unknown>): string {
  switch (part["type"]) {
    case "input_text":
    case "output_text":
    case "text":
      return typeof part["text"] === "string" ? part["text"] : "";
    case "input_image":
      return "[image]";
    case "input_file":
      return "[file]";
    case "input_audio":
      return "[audio]";
    case "input_video":
      return "[video]";
    case "refusal":
      return "[refusal]";
    default:
      // An unknown part type still happened, and the router should see that
      // the turn was not empty. `text` is read opportunistically in case a
      // future part type carries some.
      return typeof part["text"] === "string" ? part["text"] : "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upstreamUnavailable(c: Context): Response {
  return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
}
