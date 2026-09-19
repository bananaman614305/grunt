/**
 * The ground-truth verification pass (ADR-019): given extracted claims and the
 * ground truth, ask Milo's server-side Jev for a verdict on each and aggregate
 * them into one finding. This is the shared classifier all three layers run --
 * the /v1/verify handler, the fleet done-gate, and the completeness gate.
 *
 * Like `checkCompleteness`, `rankAnswer`, and `classifyWorker`, `verifyClaims`
 * THROWS on a Jev failure or a malformed answer; every consumer wraps it
 * fail-open (a hiccup returns an empty, non-blocking result and never fails
 * the request or the agent turn). The pure pieces -- `buildGroundState`,
 * `aggregate`, `isCrossFamily` -- are unit-tested directly.
 */

import type { JevClientLike } from "../jev/types.js";
import { claimQuestion } from "./questions.js";
import { normalizeReceipts } from "./probes.js";
import type {
  Claim,
  ClaimResult,
  ClaimVerdict,
  VerifyGroundTruth,
  VerifyResult,
  VerifySummary,
} from "./types.js";
import { CLAIM_VERDICTS } from "./types.js";

/** Total budget for one verification call, ms. Same habit as the gate. */
export const VERIFY_BUDGET_MS = 8_000;

/** At or above this confidence a `contradicted` verdict is a CONFIDENT finding. */
export const VERIFY_CONFIDENT = 0.6;

/** Most claims one call carries; more than this and the payload/latency grows. */
export const MAX_CLAIMS_PER_CALL = 12;

/**
 * The family a model id belongs to: the vendor prefix before the first `/`,
 * lower-cased (e.g. "anthropic/claude-opus-4.8" -> "anthropic"). Used only to
 * assert the auditor is cross-family to the executor.
 */
export function modelFamily(modelId: string): string {
  const slash = modelId.indexOf("/");
  const head = (slash === -1 ? modelId : modelId.slice(0, slash)).toLowerCase();
  return head.trim();
}

/** The auditor's family. Jev is TypeSafe's classifier, never a code executor. */
export const AUDITOR_FAMILY = "typesafe";

/**
 * Whether the auditor is cross-family to the executor that wrote the code.
 * With Jev as the auditor this is always true, but an executor id lets a caller
 * record the assertion honestly (and would catch a future same-family auditor).
 */
export function isCrossFamily(executorModelOrFamily: string | undefined, auditorFamily = AUDITOR_FAMILY): boolean {
  if (executorModelOrFamily === undefined || executorModelOrFamily.trim() === "") return true;
  const executor = executorModelOrFamily.includes("/")
    ? modelFamily(executorModelOrFamily)
    : executorModelOrFamily.toLowerCase().trim();
  return executor !== auditorFamily.toLowerCase().trim();
}

/**
 * Build the ground-truth `state` for the Jev call: a compact object of the
 * parsed git probes and normalized receipts. No message content, no secrets --
 * just the mechanical evidence. The diff is already clipped by the parser.
 */
export function buildGroundState(ground: VerifyGroundTruth): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (ground.git !== undefined) {
    const g = ground.git;
    state["git"] = {
      clean: g.clean,
      filesChanged: g.filesChanged,
      insertions: g.insertions,
      deletions: g.deletions,
      untracked: g.untracked,
      files: g.files.map((f) => ({ path: f.path, status: f.status, staged: f.staged })),
      recentCommits: g.recentCommits,
      ...(g.diff !== undefined ? { diff: g.diff } : {}),
    };
  }
  if (ground.receipts !== undefined && ground.receipts.length > 0) {
    state["receipts"] = normalizeReceipts(ground.receipts);
  }
  if (ground.note !== undefined && ground.note.trim() !== "") state["note"] = ground.note;
  return state;
}

function isVerdict(value: string): value is ClaimVerdict {
  return (CLAIM_VERDICTS as readonly string[]).includes(value);
}

/**
 * Aggregate per-claim results into one finding and summary line. Pure. The
 * `blocking` flag fires only on a `contradicted` claim at or above the
 * confidence bar -- the single confident, positive finding an opt-in block may
 * act on; a warning fires on any adverse verdict.
 */
export function aggregate(results: ClaimResult[]): VerifySummary {
  let supported = 0;
  let unsupported = 0;
  let contradicted = 0;
  let blocking = false;
  for (const r of results) {
    if (r.verdict === "supported") supported += 1;
    else if (r.verdict === "unsupported") unsupported += 1;
    else {
      contradicted += 1;
      if (r.confidence >= VERIFY_CONFIDENT) blocking = true;
    }
  }
  const finding = contradicted > 0 ? "contradicted" : unsupported > 0 ? "unsupported" : "clean";
  const checked = results.length;
  const line =
    checked === 0
      ? "No load-bearing claims to verify."
      : `${checked} claim${checked === 1 ? "" : "s"} checked: ${supported} supported, ${unsupported} unsupported, ${contradicted} contradicted.`;
  return { checked, supported, unsupported, contradicted, finding, blocking, line };
}

/** An empty, explicitly non-blocking result: the fail-open answer. */
export function emptyResult(line = "Verification unavailable; nothing blocked."): VerifyResult {
  return {
    results: [],
    summary: { checked: 0, supported: 0, unsupported: 0, contradicted: 0, finding: "clean", blocking: false, line },
    latencyMs: 0,
  };
}

/**
 * Verify each claim against the ground truth with one Jev call (several claims
 * ride one call as separate choice questions over the shared state). Throws on
 * a Jev failure or a malformed answer; the caller decides what that means. A
 * claim whose answer is missing or the wrong shape is skipped rather than
 * failing the whole pass.
 */
export async function verifyClaims(
  jev: JevClientLike,
  claims: readonly Claim[],
  ground: VerifyGroundTruth,
  budgetMs = VERIFY_BUDGET_MS,
): Promise<VerifyResult> {
  const selected = claims.slice(0, MAX_CLAIMS_PER_CALL);
  if (selected.length === 0) return { ...emptyResult("No load-bearing claims to verify."), latencyMs: 0 };

  const questions: Record<string, ReturnType<typeof claimQuestion>> = {};
  for (const claim of selected) questions[claim.id] = claimQuestion(claim);

  const result = await jev.systemone({ state: buildGroundState(ground), questions }, { budgetMs });

  const results: ClaimResult[] = [];
  for (const claim of selected) {
    const answer = result.answers[claim.id];
    if (answer?.type !== "choice" || !isVerdict(answer.choice)) continue;
    results.push({ claim, verdict: answer.choice, confidence: answer.confidence });
  }
  return { results, summary: aggregate(results), latencyMs: result.latencyMs };
}
