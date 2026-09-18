#!/usr/bin/env node
/**
 * Ranks each benchmark model's OpenRouter providers by estimated wall time for
 * a representative answer, and prints a per-model pin map for
 * `packages/evals/src/bench/providers.ts`.
 *
 * Time is estimated as time-to-first-token plus tokens / throughput, both from
 * OpenRouter's own `/models/:id/endpoints` (authenticated), filtered to
 * providers with a live status and at least 95% 30-minute uptime. Providers
 * differ several-fold in throughput, which dominates a multi-hundred-token
 * answer, so pinning to fast ones is what makes runs comparable and best-of-N
 * fast. Needs `OPENROUTER_API_KEY`.
 *
 *   pnpm --filter @milo/evals exec tsx scripts/rank-providers.ts [--out <file>] [--tokens 600]
 */

import { writeFileSync } from "node:fs";
import { DEFAULT_ROSTER } from "@milo/core";
import { BASELINE_MODEL_ID } from "../src/bench/prices.js";

const JUDGE_MODEL = "anthropic/claude-sonnet-5";
const OUT_TOKENS = numberFlag("--tokens", 600);

type Endpoint = {
  provider_name: string;
  tag: string;
  status: number;
  quantization?: string | null;
  pricing?: { completion?: string | null } | null;
  uptime_last_30m?: number | null;
  latency_last_30m?: { p50: number } | null;
  throughput_last_30m?: { p50: number } | null;
};

function numberFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function rank(model: string, key: string): Promise<string[]> {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  const endpoints = ((await res.json()) as { data: { endpoints: Endpoint[] } }).data.endpoints;
  const scored = endpoints
    .filter((e) => e.status === 0 && e.latency_last_30m && e.throughput_last_30m && (e.uptime_last_30m ?? 0) >= 95)
    .map((e) => ({
      slug: e.tag.split("/")[0] as string,
      est: (e.latency_last_30m as { p50: number }).p50 / 1000 + OUT_TOKENS / Math.max((e.throughput_last_30m as { p50: number }).p50, 1),
    }))
    .sort((a, b) => a.est - b.est);
  const order: string[] = [];
  for (const { slug } of scored) if (!order.includes(slug)) order.push(slug);
  return order.slice(0, 3);
}

async function main(): Promise<void> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (key === undefined || key === "") throw new Error("OPENROUTER_API_KEY is not set");
  const models = [...new Set([...DEFAULT_ROSTER.fast, ...DEFAULT_ROSTER.mid, ...DEFAULT_ROSTER.frontier, JUDGE_MODEL, BASELINE_MODEL_ID])];
  const pins: Record<string, string[]> = {};
  for (const model of models) {
    try {
      pins[model] = await rank(model, key);
      process.stderr.write(`${model} -> ${pins[model].join(", ")}\n`);
    } catch (error) {
      process.stderr.write(`${model}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const json = `${JSON.stringify(pins, null, 2)}\n`;
  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) writeFileSync(process.argv[outIndex + 1] as string, json);
  else process.stdout.write(json);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
