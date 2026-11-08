/**
 * Replays a capped sample of the routing eval set through a running local
 * Milo (`milo serve`) and reports where the work landed (ADR-031): tasks per
 * subscription, failures, latency, tokens, and how much of each plan the run
 * used, read from `/v1/usage` before and after.
 *
 * Every task spends real subscription quota, so the sample is always capped.
 */

import type { RoutingExample } from "./schema.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ReplayOptions = {
  baseUrl: string;
  examples: RoutingExample[];
  /** How many tasks to run. Required: there is no "run everything" default. */
  sample: number;
  /** Seed for the stratified sample. Default 1. */
  seed?: number;
  fetch?: FetchLike;
  now?: () => number;
  /** Called after each task, for progress output. */
  onTask?: (task: ReplayTask, index: number, total: number) => void;
};

export type ReplayTask = {
  id: string;
  /** The label from the eval set. */
  labelTaskType: string;
  labelDifficulty: number;
  status: number;
  backend?: string;
  model?: string;
  classifiedAs?: string;
  classifier?: string;
  reason?: string;
  failover?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
};

type Capacity = { usedPercent?: number; remainingPercent?: number; window?: string; source: string; limited: boolean };
type Totals = { calls: number; inputTokens: number; outputTokens: number; apiEquivalentUsd: number };
type UsageReport = {
  subscriptions: Array<{ backend: string; capacity: Capacity; last7d: Totals | null }>;
};

export type BackendSummary = {
  backend: string;
  tasks: number;
  promptTokens: number;
  completionTokens: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** Plan usage before and after the run, in percent of the tightest window, when the CLI reported it. */
  usedPercentBefore?: number;
  usedPercentAfter?: number;
  window?: string;
  /** Pay-per-token API price of the same calls, where the CLI reports it (Claude Code does). */
  apiEquivalentUsd?: number;
};

export type ReplayReport = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  sampled: number;
  setSize: number;
  served: number;
  failures: number;
  failedOver: number;
  byBackend: BackendSummary[];
  tasks: ReplayTask[];
};

/**
 * Picks `n` examples spread across task types: a seeded shuffle, then one
 * from each type in turn. Deterministic for a given seed.
 */
export function stratifiedSample(examples: RoutingExample[], n: number, seed = 1): RoutingExample[] {
  let state = seed >>> 0 || 1;
  const random = (): number => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const groups = new Map<string, RoutingExample[]>();
  for (const example of examples) {
    const group = groups.get(example.task_type) ?? [];
    group.push(example);
    groups.set(example.task_type, group);
  }
  for (const group of groups.values()) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [group[i], group[j]] = [group[j] as RoutingExample, group[i] as RoutingExample];
    }
  }
  const keys = [...groups.keys()].sort();
  const out: RoutingExample[] = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const key of keys) {
      const pick = groups.get(key)?.[round];
      if (pick !== undefined && out.length < n) {
        out.push(pick);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function readUsage(baseUrl: string, fetchImpl: FetchLike): Promise<UsageReport | undefined> {
  try {
    const response = await fetchImpl(new URL("/v1/usage", baseUrl).toString());
    if (!response.ok) return undefined;
    return (await response.json()) as UsageReport;
  } catch {
    return undefined;
  }
}

export async function runSubscriptionReplay(opts: ReplayOptions): Promise<ReplayReport> {
  if (!Number.isInteger(opts.sample) || opts.sample <= 0) throw new Error("sample must be a positive integer");
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const picked = stratifiedSample(opts.examples, opts.sample, opts.seed ?? 1);
  const startedAt = new Date(now()).toISOString();
  const before = await readUsage(opts.baseUrl, fetchImpl);

  const tasks: ReplayTask[] = [];
  for (const [index, example] of picked.entries()) {
    const started = now();
    let task: ReplayTask;
    try {
      const response = await fetchImpl(new URL("/v1/chat/completions", opts.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "milo/auto", messages: example.messages }),
      });
      const body = (await response.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { code?: string; message?: string };
      };
      const h = (name: string): string | undefined => response.headers.get(name) ?? undefined;
      task = {
        id: example.id,
        labelTaskType: example.task_type,
        labelDifficulty: example.difficulty_band,
        status: response.status,
        latencyMs: now() - started,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      };
      const fields: Array<[keyof ReplayTask, string | undefined]> = [
        ["backend", h("x-milo-backend")],
        ["model", h("x-milo-model")],
        ["classifiedAs", h("x-milo-task-type")],
        ["classifier", h("x-milo-classifier")],
        ["reason", h("x-milo-reason")],
        ["failover", h("x-milo-failover")],
        ["error", response.ok ? undefined : (body.error?.code ?? `http_${response.status}`)],
      ];
      for (const [key, value] of fields) if (value !== undefined) (task as Record<string, unknown>)[key] = value;
    } catch (error) {
      task = {
        id: example.id,
        labelTaskType: example.task_type,
        labelDifficulty: example.difficulty_band,
        status: 0,
        latencyMs: now() - started,
        promptTokens: 0,
        completionTokens: 0,
        error: error instanceof Error ? error.name : "network",
      };
    }
    tasks.push(task);
    opts.onTask?.(task, index, picked.length);
  }

  const after = await readUsage(opts.baseUrl, fetchImpl);
  const backends = [...new Set([...tasks.flatMap((t) => (t.backend ? [t.backend] : [])), ...(after?.subscriptions ?? []).map((s) => s.backend)])].sort();
  const byBackend = backends.map((backend): BackendSummary => {
    const mine = tasks.filter((t) => t.backend === backend && t.status === 200);
    const b = before?.subscriptions.find((s) => s.backend === backend);
    const a = after?.subscriptions.find((s) => s.backend === backend);
    const summary: BackendSummary = {
      backend,
      tasks: mine.length,
      promptTokens: mine.reduce((sum, t) => sum + t.promptTokens, 0),
      completionTokens: mine.reduce((sum, t) => sum + t.completionTokens, 0),
      latencyP50Ms: percentile(mine.map((t) => t.latencyMs), 50),
      latencyP95Ms: percentile(mine.map((t) => t.latencyMs), 95),
    };
    if (b?.capacity.usedPercent !== undefined) summary.usedPercentBefore = b.capacity.usedPercent;
    if (a?.capacity.usedPercent !== undefined) summary.usedPercentAfter = a.capacity.usedPercent;
    if (a?.capacity.window !== undefined) summary.window = a.capacity.window;
    const usd = (a?.last7d?.apiEquivalentUsd ?? 0) - (b?.last7d?.apiEquivalentUsd ?? 0);
    if (usd > 0) summary.apiEquivalentUsd = Math.round(usd * 10_000) / 10_000;
    return summary;
  });

  return {
    baseUrl: opts.baseUrl,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    sampled: picked.length,
    setSize: opts.examples.length,
    served: tasks.filter((t) => t.status === 200).length,
    failures: tasks.filter((t) => t.status !== 200).length,
    failedOver: tasks.filter((t) => t.failover !== undefined).length,
    byBackend,
    tasks,
  };
}

/** A short plain-text summary of a replay. */
export function formatReplayReport(report: ReplayReport): string {
  const lines = [
    `Replay of ${report.sampled} of ${report.setSize} Milo routing tasks through ${report.baseUrl}`,
    `served ${report.served}, failed ${report.failures}, failed over ${report.failedOver}`,
    "",
  ];
  for (const b of report.byBackend) {
    const quota =
      b.usedPercentBefore !== undefined || b.usedPercentAfter !== undefined
        ? `plan used ${b.usedPercentBefore ?? "?"}% -> ${b.usedPercentAfter ?? "?"}%${b.window ? ` (${b.window})` : ""}`
        : "plan usage not reported";
    const usd = b.apiEquivalentUsd !== undefined ? `, API-equivalent $${b.apiEquivalentUsd}` : "";
    lines.push(
      `${b.backend}: ${b.tasks} tasks, ${b.promptTokens} in / ${b.completionTokens} out tokens, ` +
        `p50 ${Math.round(b.latencyP50Ms / 100) / 10}s, p95 ${Math.round(b.latencyP95Ms / 100) / 10}s; ${quota}${usd}`,
    );
  }
  const failed = report.tasks.filter((t) => t.status !== 200);
  if (failed.length > 0) {
    lines.push("", "failures:");
    for (const t of failed) lines.push(`  ${t.id} (${t.labelTaskType}): ${t.error ?? t.status}`);
  }
  return `${lines.join("\n")}\n`;
}
