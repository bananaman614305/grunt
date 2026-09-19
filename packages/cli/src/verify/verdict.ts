/**
 * The Stop-hook's warn-vs-block decision (ADR-019), as a pure function so it is
 * unit-tested without a harness. The generated hook script inlines the same
 * rule; this is the specification of it.
 *
 * The posture is WARN-PRIMARY: an adverse finding is surfaced as a warning at
 * the next prompt and never blocks. Blocking is opt-in (an env flag) and, even
 * then, fires ONLY on a confident positive finding -- a `contradicted` claim
 * the auditor is sure of (`blocking`) -- and AT MOST twice per session. A
 * self-check that can stall the agent on an uncertain finding is worse than a
 * warning, so honest uncertainty and `unsupported` findings never block.
 */

/** The shape of the /v1/verify response the hook reads back. */
export type VerifyFinding = {
  finding: "clean" | "unsupported" | "contradicted" | string;
  blocking: boolean;
  line: string;
  unavailable?: boolean;
};

export type DecideOptions = {
  /** Whether the block env flag is set (`MILO_VERIFY_BLOCK`). */
  blockEnabled: boolean;
  /** How many times this session has already blocked. */
  sessionBlocks: number;
  /** The per-session block cap. Default 2. */
  maxBlocks?: number;
};

export type HookAction = {
  /** `block` stops the turn (only ever a confident positive finding); `warn`
   *  surfaces a message; `none` says nothing. */
  level: "block" | "warn" | "none";
  /** True only for `level: "block"`. */
  block: boolean;
  /** The message to show at the next prompt (empty for `none`). */
  message: string;
  /** Whether this action consumed one of the session's block slots. */
  consumedBlock: boolean;
};

export const MAX_SESSION_BLOCKS = 2;

/** Decide what the hook does with a finding. Pure. */
export function decideAction(finding: VerifyFinding, opts: DecideOptions): HookAction {
  const maxBlocks = opts.maxBlocks ?? MAX_SESSION_BLOCKS;

  // The verifier could not run, or nothing adverse: say nothing, never block.
  if (finding.unavailable === true || finding.finding === "clean") {
    return { level: "none", block: false, message: "", consumedBlock: false };
  }

  const warning = `Milo ground-truth check: ${finding.line}`;

  // Block only on a confident positive finding, only when opted in, only within
  // the per-session cap.
  const canBlock = opts.blockEnabled && finding.blocking && opts.sessionBlocks < maxBlocks;
  if (canBlock) {
    return {
      level: "block",
      block: true,
      message: `${warning}\nBlocking this turn (Milo verify block is on). Address the contradicted claim, or continue past this notice.`,
      consumedBlock: true,
    };
  }

  return { level: "warn", block: false, message: warning, consumedBlock: false };
}
