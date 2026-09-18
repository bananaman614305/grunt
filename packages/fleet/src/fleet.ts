/**
 * The fleet controller (ADR-015): manage N workers, poll the supervisor, and
 * expose state and an attention list.
 *
 * IMPORTANT framing (ADR-015): the fleet is a TOOL the frontier agent calls,
 * not an orchestrator. It does not plan, decompose, or decide what to build --
 * the user's frontier agent (Claude Code / Codex) does that and hands the fleet
 * a list of ready tasks. The fleet's whole job is cheap parallel execution plus
 * the one thing a frontier agent cannot see from the outside: whether each
 * worker, from its model traffic, is progressing, idle, wedged, or done.
 *
 * Everything here is pure over its injected dependencies:
 *   - `spawn(task)` yields a live `WorkerHandle` (the fleet never spawns pi
 *     itself; in production this is `startWorker` bound to the node runtime, in
 *     tests a scripted fake);
 *   - `jev` answers supervision calls;
 *   - `now()` and `window` are configuration.
 *
 * Supervision is an explicit `superviseOnce()` pass rather than a hidden timer,
 * so tests advance a fleet deterministically. `runSupervisionLoop` is the thin
 * interval wrapper the CLI uses.
 */

import type { JevClientLike } from "@milo/core";
import { classifyWorker } from "./supervisor.js";
import type {
  AttentionItem,
  Task,
  WorkerClassification,
  WorkerState,
} from "./types.js";
import type { WorkerHandle } from "./worker.js";

/** The dependencies a fleet runs on. All injectable. */
export type FleetDeps = {
  /** Start one worker and return a live handle. */
  spawn: (task: Task) => WorkerHandle;
  /** The Jev client the supervisor uses. */
  jev: JevClientLike;
  /** How many trailing events each supervision pass considers. */
  window?: number;
  /** Reference clock for supervision idle gaps; defaults to `Date.now`. */
  now?: () => number;
};

const DEFAULT_WINDOW = 40;

type WorkerRecord = {
  handle: WorkerHandle;
  classification?: WorkerClassification;
  /** A supervision error from the last pass, if any (kept, not thrown). */
  superviseError?: string;
};

export class Fleet {
  private readonly window: number;
  private readonly now: () => number;
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(private readonly deps: FleetDeps) {
    this.window = deps.window ?? DEFAULT_WINDOW;
    this.now = deps.now ?? Date.now;
  }

  /** Spawn a worker per task. Ignores ids already in the fleet. */
  start(tasks: Task[]): void {
    for (const task of tasks) {
      if (this.workers.has(task.id)) continue;
      this.workers.set(task.id, { handle: this.deps.spawn(task) });
    }
  }

  /** The ids of every worker in the fleet, in insertion order. */
  ids(): string[] {
    return [...this.workers.keys()];
  }

  /**
   * One supervision pass: classify every still-running worker from its recent
   * event window. Finished and failed workers are skipped -- their state is
   * settled -- so a fleet quiesces to no Jev calls once every worker is done.
   * A Jev failure on one worker is recorded, not thrown, so one bad call does
   * not blind the whole fleet.
   */
  async superviseOnce(): Promise<void> {
    const now = this.now();
    const running = [...this.workers.values()].filter((r) => r.handle.lifecycle() === "running");
    await Promise.all(
      running.map(async (rec) => {
        const events = rec.handle.events();
        const window = events.slice(Math.max(0, events.length - this.window));
        try {
          rec.classification = await classifyWorker(this.deps.jev, window, { now });
          delete rec.superviseError;
        } catch (err) {
          rec.superviseError = err instanceof Error ? err.message : String(err);
        }
      }),
    );
  }

  /** The public state of one worker, or `undefined` if unknown. */
  worker(id: string): WorkerState | undefined {
    const rec = this.workers.get(id);
    return rec === undefined ? undefined : this.toState(id, rec);
  }

  /** Every worker's public state, in insertion order. */
  status(): WorkerState[] {
    return [...this.workers.entries()].map(([id, rec]) => this.toState(id, rec));
  }

  /** Finished and failed workers with their results, in insertion order. */
  results(): WorkerState[] {
    return this.status().filter((s) => s.result !== undefined);
  }

  /** True once every worker has terminated. */
  allSettled(): boolean {
    return [...this.workers.values()].every((r) => r.handle.lifecycle() !== "running");
  }

  /**
   * The workers a frontier agent should look at: any running worker the last
   * pass called `wedged` or `idle`, any worker the `needs_human` gate flagged,
   * and any failed worker. Progressing and cleanly-done workers never appear.
   */
  needsAttention(): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const [id, rec] of this.workers) {
      const lifecycle = rec.handle.lifecycle();
      if (lifecycle === "failed") {
        items.push({
          id,
          task: rec.handle.task,
          reason: "failed",
          detail: rec.handle.result()?.note ?? "worker failed",
        });
        continue;
      }
      if (lifecycle !== "running") continue;

      const c = rec.classification;
      if (c === undefined) continue;
      if (c.needsHuman) {
        items.push({
          id,
          task: rec.handle.task,
          reason: "needs_human",
          detail: `supervisor flagged a human decision (verdict ${c.verdict})`,
          confidence: c.confidence,
        });
        continue;
      }
      if (c.verdict === "wedged" || c.verdict === "idle") {
        items.push({
          id,
          task: rec.handle.task,
          reason: c.verdict,
          detail: `supervisor verdict ${c.verdict}`,
          confidence: c.confidence,
        });
      }
    }
    return items;
  }

  /** Resolve when every worker has terminated (results are then complete). */
  async drain(): Promise<WorkerState[]> {
    await Promise.all([...this.workers.values()].map((r) => r.handle.done));
    return this.results();
  }

  private toState(id: string, rec: WorkerRecord): WorkerState {
    const handle = rec.handle;
    const result = handle.result();
    return {
      id,
      task: handle.task,
      lifecycle: handle.lifecycle(),
      worktreePath: handle.worktreePath,
      branch: handle.branch,
      ...(rec.classification !== undefined ? { classification: rec.classification } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  }
}

/**
 * Poll a fleet on a fixed interval until every worker settles, calling
 * `onPass` after each supervision pass (the CLI prints attention there). The
 * timer wrapper the fleet's own logic deliberately avoids; not unit-tested.
 */
export async function runSupervisionLoop(
  fleet: Fleet,
  opts: { intervalMs: number; onPass?: (fleet: Fleet) => void },
): Promise<WorkerState[]> {
  while (!fleet.allSettled()) {
    await fleet.superviseOnce();
    opts.onPass?.(fleet);
    if (fleet.allSettled()) break;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return fleet.drain();
}
