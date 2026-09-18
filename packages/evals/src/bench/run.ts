/**
 * The benchmark runner. For each example it calls every arm in a per-example
 * shuffled order (so no arm systematically goes first while OpenRouter is
 * busier or quieter), measures each call, fetches the routed arm's decision
 * record for Jev's own latency, then grades every successful answer.
 *
 * One Milo posture per run: the router's sticky cache keys on the
 * conversation fingerprint and the user-turn count, not the posture, so a
 * second posture on the same prompt would inherit the first decision. The
 * runner records `x-milo-sticky` so inherited decisions are visible in the
 * report, and `salt` can be appended to the first user message to force a
 * fresh fingerprint when a rerun lands inside the 30 minute TTL.
 *
 * Nothing here logs a key or an answer. The OpenRouter key comes from the
 * caller and goes only into the `Authorization` header.
 */

import type { ChatMessage, CostPosture, JevClientLike, Tier } from "@milo/core";
import type { RoutingExample } from "../schema.js";
import { auditSelected, graderContentHash, verdictKey } from "./cache.js";
import type { JudgeCacheLike } from "./cache.js";
import { buildJudgeMessages, gradeMechanically, isMechanical, parseJudgeVerdict } from "./graders.js";
import type { Grader, GraderRow } from "./graders.js";
import { DEFAULT_PROVIDER_PINS, pinsFor } from "./providers.js";
import type { ProviderPins } from "./providers.js";
import { DEEPSEEK_BRANCH_MODEL, sizeCompute } from "./deepseek.js";
import type { ComputeSizing } from "./deepseek.js";
import { applyVariant, pickByJev, pickByOracle, rankAnswer, variantFor } from "./sampling.js";
import type { RankedSample } from "./sampling.js";
import { measureChatCompletion } from "./sse.js";
import type { ArmName, ArmResult, BenchReport, BenchRow, CallMeasurement, ComputeRecord, FixedArm, Grade, ModelPrice, SampleRecord, SamplingConfig } from "./types.js";
import { customArmModel, DEEPSEEK_ARM, FIXED_ARMS, isCustomArm, MILO_ARM } from "./types.js";

/** Jev's price per systemone call, USD (docs/PLAN.md). Charged to the best-of arms once per sample. */
export const JEV_USD_PER_CALL = 0.00002;

/**
 * The deepseek arm's adaptive stop, mirroring the gateway's first-k early
 * return (`packages/gateway/src/routes/sampling.ts`, `MIN_RANKED_DEFAULT` and
 * `EARLY_WIN_QUALITY`): once this many samples are ranked and the best
 * expected quality is at or above the win bar, the pick returns and the
 * still-running stragglers are aborted.
 */
export const DEEPSEEK_MIN_RANKED = 3;
/** Jev expected quality (0..3) at which an early pick is a clear winner. */
export const DEEPSEEK_EARLY_WIN_QUALITY = 2.5;

export type RunBenchOptions = {
  examples: RoutingExample[];
  graders: Map<string, GraderRow>;
  /** Milo's `/v1` base, e.g. `http://127.0.0.1:8787/v1`. */
  gatewayBaseUrl: string;
  /** OpenRouter's `/api/v1` base, or a key-injecting proxy in front of it. */
  openRouterBaseUrl: string;
  apiKey: string;
  posture: CostPosture;
  arms: ArmName[];
  fixedModels: Record<FixedArm, string>;
  judgeModel: string;
  /** False skips every judge call; judged examples are then ungraded. */
  judge: boolean;
  /**
   * Re-grade this fraction of judged answers with `auditJudgeModel` too, so
   * a cheap judge is continuously checked against a stronger one. The pick
   * is deterministic per (example id, arm), so reruns audit the same
   * answers. 0 or undefined audits nothing.
   */
  judgeAuditFraction?: number;
  /** The auditing judge. No audit runs when it is absent or equals `judgeModel`. */
  auditJudgeModel?: string;
  /**
   * Verdict cache: a hit skips the judge call and carries no cost, so the
   * report's judge cost counts fresh calls only. Undefined bypasses caching
   * and every judge call goes out fresh. Failed calls are never cached.
   */
  judgeCache?: JudgeCacheLike;
  prices: Map<string, ModelPrice>;
  baseline: ModelPrice;
  concurrency: number;
  timeoutMs: number;
  salt?: string;
  /**
   * OpenRouter provider slugs to pin every call to, in preference order, with
   * fallbacks disabled. OpenRouter takes the first entry that serves the model
   * being called, so one list covers the fixed arms, the judge, and whichever
   * model Milo picks. Token counting and latency differ by provider, so a pin
   * is what makes two runs comparable. Empty leaves the choice to OpenRouter.
   */
  /** Per-model OpenRouter provider pins. Defaults to `DEFAULT_PROVIDER_PINS`. */
  providerPins?: ProviderPins;
  /**
   * Per-sample wall-clock cap for best-of-N draws, ms. A straggling sample is
   * aborted at this bound and dropped, so one slow provider cannot define the
   * arm's latency. Defaults to `timeoutMs`.
   */
  sampleTimeoutMs?: number;
  /**
   * Best-of-N: draw this many samples per example from `sampleTier`'s fixed
   * model, grade each, rank each with `jev`, and add the `bestof-*` arms.
   * 1 or undefined draws none.
   */
  samples?: number;
  /** Which tier's fixed model to sample. Defaults to `fast`. */
  sampleTier?: FixedArm;
  /** OpenRouter `reasoning.effort` for the deepseek arm's samples (ablation knob). */
  dsReasoning?: string;
  /** Band-3 structural knobs: swap the orchestrator for the branch model, or cap its samples. */
  dsBand3Model?: "flash" | "v41";
  dsBand3Samples?: number;
  /** Cycle the prompt framings in `PROMPT_VARIANTS` across samples. */
  vary?: boolean;
  /** Ranks samples. Required when `samples` > 1. */
  jev?: JevClientLike;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
  /** Injectable for tests. */
  now?: () => string;
};

/**
 * The `provider` body field pinning `model` to its fast providers, or nothing
 * when the model is not in the pin map. A model absent from the map (the
 * routed `milo/auto`, whose downstream model the gateway picks) is left to
 * OpenRouter's own choice, since a per-model pin cannot name a provider for a
 * model that is not known until the gateway has routed.
 */
export function providerField(model: string, pins: ProviderPins): Record<string, unknown> {
  const order = pinsFor(model, pins);
  if (order.length === 0) return {};
  return { provider: { order, allow_fallbacks: false } };
}

/** Stands in for "this request looked agentic" without inviting a tool call. */
export const BENCH_TOOLS: unknown[] = [
  { type: "function", function: { name: "bench_placeholder", description: "benchmark placeholder tool", parameters: { type: "object", properties: {} } } },
];

/** Appends the salt to the first user message so the fingerprint changes and nothing else does. */
export function saltMessages(messages: ChatMessage[], salt: string | undefined): ChatMessage[] {
  if (salt === undefined || salt === "") return messages;
  let done = false;
  return messages.map((m) => {
    if (done || m.role !== "user" || typeof m.content !== "string") return m;
    done = true;
    return { ...m, content: `${m.content}\n\n[bench ${salt}]` };
  });
}

/**
 * A per-example deterministic order of arms: rotated by the example's index,
 * so every arm goes first equally often and time-of-day bias spreads evenly.
 */
export function armOrder(arms: ArmName[], index: number): ArmName[] {
  if (arms.length === 0) return [];
  const k = index % arms.length;
  return [...arms.slice(k), ...arms.slice(0, k)];
}

function classify(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timeout";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(error.message)) return "network";
    return error.name === "Error" ? "error" : error.name;
  }
  return "error";
}

type Runner = {
  options: RunBenchOptions;
  measure: (baseUrl: string, body: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<CallMeasurement>;
  /** Present when `judgeCache` is; mutated as verdicts hit or miss. */
  cacheStats?: { hits: number; misses: number };
};

async function callArm(runner: Runner, example: RoutingExample, messages: ChatMessage[], arm: Exclude<ArmName, typeof DEEPSEEK_ARM>): Promise<ArmResult> {
  const { options } = runner;
  const routed = arm === MILO_ARM;
  const model = routed ? "milo/auto" : isCustomArm(arm) ? customArmModel(arm) : options.fixedModels[arm];
  const body: Record<string, unknown> = {
    model,
    messages,
    // `tool_choice: "auto"` rather than `"none"`: OpenRouter's endpoint filter
    // drops some providers (StreamLake, for one) for `"none"` and answers 404
    // when fallbacks are off, while `"auto"` is accepted everywhere and the
    // placeholder tool is never worth calling.
    ...(example.has_tools ? { tools: BENCH_TOOLS, tool_choice: "auto" } : {}),
    ...(routed ? { milo: { posture: options.posture } } : {}),
    ...providerField(model, options.providerPins ?? DEFAULT_PROVIDER_PINS),
  };
  const baseUrl = routed ? options.gatewayBaseUrl : options.openRouterBaseUrl;
  // A custom arm has no roster tier; "mid" is a placeholder the summaries never read.
  const tier: Tier = routed || isCustomArm(arm) ? "mid" : arm;
  const base: ArmResult = { arm, model, tier, status: 0, ttfbMs: NaN, totalMs: NaN };

  let measured: CallMeasurement;
  try {
    measured = await runner.measure(baseUrl, body);
  } catch (error) {
    return { ...base, error: classify(error) };
  }

  const result: ArmResult = {
    ...base,
    status: measured.status,
    ttfbMs: measured.ttfbMs,
    totalMs: measured.totalMs,
    ...(measured.provider !== undefined ? { provider: measured.provider } : {}),
    ...(measured.inputTokens !== undefined ? { inputTokens: measured.inputTokens } : {}),
    ...(measured.outputTokens !== undefined ? { outputTokens: measured.outputTokens } : {}),
    ...(measured.reasoningTokens !== undefined ? { reasoningTokens: measured.reasoningTokens } : {}),
    ...(measured.costUsd !== undefined ? { costUsd: measured.costUsd } : {}),
  };
  if (measured.status !== 200) result.error = `HTTP ${measured.status}`;

  if (routed) {
    const { milo } = measured;
    if (milo.model !== undefined) result.model = milo.model;
    const tier = milo.tier;
    if (tier === "fast" || tier === "mid" || tier === "frontier") result.tier = tier;
    result.sticky = milo.sticky === "true";
    if (milo.decisionId !== undefined) {
      result.decisionId = milo.decisionId;
      await attachDecision(runner, result, milo.decisionId);
    }
  } else if (measured.model !== undefined && measured.model !== "") {
    result.model = measured.model;
  }

  return grade(runner, example, messages, result, measured.text);
}

/** Reads Jev's and the upstream's latency off the decision record. Best effort; a failure leaves both unset. */
async function attachDecision(runner: Runner, result: ArmResult, decisionId: string): Promise<void> {
  const { options } = runner;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.gatewayBaseUrl.replace(/\/+$/, "")}/decisions/${decisionId}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    if (!response.ok) return;
    const record = (await response.json()) as {
      signals?: { latencyMs?: unknown };
      upstream?: { latencyMs?: unknown };
      unsampledTier?: unknown;
      samples?: unknown;
    };
    if (typeof record.signals?.latencyMs === "number") result.jevLatencyMs = record.signals.latencyMs;
    if (typeof record.upstream?.latencyMs === "number") result.upstreamLatencyMs = record.upstream.latencyMs;
    // A sampled decision (ADR-010) executes on fast while the policy's own
    // choice is recorded as unsampledTier; agreement must judge the choice.
    const unsampled = record.unsampledTier;
    if (unsampled === "fast" || unsampled === "mid" || unsampled === "frontier") result.unsampledTier = unsampled;
    if (typeof record.samples === "number" && record.samples > 1) result.gatewaySamples = record.samples;
  } catch {
    // Latency detail is optional; the measurement itself already succeeded.
  }
}

/** One judge call. `verdict` is false when the call itself failed — worth retrying later, so never cached or audited. */
async function callJudge(
  runner: Runner,
  task: ChatMessage[],
  answer: string,
  grader: Extract<Grader, { type: "judge" }>,
  model: string,
): Promise<{ grade: Grade; verdict: boolean }> {
  const { options } = runner;
  try {
    const measured = await runner.measure(options.openRouterBaseUrl, {
      model,
      messages: buildJudgeMessages(task, answer, grader),
      temperature: 0,
      ...providerField(model, options.providerPins ?? DEFAULT_PROVIDER_PINS),
    });
    if (measured.status !== 200) return { grade: { score: 0, pass: false, by: "judge", reason: `judge HTTP ${measured.status}` }, verdict: false };
    const parsed = parseJudgeVerdict(measured.text);
    return { grade: { ...parsed, ...(measured.costUsd !== undefined ? { judgeCostUsd: measured.costUsd } : {}) }, verdict: true };
  } catch (error) {
    return { grade: { score: 0, pass: false, by: "judge", reason: `judge ${classify(error)}` }, verdict: false };
  }
}

/** A verdict from the cache when possible, else a fresh call whose real verdict is cached. */
async function judgeWithCache(
  runner: Runner,
  exampleId: string,
  task: ChatMessage[],
  answer: string,
  grader: Extract<Grader, { type: "judge" }>,
  model: string,
): Promise<{ grade: Grade; verdict: boolean }> {
  const cache = runner.options.judgeCache;
  if (cache === undefined) return callJudge(runner, task, answer, grader, model);
  const key = verdictKey({ exampleId, graderHash: graderContentHash(grader), judgeModel: model, answer });
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (runner.cacheStats !== undefined) runner.cacheStats.hits += 1;
    return { grade: hit, verdict: true };
  }
  const fresh = await callJudge(runner, task, answer, grader, model);
  if (runner.cacheStats !== undefined) runner.cacheStats.misses += 1;
  if (fresh.verdict) cache.set(key, fresh.grade);
  return fresh;
}

/**
 * Grades one answer with the example's grader: mechanically, or by the judge
 * when enabled. `armKey` names the answer's slot — an arm name, or
 * `sample-<n>` for a best-of-N draw — and drives the deterministic audit
 * pick: a picked slot whose primary verdict was real is also graded by the
 * auditing judge, and that verdict rides on the grade as `audit`.
 */
async function gradeAnswer(runner: Runner, example: RoutingExample, task: ChatMessage[], answer: string, armKey: string): Promise<Grade | undefined> {
  const { options } = runner;
  const row = options.graders.get(example.id);
  if (row === undefined) return undefined;

  if (isMechanical(row.grader)) return gradeMechanically(row.grader, answer);
  if (!options.judge || row.grader.type !== "judge") return undefined;

  const primary = await judgeWithCache(runner, example.id, task, answer, row.grader, options.judgeModel);
  const auditModel = options.auditJudgeModel;
  if (
    primary.verdict &&
    auditModel !== undefined &&
    auditModel !== options.judgeModel &&
    auditSelected(example.id, armKey, options.judgeAuditFraction ?? 0)
  ) {
    const audit = await judgeWithCache(runner, example.id, task, answer, row.grader, auditModel);
    if (audit.verdict) {
      primary.grade.audit = {
        model: auditModel,
        score: audit.grade.score,
        pass: audit.grade.pass,
        ...(audit.grade.reason !== undefined ? { reason: audit.grade.reason } : {}),
        ...(audit.grade.judgeCostUsd !== undefined ? { judgeCostUsd: audit.grade.judgeCostUsd } : {}),
      };
    }
  }
  return primary.grade;
}

async function grade(runner: Runner, example: RoutingExample, task: ChatMessage[], result: ArmResult, answer: string): Promise<ArmResult> {
  if (result.error !== undefined) return result;
  const verdict = await gradeAnswer(runner, example, task, answer, result.arm);
  if (verdict !== undefined) result.grade = verdict;
  return result;
}

// ---------------------------------------------------------------------------
// Best-of-N sampling
// ---------------------------------------------------------------------------

type DrawnSample = { record: SampleRecord; text: string };

/**
 * One best-of-N draw: one streamed call on `model` with sample `index`'s
 * prompt framing, under the per-sample timeout. `external` lets a caller
 * abort the draw mid-stream (the adaptive stop); a draw cancelled that way
 * records `error: "aborted"` rather than a timeout. Never throws.
 */
async function drawSample(
  runner: Runner,
  example: RoutingExample,
  messages: ChatMessage[],
  model: string,
  index: number,
  vary: boolean,
  external?: AbortController,
  reasoningEffort?: string,
): Promise<DrawnSample> {
  const { options } = runner;
  const variant = variantFor(index, vary);
  const body: Record<string, unknown> = {
    model,
    messages: applyVariant(messages, variant),
    ...(example.has_tools ? { tools: BENCH_TOOLS, tool_choice: "auto" } : {}),
    ...providerField(model, options.providerPins ?? DEFAULT_PROVIDER_PINS),
    // Gate run 1: the band-3 orchestrator spent ~15k reasoning tokens per
    // example (97% of the arm's cost). The cap trades thinking length for
    // price; the ablation measures what that trade costs in pass rate.
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}),
  };
  const base: SampleRecord = { index, variant, model, status: 0, ttfbMs: NaN, totalMs: NaN };
  try {
    const m = await runner.measure(options.openRouterBaseUrl, body, options.sampleTimeoutMs ?? options.timeoutMs, external?.signal);
    if (external?.signal.aborted === true) return { record: { ...base, error: "aborted" }, text: "" };
    const record: SampleRecord = {
      ...base,
      status: m.status,
      ttfbMs: m.ttfbMs,
      totalMs: m.totalMs,
      ...(m.provider !== undefined ? { provider: m.provider } : {}),
      ...(m.inputTokens !== undefined ? { inputTokens: m.inputTokens } : {}),
      ...(m.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}),
      ...(m.reasoningTokens !== undefined ? { reasoningTokens: m.reasoningTokens } : {}),
      ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}),
      ...(m.status !== 200 ? { error: `HTTP ${m.status}` } : {}),
    };
    return { record, text: m.text };
  } catch (error) {
    return { record: { ...base, error: external?.signal.aborted === true ? "aborted" : classify(error) }, text: "" };
  }
}

/** Draws, grades, and ranks N samples for one example. */
async function drawSamples(runner: Runner, example: RoutingExample, messages: ChatMessage[]): Promise<SampleRecord[]> {
  const { options } = runner;
  const n = options.samples ?? 1;
  const tier: FixedArm = options.sampleTier ?? "fast";
  const model = options.fixedModels[tier];

  const drawn = await Promise.all(
    Array.from({ length: n }, (_, i) => drawSample(runner, example, messages, model, i, options.vary === true)),
  );

  await Promise.all(
    drawn.map(async ({ record, text }) => {
      if (record.error !== undefined) return;
      const verdict = await gradeAnswer(runner, example, messages, text, `sample-${record.index}`);
      if (verdict !== undefined) record.grade = verdict;
      if (options.jev === undefined) return;
      try {
        record.rank = await rankAnswer(options.jev, messages, text);
      } catch (error) {
        record.rankError = classify(error);
      }
    }),
  );

  return drawn.map((d) => d.record);
}

/** Folds the samples into one synthetic arm result around the chosen sample. */
function sampledArm(arm: "bestof-jev" | "bestof-oracle", samples: SampleRecord[], tier: Tier, pick: RankedSample | undefined): ArmResult {
  const ok = samples.filter((s) => s.error === undefined && s.status === 200);
  const chosen = pick === undefined ? undefined : samples[pick.index];
  const model = samples[0]?.model ?? "";
  if (chosen === undefined || ok.length === 0) {
    return { arm, model, tier, status: 0, ttfbMs: NaN, totalMs: NaN, error: "no successful sample" };
  }
  const sum = (pickField: (s: SampleRecord) => number | undefined): number | undefined => {
    const values = ok.map(pickField).filter((v): v is number => v !== undefined);
    return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0);
  };
  // The pick is usable once the slowest sample has finished and the slowest
  // ranking call has answered; samples and ranks both run in parallel.
  const slowest = Math.max(...ok.map((s) => s.totalMs));
  const rankWait = Math.max(0, ...ok.map((s) => s.rank?.latencyMs ?? 0));
  const ready = slowest + (arm === "bestof-jev" ? rankWait : 0);
  const cost = sum((s) => s.costUsd);
  const jevCost = arm === "bestof-jev" ? ok.filter((s) => s.rank !== undefined).length * JEV_USD_PER_CALL : 0;
  const inputTokens = sum((s) => s.inputTokens);
  const outputTokens = sum((s) => s.outputTokens);
  const reasoningTokens = sum((s) => s.reasoningTokens);
  return {
    arm,
    model,
    tier,
    ...(chosen.provider !== undefined ? { provider: chosen.provider } : {}),
    status: 200,
    ttfbMs: ready,
    totalMs: ready,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { costUsd: cost + jevCost } : {}),
    ...(chosen.grade !== undefined ? { grade: chosen.grade } : {}),
  };
}

// ---------------------------------------------------------------------------
// The composed deepseek arm (ADR-012 phase 1)
// ---------------------------------------------------------------------------

/**
 * One example through the compute controller: a Jev sizing call with the
 * router's questions picks a band and a budget (`deepseek.ts`), the budget's
 * samples are drawn in parallel with the varied framings, each finished
 * sample is ranked by Jev as it lands, and the adaptive stop mirrors the
 * gateway's first-k early return: once `DEEPSEEK_MIN_RANKED` samples are
 * ranked and the best expected quality clears `DEEPSEEK_EARLY_WIN_QUALITY`,
 * the pick returns and every still-running straggler is aborted through its
 * `AbortController` (recorded as `error: "aborted"`, never graded). When no
 * early winner emerges the pick falls to Jev's best over everything ranked,
 * or the first success when ranking failed throughout.
 *
 * The result's `costUsd` is the true aggregate: every completed sample plus
 * every Jev call (one sizing, one rank per ranked sample) at
 * `JEV_USD_PER_CALL`. `totalMs` is sizing plus the wall time to the pick --
 * the sequential shape a gateway implementation would have.
 */
async function runDeepseekArm(runner: Runner, example: RoutingExample, messages: ChatMessage[]): Promise<ArmResult> {
  const { options } = runner;
  const jev = options.jev;
  const base: ArmResult = { arm: DEEPSEEK_ARM, model: DEEPSEEK_BRANCH_MODEL, tier: "fast", status: 0, ttfbMs: NaN, totalMs: NaN };
  if (jev === undefined) return { ...base, error: "no jev client" };

  let sizing: ComputeSizing;
  try {
    sizing = await sizeCompute(jev, messages, example.has_tools ? BENCH_TOOLS : undefined);
    // Structural band-3 cost knobs (the ablation showed reasoning.effort is
    // ignored upstream): swap the orchestrator for the branch model, or cap
    // the draw, and price what each concession costs in pass rate.
    if (sizing.budget.band === 3) {
      if (options.dsBand3Model === "flash") sizing = { ...sizing, budget: { ...sizing.budget, model: DEEPSEEK_BRANCH_MODEL } };
      if (options.dsBand3Samples !== undefined) sizing = { ...sizing, budget: { ...sizing.budget, samples: options.dsBand3Samples } };
    }
  } catch (error) {
    return { ...base, error: `sizing ${classify(error)}` };
  }
  const { budget } = sizing;
  const n = budget.samples;
  const minRanked = Math.max(1, Math.min(DEEPSEEK_MIN_RANKED, n));
  const started = performance.now();

  type Slot = { controller: AbortController; done: Promise<void>; drawn?: DrawnSample; settled: boolean };
  const slots: Slot[] = [];
  let decided = false;
  let earlyStop = false;
  let resolveDecision: () => void = () => undefined;
  const decision = new Promise<void>((resolve) => {
    resolveDecision = resolve;
  });
  const decide = (early: boolean): void => {
    if (decided) return;
    decided = true;
    if (early && slots.some((slot) => !slot.settled)) {
      earlyStop = true;
      for (const slot of slots) if (!slot.settled) slot.controller.abort();
    }
    resolveDecision();
  };

  const okDrawn = (d: DrawnSample | undefined): d is DrawnSample =>
    d !== undefined && d.record.error === undefined && d.record.status === 200;

  // The gateway's evaluate, one to one: an early win needs minRanked ranked
  // samples and a clear winner; when every rank failed, more samples cannot
  // change a pick Jev will never score, so enough successes decide too.
  const evaluate = (): void => {
    if (decided) return;
    const settled = slots.filter((slot) => slot.settled);
    const successes = settled.filter((slot) => okDrawn(slot.drawn));
    const ranked = successes.filter((slot) => slot.drawn?.record.rank !== undefined);
    if (ranked.length >= minRanked) {
      const best = Math.max(...ranked.map((slot) => slot.drawn?.record.rank?.quality ?? 0));
      if (best >= DEEPSEEK_EARLY_WIN_QUALITY) {
        decide(true);
        return;
      }
    }
    if (ranked.length === 0 && successes.length >= minRanked) {
      decide(true);
      return;
    }
    if (settled.length === slots.length) decide(false);
  };

  for (let index = 0; index < n; index += 1) {
    const controller = new AbortController();
    const slot: Slot = { controller, settled: false, done: Promise.resolve() };
    slots.push(slot);
    slot.done = (async (): Promise<void> => {
      const drawn = await drawSample(runner, example, messages, budget.model, index, true, controller, options.dsReasoning);
      slot.drawn = drawn;
      // Rank as the stream completes; after a decision no new ranks start.
      if (n > 1 && okDrawn(drawn) && !decided) {
        try {
          drawn.record.rank = await rankAnswer(jev, messages, drawn.text);
        } catch (error) {
          drawn.record.rankError = classify(error);
        }
      }
      slot.settled = true;
      evaluate();
    })();
  }

  await decision;
  const decidedAfterMs = performance.now() - started;
  // Aborted stragglers settle promptly (their fetch rejects); collect them.
  await Promise.all(slots.map((slot) => slot.done));

  const drawnAll = slots.map((slot) => slot.drawn as DrawnSample);
  const samples = drawnAll.map((d) => d.record);
  const successes = drawnAll.filter((d) => okDrawn(d));
  const rankedSamples: RankedSample[] = successes.map((d) => ({ index: d.record.index, rank: d.record.rank }));
  const pick = pickByJev(rankedSamples);
  const picked = pick === undefined ? undefined : drawnAll[pick.index];

  const ranks = successes.map((d) => d.record.rank).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const jevCalls = 1 + ranks.length;
  const jevCostUsd = jevCalls * JEV_USD_PER_CALL;
  const rankLatencyMean = ranks.length === 0 ? undefined : ranks.reduce((sum, r) => sum + r.latencyMs, 0) / ranks.length;
  const compute: ComputeRecord = {
    band: budget.band,
    budget: n,
    completed: successes.length,
    aborted: samples.filter((r) => r.error === "aborted").length,
    earlyStop,
    ...(picked !== undefined ? { pick: picked.record.index } : {}),
    sizingLatencyMs: sizing.latencyMs,
    ...(rankLatencyMean !== undefined ? { rankLatencyMs: rankLatencyMean } : {}),
    jevCalls,
    jevCostUsd,
    samples,
  };

  if (picked === undefined) {
    return { ...base, model: budget.model, error: "no successful sample", jevLatencyMs: sizing.latencyMs, compute };
  }

  const sum = (field: (r: SampleRecord) => number | undefined): number | undefined => {
    const values = successes.map((d) => field(d.record)).filter((v): v is number => v !== undefined);
    return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0);
  };
  const sampleCost = sum((r) => r.costUsd);
  const inputTokens = sum((r) => r.inputTokens);
  const outputTokens = sum((r) => r.outputTokens);
  const reasoningTokens = sum((r) => r.reasoningTokens);
  const totalMs = sizing.latencyMs + decidedAfterMs;

  const result: ArmResult = {
    arm: DEEPSEEK_ARM,
    model: budget.model,
    tier: "fast",
    ...(picked.record.provider !== undefined ? { provider: picked.record.provider } : {}),
    status: 200,
    // A single-call budget has a real first token; a sampled one is usable at the pick.
    ttfbMs: n === 1 ? sizing.latencyMs + picked.record.ttfbMs : totalMs,
    totalMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    costUsd: (sampleCost ?? 0) + jevCostUsd,
    jevLatencyMs: sizing.latencyMs,
    compute,
  };
  return grade(runner, example, messages, result, picked.text);
}

async function runExample(runner: Runner, example: RoutingExample, index: number): Promise<BenchRow> {
  const { options } = runner;
  const messages = saltMessages(example.messages as ChatMessage[], options.salt);
  const results: ArmResult[] = [];
  for (const arm of armOrder(options.arms, index)) {
    results.push(arm === DEEPSEEK_ARM ? await runDeepseekArm(runner, example, messages) : await callArm(runner, example, messages, arm));
  }

  let samples: SampleRecord[] | undefined;
  if ((options.samples ?? 1) > 1) {
    samples = await drawSamples(runner, example, messages);
    const tier: Tier = options.sampleTier ?? "fast";
    const ranked: RankedSample[] = samples
      .filter((s) => s.error === undefined && s.status === 200)
      .map((s) => ({ index: s.index, grade: s.grade, rank: s.rank }));
    results.push(sampledArm("bestof-jev", samples, tier, pickByJev(ranked)));
    results.push(sampledArm("bestof-oracle", samples, tier, pickByOracle(ranked)));
  }

  options.onProgress?.(`${example.id}: ${results.map((r) => `${r.arm}=${r.error ?? (r.grade ? (r.grade.pass ? "pass" : "fail") : "ok")}`).join(" ")}`);
  return {
    id: example.id,
    taskType: example.task_type,
    difficultyBand: example.difficulty_band,
    expectedTier: example.expected_tier_balanced,
    hasGrader: options.graders.has(example.id),
    results,
    ...(samples !== undefined ? { samples } : {}),
  };
}

export async function runBench(options: RunBenchOptions): Promise<BenchReport> {
  if ((options.samples ?? 1) > 1 && options.jev === undefined) {
    throw new Error("samples > 1 needs a Jev client to rank them");
  }
  if (options.arms.includes(DEEPSEEK_ARM) && options.jev === undefined) {
    throw new Error("the deepseek arm needs a Jev client to size the compute budget and rank the samples");
  }
  const cacheStats = options.judgeCache !== undefined ? { hits: 0, misses: 0 } : undefined;
  const runner: Runner = {
    options,
    ...(cacheStats !== undefined ? { cacheStats } : {}),
    measure: (baseUrl, body, timeoutMs, signal) =>
      measureChatCompletion({
        baseUrl,
        apiKey: options.apiKey,
        body,
        timeoutMs: timeoutMs ?? options.timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
  };

  const rows: BenchRow[] = new Array<BenchRow>(options.examples.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const example = options.examples[index];
      if (example === undefined) return;
      rows[index] = await runExample(runner, example, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  const prices: Record<string, ModelPrice> = {};
  for (const [id, price] of options.prices) prices[id] = price;

  const sampleTier: FixedArm = options.sampleTier ?? "fast";
  const sampling: SamplingConfig | undefined =
    (options.samples ?? 1) > 1
      ? { n: options.samples as number, model: options.fixedModels[sampleTier], tier: sampleTier, vary: options.vary === true, jevUsdPerCall: JEV_USD_PER_CALL }
      : undefined;

  const auditFraction = options.judgeAuditFraction ?? 0;
  const auditing =
    options.judge && auditFraction > 0 && options.auditJudgeModel !== undefined && options.auditJudgeModel !== options.judgeModel;

  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    gateway: options.gatewayBaseUrl,
    posture: options.posture,
    fixedModels: options.fixedModels,
    prices,
    baseline: options.baseline,
    judgeModel: options.judgeModel,
    ...(auditing ? { judgeAudit: { model: options.auditJudgeModel as string, fraction: auditFraction } } : {}),
    ...(cacheStats !== undefined ? { judgeCacheStats: cacheStats } : {}),
    providerPins: options.providerPins ?? DEFAULT_PROVIDER_PINS,
    ...(sampling !== undefined ? { sampling } : {}),
    rows: rows.filter((r): r is BenchRow => r !== undefined),
  };
}

/** The default model for each fixed arm: the first entry of that tier in the roster. */
export function fixedModelsFromRoster(roster: Record<FixedArm, string[]>): Record<FixedArm, string> {
  const out = {} as Record<FixedArm, string>;
  for (const arm of FIXED_ARMS) {
    const first = roster[arm][0];
    if (first === undefined) throw new Error(`roster has no model for the ${arm} tier`);
    out[arm] = first;
  }
  return out;
}
