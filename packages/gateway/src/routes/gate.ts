/**
 * Executing the completeness gate (ADR-013 phase A) behind the routed
 * `POST /v1/chat/completions` surface, both routing modes.
 *
 * After the final answer is in hand -- the single forward's body, or the
 * sampled fan-out's pick -- one Jev call on Milo's key asks whether it
 * addresses every part of the request (`checkCompleteness`, core). A
 * `complete` verdict, and any gate failure at all, serves the answer as-is:
 * the gate can spend Milo a classification call and the user a retry, but
 * it can never fail a request that already has an answer. A failing verdict
 * buys exactly ONE retry -- same model, the original messages plus the
 * failure type's fixed template as a final system message -- then a second
 * Jev call rates BOTH answers with the ranking questions ADR-010 validated,
 * and the better one is served (the original wins ties, and wins whenever
 * the rating itself fails).
 *
 * The gate runs where all of these hold (`gateFor`):
 *
 *   - the decision carries signals whose difficulty band is >= 1 -- band 0
 *     is the trivial cell, and a completeness check there costs more than
 *     it saves (a forced tier has no signals, so it never gates);
 *   - the posture is not `low` ("cheap" is a promise; ADR-013);
 *   - the request did not opt out with `milo: { gates: false }`;
 *   - the deployment has a Jev client to ask.
 *
 * Disclosure: `x-milo-completeness` carries the verdict, `x-milo-retry: 1`
 * says the retry fired, `x-milo-gate-pick` which answer won. The decision
 * record's upstream block stores the verdict and the retry's own usage
 * (`gate`), with the retry's tokens folded into the row's aggregate -- the
 * caller is billed for what was actually generated, both answers included.
 * No content is stored.
 *
 * A streaming client is answered by buffer-and-replay exactly like sampling:
 * the graded (or retried) completion goes out as well-formed SSE.
 */

import type { Context } from "hono";
import {
  checkCompleteness,
  compareRanked,
  computeBand,
  isStreaming,
  prepareBody,
  rankAnswer,
  retryMessages,
} from "@milo/core";
import type {
  ChatMessage,
  CostPosture,
  GateFailureType,
  GateUpstream,
  MiloRequestExtension,
  RouteDecision,
} from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { chargeBuffered, upstreamHeadersFor } from "../billing.js";
import { briefHeaders } from "../brief.js";
import { errorMessage, errorResponse } from "../errors.js";
import { answerText, replayAsSse } from "./sampling.js";
import { applyMiloHeaders } from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { addUsage, readBodyUsage, toUpstreamRecord } from "./usage.js";
import type { UpstreamUsage } from "./usage.js";

export const COMPLETENESS_HEADER = "x-milo-completeness";
export const RETRY_HEADER = "x-milo-retry";
export const GATE_PICK_HEADER = "x-milo-gate-pick";

/** One finished answer as the gate handles it: body, message, serialized text. */
export type GateAnswer = {
  json: Record<string, unknown>;
  message: Record<string, unknown>;
  text: string;
};

/** What running the gate over one answer produced. */
export type GateResult = {
  /** The answer to serve: the original, or the retry when it rated better. */
  answer: GateAnswer;
  /** Disclosure headers to set on the response. */
  headers: Record<string, string>;
  /** The retry call's usage, to fold into the row's aggregate and the bill. */
  extraUsage?: UpstreamUsage;
  /** The decision record's `gate` block. */
  record: GateUpstream;
};

export type GateRunner = (answer: GateAnswer) => Promise<GateResult>;

/** A failure class for the record: a name, never upstream text. */
function classify(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(error.message)) return "network";
    return error.name === "Error" ? "error" : error.name;
  }
  return "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `choices[0].message` of a buffered chat completion, or undefined. */
export function completionMessage(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = json["choices"];
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const message = first["message"];
  return isRecord(message) ? message : undefined;
}

/**
 * Whether the gate applies to this decision, and the runner for it when it
 * does. `body` is the outgoing (brief-applied) request body; its messages
 * are the task the gate and the retry both read.
 */
export function gateFor(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  posture: CostPosture,
  extension: MiloRequestExtension | undefined,
): GateRunner | undefined {
  if (deps.jev === undefined) return undefined;
  if (extension?.gates === false) return undefined;
  if (posture === "low") return undefined;
  if (decision.signals === undefined) return undefined;
  if (computeBand(decision.signals) < 1) return undefined;
  const jev = deps.jev;
  return (answer) => runGate(c, deps, jev, body, decision, answer);
}

/**
 * Runs the gate over one finished answer. Never throws and never fails the
 * request: every failure path resolves to "serve an answer", with the
 * failure named in the record.
 */
async function runGate(
  c: Context,
  deps: AppDeps,
  jev: NonNullable<AppDeps["jev"]>,
  body: Body,
  decision: RouteDecision,
  answer: GateAnswer,
): Promise<GateResult> {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];

  let verdict: GateFailureType;
  let confidence: number;
  try {
    const check = await checkCompleteness(jev, messages, answerText(answer.message));
    if (check.verdict === "complete") {
      return {
        answer,
        headers: { [COMPLETENESS_HEADER]: "complete" },
        record: { verdict: "complete", confidence: check.confidence },
      };
    }
    verdict = check.verdict;
    confidence = check.confidence;
  } catch (error) {
    // The check itself failed: the answer goes out exactly as a passing one
    // would (never fail the request on a gate); the record says `error`.
    deps.logger.warn("completeness check failed", { decisionId: decision.id, error: classify(error) });
    return { answer, headers: { [COMPLETENESS_HEADER]: "complete" }, record: { verdict: "error" } };
  }

  // A failing verdict buys exactly one retry: same model, the original
  // messages plus the failure type's fixed template as a final system
  // message, buffered whatever the client asked for.
  const retryBody = prepareBody(body, decision.model);
  retryBody["messages"] = retryMessages(messages, verdict);
  retryBody["stream"] = false;
  delete retryBody["stream_options"];

  const headers: Record<string, string> = { [COMPLETENESS_HEADER]: verdict, [RETRY_HEADER]: "1" };
  const record: GateUpstream = { verdict, confidence, retried: true, pick: "original" };
  const serveOriginal = (): GateResult => ({ answer, headers: { ...headers, [GATE_PICK_HEADER]: "original" }, record });

  const retryStart = deps.now();
  let retryResponse: Response;
  try {
    retryResponse = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: retryBody });
  } catch (error) {
    record.retry = { status: 0, latencyMs: deps.now() - retryStart, error: classify(error) };
    return serveOriginal();
  }
  const retryText = await retryResponse.text();
  const retryLatencyMs = deps.now() - retryStart;
  const retryUsage = retryResponse.ok ? readBodyUsage("chat", retryText) : {};
  record.retry = {
    status: retryResponse.status,
    latencyMs: retryLatencyMs,
    ...toUpstreamRecord(retryUsage),
    ...(retryResponse.ok ? {} : { error: `http_${retryResponse.status}` }),
  };
  if (!retryResponse.ok) return serveOriginal();

  let retryJson: unknown;
  try {
    retryJson = JSON.parse(retryText);
  } catch {
    record.retry.error = "malformed_body";
    return { ...serveOriginal(), extraUsage: retryUsage };
  }
  const retryMessage = isRecord(retryJson) ? completionMessage(retryJson) : undefined;
  if (!isRecord(retryJson) || retryMessage === undefined) {
    record.retry.error = "malformed_body";
    return { ...serveOriginal(), extraUsage: retryUsage };
  }

  // Rate BOTH answers with the validated ranking questions; the better one
  // is served, the original winning ties (index 0 in `compareRanked`) and
  // winning outright when the rating itself fails.
  try {
    const [original, retry] = await Promise.all([
      rankAnswer(jev, messages, answerText(answer.message)),
      rankAnswer(jev, messages, answerText(retryMessage)),
    ]);
    record.originalQuality = original.quality;
    record.retryQuality = retry.quality;
    const ranked = [
      { index: 0, rank: original },
      { index: 1, rank: retry },
    ].sort(compareRanked);
    if (ranked[0]?.index === 1) {
      record.pick = "retry";
      return {
        answer: { json: retryJson, message: retryMessage, text: retryText },
        headers: { ...headers, [GATE_PICK_HEADER]: "retry" },
        extraUsage: retryUsage,
        record,
      };
    }
  } catch (error) {
    deps.logger.warn("gate answer rating failed; serving the original", {
      decisionId: decision.id,
      error: classify(error),
    });
  }
  return { ...serveOriginal(), extraUsage: retryUsage };
}

// ---------------------------------------------------------------------------
// The gated single forward
// ---------------------------------------------------------------------------

/**
 * The routed single-call forward when the gate applies: like `forward` in
 * `chat.ts`, but the upstream call is buffered whatever the client asked
 * for -- the gate has to read the whole answer before a byte goes out --
 * and a streaming client gets the served answer replayed as well-formed
 * SSE, exactly like a sampled decision. Billing charges the sum of what was
 * actually generated: the answer, plus the retry when one fired.
 */
export async function forwardGated(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  gate: GateRunner,
  briefVersion?: string,
): Promise<Response> {
  const forwarded = prepareBody(body, decision.model);
  forwarded["stream"] = false;
  delete forwarded["stream_options"];
  const startedAt = deps.now();

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, { status: 502, latencyMs: deps.now() - startedAt });
    deps.logger.error("openrouter chat completions failed", { decisionId: decision.id, error: errorMessage(err) });
    return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
  }

  const text = await upstream.text();
  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);
  for (const [k, v] of Object.entries(briefHeaders(briefVersion))) headers.set(k, v);

  // An upstream error passes through with its own status, ungated, exactly
  // as the ordinary forward would answer it.
  if (!upstream.ok) {
    deps.recordUpstream(decision.id, { status: upstream.status, latencyMs: deps.now() - startedAt });
    return new Response(text, { status: upstream.status, headers });
  }

  const usage = readBodyUsage("chat", text);
  const ctx = { surface: "chat" as const, model: decision.model, decisionId: decision.id };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const message = isRecord(parsed) ? completionMessage(parsed) : undefined;

  // A body that is not a well-formed completion cannot be graded or retried;
  // it passes through as-is with no gate headers, like the ordinary forward.
  if (!isRecord(parsed) || message === undefined) {
    deps.recordUpstream(decision.id, {
      status: upstream.status,
      latencyMs: deps.now() - startedAt,
      ...toUpstreamRecord(usage),
    });
    await chargeBuffered(c, deps, headers, ctx, usage);
    return new Response(text, { status: upstream.status, headers });
  }

  const result = await gate({ json: parsed, message, text });
  for (const [k, v] of Object.entries(result.headers)) headers.set(k, v);

  const total = addUsage(usage, result.extraUsage);
  const record: Upstream = {
    status: upstream.status,
    latencyMs: deps.now() - startedAt,
    ...toUpstreamRecord(total),
    gate: result.record,
  };
  deps.recordUpstream(decision.id, record);
  await chargeBuffered(c, deps, headers, ctx, total);

  if (isStreaming(body)) {
    headers.set("content-type", "text/event-stream");
    return new Response(replayAsSse(result.answer), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(result.answer.text, { status: 200, headers });
}
