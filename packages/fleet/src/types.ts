/**
 * The Milo worker fleet vocabulary (ADR-015). Strict terms, used everywhere:
 *
 *   - task       one unit of work a worker is assigned
 *   - worker     a coding agent (pi) running that task in isolation
 *   - worktree   the isolated git checkout a worker owns
 *   - fleet      the set of workers the frontier agent fanned out
 *   - supervisor the Jev-backed classifier watching each worker's traffic
 *
 * No other metaphor or borrowed vernacular appears anywhere in this package.
 */

import type { Receipt } from "@milo/core";
import type { DoneVerification } from "./done-gate.js";
import type { PiRunStats } from "./pi-events.js";

/** One unit of work handed to a worker. */
export type Task = {
  /** Stable id, unique within a fleet; used for the worker's branch name. */
  id: string;
  /** The prompt written into the worktree and handed to pi. */
  prompt: string;
  /** Optional human label for status surfaces. */
  title?: string;
  /**
   * Explicit outcomes the worker must satisfy. The fleet compiles these with
   * checklist items in the prompt into the task's durable verification rubric.
   */
  acceptanceCriteria?: string[];
};

/** Process-level state of a worker, independent of what the supervisor thinks. */
export type WorkerLifecycle = "pending" | "running" | "finished" | "failed";

/**
 * The supervisor's content-level verdict on a running worker. This is the
 * signal a process-liveness supervisor cannot produce: `wedged` and `idle`
 * both look alive to the OS.
 */
export const WORKER_VERDICTS = ["progressing", "idle", "wedged", "done"] as const;
export type WorkerVerdict = (typeof WORKER_VERDICTS)[number];

/** What one supervision pass concluded about a worker. */
export type WorkerClassification = {
  verdict: WorkerVerdict;
  /** Jev's confidence in the verdict, 0..1. */
  confidence: number;
  /** The `needs_human` gate: has this worker reached something only a person can unblock. */
  needsHuman: boolean;
  /** Round-trip latency of the supervision call, ms. */
  latencyMs: number;
};

/** What a worker produced once pi exited. */
export type WorkerResult = {
  /** How pi exited: an OS exit code, or null when it never started. */
  exitCode: number | null;
  /** True when pi was killed for exceeding its timeout. */
  timedOut: boolean;
  /** The unified diff of the worktree against its base branch. */
  diff: string;
  /** Aggregated pi turns / tool calls / usage (from the reused PiEventParser). */
  stats: PiRunStats;
  /**
   * Receipts of commands the worker's harness actually ran (tests, build),
   * for the done-gate (ADR-019). The v0 node runtime leaves this empty -- it
   * runs no test command of its own -- so the gate checks the diff alone; a
   * runtime that captures receipts populates it and the gate weighs them too.
   */
  receipts?: Receipt[];
  /** A one-line note when something went wrong (spawn failure, timeout). */
  note?: string;
};

/** A worker's full public state as the fleet reports it. */
export type WorkerState = {
  id: string;
  task: Task;
  lifecycle: WorkerLifecycle;
  worktreePath: string;
  branch: string;
  /** The last supervision verdict, absent until the first pass runs. */
  classification?: WorkerClassification;
  /** Present once the worker is finished or failed. */
  result?: WorkerResult;
  /**
   * The done-gate's verdict (ADR-019), present once a finished worker has been
   * checked against its git diff and receipts. Absent while the worker runs,
   * and when the gate itself could not run (Jev unavailable) -- fail-open.
   */
  doneVerification?: DoneVerification;
};

/** An entry in the fleet's attention list: why a worker needs a look. */
export type AttentionItem = {
  id: string;
  task: Task;
  reason: "wedged" | "idle" | "needs_human" | "failed" | "done_unverified";
  detail: string;
  /** The verdict confidence, when the reason came from a supervision pass. */
  confidence?: number;
};
