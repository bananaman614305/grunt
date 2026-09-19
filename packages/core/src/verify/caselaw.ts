/**
 * Case law (ADR-019): the "demanded oracle". When a confident claim comes back
 * `unsupported` -- there is simply no check that can back it -- the auditor does
 * not shrug and move on; it demands an oracle, a persisted obligation that the
 * claim be backed. The obligation is written to a git-tracked file and
 * re-checked mechanically thereafter, so the same claim is not re-litigated
 * from scratch every turn (the veritaserum idea of accumulating case law).
 *
 * This module is the pure part: it produces and updates `CaseLawEntry` records.
 * Persisting them (writing the git-tracked file) is the hook's job -- runtime
 * glue kept out of the test path, exactly as the fleet keeps its node runtime.
 *
 * Only `unsupported` claims demand an oracle. A `contradicted` claim is a real,
 * present finding to surface now, not a missing check; a `supported` claim is
 * already backed.
 */

import type { CaseLawEntry, ClaimResult } from "./types.js";

const RECHECK: Record<CaseLawEntry["category"], string> = {
  test: "Re-run the test suite and confirm a passing receipt covers this claim.",
  build: "Re-run the build/type-check and confirm a clean receipt covers this claim.",
  implementation: "Re-check the git diff for the change this claim asserts.",
  completion: "Re-check that the diff and receipts show the asserted work landed.",
  other: "Re-verify this claim against fresh git probes and receipts.",
};

/**
 * Demand an oracle for one unsupported claim: a fresh `open` case-law entry.
 * `now` is injected so the record is deterministic in tests.
 */
export function demandOracle(result: ClaimResult, now: Date = new Date()): CaseLawEntry {
  return {
    id: result.claim.id,
    claim: result.claim.text,
    category: result.claim.category,
    demandedAt: now.toISOString(),
    status: "open",
    recheck: RECHECK[result.claim.category],
  };
}

/**
 * The oracles a verification pass demands: one per `unsupported` claim. A
 * `contradicted` or `supported` claim demands nothing (present finding, or
 * already backed).
 */
export function demandedOracles(results: readonly ClaimResult[], now: Date = new Date()): CaseLawEntry[] {
  return results.filter((r) => r.verdict === "unsupported").map((r) => demandOracle(r, now));
}

/**
 * Merge freshly demanded oracles into the existing case law, and resolve any
 * open entry whose claim is now `supported`. Pure: returns a new array, does
 * not mutate its inputs. Matching is by claim id, so re-stating the same claim
 * updates the same entry rather than piling up duplicates.
 */
export function updateCaseLaw(
  existing: readonly CaseLawEntry[],
  results: readonly ClaimResult[],
  now: Date = new Date(),
): CaseLawEntry[] {
  const byId = new Map<string, CaseLawEntry>(existing.map((e) => [e.id, { ...e }]));

  // Resolve entries whose claim is now supported.
  const supportedIds = new Set(results.filter((r) => r.verdict === "supported").map((r) => r.claim.id));
  for (const [id, entry] of byId) {
    if (entry.status === "open" && supportedIds.has(id)) {
      byId.set(id, { ...entry, status: "resolved", resolvedAt: now.toISOString() });
    }
  }

  // Add new demands for unsupported claims not already tracked as open.
  for (const oracle of demandedOracles(results, now)) {
    const prior = byId.get(oracle.id);
    if (prior === undefined || prior.status === "resolved") byId.set(oracle.id, oracle);
  }

  return [...byId.values()];
}

/** The still-open obligations, for a hook to print or a re-check to run. */
export function openCaseLaw(entries: readonly CaseLawEntry[]): CaseLawEntry[] {
  return entries.filter((e) => e.status === "open");
}
