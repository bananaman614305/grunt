import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DiagnosticEvent } from './diagnostics.js';

export const workStages = ['task', 'queue', 'setup', 'tool', 'verification', 'collection', 'capture'] as const;
export type WorkStage = typeof workStages[number];
export type WorkOutcome = 'passed' | 'failed' | 'cancelled' | 'skipped';
export type WorkDisposition = 'fresh' | 'reused' | 'deduplicated';
export interface WorkTimingSpan {
  readonly id: string;
  finish(outcome: WorkOutcome): void;
  run<T>(operation: () => T): T;
}
export interface WorkTimingObserver {
  start(stage: WorkStage, options?: { parentId?: string; workDisposition?: WorkDisposition }): WorkTimingSpan;
}
export interface WorkTimingOptions { timing?: WorkTimingObserver; parentId?: string; workDisposition?: WorkDisposition }
interface ActiveSpan { id: string; observer: WorkTimingObserver }
const active = new AsyncLocalStorage<ActiveSpan>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const version = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,64})?$/;

/** Trusted metadata only. Observer exceptions never alter the work being measured. */
export function createWorkTimingObserver(options: {
  sink: { record(event: DiagnosticEvent): void };
  now?: () => number;
  monotonicNow?: () => number;
  runtimeVersion?: string;
}): WorkTimingObserver {
  const now = options.now ?? Date.now, monotonic = options.monotonicNow ?? (() => performance.now());
  const observer: WorkTimingObserver = {
    start(stage, input = {}) {
      const id = randomUUID(), parentId = input.parentId ?? active.getStore()?.id;
      let started = 0, finished = false;
      try { started = monotonic(); } catch { /* A clock failure cannot fail work. */ }
      const record = (type: 'work.start' | 'work.finish', outcome?: WorkOutcome) => {
        try {
          if (!workStages.includes(stage) || outcome !== undefined && !['passed', 'failed', 'cancelled', 'skipped'].includes(outcome)) return;
          const at = now(), elapsed = Math.max(0, monotonic() - started);
          if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(elapsed)) return;
          options.sink.record({ version: 1, id: randomUUID(), at, requestId: id, type, kind: 'user', actor: 'worker',
            stage, ...(parentId && uuid.test(parentId) ? { parentId } : {}),
            ...(input.workDisposition && ['fresh', 'reused', 'deduplicated'].includes(input.workDisposition) ? { workDisposition: input.workDisposition } : {}),
            ...(options.runtimeVersion && version.test(options.runtimeVersion) ? { runtimeVersion: options.runtimeVersion } : {}),
            ...(outcome ? { outcome, durationMs: elapsed } : {}) });
        } catch { /* Recording is observation, never execution authority. */ }
      };
      record('work.start');
      return { id,
        finish(outcome) { if (!finished) { finished = true; record('work.finish', outcome); } },
        run(operation) { return active.run({ id, observer }, operation); }
      };
    }
  };
  return observer;
}

/** Uses a trusted injected observer or a parent stage; absent observation is a no-op. */
export function startWorkTiming(stage: WorkStage, options: WorkTimingOptions = {}): WorkTimingSpan {
  let span: WorkTimingSpan | undefined, observer: WorkTimingObserver | undefined;
  try {
    observer = options.timing ?? active.getStore()?.observer;
    span = observer?.start(stage, { ...(options.parentId ? { parentId: options.parentId } : {}), ...(options.workDisposition ? { workDisposition: options.workDisposition } : {}) });
  } catch { /* Even an injected observer cannot prevent work. */ }
  let id: string = randomUUID(), finished = false;
  try { if (span?.id && uuid.test(span.id)) id = span.id; } catch { /* An observer getter cannot prevent execution. */ }
  return { id, finish(outcome) { if (finished) return; finished = true; try { span?.finish(outcome); } catch { /* Observational only. */ } },
    // Never delegate execution to an observer-provided run method.
    run(operation) {
      return observer ? active.run({ id, observer }, operation) : operation();
    }
  };
}

/** A passed stage means this operation returned, not that a project task is verified. */
export async function measureWorkTiming<T>(stage: WorkStage, operation: () => Promise<T>, options: WorkTimingOptions & { signal?: AbortSignal } = {}): Promise<T> {
  const span = startWorkTiming(stage, options);
  try { const result = await span.run(operation); span.finish(options.signal?.aborted ? 'cancelled' : 'passed'); return result; }
  catch (error) { span.finish(options.signal?.aborted ? 'cancelled' : 'failed'); throw error; }
}
