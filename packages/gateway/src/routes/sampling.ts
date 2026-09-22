/**
 * Executing a sampled decision (ADR-010): the best-of-N fan-out behind
 * `POST /v1/chat/completions` when policy v4 resolved a cell to
 * `{ tier: "fast", samples: N }`.
 *
 * The shape of the trade: N upstream calls on the user's key, each with one
 * of the varied framings from `PROMPT_VARIANTS` appended to the system
 * prompt and each under its own wall-clock cap; one closed-rubric Jev call per
 * finished answer on Milo's key. Hard vetoes lose, unknown required evidence
 * abstains, then quality, correctness, and index deterministically select the
 * answer returned to the client.
 * Tool-call answers are ranked and picked like any other; the client
 * executes only what it receives.
 *
 * Two things keep the fan-out fast and cheap:
 *
 *   - Live-fast providers. Unless the caller sent a `provider` field of
 *     their own, every sampled sub-request carries
 *     `provider: { sort: "throughput" }`, so OpenRouter's rolling window
 *     picks the currently fastest provider for each draw. A caller-supplied
 *     provider preference always passes through untouched, and unsampled
 *     forwards are never touched at all.
 *
 *   - First-k early return. Sub-requests are internally streamed (SSE),
 *     whatever the client asked for, and each sample is ranked the moment
 *     its stream completes. Once `sampling.minRanked` samples (default
 *     `MIN_RANKED_DEFAULT`) are ranked, a clear winner -- best expected
 *     quality at or above `EARLY_WIN_QUALITY`, or the first success when
 *     ranking is degraded -- is returned immediately and the
 *     still-streaming stragglers are aborted. Aborting a streamed
 *     generation stops its token spend at that point (the user-cost win);
 *     an aborted sample records `aborted: true` with whatever partial usage
 *     its stream reported and never carries content. Wall time on the happy
 *     path is bounded by the k-th fastest sample plus one Jev rank, not the
 *     slowest of N.
 *
 * Failure ladder when no early winner emerges (fewer than k successes by
 * the per-sample timeout included), in order of preference:
 *
 *   1. every sample failed -> one ordinary unsampled call on the decision's
 *      `unsampledTier`, exactly what policy v3 would have bought;
 *   2. samples succeeded but Jev could not rank any of them -> the first
 *      successful sample, and the decision record says `ranking_failed`;
 *   3. otherwise -> Jev's pick over every ranked sample.
 *
 * A request carrying a canonical `milo.task` takes the stricter branch: all
 * candidates are evaluated against its criteria, the two strongest viable
 * candidates get a direct Jev comparison, and any non-decision falls back to
 * the ordinary unsampled tier instead of serving an arbitrary sample.
 *
 * The client sees exactly one well-formed chat completion either way: a
 * buffered request gets the chosen answer reassembled as one JSON body, a
 * streaming request gets it replayed as well-formed SSE (one content chunk,
 * one final chunk with the finish reason and usage, then `[DONE]`).
 *
 * Disclosure: `x-milo-samples` and `x-milo-sample-pick` on the response; the
 * decision record's upstream block stores per-sample metadata (tokens, cost,
 * Jev scores, `aborted`, the pick) with no content, and its aggregate
 * tokens/cost sum only what was actually billed: completed samples plus any
 * partial usage an aborted stream reported. A Milo key is charged that same
 * sum in one usage row (ADR-010's spend disclosure).
 */

import type { Context } from "hono";
import {
  applyVariant,
  applyVariantSuffix,
  checkCandidate,
  compareRanked,
  expectsJsonResponse,
  isStreaming,
  messageText,
  prepareBody,
  rankAnswer,
  resolveModel,
  selectPairwise,
  variantFor,
} from "@milo/core";
import type {
  ChatMessage,
  CriterionEvidence,
  RankScore,
  RouteDecision,
  SampleUpstream,
  TaskRecord,
  Tier,
} from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { chargeBuffered, chargeStream, forwardedJevKey, upstreamHeadersFor } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";
import { briefHeaders } from "../brief.js";
import { factHeaders } from "../facts.js";
import type { RoutedFacts } from "../facts.js";
import { storedGate } from "./gate.js";
import type { GateAnswer, GateRunner } from "./gate.js";
import { applyPruneHeaders, pruneRecord } from "./prune.js";
import type { PruneOutcome } from "./prune.js";
import {
  stripChatReasoningBody,
  stripChatReasoningPayload,
  stripChatReasoningSse,
  wantsVisibleReasoning,
} from "./chat-reasoning.js";
import { applyJevTransportHeader, applyMiloHeaders, resolveRoster, retargetProviderStrategy } from "./shared.js";
import type { Body, Upstream } from "./shared.js";
import { addUsage, readBodyUsage, toUpstreamRecord, usageFromStream } from "./usage.js";
import type { UpstreamUsage } from "./usage.js";

/** Per-sample wall-clock cap when the deployment configures none. */
export const SAMPLE_TIMEOUT_MS_DEFAULT = 60_000;

/**
 * A prompt longer than this (characters of message text) is a large prompt,
 * and its samples get a longer wall-clock cap.
 *
 * Live evidence: two band-3 `docs` decisions in a long-horizon run lost ALL
 * FIVE samples to the 60 s cap and fell through to the degraded
 * all-samples-failed path. Their prompts were whole-file agent contexts; 60 s
 * is a cap fitted to short chat turns, and a cap that every sample hits is
 * not a cap, it is an outage. ~8k characters is roughly 2k tokens, the point
 * above which first-token latency plus generation stops fitting in a minute
 * on the fast tier.
 */
export const LARGE_PROMPT_CHARS = 8_000;

/**
 * What a large prompt multiplies the per-sample cap by: the 60 s default
 * becomes 120 s. A multiplier rather than a floor, so a deployment that
 * deliberately configured a short cap keeps its own proportions.
 */
export const LARGE_PROMPT_TIMEOUT_FACTOR = 2;

/** Total characters of message text in a prompt: what `LARGE_PROMPT_CHARS` counts. */
export function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageText(message.content).length, 0);
}

/** The per-sample cap for this prompt: the configured one, doubled when the prompt is large. */
export function sampleTimeoutFor(configuredMs: number, chars: number): number {
  return chars > LARGE_PROMPT_CHARS ? configuredMs * LARGE_PROMPT_TIMEOUT_FACTOR : configuredMs;
}

/** How many ranked samples the early return waits for (`sampling.minRanked`). */
export const MIN_RANKED_DEFAULT = 3;

/** Jev expected quality (0..3) at which an early pick is a clear winner. */
export const EARLY_WIN_QUALITY = 2.5;

/**
 * Adaptive-N (ADR-024, opt-in): the drawing knobs the fan-out reads when
 * `sampling.adaptive.enabled` is true. Default OFF -- absent, the fan-out draws
 * the full budgeted N up front exactly as ADR-010 shipped it. When on, samples
 * are drawn incrementally and drawing stops once the top ranked answer is
 * confidently good enough, so the tail samples are never started (not merely
 * aborted). None of the thresholds is measured by ADR-010's benchmark, so a
 * deployment validates a chosen set with `milo canary`/`pnpm bench` before
 * enabling it in production; the numbers here are only the shape's defaults.
 */
export type AdaptiveSamplingConfig = {
  enabled?: boolean;
  /** Initial concurrent batch drawn before the first stop check. Default `minRanked`. */
  minSamples?: number;
  /** Hard cap on samples drawn, never above the budgeted N. Default N. */
  maxSamples?: number;
  /** Top ranked expected quality (0..3) that ends drawing. Default `EARLY_WIN_QUALITY`. */
  qualityBar?: number;
  /** A lead of this much over the runner-up (0..3) ends drawing. Default `ADAPTIVE_LEAD_MARGIN_DEFAULT`. */
  leadMargin?: number;
};

/**
 * Default decisive-lead margin (0..3): once the top ranked answer leads the
 * runner-up by this much expected quality, more samples are unlikely to change
 * the pick, so drawing stops. Only consulted when adaptive-N is enabled.
 */
export const ADAPTIVE_LEAD_MARGIN_DEFAULT = 1;

export const SAMPLES_HEADER = "x-milo-samples";
export const SAMPLE_PICK_HEADER = "x-milo-sample-pick";
/** How many ranked candidates were returned as `choices[]` (ADR-026 top-K). */
export const EXPOSED_HEADER = "x-milo-exposed";

/** What the fan-out needs beyond the decision: the request's own knobs. */
export type SamplingContext = {
  candidates?: string[] | undefined;
  /** Canonical task intent and source-linked evidence for task-aware selection. */
  task?: TaskRecord | undefined;
  evidence?: CriterionEvidence[] | undefined;
  /** Version of the injected preference brief, for `x-milo-brief-version` (ADR-011). */
  briefVersion?: string | undefined;
  /**
   * The completeness gate (ADR-013 phase A), when it applies to this
   * request: runs over the chosen sample before it is served, and may swap
   * in a retried answer, add the retry's usage to the bill, and set the
   * gate's disclosure headers. Absent means no gate (skipped, opted out, or
   * not configured). The all-samples-failed fallback is never gated: it is
   * already the degraded path.
   */
  gate?: GateRunner | undefined;
  /**
   * Context pruning's outcome (ADR-014), when the gate shed older context
   * from this request's messages before the fan-out. Disclosure only: the
   * samples already drew on the pruned body, so this just sets the headers
   * and the decision record's `prune` block.
   */
  prune?: PruneOutcome | undefined;
  /**
   * The relevance-gated personal-fact note (ADR-017), when facts were injected
   * into this request's body before the fan-out. Disclosure only: the samples
   * already drew on the note; this sets `x-milo-facts-injected`.
   */
  facts?: RoutedFacts | undefined;
};

type Sample = {
  index: number;
  status: number;
  latencyMs: number;
  /** The sample's completion body, reassembled from its stream. */
  text: string;
  /** The upstream response, for its pass-through headers. */
  response?: Response;
  /** `choices[0].message` of a successful sample. */
  message?: Record<string, unknown>;
  /** The reassembled completion body of a successful sample. */
  json?: Record<string, unknown>;
  usage: UpstreamUsage;
  rank?: RankScore;
  /**
   * Static candidate verification (ADR-026): true when the structural check
   * found a high-confidence defect (truncation, unbalanced code, bad diff/JSON).
   * Only ever set when `sampling.verifyCandidates` is on; a broken candidate is
   * demoted below every structurally-valid one by `bySampleRank`.
   */
  broken?: boolean;
  /** The structural defect classes found (ADR-026). Format names, never content. */
  flaws?: string[];
  /** Milo aborted this sample's stream after an early winner was found. */
  aborted?: boolean;
  /** Failure class only -- never upstream text. */
  error?: string;
  /** The sample answered but Jev could not rank it. Failure class only. */
  rankError?: string;
};

/**
 * One decision-log row. The `aborted` marker is a gateway-local, purely
 * additive extension of the `SampleUpstream` contract
 * (`packages/core/src/types.ts`), which predates the abort path; folding it
 * into the type itself needs an ADR.
 */
type SampleRow = SampleUpstream & { aborted?: boolean; broken?: boolean; flaws?: string[] };

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
export function answerText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "string" && content.trim() !== "") return content;
  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return JSON.stringify(toolCalls);
  return typeof content === "string" ? content : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How many ranked candidates the client asked to see (ADR-026), from the OpenAI
 * `n` field: `1` (or absent/invalid) is the default single best choice, larger
 * values expose the top-K, clamped to the budgeted sample count `n` since Milo
 * can return no more candidates than it drew.
 */
export function requestedChoices(body: Body, drawn: number): number {
  const requested = body["n"];
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) return 1;
  return Math.min(requested, Math.max(1, drawn));
}

/** `choices[0].finish_reason` of a reassembled completion, when present. */
function finishReasonOf(json: Record<string, unknown> | undefined): unknown {
  if (json === undefined) return undefined;
  const choices = json["choices"];
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined;
  return (choices[0] as Record<string, unknown>)["finish_reason"];
}

/** The choice `{message, finish_reason}` a completion body carries at index 0. */
function choiceParts(
  json: Record<string, unknown> | undefined,
  fallbackMessage: Record<string, unknown> | undefined,
): { message: Record<string, unknown>; finish_reason: unknown } {
  const message = fallbackMessage ?? {};
  const choices = json?.["choices"];
  const first = Array.isArray(choices) && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : undefined;
  const msg = first !== undefined && isRecord(first["message"]) ? (first["message"] as Record<string, unknown>) : message;
  return { message: msg, finish_reason: first?.["finish_reason"] ?? "stop" };
}

/** One sample's decision-log row: tokens, cost, Jev scores. No content. */
function toSampleUpstream(sample: Sample, picked: boolean): SampleRow {
  return {
    index: sample.index,
    status: sample.status,
    latencyMs: sample.latencyMs,
    ...(sample.usage.inputTokens !== undefined ? { inputTokens: sample.usage.inputTokens } : {}),
    ...(sample.usage.outputTokens !== undefined ? { outputTokens: sample.usage.outputTokens } : {}),
    ...(sample.usage.costUsd !== undefined ? { costUsd: sample.usage.costUsd } : {}),
    ...(sample.rank !== undefined ? { jevQuality: sample.rank.quality, jevCorrect: sample.rank.correct } : {}),
    ...(sample.rank?.outcome === undefined ? {} : { selectionOutcome: sample.rank.outcome }),
    ...(sample.rank?.criterionEvidence === undefined
      ? {}
      : {
          criterionEvidence: sample.rank.criterionEvidence.map((finding) => ({
            criterionId: finding.criterionId,
            verdict: finding.verdict,
            confidence: finding.confidence,
            source: finding.source,
            ...(finding.sourceRef === undefined ? {} : { sourceRef: finding.sourceRef }),
          })),
        }),
    ...(sample.broken === true ? { broken: true } : {}),
    ...(sample.flaws !== undefined && sample.flaws.length > 0 ? { flaws: sample.flaws } : {}),
    ...(sample.aborted === true ? { aborted: true } : {}),
    ...(sample.error !== undefined
      ? { error: sample.error }
      : sample.rankError !== undefined
        ? { error: sample.rankError }
        : {}),
    ...(picked ? { picked: true } : {}),
  };
}

/**
 * The sum of what was actually billed: every sample's reported usage -- full
 * for completed samples, partial for an aborted stream that reported any --
 * never an estimate for tokens an abort prevented.
 */
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
 * Orders two ranked samples, best first: highest expected quality wins,
 * correctness then index break ties. The single comparator behind both the
 * fixed and adaptive pickers, so an adaptive stop and the final selection can
 * never disagree about which sample is best.
 */
function bySampleRank(a: Sample, b: Sample): number {
  // Static verification gate (ADR-026): a structurally-broken candidate sorts
  // below every valid one regardless of its Jev score, so it cannot win on the
  // text judgment alone. `broken` is only ever set when `verifyCandidates` is
  // on; with the gate off no sample carries it, so this comparison is always a
  // tie and the ordering below is byte-identical to ADR-010's.
  const ba = a.broken === true;
  const bb = b.broken === true;
  if (ba !== bb) return ba ? 1 : -1;
  const ra = a.rank as RankScore;
  const rb = b.rank as RankScore;
  return compareRanked({ index: a.index, rank: ra }, { index: b.index, rank: rb });
}

/**
 * Successful samples ordered best-first for top-K exposure (ADR-026): ranked
 * samples by `bySampleRank` (valid before broken, then Jev), then any samples
 * Jev could not rank, by index. Never sorts a rank-less sample through
 * `bySampleRank` (which would read an undefined rank), so it is safe on the
 * degraded-ranking path.
 */
function orderSuccesses(successes: Sample[]): Sample[] {
  const ranked = successes.filter((s) => s.rank !== undefined && (s.rank.outcome === undefined || s.rank.outcome === "accept")).sort(bySampleRank);
  const unranked = successes.filter((s) => s.rank === undefined).sort((a, b) => a.index - b.index);
  return [...ranked, ...unranked];
}

/** Highest expected quality wins; correctness, then index, break ties. */
function bestRanked(ranked: Sample[]): Sample {
  return [...ranked].sort(bySampleRank)[0] as Sample;
}

/** The lowest-index success: the deterministic degraded-ranking pick. */
function firstSuccess(successes: Sample[]): Sample {
  return [...successes].sort((a, b) => a.index - b.index)[0] as Sample;
}

// ---------------------------------------------------------------------------
// SSE accumulation
// ---------------------------------------------------------------------------

type ToolCallAccumulator = { id?: string; type?: string; name?: string; arguments: string };

/** A sample's stream folded down as it arrives: metadata, text, usage. */
type SseAccumulator = {
  id?: string;
  created?: number;
  model?: string;
  content: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  finishReason?: unknown;
  /** The newest raw `usage` object any frame carried. */
  usage?: Record<string, unknown>;
  sawChunk: boolean;
};

/** One SSE line into the accumulator. Non-data lines and `[DONE]` are ignored. */
function feedSseLine(acc: SseAccumulator, rawLine: string): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith("data:")) return;
  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  if (typeof parsed["id"] === "string") acc.id = parsed["id"];
  if (typeof parsed["created"] === "number") acc.created = parsed["created"];
  if (typeof parsed["model"] === "string") acc.model = parsed["model"];
  if (isRecord(parsed["usage"])) acc.usage = parsed["usage"];

  const choices = parsed["choices"];
  if (!Array.isArray(choices)) return;
  const choice = choices.find((entry) => isRecord(entry) && (entry["index"] === 0 || entry["index"] === undefined));
  if (!isRecord(choice)) return;
  acc.sawChunk = true;

  const finish = choice["finish_reason"];
  if (finish !== null && finish !== undefined) acc.finishReason = finish;

  const delta = choice["delta"];
  if (!isRecord(delta)) return;
  if (typeof delta["content"] === "string") acc.content += delta["content"];

  const toolCalls = delta["tool_calls"];
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const index = typeof call["index"] === "number" ? call["index"] : 0;
    const entry = acc.toolCalls.get(index) ?? { arguments: "" };
    if (typeof call["id"] === "string") entry.id = call["id"];
    if (typeof call["type"] === "string") entry.type = call["type"];
    const fn = call["function"];
    if (isRecord(fn)) {
      if (typeof fn["name"] === "string") entry.name = fn["name"];
      if (typeof fn["arguments"] === "string") entry.arguments += fn["arguments"];
    }
    acc.toolCalls.set(index, entry);
  }
}

/** The finished stream reassembled as one `chat.completion` body. */
function completionFromAccumulator(
  acc: SseAccumulator,
  fallbackModel: string,
): { json: Record<string, unknown>; message: Record<string, unknown> } {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => ({
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      type: entry.type ?? "function",
      function: { name: entry.name ?? "", arguments: entry.arguments },
    }));
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 && acc.content === "" ? null : acc.content,
  };
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  const json: Record<string, unknown> = {
    id: acc.id ?? "milo-sampled",
    object: "chat.completion",
    created: acc.created ?? Math.floor(Date.now() / 1000),
    model: acc.model ?? fallbackModel,
    choices: [{ index: 0, message, finish_reason: acc.finishReason ?? "stop" }],
    ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
  };
  return { json, message };
}

/** What the stream has reported about spend so far: id, tokens, cost. */
function usageFromAccumulator(acc: SseAccumulator): UpstreamUsage {
  const usage: UpstreamUsage = {};
  if (acc.id !== undefined) usage.id = acc.id;
  const raw = acc.usage;
  if (raw !== undefined) {
    if (typeof raw["prompt_tokens"] === "number") usage.inputTokens = raw["prompt_tokens"];
    if (typeof raw["completion_tokens"] === "number") usage.outputTokens = raw["completion_tokens"];
    if (typeof raw["cost"] === "number") usage.costUsd = raw["cost"];
  }
  return usage;
}

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

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
  // ADR-022: under the OpenRouter Jev transport, bill each sample-ranking call
  // to the caller's forwarded key -- the same key the sampled completions run
  // on. Undefined under the TypeSafe transport (Milo's key ranks, as before).
  const jevKey = forwardedJevKey(c, deps);
  const taskAware = ctx.task !== undefined;
  const minRanked = Math.max(1, Math.min(deps.sampling?.minRanked ?? MIN_RANKED_DEFAULT, n));

  // Adaptive-N (ADR-024). Default OFF: with no `adaptive` block, or `enabled`
  // not true, the scheduler below launches the full budgeted N up front and
  // the behaviour is byte-identical to ADR-010's fixed best-of-N. When on,
  // `maxN` caps drawing (never above N), `initialN` is the concurrent probe,
  // and `qualityBar`/`leadMargin` are the confident-stop thresholds.
  const adaptive: AdaptiveSamplingConfig | undefined = deps.sampling?.adaptive;
  const adaptiveOn = adaptive?.enabled === true;
  const maxN = adaptiveOn ? Math.max(1, Math.min(adaptive?.maxSamples ?? n, n)) : n;
  const initialN = adaptiveOn ? Math.max(1, Math.min(adaptive?.minSamples ?? minRanked, maxN)) : n;
  const qualityBar = adaptive?.qualityBar ?? EARLY_WIN_QUALITY;
  const leadMargin = adaptive?.leadMargin ?? ADAPTIVE_LEAD_MARGIN_DEFAULT;

  // Cache-friendly framings (ADR-024). Default OFF: the benchmarked
  // system-prompt placement (`applyVariant`) stands, so the varied samples
  // diverge at the head of the token sequence and a provider prompt cache
  // cannot reuse the conversation body across them. When on, the framing rides
  // the last message's tail (`applyVariantSuffix`), keeping the whole prefix
  // byte-stable and cache-eligible; the framing text -- and thus the sample
  // diversity -- is unchanged either way.
  const applyFraming = deps.sampling?.cacheFriendlyVariants === true ? applyVariantSuffix : applyVariant;

  // Static candidate verification (ADR-026). Default OFF: with the gate off no
  // sample is ever marked broken, so `bySampleRank` orders exactly as ADR-010
  // does and the pick is byte-identical. When on, each successful sample gets a
  // cheap structural check and a broken candidate is demoted below valid ones.
  const verifyOn = deps.sampling?.verifyCandidates === true;
  const expectJson = expectsJsonResponse(body);

  // Top-K candidate exposure (ADR-026), opt-in via the OpenAI `n` field. Default
  // 1 (a single best choice, exactly as ADR-010): only an explicit `n > 1` asks
  // for the top ranked candidates as multiple `choices[]`, so a client with its
  // own workspace can run real tests over them. Capped at the budgeted N -- more
  // choices than samples cannot exist. The `milo` field is already stripped
  // before the forward, so `n` is the request-visible knob here.
  const exposeK = requestedChoices(body, n);

  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  // A large prompt gets a longer per-sample cap: see `LARGE_PROMPT_CHARS`.
  const timeoutMs = sampleTimeoutFor(
    deps.sampling?.sampleTimeoutMs ?? SAMPLE_TIMEOUT_MS_DEFAULT,
    promptChars(messages),
  );
  const startedAt = deps.now();

  // One streamed draw. Never throws: every outcome is a Sample row.
  const draw = async (index: number, abort: AbortController): Promise<Sample> => {
    const sampleBody = prepareBody(body, decision.model);
    sampleBody["messages"] = applyFraming(messages, variantFor(index));
    // Top-K exposure (ADR-026): Milo synthesizes the multiple `choices[]` from
    // the top ranked SAMPLES, so each draw generates a single completion. Force
    // `n = 1` on the sub-request when the client asked for top-K, so a client
    // `n` never fans each draw out into n upstream generations. Untouched when
    // top-K is not requested, so the default draw is byte-identical to ADR-010.
    if (exposeK > 1) sampleBody["n"] = 1;
    // Internally streamed, whatever the client asked for: a stream can be
    // ranked the moment it completes and aborted while it is still running.
    sampleBody["stream"] = true;
    sampleBody["stream_options"] = { include_usage: true };
    // Live-fast providers, sampled sub-requests only: OpenRouter's rolling
    // throughput window picks the currently fastest provider for this draw.
    // A caller-supplied `provider` field always wins, untouched.
    if (sampleBody["provider"] === undefined) sampleBody["provider"] = { sort: "throughput", allow_fallbacks: true };

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout]);
    const sampleStart = deps.now();
    const base: Sample = { index, status: 0, latencyMs: 0, text: "", usage: {} };
    const acc: SseAccumulator = { content: "", toolCalls: new Map(), sawChunk: false };
    let response: Response | undefined;

    /** The row for a stream Milo aborted: partial usage only, never content. */
    const abortedRow = (): Sample => ({
      ...base,
      status: response?.status ?? 0,
      latencyMs: deps.now() - sampleStart,
      usage: usageFromAccumulator(acc),
      aborted: true,
    });

    try {
      response = await deps.openRouter.chatCompletions({
        headers: upstreamHeadersFor(c),
        body: sampleBody,
        signal,
      });
      if (abort.signal.aborted) return abortedRow();
      if (!response.ok) {
        const text = await response.text();
        return {
          ...base,
          status: response.status,
          latencyMs: deps.now() - sampleStart,
          response,
          usage: readBodyUsage("chat", text),
          error: `http_${response.status}`,
        };
      }
      if (response.body === null) {
        return { ...base, status: response.status, latencyMs: deps.now() - sampleStart, response, error: "malformed_body" };
      }

      // Drain the SSE stream line by line into the accumulator. The abort
      // listener cancels the reader so a pending read settles promptly even
      // under an injected fetch that ignores signals (tests); the real fetch
      // additionally rejects the read, which the catch below classifies.
      const reader = response.body.getReader();
      const cancelOnAbort = (): void => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancelOnAbort, { once: true });
      if (signal.aborted) cancelOnAbort();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const cut = buffer.lastIndexOf("\n");
          if (cut === -1) continue;
          for (const line of buffer.slice(0, cut).split("\n")) feedSseLine(acc, line);
          buffer = buffer.slice(cut + 1);
        }
        feedSseLine(acc, buffer);
      } finally {
        signal.removeEventListener("abort", cancelOnAbort);
        reader.releaseLock();
      }

      if (abort.signal.aborted) return abortedRow();
      if (timeout.aborted) {
        return {
          ...base,
          status: response.status,
          latencyMs: deps.now() - sampleStart,
          usage: usageFromAccumulator(acc),
          error: "timeout",
        };
      }
      if (!acc.sawChunk) {
        return { ...base, status: response.status, latencyMs: deps.now() - sampleStart, response, error: "malformed_body" };
      }

      const { json, message } = completionFromAccumulator(acc, decision.model);
      return {
        index,
        status: response.status,
        latencyMs: deps.now() - sampleStart,
        text: JSON.stringify(json),
        response,
        message,
        json,
        usage: usageFromAccumulator(acc),
      };
    } catch (error) {
      if (abort.signal.aborted) return abortedRow();
      return { ...base, latencyMs: deps.now() - sampleStart, error: classify(error) };
    }
  };

  // Coordination: each sample streams, then ranks, then reports in.
  // `evaluate` decides as soon as the early-return condition holds, or when
  // every sample has settled.
  type Slot = { controller: AbortController; streamed: Promise<Sample>; sample?: Sample; settled: boolean };
  type Outcome = { pick?: Sample; note?: Upstream["sampleNote"] };

  const slots: Slot[] = [];
  let decided = false;
  let decide: (outcome: Outcome) => void = () => undefined;
  const outcomePromise = new Promise<Outcome>((resolve) => {
    decide = (outcome) => {
      if (decided) return;
      decided = true;
      resolve(outcome);
    };
  });

  const isSuccess = (sample: Sample): boolean =>
    sample.error === undefined && sample.aborted !== true && sample.message !== undefined;

  // Assigned once both evaluators exist (below); a launched draw reports in
  // through this indirection so `launch` need not know which mode is running.
  let onSettled: () => void = () => undefined;

  // Start one draw: stream it, rank it as it completes, then report in. A
  // failed rank marks the sample rather than failing a request that already
  // has answers; after a decision no new ranks start, since their verdicts
  // could no longer matter. This is ADR-010's per-sample loop body verbatim,
  // lifted into a helper so the adaptive scheduler can call it on demand.
  const launch = (index: number): void => {
    const controller = new AbortController();
    const slot: Slot = { controller, streamed: draw(index, controller), settled: false };
    slots.push(slot);
    void slot.streamed.then(async (sample) => {
      slot.sample = sample;
      // Static verification (ADR-026): score the candidate's structural validity
      // before it can be ranked or picked. Sync and independent of Jev, so it is
      // set the moment the stream settles and is visible to every selector.
      if (verifyOn && isSuccess(sample)) {
        const check = checkCandidate({
          text: answerText(sample.message ?? {}),
          finishReason: finishReasonOf(sample.json),
          expectJson,
        });
        if (!check.ok) {
          sample.broken = true;
          sample.flaws = check.flaws;
        }
      }
      if (isSuccess(sample) && deps.jev !== undefined && !decided) {
        try {
          sample.rank = await rankAnswer(
            deps.jev,
            messages,
            answerText(sample.message ?? {}),
            undefined,
            jevKey,
            ctx.task === undefined
              ? undefined
              : {
                  record: ctx.task,
                  decisionId: decision.id,
                  candidateId: `sample-${sample.index}`,
                  ...(ctx.evidence === undefined ? {} : { evidence: ctx.evidence }),
                },
          );
        } catch (error) {
          sample.rankError = `rank_${classify(error)}`;
          deps.logger.warn("jev sample ranking failed", {
            decisionId: decision.id,
            index: sample.index,
            error: sample.rankError,
          });
        }
      }
      slot.settled = true;
      onSettled();
    });
  };

  // Fixed best-of-N (ADR-010): every sample is already drawn, so the only
  // choices are an early clear winner, a degraded-ranking pick, or -- once all
  // have settled -- the outcome over whatever ranked.
  const evaluate = (): void => {
    if (decided) return;
    const settled = slots.filter((slot) => slot.settled).map((slot) => slot.sample as Sample);
    const successes = settled.filter(isSuccess);
    const attempted = successes.filter((sample) => sample.rank !== undefined);
    const ranked = successes.filter((sample) => sample.rank !== undefined
      && (sample.rank.outcome === undefined || sample.rank.outcome === "accept"));
    if (!taskAware && ranked.length >= minRanked) {
      const best = bestRanked(ranked);
      if ((best.rank as RankScore).quality >= EARLY_WIN_QUALITY) {
        decide({ pick: best });
        return;
      }
    }
    if (!taskAware && ranked.length === 0 && attempted.length === 0 && successes.length >= minRanked) {
      // Ranking is degraded: more samples cannot change a pick Jev will
      // never score, so the first success wins now.
      decide({ pick: firstSuccess(successes), note: "ranking_failed" });
      return;
    }
    if (settled.length === slots.length) decide({});
  };

  // Adaptive-N (ADR-024): the same stop conditions, but drawing is
  // incremental. Once the in-flight batch has all settled without a confident
  // top answer, one more sample is drawn until the max-N cap; a confident
  // top answer (clears the quality bar, or leads the runner-up decisively)
  // ends drawing so the tail samples are never started.
  const evaluateAdaptive = (): void => {
    if (decided) return;
    const settled = slots.filter((slot) => slot.settled).map((slot) => slot.sample as Sample);
    const successes = settled.filter(isSuccess);
    const attempted = successes.filter((sample) => sample.rank !== undefined);
    const ranked = successes.filter((sample) => sample.rank !== undefined
      && (sample.rank.outcome === undefined || sample.rank.outcome === "accept"));
    if (!taskAware && ranked.length >= minRanked) {
      const ordered = [...ranked].sort(bySampleRank);
      const best = ordered[0] as Sample;
      const bestQuality = (best.rank as RankScore).quality;
      const runnerUp = ordered[1];
      const decisiveLead = runnerUp !== undefined && bestQuality - (runnerUp.rank as RankScore).quality >= leadMargin;
      if (bestQuality >= qualityBar || decisiveLead) {
        decide({ pick: best });
        return;
      }
    }
    if (!taskAware && ranked.length === 0 && attempted.length === 0 && successes.length >= minRanked) {
      decide({ pick: firstSuccess(successes), note: "ranking_failed" });
      return;
    }
    if (settled.length === slots.length) {
      // The whole in-flight batch has settled and no winner is clear: draw one
      // more if the budget allows, otherwise finish with the best in hand.
      if (slots.length < maxN) {
        launch(slots.length);
        return;
      }
      decide({});
    }
  };

  onSettled = adaptiveOn ? evaluateAdaptive : evaluate;
  // Fixed mode launches the full budgeted N up front (byte-identical to
  // ADR-010); adaptive mode launches only the initial probe and grows it.
  for (let index = 0; index < initialN; index += 1) launch(index);

  const outcome = await outcomePromise;

  if (outcome.pick !== undefined) {
    // A winner is in hand: stop paying for the stragglers. Aborting a
    // finished sample's controller is a no-op; aborting a live stream stops
    // its token spend at the point of the abort.
    for (const slot of slots) slot.controller.abort();
  }
  // Aborted draws settle promptly (the abort cancels their read), so this
  // wait adds microtasks, not wall time.
  const samples = await Promise.all(slots.map((slot) => slot.streamed));
  const successes = samples.filter(isSuccess);
  if (successes.length === 0) {
    return fallbackUnsampled(c, deps, body, decision, ctx, samples, startedAt);
  }

  let chosen: Sample;
  let note = outcome.note;
  if (taskAware) {
    const attempted = successes.filter((sample) => sample.rank !== undefined);
    const accepted = successes.filter((sample) => sample.rank?.outcome === "accept");
    const structurallyValid = accepted.filter((sample) => sample.broken !== true);
    const ranked = (structurallyValid.length > 0 ? structurallyValid : accepted).sort(bySampleRank);
    if (ranked.length === 0 || deps.jev === undefined || ctx.task === undefined) {
      return fallbackUnsampled(
        c,
        deps,
        body,
        decision,
        ctx,
        samples,
        startedAt,
        attempted.length > 0 ? "ranking_abstained" : "ranking_failed",
      );
    }
    if (ranked.length === 1) {
      chosen = ranked[0] as Sample;
    } else {
      const first = ranked[0] as Sample;
      const second = ranked[1] as Sample;
      let selected: number | undefined;
      try {
        selected = await selectPairwise(
          deps.jev,
          {
            record: ctx.task,
            decisionId: decision.id,
            ...(ctx.evidence === undefined ? {} : { evidence: ctx.evidence }),
          },
          {
            index: first.index,
            candidateId: `sample-${first.index}`,
            answer: answerText(first.message ?? {}),
            rank: first.rank as RankScore,
          },
          {
            index: second.index,
            candidateId: `sample-${second.index}`,
            answer: answerText(second.message ?? {}),
            rank: second.rank as RankScore,
          },
          undefined,
          jevKey,
        );
      } catch (error) {
        deps.logger.warn("jev pairwise selection failed", {
          decisionId: decision.id,
          error: `pairwise_${classify(error)}`,
        });
        return fallbackUnsampled(c, deps, body, decision, ctx, samples, startedAt, "ranking_failed");
      }
      if (selected === undefined) {
        return fallbackUnsampled(c, deps, body, decision, ctx, samples, startedAt, "ranking_abstained");
      }
      chosen = selected === first.index ? first : second;
    }
  } else if (outcome.pick !== undefined) {
    chosen = outcome.pick;
  } else {
    const attempted = successes.filter((sample) => sample.rank !== undefined);
    const ranked = successes.filter((sample) => sample.rank !== undefined
      && (sample.rank.outcome === undefined || sample.rank.outcome === "accept"));
    if (ranked.length > 0) {
      chosen = bestRanked(ranked);
    } else {
      chosen = firstSuccess(successes);
      note = attempted.length > 0 ? "ranking_abstained" : "ranking_failed";
    }
  }
  if (note === "ranking_failed") {
    deps.logger.warn("jev ranking unavailable; returning the first successful sample", {
      decisionId: decision.id,
      samples: n,
    });
  }
  if (note === "ranking_abstained") {
    deps.logger.warn("jev ranking abstained; returning the first successful sample for completeness gating", {
      decisionId: decision.id,
      samples: n,
    });
  }
  const pickIndex = chosen.index;

  // The completeness gate (ADR-013) runs over the pick before anything is
  // recorded or served: it may swap in a retried answer, and its retry's
  // usage belongs in this decision's one aggregate.
  let served: { json?: Record<string, unknown>; message?: Record<string, unknown>; text: string } = chosen;
  let gateHeaders: Record<string, string> = {};
  let gateRecord: Upstream["gate"] | undefined;
  let gateUsage: UpstreamUsage | undefined;
  if (ctx.gate !== undefined && chosen.json !== undefined && chosen.message !== undefined) {
    // The other finished samples, ranked best-first, so the gate can reuse a
    // complete one instead of spending a fresh retry (ADR-027 change 3). Only
    // fully-parsed candidates (json + message present) can be served as-is.
    const siblings: GateAnswer[] = orderSuccesses(successes)
      .filter((s) => s.index !== chosen.index && s.json !== undefined && s.message !== undefined)
      .map((s) => ({
        json: s.json as Record<string, unknown>,
        message: s.message as Record<string, unknown>,
        text: s.text,
      }));
    const result = await ctx.gate({ json: chosen.json, message: chosen.message, text: chosen.text }, siblings);
    served = result.answer;
    gateHeaders = result.headers;
    gateRecord = storedGate(result.record);
    gateUsage = result.extraUsage;
  }

  // The audit row: aggregates across samples (plus the gate's retry, when
  // one fired), per-sample metadata, the pick.
  const usage = addUsage(aggregateUsage(samples, chosen), gateUsage);
  const record: Upstream = {
    status: chosen.status,
    latencyMs: deps.now() - startedAt,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    samples: samples.map((s) => toSampleUpstream(s, s.index === pickIndex)),
    samplePick: pickIndex,
    ...(note !== undefined ? { sampleNote: note } : {}),
    ...(gateRecord !== undefined ? { gate: gateRecord } : {}),
    ...pruneRecord(ctx.prune),
  };
  deps.recordUpstream(decision.id, record);

  const headers = chosen.response !== undefined ? passThroughHeaders(chosen.response) : new Headers();
  applyMiloHeaders(headers, decision);
  applyJevTransportHeader(headers, deps);
  applyPruneHeaders(headers, ctx.prune);
  for (const [k, v] of Object.entries(briefHeaders(ctx.briefVersion))) headers.set(k, v);
  for (const [k, v] of Object.entries(factHeaders(ctx.facts))) headers.set(k, v);
  // The count actually drawn. In fixed mode every budgeted sample is drawn, so
  // this is `n` (byte-identical to ADR-010); under adaptive-N an early stop
  // draws fewer, and the header discloses what was really spent.
  headers.set(SAMPLES_HEADER, String(adaptiveOn ? samples.length : n));
  headers.set(SAMPLE_PICK_HEADER, String(pickIndex));
  for (const [k, v] of Object.entries(gateHeaders)) headers.set(k, v);

  // A Milo key pays for what was actually spent: the sum of every sample
  // (and the gate's retry), as one usage row against this decision (ADR-010).
  await chargeBuffered(c, deps, headers, { surface: "chat", model: decision.model, decisionId: decision.id }, usage);

  if (!wantsVisibleReasoning(body)) {
    const json =
      served.json !== undefined ? (stripChatReasoningPayload(served.json) as Record<string, unknown>) : undefined;
    const message =
      json !== undefined && Array.isArray(json["choices"]) && isRecord(json["choices"][0])
        ? ((json["choices"][0] as Record<string, unknown>)["message"] as Record<string, unknown> | undefined)
        : served.message;
    served = {
      ...(json !== undefined ? { json } : {}),
      ...(message !== undefined ? { message } : {}),
      text: stripChatReasoningBody(served.text),
    };
  }

  // Top-K exposure (ADR-026): when the client asked for more than one choice
  // (`n > 1`) and more than one candidate survives, return the top ranked
  // candidates as multiple `choices[]`, best-first. These are candidates the
  // user already paid to generate; nothing beyond their completion text is
  // exposed. Choice 0 is the served pick (gate-applied and reasoning-scrubbed
  // above); the rest are the next-best ranked successes, each reasoning-scrubbed
  // the same way. When only one candidate survives, the single-best path below
  // runs exactly as ADR-010.
  const exposed = exposeK > 1 ? orderSuccesses(successes).filter((s) => s.index !== chosen.index) : [];
  if (exposeK > 1 && exposed.length > 0) {
    const scrub = !wantsVisibleReasoning(body);
    const head = choiceParts(served.json, served.message);
    const choices: Array<Record<string, unknown>> = [
      { index: 0, message: head.message, finish_reason: head.finish_reason },
    ];
    for (const sample of exposed.slice(0, exposeK - 1)) {
      const json =
        scrub && sample.json !== undefined
          ? (stripChatReasoningPayload(sample.json) as Record<string, unknown>)
          : sample.json;
      const part = choiceParts(json, sample.message);
      choices.push({ index: choices.length, message: part.message, finish_reason: part.finish_reason });
    }
    headers.set(EXPOSED_HEADER, String(choices.length));
    const multi: Record<string, unknown> = { ...(served.json ?? chosen.json ?? {}), choices };
    if (isStreaming(body)) {
      headers.set("content-type", "text/event-stream");
      return new Response(replayChoicesAsSse(multi, choices), { status: 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(multi), { status: 200, headers });
  }

  if (isStreaming(body)) {
    headers.set("content-type", "text/event-stream");
    return new Response(replayAsSse(served), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(served.text, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Streaming replay
// ---------------------------------------------------------------------------

/**
 * The chosen (reassembled or buffered) completion as well-formed SSE in the
 * OpenAI chunk shape: one chunk carrying the whole message as a delta, one
 * final chunk with the finish reason and usage, then `[DONE]`. Shared with
 * the completeness gate's buffered forward (`gate.ts`), which replays a
 * graded answer to a streaming client the same way.
 */
export function replayAsSse(chosen: {
  json?: Record<string, unknown> | undefined;
  message?: Record<string, unknown> | undefined;
}): ReadableStream<Uint8Array> {
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

/**
 * The top-K exposure (ADR-026) as well-formed multi-choice SSE: one chunk
 * carrying every choice's message as its delta (each on its own `index`), one
 * final chunk closing every choice with its finish reason and the aggregate
 * usage, then `[DONE]`. The OpenAI streaming shape for `n > 1`: a client reads
 * each candidate off `choices[].index`.
 */
export function replayChoicesAsSse(
  json: Record<string, unknown>,
  choices: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  const frame = {
    id: typeof json["id"] === "string" ? json["id"] : "milo-sampled",
    object: "chat.completion.chunk",
    created: typeof json["created"] === "number" ? json["created"] : Math.floor(Date.now() / 1000),
    model: typeof json["model"] === "string" ? json["model"] : "",
  };

  const deltaFor = (message: Record<string, unknown>): Record<string, unknown> => {
    const delta: Record<string, unknown> = { role: "assistant" };
    if (typeof message["content"] === "string") delta["content"] = message["content"];
    const toolCalls = message["tool_calls"];
    if (Array.isArray(toolCalls)) {
      delta["tool_calls"] = toolCalls.map((call, index) => (isRecord(call) ? { index, ...call } : call));
    }
    return delta;
  };

  const contentChunk = {
    ...frame,
    choices: choices.map((choice, index) => ({
      index,
      delta: deltaFor(isRecord(choice["message"]) ? (choice["message"] as Record<string, unknown>) : {}),
      finish_reason: null,
    })),
  };
  const finalChunk = {
    ...frame,
    choices: choices.map((choice, index) => ({ index, delta: {}, finish_reason: choice["finish_reason"] ?? "stop" })),
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
// Unsampled safety fallback
// ---------------------------------------------------------------------------

/**
 * Sampling produced no safe winner, so the request gets what the policy would
 * have bought without sampling: one ordinary call on `unsampledTier`, streamed
 * or buffered exactly as asked. The decision record keeps every sample's
 * metadata and names the failure or abstention reason.
 *
 * The body still carries the posture-aware provider strategy `routed()`
 * applied -- but that strategy's price ceiling was computed for the SAMPLED
 * model, and this call goes to a different, dearer one. Shipping the fast
 * model's ceiling to a frontier model excludes every endpoint it has and
 * OpenRouter answers 404, which is exactly what the live run recorded on the
 * two decisions that lost all five samples to the sample timeout. The
 * ceiling is therefore recomputed for the model actually being called
 * (`retargetProviderStrategy`); a caller-supplied `provider` still passes
 * through untouched.
 */
async function fallbackUnsampled(
  c: Context,
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  ctx: SamplingContext,
  samples: Sample[],
  startedAt: number,
  sampleNote: NonNullable<Upstream["sampleNote"]> = "all_samples_failed",
): Promise<Response> {
  const tier: Tier = decision.unsampledTier ?? decision.tier;
  let model: string;
  if (decision.unsampledModel !== undefined) {
    // The decision's sampled model is not tier-derived (ADR-012: the deepseek
    // controller samples a fixed family model), so it names its own single-call
    // fallback and the roster has nothing to resolve.
    model = decision.unsampledModel;
  } else {
    const roster = await resolveRoster(c, deps);
    try {
      model = resolveModel(tier, roster, ctx.candidates, {
        longOutput: decision.signals?.longOutput ?? 0,
      });
    } catch (err) {
      deps.logger.error("sampled fallback could not resolve a model", { decisionId: decision.id, error: errorMessage(err) });
      model = decision.model;
    }
  }
  deps.logger.warn("sample selection did not produce a safe winner; falling back to one unsampled call", {
    decisionId: decision.id,
    tier,
    model,
    sampleNote,
  });

  const sampleMeta = samples.map((s) => toSampleUpstream(s, false));
  const sampledUsage = aggregateUsage(samples, undefined);
  const forwarded = prepareBody(retargetProviderStrategy(body, decision.model, model), model);

  let upstream: Response;
  try {
    upstream = await deps.openRouter.chatCompletions({ headers: upstreamHeadersFor(c), body: forwarded });
  } catch (err) {
    deps.recordUpstream(decision.id, {
      status: 502,
      latencyMs: deps.now() - startedAt,
      ...toUpstreamRecord(sampledUsage),
      samples: sampleMeta,
      sampleNote,
      ...pruneRecord(ctx.prune),
    });
    deps.logger.error("openrouter chat completions failed", { decisionId: decision.id, error: errorMessage(err) });
    return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
  }

  const headers = passThroughHeaders(upstream);
  applyMiloHeaders(headers, decision);
  applyJevTransportHeader(headers, deps);
  applyPruneHeaders(headers, ctx.prune);
  for (const [k, v] of Object.entries(briefHeaders(ctx.briefVersion))) headers.set(k, v);
  for (const [k, v] of Object.entries(factHeaders(ctx.facts))) headers.set(k, v);
  // The response the client got came from the fallback, not the sampled fast
  // model, and the headers must say what actually answered.
  headers.set("x-milo-model", model);
  headers.set("x-milo-tier", tier);
  headers.set(SAMPLES_HEADER, String(decision.samples ?? 0));

  const chargeCtx = { surface: "chat" as const, model, decisionId: decision.id };
  const scrub = !wantsVisibleReasoning(body);

  if (isStreaming(body) && upstream.ok && upstream.body !== null) {
    const [client, audit] = upstream.body.tee();
    const work = usageFromStream("chat", audit).then((fallbackUsage) => {
      const usage = addUsage(sampledUsage, fallbackUsage);
      deps.recordUpstream(decision.id, {
        status: upstream.status,
        latencyMs: deps.now() - startedAt,
        ...toUpstreamRecord(usage),
        samples: sampleMeta,
        sampleNote,
        ...pruneRecord(ctx.prune),
      });
    }).catch((error: unknown) => {
      deps.logger.error("could not read sampled fallback usage", { decisionId: decision.id, error: errorMessage(error) });
    });
    deps.track?.(work);
    let served = client;
    if (scrub) served = served.pipeThrough(stripChatReasoningSse());
    return new Response(chargeStream(c, deps, headers, chargeCtx, served, sampledUsage), { status: upstream.status, headers });
  }

  let text = await upstream.text();
  if (scrub && upstream.ok) text = stripChatReasoningBody(text);
  const usage = addUsage(sampledUsage, upstream.ok ? readBodyUsage("chat", text) : {});
  const record: Upstream = {
    status: upstream.status,
    latencyMs: deps.now() - startedAt,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    samples: sampleMeta,
    sampleNote,
    ...pruneRecord(ctx.prune),
  };
  deps.recordUpstream(decision.id, record);
  if (upstream.ok) await chargeBuffered(c, deps, headers, chargeCtx, usage);

  return new Response(text, { status: upstream.status, headers });
}
