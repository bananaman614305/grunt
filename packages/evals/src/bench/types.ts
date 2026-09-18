/**
 * Types for `pnpm bench`: the live benchmark that sends the labeled routing
 * set through Milo and through fixed models, and grades every answer for
 * speed, outcome accuracy, and cost against an estimated Fable baseline.
 * See `docs/evals.md` ("Benchmark") for what each number means.
 */

import type { CostPosture, TaskType, Tier } from "@milo/core";
import type { DifficultyBand } from "../report.js";

/** The fixed-model arms: one per roster tier, called directly on OpenRouter. */
export const FIXED_ARMS = ["fast", "mid", "frontier"] as const satisfies readonly Tier[];
export type FixedArm = (typeof FIXED_ARMS)[number];

/** The routed arm: `milo/auto` through a gateway, at one cost posture per run. */
export const MILO_ARM = "milo" as const;
export type ArmName = FixedArm | typeof MILO_ARM;
export const ARM_NAMES = [MILO_ARM, ...FIXED_ARMS] as const satisfies readonly ArmName[];

/** Per-million-token USD prices, as OpenRouter quotes them. */
export type ModelPrice = { id: string; inputUsdPerM: number; outputUsdPerM: number };

/** What one streamed chat completion measured. */
export type CallMeasurement = {
  status: number;
  /** ms from request start to the first SSE frame carrying content or reasoning. */
  ttfbMs: number;
  /** ms from request start to the end of the stream. */
  totalMs: number;
  /** The assembled assistant text. */
  text: string;
  /** The model the response named, when it did. */
  model?: string;
  /** OpenRouter's upstream provider for this response, when named. Token counts vary by provider. */
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** OpenRouter's `usage.cost`, USD. */
  costUsd?: number;
  /** The `x-milo-*` headers on a routed call; empty on a direct one. */
  milo: Partial<Record<"decisionId" | "model" | "tier" | "taskType" | "difficulty" | "sticky", string>>;
};

/** One arm's result for one example. */
export type ArmResult = {
  arm: ArmName;
  /** The OpenRouter model id the answer came from. */
  model: string;
  /** Milo's tier for the routed arm; the arm's own tier for a fixed one. */
  tier: Tier;
  /** OpenRouter's upstream provider, when the response named one. */
  provider?: string;
  status: number;
  ttfbMs: number;
  totalMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** Routed arm only: served from the sticky cache, so the decision was inherited. */
  sticky?: boolean;
  /** Routed arm only: Jev's own latency from the decision record. */
  jevLatencyMs?: number;
  /** Routed arm only: the gateway's measured upstream latency from the decision record. */
  upstreamLatencyMs?: number;
  /** Routed arm only. */
  decisionId?: string;
  /** Set when the call failed; the answer is then not graded. */
  error?: string;
  /** The outcome grade, when a grader exists and the call succeeded. */
  grade?: Grade;
};

export type Grade = {
  /** 0..1. Mechanical graders are 0 or 1; the judge may be fractional. */
  score: number;
  pass: boolean;
  by: "mechanical" | "judge";
  reason?: string;
  /** Judge cost, USD, so it can be reported apart from the arms. */
  judgeCostUsd?: number;
};

/** One example with every arm's result. */
export type BenchRow = {
  id: string;
  taskType: TaskType;
  difficultyBand: DifficultyBand;
  expectedTier: Tier;
  hasGrader: boolean;
  results: ArmResult[];
};

export type BenchReport = {
  generatedAt: string;
  gateway: string;
  posture: CostPosture;
  /** The model each fixed arm called. */
  fixedModels: Record<FixedArm, string>;
  /** Prices in effect during the run, including the baseline. */
  prices: Record<string, ModelPrice>;
  baseline: ModelPrice;
  judgeModel: string;
  /** OpenRouter provider slugs every call was pinned to, in order; empty means OpenRouter's own choice. */
  providers: string[];
  rows: BenchRow[];
};
