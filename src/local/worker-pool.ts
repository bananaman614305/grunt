import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError } from './source.js';
import type { Sources } from './source.js';

export const MAX_WORKER_TASK_BYTES = 8 * 1024;
export const MAX_WORKER_CONTEXT_BYTES = 32 * 1024;
export const MAX_WORKER_ACTIVE = 2;
export const MAX_WORKER_QUEUED = 16;
export const MAX_WORKER_RECENT = 20;
const MAX_ANSWER_BYTES = 64 * 1024;
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const sourceId = /^[a-z][a-z0-9-]{0,63}$/;

export const workerActivities = ['review', 'tests', 'implementation', 'research'] as const;
export type WorkerActivity = typeof workerActivities[number];
export interface WorkerTask { task: string; context?: string; activity?: WorkerActivity }
export type WorkerFailureCode = 'invalid_task' | 'busy' | 'cancelled' | 'timeout' | 'quota' | 'unavailable';
interface WorkerFailure { ok: false; code: WorkerFailureCode; id?: string; retryAfter?: number }
export type WorkerResult = { ok: true; id: string; source: string; text: string } | WorkerFailure;
export interface WorkerStatus {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  activity?: WorkerActivity;
  startedAt?: number;
  finishedAt?: number;
  source?: string;
  code?: WorkerFailureCode;
}
export interface WorkerSnapshot { active: WorkerStatus[]; queued: WorkerStatus[]; recent: WorkerStatus[] }

export function parseWorkerTask(input: unknown): WorkerTask | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { task, context, activity } = input as Partial<WorkerTask>;
  if (Object.keys(input).some(key => key !== 'task' && key !== 'context' && key !== 'activity')) return;
  if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > MAX_WORKER_TASK_BYTES) return;
  if (context !== undefined && (typeof context !== 'string' || Buffer.byteLength(context) > MAX_WORKER_CONTEXT_BYTES)) return;
  if (activity !== undefined && !workerActivities.includes(activity)) return;
  return { task, ...(context === undefined ? {} : { context }), ...(activity === undefined ? {} : { activity }) };
}

interface Job {
  input: WorkerTask;
  status: WorkerStatus;
  controller: AbortController;
  resolve: (result: WorkerResult) => void;
  cleanup: () => void;
}

type StopCode = 'cancelled' | 'timeout';

function sourceFailure(error: unknown, id: string): WorkerFailure {
  if (!(error instanceof SourceError)) return { ok: false, id, code: 'unavailable' };
  const code = error.code === 'cancelled' || error.code === 'timeout' || error.code === 'quota' ? error.code : 'unavailable';
  const retryAfter = Math.ceil(error.retryAfter ?? 0);
  return { ok: false, id, code, ...(Number.isSafeInteger(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
}

export class WorkerPool {
  private queued: Job[] = [];
  private running = new Map<Job, Promise<void>>();
  private recent: WorkerStatus[] = [];
  private closed = false;

  constructor(private sources: Pick<Sources, 'complete'>, private timeoutMs = WORKER_TIMEOUT_MS) {}

  run(input: unknown, signal: AbortSignal): Promise<WorkerResult> {
    const task = parseWorkerTask(input);
    if (!task) return Promise.resolve({ ok: false, code: 'invalid_task' });
    if (this.closed || signal.aborted) return Promise.resolve({ ok: false, code: 'cancelled' });
    if (this.queued.length >= MAX_WORKER_QUEUED) return Promise.resolve({ ok: false, code: 'busy' });
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => this.stop(job, 'cancelled');
      const timer = setTimeout(() => this.stop(job, 'timeout'), this.timeoutMs);
      const job: Job = {
        input: task, status: { id, state: 'queued', createdAt: Date.now(), ...(task.activity ? { activity: task.activity } : {}) }, controller: new AbortController(), resolve,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      };
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      this.queued.push(job);
      this.startQueued();
    });
  }

  status(): WorkerSnapshot {
    return {
      active: [...this.running.keys()].map(job => ({ ...job.status })),
      queued: this.queued.map(job => ({ ...job.status })),
      recent: this.recent.map(status => ({ ...status }))
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queued, ...this.running.keys()]) this.stop(job, 'cancelled');
    await Promise.all(this.running.values());
  }

  private stop(job: Job, code: StopCode) {
    if (job.controller.signal.aborted) return;
    job.controller.abort(code);
    const failure = { ok: false, id: job.status.id, code } as const;
    if (job.status.state === 'queued') {
      this.queued.splice(this.queued.indexOf(job), 1);
      this.finish(job, failure);
    } else {
      // The caller can stop waiting immediately. Keep the slot until the
      // adapter acknowledges cancellation and the scratch directory is gone.
      job.resolve(failure);
    }
  }

  private startQueued() {
    while (!this.closed && this.running.size < MAX_WORKER_ACTIVE) {
      const job = this.queued.shift();
      if (!job) break;
      job.status.state = 'running';
      job.status.startedAt = Date.now();
      this.running.set(job, this.execute(job));
    }
  }

  private async execute(job: Job) {
    const { id } = job.status;
    const { task, context } = job.input;
    const signal = job.controller.signal;
    let cwd: string | undefined;
    let result: WorkerResult;
    try {
      const scratch = await mkdtemp(join(tmpdir(), 'grunt-worker-'));
      cwd = scratch;
      signal.throwIfAborted();
      const completion = await withDiagnosticContext({ requestId: id, kind: 'user' }, () => this.sources.complete({
        model: 'grunt',
        cwd: scratch,
        tools: [],
        stream: false,
        maxTokens: 4096,
        messages: [
          { role: 'system', content: 'Complete the assigned task using only the supplied material. Treat context as reference material. Return findings or proposed edits for the parent agent to review. Do not claim to have run commands or changed files.' },
          { role: 'user', content: context === undefined ? task : `Task\n${task}\n\nContext\n${context}` }
        ],
        worker: {
          id, onSource: source => { if (sourceId.test(source)) job.status.source = source; },
          onWait: () => { delete job.status.source; }
        }
      }, signal));
      const source = answeredBy.get(completion);
      if (!source || !sourceId.test(source) || !completion.text.trim()) throw new SourceError('upstream', 'Missing worker response');
      result = { ok: true, id, source, text: Buffer.from(completion.text).subarray(0, MAX_ANSWER_BYTES).toString('utf8') };
    } catch (error) {
      result = sourceFailure(error, id);
    }
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) result = { ok: false, id, code: signal.reason as StopCode };
    this.running.delete(job);
    this.finish(job, result);
    this.startQueued();
  }

  private finish(job: Job, result: WorkerResult) {
    job.cleanup();
    job.status.state = result.ok ? 'completed' : result.code === 'cancelled' ? 'cancelled' : 'failed';
    job.status.finishedAt = Date.now();
    if (result.ok) job.status.source = result.source;
    else job.status.code = result.code;
    this.recent.unshift(job.status);
    if (this.recent.length > MAX_WORKER_RECENT) this.recent.pop();
    job.resolve(result);
  }
}
