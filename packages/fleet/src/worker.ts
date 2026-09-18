/**
 * The worker runtime (ADR-015): run one task as a coding agent in an isolated
 * git worktree, routed through Milo, and capture what it did.
 *
 * A worker's lifecycle:
 *   1. create a git worktree off the fleet's base branch on a fresh branch;
 *   2. write the task prompt into the worktree;
 *   3. run `pi -p --mode json` with cwd = the worktree and PI_CODING_AGENT_DIR
 *      passed through, so pi's provider config points model calls at Milo
 *      (DeepSeek mode) -- every worker's traffic then flows through the gateway,
 *      which is what lets the supervisor watch content, not just the process;
 *   4. stream pi's JSONL events into the reused `PiEventParser` (turns / tool
 *      calls / usage) and a `WorkerEventLog` (the ordered window the supervisor
 *      reads);
 *   5. capture the worktree diff against the base branch.
 *
 * All process and git I/O is behind the injectable `WorkerRuntime`, so tests
 * drive the whole pipeline with a fake and never spawn pi, touch git, or reach
 * a gateway. `nodeWorkerRuntime()` is the real implementation, used by the CLI.
 */

import type { WorkerEvent } from "./events.js";
import { WorkerEventLog } from "./events.js";
import { PiEventParser } from "./pi-events.js";
import type { Task, WorkerLifecycle, WorkerResult } from "./types.js";

/** How pi (or any spawned process) exited. */
export type SpawnOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  failure?: string;
};

/** Inputs to one pi run. `onChunk` receives stdout as it streams. */
export type RunPiInput = {
  worktreePath: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onChunk: (chunk: string) => void;
};

/**
 * Everything the worker does to the outside world, injectable so tests fake it.
 * The real one is `nodeWorkerRuntime()`.
 */
export interface WorkerRuntime {
  /** Create a worktree at `worktreePath` on `branch`, based on `baseBranch`. */
  createWorktree(input: { worktreePath: string; baseBranch: string; branch: string }): Promise<void>;
  /** Write the task prompt into the worktree; returns the file path. */
  writePrompt(input: { worktreePath: string; prompt: string }): Promise<string>;
  /** Run pi in the worktree, streaming stdout to `onChunk`. */
  runPi(input: RunPiInput): Promise<SpawnOutcome>;
  /** The unified diff of the worktree against its base branch. */
  captureDiff(input: { worktreePath: string; baseBranch: string }): Promise<string>;
  /** Tear the worktree down. Optional; the CLI keeps them by default. */
  removeWorktree?(input: { worktreePath: string }): Promise<void>;
}

/** Options shared by `spawnWorker` and `startWorker`. */
export type WorkerOptions = {
  /** Directory under which each worker's worktree is created. */
  root: string;
  /** The branch every worktree is based on. */
  baseBranch: string;
  /** pi wall-clock budget, ms. */
  timeoutMs: number;
  /** Passed through as PI_CODING_AGENT_DIR so pi routes through Milo. */
  piAgentDir?: string;
  /** Base environment; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Monotonic clock for event timestamps; defaults to `Date.now`. */
  clock?: () => number;
  /** Path join, injectable so tests need no real filesystem layout. */
  join?: (root: string, id: string) => string;
};

const defaultJoin = (root: string, id: string): string =>
  `${root.replace(/\/+$/, "")}/${id}`;

/** The branch a worker's worktree lives on. One per task, namespaced. */
export function workerBranch(taskId: string): string {
  return `fleet/${taskId}`;
}

/**
 * Build the environment for a pi run: the base environment plus, when given,
 * PI_CODING_AGENT_DIR so pi's provider config points at Milo. Pure, so the
 * passthrough is unit-testable without spawning anything.
 */
export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv, piAgentDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (piAgentDir !== undefined) env["PI_CODING_AGENT_DIR"] = piAgentDir;
  return env;
}

/** Feeds a streamed chunk into both the stats parser and the ordered log. */
function makeSink(parser: PiEventParser, log: WorkerEventLog, clock: () => number) {
  let buffer = "";
  return {
    onChunk(chunk: string): void {
      parser.feed(chunk);
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        log.feedLine(line, clock());
      }
    },
    flush(): void {
      if (buffer !== "") log.feedLine(buffer, clock());
      buffer = "";
      parser.end();
    },
  };
}

/** Classify a spawn outcome into a terminal lifecycle and an optional note. */
function outcomeLifecycle(outcome: SpawnOutcome): { lifecycle: WorkerLifecycle; note?: string } {
  if (outcome.failure !== undefined) {
    return { lifecycle: "failed", note: `pi failed to start: ${outcome.failure}` };
  }
  if (outcome.timedOut) return { lifecycle: "failed", note: "pi exceeded its timeout" };
  return { lifecycle: "finished" };
}

/** What one completed worker run produced, plus the ordered event log. */
export type WorkerRun = {
  result: WorkerResult;
  lifecycle: WorkerLifecycle;
  events: readonly WorkerEvent[];
};

/**
 * Run one worker to completion. Used directly for batch runs and unit tests;
 * the fleet uses `startWorker` for a live, pollable handle. Every side effect
 * goes through `runtime`.
 */
export async function spawnWorker(
  task: Task,
  runtime: WorkerRuntime,
  opts: WorkerOptions,
): Promise<WorkerRun> {
  const clock = opts.clock ?? Date.now;
  const join = opts.join ?? defaultJoin;
  const branch = workerBranch(task.id);
  const worktreePath = join(opts.root, task.id);

  await runtime.createWorktree({ worktreePath, baseBranch: opts.baseBranch, branch });
  await runtime.writePrompt({ worktreePath, prompt: task.prompt });

  const parser = new PiEventParser();
  const log = new WorkerEventLog();
  const sink = makeSink(parser, log, clock);
  const env = buildWorkerEnv(opts.baseEnv ?? process.env, opts.piAgentDir);

  const outcome = await runtime.runPi({
    worktreePath,
    prompt: task.prompt,
    env,
    timeoutMs: opts.timeoutMs,
    onChunk: sink.onChunk,
  });
  sink.flush();

  const diff = await runtime.captureDiff({ worktreePath, baseBranch: opts.baseBranch });
  const { lifecycle, note } = outcomeLifecycle(outcome);

  const result: WorkerResult = {
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    diff,
    stats: parser.stats(),
    ...(note !== undefined ? { note } : {}),
  };
  return { result, lifecycle, events: log.list() };
}

/** A live, pollable view of a running worker. The fleet holds these. */
export interface WorkerHandle {
  readonly id: string;
  readonly task: Task;
  readonly worktreePath: string;
  readonly branch: string;
  lifecycle(): WorkerLifecycle;
  /** The ordered event window so far; grows as pi streams. */
  events(): readonly WorkerEvent[];
  /** The result, once the worker is finished or failed. */
  result(): WorkerResult | undefined;
  /** Resolves when the worker terminates. */
  readonly done: Promise<WorkerResult>;
}

/**
 * Start a worker and return a live handle immediately, without awaiting pi.
 * The fleet polls `events()` and `lifecycle()` between supervision passes. The
 * handle's log fills as pi streams, so a mid-run window reflects only what has
 * happened so far. Injectable runtime, so tests exercise this without pi.
 */
export function startWorker(task: Task, runtime: WorkerRuntime, opts: WorkerOptions): WorkerHandle {
  const clock = opts.clock ?? Date.now;
  const join = opts.join ?? defaultJoin;
  const branch = workerBranch(task.id);
  const worktreePath = join(opts.root, task.id);

  const parser = new PiEventParser();
  const log = new WorkerEventLog();
  const sink = makeSink(parser, log, clock);
  const env = buildWorkerEnv(opts.baseEnv ?? process.env, opts.piAgentDir);

  let lifecycle: WorkerLifecycle = "running";
  let result: WorkerResult | undefined;

  const done = (async (): Promise<WorkerResult> => {
    await runtime.createWorktree({ worktreePath, baseBranch: opts.baseBranch, branch });
    await runtime.writePrompt({ worktreePath, prompt: task.prompt });
    const outcome = await runtime.runPi({
      worktreePath,
      prompt: task.prompt,
      env,
      timeoutMs: opts.timeoutMs,
      onChunk: sink.onChunk,
    });
    sink.flush();
    const diff = await runtime.captureDiff({ worktreePath, baseBranch: opts.baseBranch });
    const settled = outcomeLifecycle(outcome);
    lifecycle = settled.lifecycle;
    result = {
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      diff,
      stats: parser.stats(),
      ...(settled.note !== undefined ? { note: settled.note } : {}),
    };
    return result;
  })().catch((err: unknown): WorkerResult => {
    lifecycle = "failed";
    const message = err instanceof Error ? err.message : String(err);
    result = { exitCode: null, timedOut: false, diff: "", stats: parser.stats(), note: message };
    return result;
  });

  return {
    id: task.id,
    task,
    worktreePath,
    branch,
    lifecycle: () => lifecycle,
    events: () => log.list(),
    result: () => result,
    done,
  };
}
