/**
 * Ground-truth verification (ADR-019): the shared types the /v1/verify
 * handler, the fleet done-gate, and the completeness gate all reason over.
 *
 * The idea (adapted from the "veritaserum" concept, an npm package by a third
 * party -- Milo reimplements it natively so Milo's server-side Jev is the
 * auditor and no user key is required): an agent's load-bearing claims
 * ("tests pass", "implemented X", "done") are checked against the only two
 * sources that cannot lie -- read-only git probes taken right now, and the
 * harness's own receipts of what actually ran. Each claim comes back
 * `supported`, `unsupported`, or `contradicted`. Honest uncertainty is never a
 * claim (the extractor drops hedged sentences), so it is never flagged.
 *
 * None of these types live in `packages/core/src/types.ts`; they are the
 * verify module's own, so this feature needs no change to that pinned
 * contract (ADR-019).
 */

/** The three verdicts a checked claim can return. */
export const CLAIM_VERDICTS = ["supported", "unsupported", "contradicted"] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

/**
 * The kind of load-bearing assertion a claim is. Used only to label the claim
 * and to pick a case-law re-check description; it never changes how Jev grades
 * the claim (the evidence does).
 */
export const CLAIM_CATEGORIES = ["test", "build", "implementation", "completion", "other"] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

/** One load-bearing claim extracted from an agent's turn. */
export type Claim = {
  /** A stable id derived from the normalized text (so case law can match it). */
  id: string;
  /** The claim as the agent stated it, trimmed. */
  text: string;
  category: ClaimCategory;
};

/** One file's change as a git probe reports it. */
export type GitFileChange = {
  path: string;
  /** Porcelain status letters, e.g. "M", "A", "??", "MM"; empty when unknown. */
  status: string;
  staged: boolean;
  insertions?: number;
  deletions?: number;
};

/**
 * The structured state parsed from read-only git probes (`git status`,
 * `git diff`, `git log`) taken at the moment of the check. Purely mechanical;
 * no model produced any of it.
 */
export type GitProbeState = {
  /** True when the working tree has no changes at all. */
  clean: boolean;
  files: GitFileChange[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
  /** Subjects of the most recent commits, newest first. */
  recentCommits: string[];
  /** The raw unified diff, clipped, when one was supplied. */
  diff?: string;
};

/**
 * A receipt: a record of something the harness actually ran -- a test command,
 * a build, a linter. `ok` is the ground truth; `summary` is a short line for
 * the auditor to read. No secrets, no full logs.
 */
export type Receipt = {
  /** What ran, e.g. "pnpm test" or "cargo build". */
  command: string;
  /** Process exit code when known. */
  exitCode?: number;
  /** Whether it succeeded; derived from `exitCode === 0` when absent. */
  ok?: boolean;
  /** A one-line result summary, e.g. "42 passed, 0 failed". */
  summary?: string;
};

/** Everything the auditor is allowed to weigh: git probes plus receipts. */
export type VerifyGroundTruth = {
  git?: GitProbeState;
  receipts?: Receipt[];
  /** A free-form note the caller wants the auditor to consider (optional). */
  note?: string;
};

/** One claim's verdict. */
export type ClaimResult = {
  claim: Claim;
  verdict: ClaimVerdict;
  /** Jev's confidence in the verdict, 0..1. */
  confidence: number;
};

/** The aggregate of a whole verification pass. */
export type VerifySummary = {
  checked: number;
  supported: number;
  unsupported: number;
  contradicted: number;
  /**
   * The overall finding: `clean` when nothing adverse, `unsupported` when a
   * claim lacks backing, `contradicted` when the evidence refutes a claim.
   */
  finding: "clean" | "unsupported" | "contradicted";
  /**
   * True only on a CONFIDENT adverse finding (a `contradicted` claim at or
   * above the confidence bar). The one signal an opt-in block is allowed to
   * act on; a warning fires on anything adverse.
   */
  blocking: boolean;
  /** One human-readable line summarizing the pass. */
  line: string;
};

/** The whole result of a verification pass over one turn. */
export type VerifyResult = {
  results: ClaimResult[];
  summary: VerifySummary;
  /** The Jev round-trip latency, ms. */
  latencyMs: number;
};

/**
 * A "demanded oracle": a claim that could not be backed because no check for
 * it exists yet. Persisted as git-tracked case law and re-checked
 * mechanically thereafter (the veritaserum idea of writing case law rather
 * than re-litigating the same claim every turn).
 */
export type CaseLawEntry = {
  id: string;
  claim: string;
  category: ClaimCategory;
  /** ISO timestamp the oracle was first demanded. */
  demandedAt: string;
  status: "open" | "resolved";
  /** ISO timestamp the claim was later supported, when it was. */
  resolvedAt?: string;
  /** A one-line description of how the claim is to be re-checked. */
  recheck: string;
};
