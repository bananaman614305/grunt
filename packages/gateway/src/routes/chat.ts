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
 *   - the response body is otherwise never rewritten. Non-streaming bodies are
 *     buffered only to read `usage` out of them; streaming bodies pass through
 *     a transform whose job is to notice when the last byte went out. On the
 *     routed path, when the caller did not ask for a visible reasoning trace,
 *     chat completions also strip `reasoning` / `reasoning_content` /
 *     `reasoning_details` / `thinking` from `choices[].message` and
 *     `choices[].delta` so an upstream that still emits them cannot leak CoT.
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
import type { ChatMessage, CostPosture, EmbedClientLike, EmbeddingVector, RouteDecision, RouteRequest } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authorization, passThroughHeaders } from "../app.js";
import {
  callerScope,
  chargeBuffered,
  chargeStream,
  creditGate,
  forwardedJevKey,
  isMetered,
  noteDecisionAccount,
  noteDecisionKeyHash,
  rateLimitBucket,
  upstreamHeadersFor,
} from "../billing.js";
import { applyBrief, briefHeaders, routedBrief } from "../brief.js";
import { maybeCapture } from "../capture.js";
import { applyFactNote, factHeaders, maybeCaptureFact, prepareQueryEmbedding, routedFacts } from "../facts.js";
import { embedClientFor } from "../embed.js";
import type { RoutedFacts } from "../facts.js";
import { errorMessage, errorResponse } from "../errors.js";
import {
  applyJevTransportHeader,
  applyMiloHeaders,
  enforceTenantLimits,
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
import {
  stripChatReasoningBody,
  stripChatReasoningSse,
  wantsVisibleReasoning,
} from "./chat-reasoning.js";
import { forwardGated, gateFor } from "./gate.js";
import { applyPruneHeaders, maybePrune, pruneRecord } from "./prune.js";
import type { PruneOutcome } from "./prune.js";
import { forwardSampled } from "./sampling.js";
import { readBodyUsage, toUpstreamRecord } from "./usage.js";

/**
 * Speculative routing disclosure (ADR-025): `hit` when the response came from
 * a call started in parallel with the Jev classification, `miss` when such a
 * call was started but discarded because the decision picked something else,
 * `off` when speculation was enabled but this request was not eligible. Absent
 * entirely when the deployment did not opt into speculation.
 */
export const SPECULATION_HEADER = "x-milo-speculation";

type SpeculationState = "off" | "hit" | "miss";

/** A single cheap call started in parallel with the Jev classification. */
type Speculation = {
  /** The model it was started on -- the request's resolved fast-tier default. */
  model: string;
  /** The exact forwarded body, for the byte-equality guard the hit test uses. */
  forwarded: Body;
  /** When the upstream call began, so `forward` can time it truthfully on a hit. */
  startedAt: number;
  abort: AbortController;
  upstream: Promise<Response>;
};

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

  // Tenant guardrails (request shape, request/token rate, spend cap) run
  // before anything else costs money: a request already over its own budget
  // should not reach the credit gate, Jev, or OpenRouter. No-ops entirely
  // when this deployment configures no `tenantLimits`.
  const tenantRefusal = await enforceTenantLimits(c, deps, body, "openai");
  if (tenantRefusal !== undefined) return tenantRefusal;

  // A Milo key with no credit is refused here, before Jev and before
  // OpenRouter: a request that cannot be paid for should not cost Milo a
  // decision either. A BYOK request never reaches the gate (ADR-007).
  const refusal = creditGate(c, deps);
  if (refusal !== undefined) return refusal;

  const { extension, isRouted, invalidTask } = extractMilo(body);
  if (isRouted && invalidTask === true) {
    return errorResponse(
      c,
      400,
      "milo.task and milo.evidence must be a valid canonical task record and criterion evidence list.",
      "invalid_request_error",
      "invalid_task_record",
    );
  }
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
  if (extension?.samples !== undefined) request.samples = extension.samples;
  // ADR-021/022: under the OpenRouter Jev transport, bill EVERY Jev call this
  // request makes to the caller's own forwarded OpenRouter key -- not only the
  // classification call below (ADR-021), but each auxiliary feature that fires
  // later on this path too (preference capture, fact capture, fact relevance,
  // pruning, the completeness gate and its ranking/verification -- ADR-022).
  // `undefined` under the default TypeSafe transport, where Milo's key is used.
  const jevKey = forwardedJevKey(c, deps);
  if (jevKey !== undefined) request.jevKey = jevKey;

  // Two-stage fact retrieval (ADR-018): prepare the turn's embedding IN
  // PARALLEL with the routing Jev call below, so its ~50 ms round trip hides
  // under the ~350 ms route and adds nothing to the critical path. Eligibility
  // is decided from what we already know (fact memory on, not `low` posture,
  // not opted out); the embed client authenticates with the RESOLVED upstream
  // key -- the account sub-key for a Milo caller, the caller's own key for
  // BYOK -- never the raw `mk_` bearer. `prepareQueryEmbedding` makes the
  // cheap, decrypt-free checks (retrieval on for this key, at least one fact
  // stored) before embedding, so a caller with no facts pays for no call. Any
  // failure resolves to undefined and the gate falls open to every fact.
  const posture: CostPosture = extension?.posture ?? "balanced";
  const retrievalEligible = deps.factMemory !== undefined && posture !== "low" && extension?.facts !== false;
  const embed: EmbedClientLike | undefined = retrievalEligible
    ? embedClientFor(deps.factRetrieval, upstreamHeadersFor(c).get("authorization") ?? "")
    : undefined;
  const promptEmbedding: Promise<EmbeddingVector | undefined> = prepareQueryEmbedding(deps.log, embed, {
    keyHash: callerScope(c),
    messages,
    logger: deps.logger,
  });

  // Speculative routing (ADR-025): before Jev answers, maybe start the single
  // cheapest fast-tier call so its wall time overlaps the classification (and
  // the brief/facts/prune Jev calls that follow) instead of stacking after it.
  // The router decides eligibility (probably-easy, cache-miss, roster mode);
  // the result is used only if the decision below resolves to this exact model
  // as a single, ungated call, and aborted otherwise, so routing never changes.
  const speculation = beginSpeculation(c, deps, body, request, posture);

  let decision: RouteDecision;
  try {
    decision = await deps.router.route(request);
  } catch (err) {
    // No decision means no forward, speculative or otherwise: stop paying for
    // the in-flight call before returning the error.
    discardSpeculation(speculation);
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
  // Stamps the caller's key hash too, so a configured spend cap can sum this
  // key's cost later (a no-op when no cap is configured).
  await noteDecisionKeyHash(c, deps, decision.id);

  // Preference capture (ADR-011) is fire-and-forget: it can write a row,
  // never delay or fail the response. The brief compiles from what is
  // already stored and is appended to the outgoing body only.
  void maybeCapture(deps.log, deps.jev, {
    keyHash: callerScope(c),
    messages,
    signals: decision.signals,
    provenance: decision.fingerprint,
    ...(jevKey !== undefined ? { jevKey } : {}),
    logger: deps.logger,
  });
  // Personal-fact capture (ADR-017) is fire-and-forget too: its own Jev call,
  // off the response path, storing an encrypted fact when the latest turn
  // states one. It never delays or fails the response.
  void maybeCaptureFact(deps.log, deps.jev, deps.factMemory?.encryptor, {
    keyHash: callerScope(c),
    messages,
    provenance: decision.fingerprint,
    ...(embed !== undefined ? { embed } : {}),
    ...(jevKey !== undefined ? { jevKey } : {}),
    logger: deps.logger,
  });
  const brief = await routedBrief(deps.log, callerScope(c), {
    extension,
    taskType: decision.signals?.taskType,
    logger: deps.logger,
  });
  // Posture-aware provider strategy for the upstream call; a caller-supplied
  // `provider` field always wins (see applyProviderStrategy). `posture` was
  // resolved above, before routing, to gate retrieval eligibility.
  // The relevance-gated fact note (ADR-017): one Jev call classifies which
  // stored facts, if any, belong in this request; only relevant ones are
  // appended, and nothing is injected on `low` posture. This runs before the
  // forward, so its cost is bounded and its result rides the outgoing body and
  // `x-milo-facts-injected`.
  const facts = await routedFacts(deps.log, deps.jev, deps.factMemory?.encryptor, {
    keyHash: callerScope(c),
    messages,
    extension,
    skip: posture === "low",
    // Two-stage retrieval (ADR-018): the embed client for the pre-filter and
    // any backfill, and the turn's embedding already in flight since before
    // routing, so the gate rarely waits on it.
    ...(embed !== undefined ? { embed } : {}),
    promptEmbedding,
    ...(jevKey !== undefined ? { jevKey } : {}),
    logger: deps.logger,
  });
  const outgoing = applyFactNote(
    applyReasoningExclusion(applyProviderStrategy(applyBrief(body, brief), posture, decision.model)),
    facts,
  );

  // Context pruning (ADR-014, ADR-013 phase C) sheds safe older context from
  // `outgoing.messages` in place before anything reads them: off by default,
  // over a token floor, never on `low` posture. See prune.ts for the exact
  // conditions; the outcome rides the forward as disclosure only.
  const prune = await maybePrune(deps, outgoing, decision, posture, extension, jevKey);

  // The completeness gate (ADR-013 phase A) applies to this surface only,
  // in both routing modes, on non-trivial cells: see gateFor for the exact
  // conditions (band >= 1, not low posture, no `milo: { gates: false }`).
  const gate = gateFor(c, deps, outgoing, decision, posture, extension);

  // A sampled decision (ADR-010) fans out instead of forwarding once. Only
  // this surface executes sampling; the other dialects opt out at routing
  // time (see routes/messages.ts and routes/responses.ts). A speculative call
  // is a single fast call, never best-of-N, so it cannot be reused here.
  if (decision.samples !== undefined && decision.samples > 1) {
    recordSpeculation(deps, speculation, "miss", decision.id);
    discardSpeculation(speculation);
    return forwardSampled(c, deps, outgoing, decision, {
      candidates,
      task: extension?.task,
      evidence: extension?.evidence,
      briefVersion: brief?.version,
      facts,
      gate,
      prune,
    });
  }

  // A gated single call buffers, grades, maybe retries, then replays; an
  // ungated one keeps the pass-through fast path untouched. A gated call is
  // never served from a speculative result (the grade/retry has to run over
  // the answer first), so speculation cannot be reused here either.
  if (gate !== undefined) {
    recordSpeculation(deps, speculation, "miss", decision.id);
    discardSpeculation(speculation);
    return forwardGated(c, deps, outgoing, decision, gate, brief?.version, prune, facts);
  }

  // The plain single-call forward: the only path a speculative result can be
  // reused on. It is a hit only when the decision resolves to the exact model
  // we speculated, as a single call, AND the fully-enriched body we would now
  // forward is byte-identical to what the speculative call already sent -- so
  // any brief/fact/prune enrichment that changed the body safely degrades to a
  // miss rather than serving a differently-built response. Correctness: the
  // served answer is always the one Jev's decision dictates.
  let state: SpeculationState | undefined = speculationBaseState(deps);
  let inflight: { upstream: Promise<Response>; startedAt: number } | undefined;
  if (speculation !== undefined) {
    const realForwarded = prepareBody(outgoing, decision.model);
    const hit =
      decision.model === speculation.model &&
      (decision.samples === undefined || decision.samples <= 1) &&
      sameBody(realForwarded, speculation.forwarded);
    if (hit) {
      state = "hit";
      inflight = { upstream: speculation.upstream, startedAt: speculation.startedAt };
    } else {
      state = "miss";
      discardSpeculation(speculation);
    }
    recordSpeculation(deps, speculation, state, decision.id);
  }

  return forward(c, deps, outgoing, decision, {
    ...(brief?.version !== undefined ? { briefVersion: brief.version } : {}),
    ...(prune !== undefined ? { prune } : {}),
    ...(facts !== undefined ? { facts } : {}),
    ...(state !== undefined ? { speculation: state } : {}),
    ...(inflight !== undefined ? { inflight } : {}),
  });
}

async function forward(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  opts: {
    briefVersion?: string;
    prune?: PruneOutcome;
    facts?: RoutedFacts;
    /** Speculative-routing disclosure for `x-milo-speculation` (ADR-025). */
    speculation?: SpeculationState;
    /**
     * A speculative call started before Jev answered (a hit): its response is
     * awaited here instead of making a fresh one, so its wall time overlapped
     * the classification. The body that produced it is byte-identical to the
     * one this forward would build (the caller's hit test guarantees it).
     */
    inflight?: { upstream: Promise<Response>; startedAt: number };
  } = {},
): Promise<Response> {
  const { briefVersion, prune, facts } = opts;
  const forwarded = prepareBody(body, decision.model);
  const startedAt = opts.inflight?.startedAt ?? deps.now();

  let upstream: Response;
  try {
    upstream =
      opts.inflight !== undefined
        ? await opts.inflight.upstream
        : await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, { status: 502, latencyMs: deps.now() - startedAt });
    deps.logger.error("openrouter chat completions failed", { decisionId: decision.id, error: errorMessage(err) });
    return upstreamUnavailable(c);
  }

  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);
  applyJevTransportHeader(headers, deps);
  applyPruneHeaders(headers, prune);
  if (opts.speculation !== undefined) headers.set(SPECULATION_HEADER, opts.speculation);
  for (const [k, v] of Object.entries(briefHeaders(briefVersion))) headers.set(k, v);
  for (const [k, v] of Object.entries(factHeaders(facts))) headers.set(k, v);

  // An upstream error is JSON however the request was made, so it takes the
  // buffered path and passes through with its own status. On success, scrub
  // reasoning fields unless the caller explicitly asked to see them.
  const ctx = { surface: "chat" as const, model: decision.model, decisionId: decision.id };
  const scrub = !wantsVisibleReasoning(body);

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    let recorded: ReadableStream<Uint8Array> = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, {
          status: upstream.status,
          latencyMs: deps.now() - startedAt,
          ...pruneRecord(prune),
        });
      }),
    );
    if (scrub) recorded = recorded.pipeThrough(stripChatReasoningSse());
    // The charge settles from the usage in the stream's final frames, after
    // the client already has every byte.
    return new Response(chargeStream(c, deps, headers, ctx, recorded), { status: upstream.status, headers });
  }

  let text = await upstream.text();
  if (scrub && upstream.ok) text = stripChatReasoningBody(text);
  const usage = upstream.ok ? readBodyUsage("chat", text) : {};
  const record: Upstream = { status: upstream.status, latencyMs: deps.now() - startedAt, ...pruneRecord(prune) };
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

// ---------------------------------------------------------------------------
// Speculative routing (ADR-025)
// ---------------------------------------------------------------------------

/** The `x-milo-speculation` value when speculation is on but nothing was started. */
function speculationBaseState(deps: AppDeps): SpeculationState | undefined {
  return deps.speculation?.enabled === true ? "off" : undefined;
}

/**
 * Starts the single cheapest fast-tier call in parallel with the Jev
 * classification when this deployment opted in and the router judges the
 * request eligible (`Router.speculativeModel`). Returns `undefined` when no
 * call was started -- speculation off, or the request ineligible.
 *
 * The body is built with exactly the non-decision-dependent transforms the
 * plain forward applies (`applyProviderStrategy` for the speculated model, plus
 * the default reasoning exclusion), so a later hit is byte-identical when no
 * brief/fact/prune enrichment fired. The call carries an abort signal so a miss
 * can stop its token spend promptly, and its rejection is pre-handled so an
 * abort never surfaces as an unhandled rejection.
 */
function beginSpeculation(
  c: Context,
  deps: AppDeps,
  body: Body,
  request: RouteRequest,
  posture: CostPosture,
): Speculation | undefined {
  if (deps.speculation?.enabled !== true) return undefined;
  const model = deps.router.speculativeModel(request);
  if (model === undefined) return undefined;

  const forwarded = prepareBody(applyReasoningExclusion(applyProviderStrategy(body, posture, model)), model);
  const abort = new AbortController();
  const startedAt = deps.now();
  const upstream = deps.openRouter.chatCompletions({
    headers: upstreamHeadersFor(c),
    body: forwarded,
    signal: abort.signal,
  });
  // A miss aborts and never awaits this promise; a hit re-awaits it in
  // `forward`. Either way it already has a rejection handler, so an abort or an
  // upstream error can never become an unhandled rejection while it is pending.
  upstream.catch(() => undefined);

  return { model, forwarded, startedAt, abort, upstream };
}

/**
 * Discards a speculative call: aborts it (stopping any in-flight token spend at
 * once, so a miss does not keep consuming an upstream concurrency slot) and
 * cancels its body if it already arrived, so nothing leaks a reader.
 */
function discardSpeculation(speculation: Speculation | undefined): void {
  if (speculation === undefined) return;
  speculation.abort.abort();
  void speculation.upstream.then((response) => response.body?.cancel()).catch(() => undefined);
}

/** Discloses a speculation outcome to the operator log, so hit-rate and wasted calls are computable. */
function recordSpeculation(
  deps: AppDeps,
  speculation: Speculation | undefined,
  state: SpeculationState,
  decisionId: string,
): void {
  if (speculation === undefined) return;
  deps.logger.info("speculation", { decisionId, state, model: speculation.model });
}

/** Whether two prepared bodies are byte-identical, and so the same request. */
function sameBody(a: Body, b: Body): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
