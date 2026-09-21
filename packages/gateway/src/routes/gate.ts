/**
 * Executing the completeness gate (ADR-013 phase A) behind the routed
 * `POST /v1/chat/completions` surface, both routing modes.
 *
 * After the final answer is in hand -- the single forward's body, or the
 * sampled fan-out's pick -- one Jev call on Milo's key asks whether it
 * addresses every part of the request (`checkCompleteness`, core). Any gate
 * failure at all serves the answer as-is: the gate can spend Milo a
 * classification call and the user a retry, but it can never fail a request
 * that already has an answer.
 *
 * Three outcomes:
 *
 *   - `complete` at or above `GATE_TRUST_CONFIDENCE` -- served as-is,
 *     `x-milo-completeness: complete`, one Jev call spent;
 *   - `complete` BELOW it -- suspect, not a pass. Production `complete`
 *     verdicts at confidence 0.31-0.57 sat on answers whose own sampled
 *     quality was 0.6-2.1, so the gate rates the answer itself: at or above
 *     `GATE_SUSPECT_QUALITY` it is served with
 *     `x-milo-completeness: complete-low-confidence`, below it the answer
 *     buys a retry like a failing verdict does;
 *   - a failing verdict -- exactly ONE retry.
 *
 * The retry runs on the strongest model the decision knows about
 * (`escalationFor`: a sampled cell's `unsampledTier`, an `unsampledModel`, or
 * the controller's band-3 orchestrator), not on the model that just missed --
 * the one retry seen in production re-begged the same fast model whose five
 * samples had all rated 0.57-0.85 and got 0.79 back. It carries the original
 * messages plus the failure type's fixed template as a final system message.
 * A second Jev call then rates BOTH answers with the ranking questions
 * ADR-010 validated, and the better one is served (the original wins ties,
 * and wins whenever the rating itself fails). Still at most one retry.
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
 * says the retry fired, `x-milo-retry-model` names the model it escalated to,
 * `x-milo-gate-pick` which answer won. The decision record's upstream block
 * stores the verdict, the retry's model and its own usage (`gate`), with the
 * retry's tokens folded into the row's aggregate -- the caller is billed for
 * what was actually generated, both answers included. No content is stored.
 *
 * A streaming client is answered by buffer-and-replay exactly like sampling:
 * the graded (or retried) completion goes out as well-formed SSE.
 */

import type { Context } from "hono";
import {
  checkCompleteness,
  compareRanked,
  computeBand,
  escalationFor,
  extractClaims,
  isStreaming,
  prepareBody,
  rankAnswer,
  retryMessages,
  verifyClaims,
  GATE_SUSPECT_QUALITY,
  GATE_TRUST_CONFIDENCE,
  LOW_CONFIDENCE_FAILURE,
} from "@milo/core";
import type {
  ChatMessage,
  CostPosture,
  GateFailureType,
  GateUpstream,
  MiloRequestExtension,
  RankScore,
  RouteDecision,
  VerifyGroundTruth,
  VerifyResult,
} from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { chargeBuffered, forwardedJevKey, upstreamHeadersFor } from "../billing.js";
import { briefHeaders } from "../brief.js";
import { factHeaders } from "../facts.js";
import type { RoutedFacts } from "../facts.js";
import { errorMessage, errorResponse } from "../errors.js";
import { applyPruneHeaders, pruneRecord } from "./prune.js";
import type { PruneOutcome } from "./prune.js";
import { answerText, replayAsSse } from "./sampling.js";
import { parseVerifyInput } from "./verify.js";
import {
  stripChatReasoningBody,
  stripChatReasoningPayload,
  wantsVisibleReasoning,
} from "./chat-reasoning.js";
import { applyJevTransportHeader, applyMiloHeaders, resolveRoster, retargetProviderStrategy } from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { addUsage, readBodyUsage, toUpstreamRecord } from "./usage.js";
import type { UpstreamUsage } from "./usage.js";

export const COMPLETENESS_HEADER = "x-milo-completeness";
export const RETRY_HEADER = "x-milo-retry";
export const GATE_PICK_HEADER = "x-milo-gate-pick";
/** The model an escalated retry ran on, when it was not the one that answered. */
export const RETRY_MODEL_HEADER = "x-milo-retry-model";
/**
 * The ground-truth verification finding (ADR-019): `clean` | `unsupported` |
 * `contradicted`, set only when the request supplied git/receipts ground truth
 * via `milo: { verify: { git, receipts } }` on a coding/agentic turn.
 */
export const VERIFY_HEADER = "x-milo-verify";

/** What `x-milo-completeness` says for a `complete` verdict Jev was unsure of. */
export const LOW_CONFIDENCE_COMPLETENESS = "complete-low-confidence";

/**
 * The wall-clock budget a fresh escalated retry runs under (ADR-027 change 4).
 * A retry normally finishes well under this; the cap exists so a slow escalated
 * retry on the strongest model cannot blow up the tail latency of a request that
 * already holds a serviceable answer. On timeout the abort serves the original.
 */
export const GATE_RETRY_BUDGET_MS = 30000;

/** The characters a complete answer's last non-whitespace char may be (ADR-027). */
const COMPLETE_ENDINGS = new Set([".", "!", "?", ")", "]", "}", '"', "'", "`"]);

/**
 * The decision-log `gate` block plus two gateway-local, purely additive
 * fields: which model the retry ran on, and whether the verdict was a
 * low-confidence `complete` the gate re-rated itself. Like `SampleRow` in
 * `sampling.ts`, folding them into the `GateUpstream` contract
 * (`packages/core/src/types.ts`) needs an ADR; the log stores the block as
 * JSON, so they round-trip either way.
 */
export type GateRecord = Omit<GateUpstream, "pick"> & {
  /**
   * Which answer was served. Widens `GateUpstream.pick` (`original`/`retry`)
   * with the gateway-local `sibling` (ADR-027 change 3): a reused best-of-N
   * candidate. The widening is gateway-local -- the log stores the block as
   * JSON, so it round-trips, and folding `sibling` into the core contract would
   * need its own ADR, the same reasoning as `retryModel`.
   */
  pick?: "original" | "retry" | "sibling";
  retryModel?: string;
  lowConfidence?: boolean;
  /**
   * The Jev completeness check was skipped: the answer was served from a local
   * fast path (ADR-027) -- a `finish_reason`-clean, well-formed completion, a
   * `max_tokens` truncation, or a reused complete sibling -- without spending a
   * `checkCompleteness` call. Purely additive gateway-local metadata, same
   * reasoning as `retryModel`.
   */
  checkSkipped?: boolean;
  /**
   * The ground-truth verification block (ADR-019), present only when the
   * request supplied ground truth. Purely additive gateway-local metadata; the
   * log stores the gate block as JSON, so it round-trips without a core-type
   * change (the same reasoning as `retryModel`/`lowConfidence`).
   */
  verify?: { finding: string; supported: number; unsupported: number; contradicted: number; blocking: boolean };
};

/**
 * The gate record as the decision log's `gate` slot (core `GateUpstream`) takes
 * it. The only gap is the gateway-local `pick: "sibling"` widening (ADR-027);
 * the slot stores the block as JSON, so the string round-trips. A localized
 * assertion here keeps the widening gateway-local without a core-type change.
 */
export function storedGate(record: GateRecord): GateUpstream {
  return record as GateUpstream;
}

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
  record: GateRecord;
};

/**
 * Runs the gate over one finished answer. On a sampled request `siblings`
 * carries the OTHER finished sample answers, ranked best-first, so the gate can
 * reuse a complete one instead of spending a fresh retry (ADR-027 change 3). The
 * single forward passes none.
 */
export type GateRunner = (answer: GateAnswer, siblings?: GateAnswer[]) => Promise<GateResult>;

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

/**
 * The ground truth a request opted into for Layer 3 (ADR-019): read
 * `milo.verify` off the outgoing body (still present -- `prepareBody` strips
 * `milo` only when it forwards) and parse its git/receipts. Returns `undefined`
 * when the request supplied none, so an ordinary chat turn is never verified
 * against ground truth it did not send. Reuses the /v1/verify parser so the two
 * surfaces read the exact same shape.
 */
export function groundTruthFrom(body: Body): VerifyGroundTruth | undefined {
  const milo = body["milo"];
  if (!isRecord(milo)) return undefined;
  const raw = milo["verify"];
  if (!isRecord(raw)) return undefined;
  const { ground } = parseVerifyInput(raw);
  return ground.git !== undefined || (ground.receipts !== undefined && ground.receipts.length > 0)
    ? ground
    : undefined;
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
 * `choices[0].finish_reason` of a buffered chat completion as a string, or
 * undefined. Read on the local pre-gate (ADR-027) to tell a `max_tokens`
 * truncation (`"length"`) and a clean stop (`"stop"`) apart before any Jev call.
 */
export function finishReason(json: Record<string, unknown>): string | undefined {
  const choices = json["choices"];
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const reason = first["finish_reason"];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * A cheap, conservative "this reads as a finished answer" test (ADR-027): the
 * trimmed text is non-empty, its ``` fences are balanced (an even count), and it
 * ends on a sentence terminator, a closing bracket/quote, or a backtick. A false
 * negative merely falls through to the Jev completeness check, so a valid answer
 * is never demoted; only an obviously-complete answer takes the fast path.
 */
export function looksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const fences = trimmed.match(/```/g);
  if (fences !== null && fences.length % 2 !== 0) return false;
  return COMPLETE_ENDINGS.has(trimmed[trimmed.length - 1] as string);
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
  const candidates = extension?.candidates;
  // ADR-022: under the OpenRouter Jev transport, every gate Jev call (the
  // completeness check, the low-confidence re-rating, the both-answers rating,
  // and ground-truth verification) bills to the caller's forwarded key.
  const jevKey = forwardedJevKey(c, deps);
  return (answer, siblings) => runGate(c, deps, jev, body, decision, answer, candidates, jevKey, siblings);
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
  candidates?: string[],
  jevKey?: string,
  siblings?: GateAnswer[],
): Promise<GateResult> {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  const answered = answerText(answer.message);

  // Layer 3 (ADR-019): when the request supplied git/receipts ground truth via
  // `milo: { verify: {...} }` on a coding/agentic turn, additionally check the
  // answer's load-bearing claims against that ground truth -- not just the
  // text's self-consistency. FAIL-OPEN: any hiccup here leaves the completeness
  // flow exactly as it was. A CONFIDENT contradiction (`blocking`) is treated
  // like a completeness failure and buys the SAME single retry; a non-blocking
  // finding (`clean`/`unsupported`) is disclosure only, on `x-milo-verify`.
  const ground = groundTruthFrom(body);
  let verify: VerifyResult | undefined;
  if (ground !== undefined) {
    try {
      verify = await verifyClaims(jev, extractClaims(answered), ground, undefined, jevKey);
    } catch (error) {
      deps.logger.warn("ground-truth verification failed; disclosing nothing", {
        decisionId: decision.id,
        error: classify(error),
      });
    }
  }
  const verifyHeaders: Record<string, string> =
    verify !== undefined ? { [VERIFY_HEADER]: verify.summary.finding } : {};
  const verifyPatch: Pick<GateRecord, "verify"> =
    verify !== undefined
      ? {
          verify: {
            finding: verify.summary.finding,
            supported: verify.summary.supported,
            unsupported: verify.summary.unsupported,
            contradicted: verify.summary.contradicted,
            blocking: verify.summary.blocking,
          },
        }
      : {};
  const forceRetry = verify?.summary.blocking === true;
  /** Merge the verify disclosure (header + record) into a served result. */
  const withVerify = (result: GateResult): GateResult => ({
    ...result,
    headers: { ...result.headers, ...verifyHeaders },
    record: { ...result.record, ...verifyPatch },
  });

  // Free local pre-gate (ADR-027): before spending a Jev completeness call,
  // inspect the buffered answer's `finish_reason`. This runs ONLY when a
  // ground-truth contradiction has not already forced a retry (`!forceRetry`),
  // so ADR-019's behaviour is preserved exactly.
  if (!forceRetry) {
    const reason = finishReason(answer.json);
    // Change 2: a `max_tokens` truncation. The caller's own cap cut the answer
    // off; a retry runs under the same cap and only re-truncates, so serve it
    // as-is -- no Jev call, no retry.
    if (reason === "length") {
      return withVerify({
        answer,
        headers: { [COMPLETENESS_HEADER]: "truncated" },
        record: { verdict: "truncated" },
      });
    }
    // Change 1: an obviously-complete answer. A clean stop on a well-formed
    // completion is complete by inspection, so serve it exactly as a passing
    // check would -- no Jev call.
    if (reason === "stop" && looksComplete(answered)) {
      return withVerify({
        answer,
        headers: { [COMPLETENESS_HEADER]: "complete" },
        record: { verdict: "complete", checkSkipped: true },
      });
    }
  }

  let check;
  try {
    check = await checkCompleteness(jev, messages, answered, undefined, jevKey);
  } catch (error) {
    // The check itself failed: the answer goes out exactly as a passing one
    // would (never fail the request on a gate); the record says `error`. A
    // ground-truth contradiction still warrants the retry, even here.
    deps.logger.warn("completeness check failed", { decisionId: decision.id, error: classify(error) });
    if (!forceRetry) {
      return withVerify({ answer, headers: { [COMPLETENESS_HEADER]: "complete" }, record: { verdict: "error" } });
    }
    check = undefined;
  }

  // The failure type the retry template comes from, the value
  // `x-milo-completeness` carries, and the record the outcome is written
  // into -- settled by the verdict AND, on a `complete` verdict, by how sure
  // Jev was of it. A ground-truth contradiction (`forceRetry`) overrides a
  // `complete` verdict and takes the retry.
  let verdict: GateFailureType;
  let disclosed: string;
  let record: GateRecord;
  /** The original's rating, when the suspect path already paid for it. */
  let originalRank: RankScore | undefined;

  if (check === undefined) {
    // The completeness check was unavailable but ground truth contradicted a
    // load-bearing claim: retry as if incomplete, disclosing the check as such.
    verdict = LOW_CONFIDENCE_FAILURE;
    disclosed = "complete";
    record = { verdict: "error", retried: true, pick: "original" };
  } else if (check.verdict === "complete") {
    if (check.confidence >= GATE_TRUST_CONFIDENCE && !forceRetry) {
      return withVerify({
        answer,
        headers: { [COMPLETENESS_HEADER]: "complete" },
        record: { verdict: "complete", confidence: check.confidence },
      });
    }

    // A `complete` Jev is not sure of (or one ground truth contradicts): rate
    // the answer rather than trust the verdict (GATE_TRUST_CONFIDENCE names the
    // evidence). A rating that cannot be had is not a reason to spend a retry,
    // so absent a contradiction it serves as-is.
    try {
      originalRank = await rankAnswer(jev, messages, answered, undefined, jevKey);
    } catch (error) {
      deps.logger.warn("low-confidence gate re-rating failed; serving as-is", {
        decisionId: decision.id,
        error: classify(error),
      });
    }
    const trusted = check.confidence >= GATE_TRUST_CONFIDENCE;
    if (!forceRetry && (originalRank === undefined || originalRank.quality >= GATE_SUSPECT_QUALITY)) {
      return withVerify({
        answer,
        headers: { [COMPLETENESS_HEADER]: trusted ? "complete" : LOW_CONFIDENCE_COMPLETENESS },
        record: {
          verdict: "complete",
          confidence: check.confidence,
          ...(trusted ? {} : { lowConfidence: true }),
          ...(originalRank !== undefined ? { originalQuality: originalRank.quality } : {}),
        },
      });
    }
    verdict = LOW_CONFIDENCE_FAILURE;
    disclosed = trusted ? "complete" : LOW_CONFIDENCE_COMPLETENESS;
    record = {
      verdict: "complete",
      confidence: check.confidence,
      ...(trusted ? {} : { lowConfidence: true }),
      retried: true,
      pick: "original",
    };
  } else {
    verdict = check.verdict;
    disclosed = check.verdict;
    record = { verdict: check.verdict, confidence: check.confidence, retried: true, pick: "original" };
  }

  // Reuse a best-of-N sibling before a fresh retry (ADR-027 change 3): on a
  // sampled request the other finished samples are already generated, ranked,
  // and paid for. If one of them is complete by the SAME cheap local test as
  // the pre-gate, serve it instead of spending a fresh escalated retry. No
  // upstream retry happens and nothing new is generated, so there is no
  // `extraUsage` and `x-milo-retry` is not set.
  if (siblings !== undefined) {
    // The SAME cheap test as the pre-gate (change 1): `finish_reason` clean and
    // the MESSAGE text well-formed. `GateAnswer.text` is the full serialized
    // completion body (it ends on `}` and would always "look complete"), so the
    // test reads the message content via `answerText`, exactly as change 1 does.
    const reuse = siblings.find((s) => finishReason(s.json) === "stop" && looksComplete(answerText(s.message)));
    if (reuse !== undefined) {
      const siblingRecord: GateRecord = { ...record, pick: "sibling", checkSkipped: true, ...verifyPatch };
      delete siblingRecord.retried;
      return {
        answer: reuse,
        headers: { [COMPLETENESS_HEADER]: disclosed, [GATE_PICK_HEADER]: "sibling", ...verifyHeaders },
        record: siblingRecord,
      };
    }
  }

  // Exactly ONE retry, on the strongest model this decision knows about
  // rather than the one that just missed (`escalationFor`): the original
  // messages plus the failure type's fixed template as a final system
  // message, buffered whatever the client asked for. When nothing stronger
  // exists the retry is the same-model re-prompt it always was.
  const escalation = escalationFor(decision, await resolveRoster(c, deps), candidates, {
    longOutput: decision.signals?.longOutput ?? 0,
  });
  const retryModel = escalation?.model ?? decision.model;
  // The outgoing body carries a provider price ceiling computed for the model
  // that answered; a retry on a different model needs its own (see
  // `retargetProviderStrategy` -- the wrong ceiling is a 404).
  const retryBody = prepareBody(retargetProviderStrategy(body, decision.model, retryModel), retryModel);
  retryBody["messages"] = retryMessages(messages, verdict);
  retryBody["stream"] = false;
  delete retryBody["stream_options"];

  const headers: Record<string, string> = {
    [COMPLETENESS_HEADER]: disclosed,
    [RETRY_HEADER]: "1",
    ...verifyHeaders,
    ...(escalation !== undefined ? { [RETRY_MODEL_HEADER]: retryModel } : {}),
  };
  record.retryModel = retryModel;
  if (verifyPatch.verify !== undefined) record.verify = verifyPatch.verify;
  const serveOriginal = (): GateResult => ({ answer, headers: { ...headers, [GATE_PICK_HEADER]: "original" }, record });

  // Bound the fresh retry with a hard time budget (ADR-027 change 4): a slow
  // escalated retry on the strongest model must not blow up tail latency on a
  // request that already holds a serviceable answer. On timeout the abort is
  // classified as "timeout" by the catch below, which serves the original.
  const retryAbort = new AbortController();
  const retryTimeout = setTimeout(() => retryAbort.abort(), GATE_RETRY_BUDGET_MS);
  const retryStart = deps.now();
  let retryResponse: Response;
  try {
    retryResponse = await deps.openRouter.chatCompletions({
      headers: upstreamHeadersFor(c),
      body: retryBody,
      signal: retryAbort.signal,
    });
  } catch (error) {
    record.retry = { status: 0, latencyMs: deps.now() - retryStart, error: classify(error) };
    return serveOriginal();
  } finally {
    clearTimeout(retryTimeout);
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
      // The suspect path already rated the original; one Jev call is enough.
      originalRank !== undefined ? Promise.resolve(originalRank) : rankAnswer(jev, messages, answered, undefined, jevKey),
      rankAnswer(jev, messages, answerText(retryMessage), undefined, jevKey),
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
  prune?: PruneOutcome,
  facts?: RoutedFacts,
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
  applyJevTransportHeader(headers, deps);
  applyPruneHeaders(headers, prune);
  for (const [k, v] of Object.entries(briefHeaders(briefVersion))) headers.set(k, v);
  for (const [k, v] of Object.entries(factHeaders(facts))) headers.set(k, v);

  // An upstream error passes through with its own status, ungated, exactly
  // as the ordinary forward would answer it.
  if (!upstream.ok) {
    deps.recordUpstream(decision.id, {
      status: upstream.status,
      latencyMs: deps.now() - startedAt,
      ...pruneRecord(prune),
    });
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
      ...pruneRecord(prune),
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
    gate: storedGate(result.record),
    ...pruneRecord(prune),
  };
  deps.recordUpstream(decision.id, record);
  await chargeBuffered(c, deps, headers, ctx, total);

  const scrub = !wantsVisibleReasoning(body);
  let answer = result.answer;
  if (scrub) {
    const json = stripChatReasoningPayload(answer.json);
    const message =
      isRecord(json) && Array.isArray(json["choices"]) && isRecord(json["choices"][0])
        ? (json["choices"][0] as Record<string, unknown>)["message"]
        : answer.message;
    answer = {
      json: isRecord(json) ? json : answer.json,
      message: isRecord(message) ? message : answer.message,
      text: stripChatReasoningBody(answer.text),
    };
  }

  if (isStreaming(body)) {
    headers.set("content-type", "text/event-stream");
    return new Response(replayAsSse(answer), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(answer.text, { status: 200, headers });
}
