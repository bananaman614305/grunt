/**
 * The routing eval runner: replays `packages/evals/data/routing.jsonl`
 * through a fresh `Router` per example and reports tier agreement against
 * the dataset's `expected_tier_balanced` label.
 *
 * Every example gets its own `Router` (and therefore its own sticky cache)
 * and its own fingerprint, so examples never influence one another even
 * though they run concurrently. A Jev failure never aborts the run: the
 * router already degrades a failed Jev call to the `mid` tier (ADR-002),
 * and this runner treats any degraded or otherwise-failed example as
 * `unscored` rather than as a routing outcome worth measuring.
 */

import type { ChatMessage, CostPosture, JevClientLike, Roster, RouteRequest } from "@milo/core";
import { classifyFailure, fingerprint, POLICY_VERSION, Router } from "@milo/core";
import type { EvalReport, ScoredExample, UnscoredExample } from "./report.js";
import type { RoutingExample } from "./schema.js";
import { loadRoutingSet } from "./schema.js";

export type RunRoutingEvalOptions = {
  /** Defaults to the committed `packages/evals/data/routing.jsonl`. */
  examples?: RoutingExample[];
  jev: JevClientLike;
  /** Defaults to "balanced", matching the dataset's `expected_tier_balanced` label. */
  posture?: CostPosture;
  roster?: Roster;
  /** Max in-flight Jev calls. Defaults to 4. */
  concurrency?: number;
  /** Router budget per example. Defaults to the router's own production value (800 ms). */
  jevTimeoutMs?: number;
};

/** A placeholder tool list, standing in for "this request looked agentic." */
const DUMMY_TOOLS: unknown[] = [
  { type: "function", function: { name: "dummy_tool", description: "eval placeholder tool", parameters: {} } },
];


async function scoreExample(
  example: RoutingExample,
  jev: JevClientLike,
  posture: CostPosture,
  roster: Roster | undefined,
  jevTimeoutMs: number | undefined,
): Promise<ScoredExample | UnscoredExample> {
  const base = {
    id: example.id,
    taskType: example.task_type,
    difficultyBand: example.difficulty_band,
    expectedTier: example.expected_tier_balanced,
    notes: example.notes,
  } as const;

  try {
    const messages = example.messages as ChatMessage[];
    const req: RouteRequest = {
      messages,
      posture,
      fingerprint: fingerprint(messages),
      ...(example.has_tools ? { tools: DUMMY_TOOLS } : {}),
    };

    // A fresh Router (and fresh sticky cache) per example: no state carries
    // between examples even when several run concurrently.
    const router = new Router({
      jev,
      ...(roster !== undefined ? { roster } : {}),
      ...(jevTimeoutMs !== undefined ? { jevTimeoutMs } : {}),
    });
    const decision = await router.route(req);

    if (decision.signals === undefined) {
      return { kind: "unscored", ...base, errorClass: "validation" };
    }

    const { signals } = decision;
    // A sampled decision (ADR-010) executes on `fast`, but the choice the
    // dataset labels -- and the gate measures -- is the tier the policy would
    // have picked without sampling. Score agreement on that.
    const chosenTier = decision.unsampledTier ?? decision.tier;
    return {
      kind: "scored",
      ...base,
      predictedTaskType: signals.taskType,
      predictedDifficulty: signals.difficulty,
      difficultyLevels: signals.difficultyLevels,
      needsReasoning: signals.needsReasoning,
      predictedTier: chosenTier,
      reason: decision.reason,
      latencyMs: signals.latencyMs,
      agree: chosenTier === example.expected_tier_balanced,
    };
  } catch (error) {
    // Anything unexpected (a bad custom roster, a router bug) still must not
    // abort the run; classify it the same way the router classifies a Jev
    // failure, never surfacing the raw error text.
    return { kind: "unscored", ...base, errorClass: classifyFailure(error).cause };
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * order. Exported for `./canary/run.ts`, which runs the same bounded-fan-out
 * shape over a smaller subset.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runRoutingEval(opts: RunRoutingEvalOptions): Promise<EvalReport> {
  const examples = opts.examples ?? loadRoutingSet();
  const posture: CostPosture = opts.posture ?? "balanced";
  const concurrency = opts.concurrency ?? 4;

  const results = await mapWithConcurrency(examples, concurrency, (example) =>
    scoreExample(example, opts.jev, posture, opts.roster, opts.jevTimeoutMs),
  );

  const scored: ScoredExample[] = [];
  const unscored: UnscoredExample[] = [];
  for (const result of results) {
    if (result.kind === "scored") {
      scored.push(result);
    } else {
      unscored.push(result);
    }
  }

  return {
    posture,
    policyVersion: POLICY_VERSION,
    generatedAt: new Date().toISOString(),
    scored,
    unscored,
  };
}
