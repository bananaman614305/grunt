/**
 * The canary run: replays a small, deterministic subset of
 * `packages/evals/data/routing.jsonl` through a fresh `Router` per example,
 * the same way `../run.ts` does for the full eval, but keeping the chosen
 * `model` id (not just the tier) so a snapshot can report tier *and* model
 * distribution, and a cost proxy.
 *
 * Deliberately not built on top of `runRoutingEval`: reusing it would mean
 * either widening `ScoredExample` (touched by the ADR-002 gate's own tests)
 * or making a second Jev call per example just to recover the model id.
 * Instead this mirrors `scoreExample`'s shape closely enough that the two
 * stay easy to compare, and shares its concurrency helper.
 */
import type { ChatMessage, CostPosture, JevClientLike, Roster, RouteRequest, TaskType, Tier } from "@milo/core";
import { classifyFailure, fingerprint, POLICY_VERSION, Router } from "@milo/core";
import type { DifficultyBand } from "../report.js";
import { mapWithConcurrency } from "../run.js";
import type { RoutingExample } from "../schema.js";
import { loadRoutingSet } from "../schema.js";
import { DEFAULT_CANARY_SIZE, selectCanarySubset } from "./subset.js";

/** A placeholder tool list, standing in for "this request looked agentic" (mirrors `../run.ts`). */
const DUMMY_TOOLS: unknown[] = [
  { type: "function", function: { name: "dummy_tool", description: "canary placeholder tool", parameters: {} } },
];

/** One example the router produced a clean (non-degraded) decision for. */
export type CanaryScoredExample = {
  kind: "scored";
  id: string;
  taskType: TaskType;
  difficultyBand: DifficultyBand;
  expectedTier: Tier;
  /** The tier policy v4 would pick, ignoring best-of-N execution sampling (mirrors `../run.ts`). */
  predictedTier: Tier;
  /** The model the router actually chose. */
  model: string;
  /** Jev call latency in ms. */
  latencyMs: number;
  /** `predictedTier === expectedTier`. */
  agree: boolean;
};

/** One example the router could not score: a Jev failure or a missing fixture. */
export type CanaryUnscoredExample = {
  kind: "unscored";
  id: string;
  taskType: TaskType;
  difficultyBand: DifficultyBand;
  expectedTier: Tier;
  /** The router's degrade cause, or a classified thrown error. Never upstream error text. */
  errorClass: string;
};

export type CanaryExampleResult = CanaryScoredExample | CanaryUnscoredExample;

export type CanaryRun = {
  posture: CostPosture;
  policyVersion: string;
  generatedAt: string;
  /** How many examples were asked for (`opts.size`, or `opts.examples.length`). */
  requestedSize: number;
  results: CanaryExampleResult[];
};

export type RunCanaryOptions = {
  /** Defaults to `selectCanarySubset(loadRoutingSet(), size ?? DEFAULT_CANARY_SIZE)`. */
  examples?: RoutingExample[];
  /** Subset size, used only when `examples` is not given. Defaults to `DEFAULT_CANARY_SIZE`. */
  size?: number;
  jev: JevClientLike;
  /** Defaults to "balanced", matching the dataset's `expected_tier_balanced` label. */
  posture?: CostPosture;
  roster?: Roster;
  /** Max in-flight Jev calls. Defaults to 4. */
  concurrency?: number;
  /** Router budget per example. Defaults to the router's own production value (800 ms). */
  jevTimeoutMs?: number;
};

async function scoreOne(
  example: RoutingExample,
  jev: JevClientLike,
  posture: CostPosture,
  roster: Roster | undefined,
  jevTimeoutMs: number | undefined,
): Promise<CanaryExampleResult> {
  const base = {
    id: example.id,
    taskType: example.task_type,
    difficultyBand: example.difficulty_band,
    expectedTier: example.expected_tier_balanced,
  } as const;

  try {
    const messages = example.messages as ChatMessage[];
    const req: RouteRequest = {
      messages,
      posture,
      fingerprint: fingerprint(messages),
      ...(example.has_tools ? { tools: DUMMY_TOOLS } : {}),
    };

    // A fresh Router (and fresh sticky cache) per example, same as the eval
    // runner: no state carries between examples even when several run
    // concurrently.
    const router = new Router({
      jev,
      ...(roster !== undefined ? { roster } : {}),
      ...(jevTimeoutMs !== undefined ? { jevTimeoutMs } : {}),
    });
    const decision = await router.route(req);

    if (decision.signals === undefined) {
      return { kind: "unscored", ...base, errorClass: "validation" };
    }

    const chosenTier = decision.unsampledTier ?? decision.tier;
    return {
      kind: "scored",
      ...base,
      predictedTier: chosenTier,
      model: decision.model,
      latencyMs: decision.signals.latencyMs,
      agree: chosenTier === example.expected_tier_balanced,
    };
  } catch (error) {
    return { kind: "unscored", ...base, errorClass: classifyFailure(error).cause };
  }
}

/** Runs the canary subset through the router and returns the raw per-example results. */
export async function runCanary(opts: RunCanaryOptions): Promise<CanaryRun> {
  const examples = opts.examples ?? selectCanarySubset(loadRoutingSet(), opts.size ?? DEFAULT_CANARY_SIZE);
  const posture: CostPosture = opts.posture ?? "balanced";
  const concurrency = opts.concurrency ?? 4;

  const results = await mapWithConcurrency(examples, concurrency, (example) =>
    scoreOne(example, opts.jev, posture, opts.roster, opts.jevTimeoutMs),
  );

  return {
    posture,
    policyVersion: POLICY_VERSION,
    generatedAt: new Date().toISOString(),
    requestedSize: examples.length,
    results,
  };
}
