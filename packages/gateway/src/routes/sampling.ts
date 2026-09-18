/**
 * Executing a sampled decision (ADR-010): the best-of-N fan-out behind
 * `POST /v1/chat/completions` when policy v4 resolved a cell to
 * `{ tier: "fast", samples: N }`.
 *
 * The shape of the trade: N identical upstream calls on the user's key, each
 * with one of the varied framings from `PROMPT_VARIANTS` appended to the
 * system prompt and each under its own wall-clock cap, then one Jev
 * score+correctness call per finished answer on Milo's key, then the answer
 * with the highest expected quality (correctness breaking ties) goes back to
 * the client. Tool-call answers are ranked and picked like any other; the
 * client executes only what it receives.
 *
 * Failure ladder, in order of preference:
 *
 *   1. every sample failed -> one ordinary unsampled call on the decision's
 *      `unsampledTier`, exactly what policy v3 would have bought;
 *   2. samples succeeded but Jev could not rank any of them -> the first
 *      successful sample, and the decision record says `ranking_failed`;
 *   3. otherwise -> Jev's pick.
 *
 * Every sample is buffered (the fan-out has to finish before there is
 * anything to choose), so a streaming request is answered by replaying the
 * chosen answer as well-formed SSE: one content chunk, one final chunk with
 * the finish reason and usage, then `[DONE]`.
 *
 * Disclosure: `x-milo-samples` and `x-milo-sample-pick` on the response; the
 * decision record's upstream block aggregates tokens and cost across every
 * sample and stores per-sample metadata (tokens, cost, Jev scores, the pick)
 * with no content. A Milo key is charged the sum of all samples' usage in
 * one usage row (ADR-010's spend disclosure: roughly N fast-tier calls).
 */

import type { Context } from "hono";
import { applyVariant, isStreaming, prepareBody, rankAnswer, resolveModel, variantFor } from "@milo/core";
import type { ChatMessage, RankScore, RouteDecision, SampleUpstream, Tier } from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { chargeBuffered, chargeStream, upstreamHeadersFor } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";
import { briefHeaders } from "../brief.js";
import { applyMiloHeaders, onFinished, resolveRoster } from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { readBodyUsage } from "./usage.js";
import type { UpstreamUsage } from "./usage.js";

/** Per-sample wall-clock cap when the deployment configures none. */
export const SAMPLE_TIMEOUT_MS_DEFAULT = 60_000;

export const SAMPLES_HEADER = "x-milo-samples";
export const SAMPLE_PICK_HEADER = "x-milo-sample-pick";

/** What the fan-out needs beyond the decision: the request's own knobs. */
export type SamplingContext = {
  candidates?: string[] | undefined;
  /** Version of the injected preference brief, for `x-milo-brief-version` (ADR-011). */
  briefVersion?: string | undefined;
};

type Sample = {
  index: number;
  status: number;
  latencyMs: number;
  /** The raw upstream body, returned verbatim when this sample is picked. */
  text: string;
  /** The upstream response, for its pass-through headers. */
  response?: Response;
  /** `choices[0].message` of a successful sample. */
  message?: Record<string, unknown>;
  /** The parsed body of a successful sample. */
  json?: Record<string, unknown>;
  usage: UpstreamUsage;
  rank?: RankScore;
  /** Failure class only -- never upstream text. */
  error?: string;
  /** The sample answered but Jev could not rank it. Failure class only. */
  rankError?: string;
};

/** A failure class the decision log can hold: a name, never upstream text. */
function classify(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(error.message)) return "network";
    return error.name === "Error" ? "error" : error.name;
  }
  return "error";
}

/** The text Jev ranks: the content, or the serialized tool calls. */
function answerText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "string" && content.trim() !== "") return content;
  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return JSON.stringify(toolCalls);
  return typeof content === "string" ? content : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One sample's decision-log row: tokens, cost, Jev scores. No content. */
function toSampleUpstream(sample: Sample, picked: boolean): SampleUpstream {
  return {
    index: sample.index,
    status: sample.status,
    latencyMs: sample.latencyMs,
    ...(sample.usage.inputTokens !== undefined ? { inputTokens: sample.usage.inputTokens } : {}),
    ...(sample.usage.outputTokens !== undefined ? { outputTokens: sample.usage.outputTokens } : {}),
    ...(sample.usage.costUsd !== undefined ? { costUsd: sample.usage.costUsd } : {}),
    ...(sample.rank !== undefined ? { jevQuality: sample.rank.quality, jevCorrect: sample.rank.correct } : {}),
    ...(sample.error !== undefined
      ? { error: sample.error }
      : sample.rankError !== undefined
        ? { error: sample.rankError }
        : {}),
    ...(picked ? { picked: true } : {}),
  };
}

/** The sum of what every sample reported: what the user's key actually spent. */
function aggregateUsage(samples: Sample[], chosen: Sample | undefined): UpstreamUsage {
  const usage: UpstreamUsage = {};
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCost = false;
  for (const sample of samples) {
    if (sample.usage.inputTokens !== undefined) {
      input += sample.usage.inputTokens;
      sawInput = true;
    }
    if (sample.usage.outputTokens !== undefined) {
      output += sample.usage.outputTokens;
      sawOutput = true;
    }
    if (sample.usage.costUsd !== undefined) {
      cost += sample.usage.costUsd;
      sawCost = true;
    }
  }
  if (sawInput) usage.inputTokens = input;
  if (sawOutput) usage.outputTokens = output;
  if (sawCost) usage.costUsd = cost;
  if (chosen?.usage.id !== undefined) usage.id = chosen.usage.id;
  return usage;
}

/**
 * Runs a sampled decision to completion and answers the client. Called by the
 * chat route instead of its ordinary forward when `decision.samples > 1`.
 */
export async function forwardSampled(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  ctx: SamplingContext = {},
): Promise<Response> {
  const n = decision.samples ?? 1;
  const timeoutMs = deps.sampling?.sampleTimeoutMs ?? SAMPLE_TIMEOUT_MS_DEFAULT;
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  const startedAt = deps.now();

  // Draw N samples in parallel, each non-streaming (the pick needs whole
  // answers) and each under its own cap so one slow provider cannot hold the
  // rest hostage.
  const draw = async (index: number): Promise<Sample> => {
    const sampleBody = prepareBody(body, decision.model);
    sampleBody["messages"] = applyVariant(messages, variantFor(index));
    delete sampleBody["stream"];
    delete sampleBody["stream_options"];

    const sampleStart = deps.now();
    const base: Sample = { index, status: 0, latencyMs: 0, text: "", usage: {} };
    try {
      const response = await deps.openRouter.chatCompletions({
        headers: upstreamHeadersFor(c),
        body: sampleBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const sample: Sample = {
        ...base,
        status: response.status,
        latencyMs: deps.now() - sampleStart,
        text,
        response,
        usage: readBodyUsage("chat", text),
      };
      if (!response.ok) {
        sample.error = `http_${response.status}`;
        return sample;
      }
      const parsed: unknown = JSON.parse(text);
      const choices = isRecord(parsed) ? parsed["choices"] : undefined;
      const message = Array.isArray(choices) && isRecord(choices[0]) ? choices[0]["message"] : undefined;
      if (!isRecord(parsed) || !isRecord(message)) {
        sample.error = "malformed_body";
        return sample;
      }
      sample.json = parsed;
      sample.message = message;
      return sample;
    } catch (error) {
      return { ...base, latencyMs: deps.now() - sampleStart, error: classify(error) };
    }
  };

  const samples = await Promise.all(Array.from({ length: n }, (_, i) => draw(i)));
  const successes = samples.filter((s) => s.error === undefined && s.message !== undefined);

  if (successes.length === 0) {
    return fallbackUnsampled(c, deps, body, decision, ctx, samples, startedAt);
  }

  // Rank every finished answer with one Jev call each, on Milo's key. A
  // failed rank marks the sample; a fully failed ranking falls back to the
  // first success rather than failing a request that already has answers.
  if (deps.jev !== undefined) {
    const jev = deps.jev;
    await Promise.all(
      successes.map(async (sample) => {
        try {
          sample.rank = await rankAnswer(jev, messages, answerText(sample.message ?? {}));
        } catch (error) {
          // The sample itself is fine; only its rank is missing.
          sample.rankError = `rank_${classify(error)}`;
          deps.logger.warn("jev sample ranking failed", {
            decisionId: decision.id,
            index: sample.index,
            error: sample.rankError,
          });
        }
      }),
    );
  }

  const ranked = successes.filter((s) => s.rank !== undefined);
  let pickIndex: number;
  let note: Upstream["sampleNote"];
  if (ranked.length > 0) {
    const best = [...ranked].sort((a, b) => {
      const ra = a.rank as RankScore;
      const rb = b.rank as RankScore;
      if (ra.quality !== rb.quality) return rb.quality - ra.quality;
      if (ra.correct !== rb.correct) return rb.correct - ra.correct;
      return a.index - b.index;
    })[0] as Sample;
    pickIndex = best.index;
  } else {
    pickIndex = (successes[0] as Sample).index;
    note = "ranking_failed";
    deps.logger.warn("jev ranking unavailable; returning the first successful sample", {
      decisionId: decision.id,
      samples: n,
    });
  }
  const chosen = samples[pickIndex] as Sample;

  // The audit row: aggregates across samples, per-sample metadata, the pick.
  const usage = aggregateUsage(samples, chosen);
  const record: Upstream = {
    status: chosen.status,
    latencyMs: deps.now() - startedAt,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    samples: samples.map((s) => toSampleUpstream(s, s.index === pickIndex)),
    samplePick: pickIndex,
    ...(note !== undefined ? { sampleNote: note } : {}),
  };
  deps.recordUpstream(decision.id, record);

  const headers = chosen.response !== undefined ? passThroughHeaders(chosen.response) : new Headers();
  applyMiloHeaders(headers, decision);
  for (const [k, v] of Object.entries(briefHeaders(ctx.briefVersion))) headers.set(k, v);
  headers.set(SAMPLES_HEADER, String(n));
  headers.set(SAMPLE_PICK_HEADER, String(pickIndex));

  // A Milo key pays for what was actually spent: the sum of every sample, as
  // one usage row against this decision (ADR-010).
  await chargeBuffered(c, deps, headers, { surface: "chat", model: decision.model, decisionId: decision.id }, usage);

  if (isStreaming(body)) {
    headers.set("content-type", "text/event-stream");
    return new Response(replayAsSse(chosen), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(chosen.text, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Streaming replay
// ---------------------------------------------------------------------------

/**
 * The chosen (buffered) completion as well-formed SSE in the OpenAI chunk
 * shape: one chunk carrying the whole message as a delta, one final chunk
 * with the finish reason and usage, then `[DONE]`.
 */
function replayAsSse(chosen: Sample): ReadableStream<Uint8Array> {
  const json = chosen.json ?? {};
  const message = chosen.message ?? {};
  const choices = Array.isArray(json["choices"]) ? json["choices"] : [];
  const first = isRecord(choices[0]) ? choices[0] : {};

  const frame = {
    id: typeof json["id"] === "string" ? json["id"] : "milo-sampled",
    object: "chat.completion.chunk",
    created: typeof json["created"] === "number" ? json["created"] : Math.floor(Date.now() / 1000),
    model: typeof json["model"] === "string" ? json["model"] : "",
  };

  const delta: Record<string, unknown> = { role: "assistant" };
  if (typeof message["content"] === "string") delta["content"] = message["content"];
  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls)) {
    delta["tool_calls"] = toolCalls.map((call, index) => (isRecord(call) ? { index, ...call } : call));
  }

  const contentChunk = { ...frame, choices: [{ index: 0, delta, finish_reason: null }] };
  const finalChunk = {
    ...frame,
    choices: [{ index: 0, delta: {}, finish_reason: first["finish_reason"] ?? "stop" }],
    ...(isRecord(json["usage"]) ? { usage: json["usage"] } : {}),
  };

  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// All-samples-failed fallback
// ---------------------------------------------------------------------------

/**
 * Every sample failed, so the request gets what the policy would have bought
 * without sampling: one ordinary call on `unsampledTier`, streamed or
 * buffered exactly as asked. The decision record keeps the failed samples'
 * metadata and says `all_samples_failed`.
 */
async function fallbackUnsampled(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  ctx: SamplingContext,
  samples: Sample[],
  startedAt: number,
): Promise<Response> {
  const tier: Tier = decision.unsampledTier ?? decision.tier;
  const roster = await resolveRoster(c, deps);
  let model: string;
  try {
    model = resolveModel(tier, roster, ctx.candidates, {
      longOutput: decision.signals?.longOutput ?? 0,
    });
  } catch (err) {
    deps.logger.error("sampled fallback could not resolve a model", { decisionId: decision.id, error: errorMessage(err) });
    model = decision.model;
  }
  deps.logger.warn("every sample failed; falling back to one unsampled call", {
    decisionId: decision.id,
    tier,
    model,
  });

  const sampleMeta = samples.map((s) => toSampleUpstream(s, false));
  const forwarded = prepareBody(body, model);

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, {
      status: 502,
      latencyMs: deps.now() - startedAt,
      samples: sampleMeta,
      sampleNote: "all_samples_failed",
    });
    deps.logger.error("openrouter chat completions failed", { decisionId: decision.id, error: errorMessage(err) });
    return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
  }

  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);
  for (const [k, v] of Object.entries(briefHeaders(ctx.briefVersion))) headers.set(k, v);
  // The response the client got came from the fallback, not the sampled fast
  // model, and the headers must say what actually answered.
  headers.set("x-milo-model", model);
  headers.set("x-milo-tier", tier);
  headers.set(SAMPLES_HEADER, String(decision.samples ?? 0));

  const chargeCtx = { surface: "chat" as const, model, decisionId: decision.id };

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const recorded = upstream.body.pipeThrough(
      onFinished(() => {
        deps.recordUpstream(decision.id, {
          status: upstream.status,
          latencyMs: deps.now() - startedAt,
          samples: sampleMeta,
          sampleNote: "all_samples_failed",
        });
      }),
    );
    return new Response(chargeStream(c, deps, headers, chargeCtx, recorded), { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const usage = upstream.ok ? readBodyUsage("chat", text) : {};
  const record: Upstream = {
    status: upstream.status,
    latencyMs: deps.now() - startedAt,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    samples: sampleMeta,
    sampleNote: "all_samples_failed",
  };
  deps.recordUpstream(decision.id, record);
  if (upstream.ok) await chargeBuffered(c, deps, headers, chargeCtx, usage);

  return new Response(text, { status: upstream.status, headers });
}
