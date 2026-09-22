/**
 * The done-gate (ADR-019): a worker's "done" is only believed once it is
 * checked against ground truth.
 *
 * A worker's process lifecycle says `finished` when pi exits cleanly, and the
 * event-based supervisor can call it `done` from the shape of its traffic --
 * but both are self-reported: a worker can exit 0 having produced an empty diff
 * or having "passed" tests that never ran. The done-gate closes that gap the
 * way veritaserum does: it asks Milo's cross-family Jev whether the worker
 * actually completed the task, judged ONLY against the worker's real git diff
 * and any receipts, not against what the worker's own events implied.
 *
 * This is a deliberate, one-per-finish check that reads the worker's produced
 * artifact (its diff) as evidence -- distinct from routine supervision, which
 * ADR-015 keeps content-free. ADR-019 licenses the distinction: the diff is the
 * worker's output to be verified, not model message content fed into a
 * classification of liveness.
 *
 * Fail-open: `verifyWorkerDone` throws on a Jev failure and the fleet catches
 * it, leaving the worker's process result exactly as it was; a hiccup never
 * turns a finished worker into a failed one.
 */

import type { ClaimResult, ClaimVerdict, JevClientLike, Receipt } from "@milo/core";
import { gitStateFromDiff, verifyClaims } from "@milo/core";
import { compileTaskRubric } from "./task-records.js";
import type { Task } from "./types.js";

/** Total budget for one done-gate call, ms. Same habit as supervision. */
export const DONE_GATE_BUDGET_MS = 8_000;

/** What the done-gate concluded about a finished worker. */
export type DoneVerification = {
  /** supported = the diff/receipts back completion; contradicted = they refute it. */
  verdict: ClaimVerdict;
  confidence: number;
  /** True only when ground truth actively refutes completion (empty diff, failing receipts). */
  contradicted: boolean;
  /** One human-readable line. */
  line: string;
  latencyMs: number;
  /** Per-criterion findings from the same Jev call. */
  criteria: ClaimResult[];
};

/**
 * Verify one finished worker's completion against its git diff and receipts.
 * Compiles the task's rubric into completion claims and hands all of them,
 * with the diff as ground truth, to the shared verifier in ONE Jev call.
 * Throws on a Jev failure (the fleet catches it); a malformed or missing
 * answer maps to a non-adverse `unsupported`, never a false contradiction.
 */
export async function verifyWorkerDone(
  jev: JevClientLike,
  input: { task: Task; diff: string; receipts?: readonly Receipt[] },
  budgetMs = DONE_GATE_BUDGET_MS,
): Promise<DoneVerification> {
  const rubric = compileTaskRubric(input.task);
  const claims = rubric.criteria.map((criterion) => ({
    id: `done:${input.task.id}:${criterion.id}`,
    text: `The worker satisfied this requirement: ${criterion.text}`,
    category: "completion" as const,
  }));
  const ground = {
    git: gitStateFromDiff(input.diff),
    ...(input.receipts !== undefined && input.receipts.length > 0 ? { receipts: [...input.receipts] } : {}),
  };
  const out = await verifyClaims(jev, claims, ground, budgetMs);
  const result = out.results.find((candidate) => candidate.verdict === "contradicted")
    ?? out.results.find((candidate) => candidate.verdict === "unsupported")
    ?? out.results[0];
  if (result === undefined || out.results.length !== claims.length) {
    return {
      verdict: "unsupported",
      confidence: result?.confidence ?? 0,
      contradicted: false,
      line: "Done unverified: one or more rubric criteria lacked a verdict.",
      latencyMs: out.latencyMs,
      criteria: out.results,
    };
  }
  const line =
    result.verdict === "supported"
      ? "Done confirmed against the diff and receipts."
      : result.verdict === "contradicted"
        ? "Done refuted: the diff and receipts do not show the task completed."
        : "Done unverified: no evidence in the diff or receipts either way.";
  return {
    verdict: result.verdict,
    confidence: result.confidence,
    contradicted: result.verdict === "contradicted",
    line,
    latencyMs: out.latencyMs,
    criteria: out.results,
  };
}
