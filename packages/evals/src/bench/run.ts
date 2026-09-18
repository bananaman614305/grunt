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

import type { ChatMessage, CostPosture } from "@milo/core";
import type { RoutingExample } from "../schema.js";
import { buildJudgeMessages, gradeMechanically, isMechanical, parseJudgeVerdict } from "./graders.js";
import type { GraderRow } from "./graders.js";
import { measureChatCompletion } from "./sse.js";
import type { ArmName, ArmResult, BenchReport, BenchRow, CallMeasurement, FixedArm, ModelPrice } from "./types.js";
import { FIXED_ARMS, MILO_ARM } from "./types.js";

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
  providers?: string[];
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
  /** Injectable for tests. */
  now?: () => string;
};

/** The `provider` body field for a pinned run, or nothing when no pin is set. */
export function providerField(providers: string[] | undefined): Record<string, unknown> {
  if (providers === undefined || providers.length === 0) return {};
  return { provider: { order: providers, allow_fallbacks: false } };
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
  measure: (baseUrl: string, body: Record<string, unknown>) => Promise<CallMeasurement>;
};

async function callArm(runner: Runner, example: RoutingExample, messages: ChatMessage[], arm: ArmName): Promise<ArmResult> {
  const { options } = runner;
  const routed = arm === MILO_ARM;
  const model = routed ? "milo/auto" : options.fixedModels[arm];
  const body: Record<string, unknown> = {
    model,
    messages,
    ...(example.has_tools ? { tools: BENCH_TOOLS, tool_choice: "none" } : {}),
    ...(routed ? { milo: { posture: options.posture } } : {}),
    ...providerField(options.providers),
  };
  const baseUrl = routed ? options.gatewayBaseUrl : options.openRouterBaseUrl;
  const base: ArmResult = { arm, model, tier: routed ? "mid" : arm, status: 0, ttfbMs: NaN, totalMs: NaN };

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
    const record = (await response.json()) as { signals?: { latencyMs?: unknown }; upstream?: { latencyMs?: unknown } };
    if (typeof record.signals?.latencyMs === "number") result.jevLatencyMs = record.signals.latencyMs;
    if (typeof record.upstream?.latencyMs === "number") result.upstreamLatencyMs = record.upstream.latencyMs;
  } catch {
    // Latency detail is optional; the measurement itself already succeeded.
  }
}

async function grade(runner: Runner, example: RoutingExample, task: ChatMessage[], result: ArmResult, answer: string): Promise<ArmResult> {
  const { options } = runner;
  if (result.error !== undefined) return result;
  const row = options.graders.get(example.id);
  if (row === undefined) return result;

  if (isMechanical(row.grader)) {
    const mechanical = gradeMechanically(row.grader, answer);
    if (mechanical !== undefined) result.grade = mechanical;
    return result;
  }
  if (!options.judge || row.grader.type !== "judge") return result;

  try {
    const verdict = await runner.measure(options.openRouterBaseUrl, {
      model: options.judgeModel,
      messages: buildJudgeMessages(task, answer, row.grader),
      temperature: 0,
      ...providerField(options.providers),
    });
    if (verdict.status !== 200) {
      result.grade = { score: 0, pass: false, by: "judge", reason: `judge HTTP ${verdict.status}` };
      return result;
    }
    const parsed = parseJudgeVerdict(verdict.text);
    result.grade = { ...parsed, ...(verdict.costUsd !== undefined ? { judgeCostUsd: verdict.costUsd } : {}) };
  } catch (error) {
    result.grade = { score: 0, pass: false, by: "judge", reason: `judge ${classify(error)}` };
  }
  return result;
}

async function runExample(runner: Runner, example: RoutingExample, index: number): Promise<BenchRow> {
  const { options } = runner;
  const messages = saltMessages(example.messages as ChatMessage[], options.salt);
  const results: ArmResult[] = [];
  for (const arm of armOrder(options.arms, index)) {
    results.push(await callArm(runner, example, messages, arm));
  }
  options.onProgress?.(`${example.id}: ${results.map((r) => `${r.arm}=${r.error ?? (r.grade ? (r.grade.pass ? "pass" : "fail") : "ok")}`).join(" ")}`);
  return {
    id: example.id,
    taskType: example.task_type,
    difficultyBand: example.difficulty_band,
    expectedTier: example.expected_tier_balanced,
    hasGrader: options.graders.has(example.id),
    results,
  };
}

export async function runBench(options: RunBenchOptions): Promise<BenchReport> {
  const runner: Runner = {
    options,
    measure: (baseUrl, body) =>
      measureChatCompletion({
        baseUrl,
        apiKey: options.apiKey,
        body,
        timeoutMs: options.timeoutMs,
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

  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    gateway: options.gatewayBaseUrl,
    posture: options.posture,
    fixedModels: options.fixedModels,
    prices,
    baseline: options.baseline,
    judgeModel: options.judgeModel,
    providers: options.providers ?? [],
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
