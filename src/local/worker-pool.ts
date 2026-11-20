import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { withDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError } from './source.js';
import type { Sources } from './source.js';
import { runWorkerAgent, validOwnedPath } from './worker-agent.js';
import type { WorkerAgentFailureReason, WorkerAgentWorkspace, WorkerArtifact, WorkerCapabilities, WorkerInitialFile, WorkerWorkspaceFactory } from './worker-agent.js';
export type { WorkerArtifact, WorkerArtifactFile, WorkerCapabilities, WorkerInitialFile, WorkerWorkspaceFactory } from './worker-agent.js';

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
export interface WorkerTask { task: string; context?: string; activity?: WorkerActivity; mode?: 'proposal' | 'agent'; ownedPaths?: string[] }
export type WorkerFailureCode = 'invalid_task' | 'busy' | 'cancelled' | 'timeout' | 'quota' | 'unavailable';
interface WorkerFailure { ok: false; code: WorkerFailureCode; id?: string; retryAfter?: number; reason?: WorkerAgentFailureReason; artifact?: WorkerArtifact }
export type WorkerResult = { ok: true; id: string; source: string; text: string; artifact?: WorkerArtifact } | WorkerFailure;
export interface WorkerTrustedScope { projectRoot: string; initialSnapshot?: WorkerInitialFile[] }
export type WorkerTransition = 'queued' | 'started' | 'source' | 'waiting' | 'progress' | 'finished';
export interface WorkerPoolOptions {
  createAgentWorkspace?: WorkerWorkspaceFactory;
  onTransition?(status: Readonly<WorkerStatus>, event: WorkerTransition): void | Promise<void>;
}
export interface WorkerStatus {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  activity?: WorkerActivity;
  startedAt?: number;
  finishedAt?: number;
  source?: string;
  code?: WorkerFailureCode;
  mode?: 'proposal' | 'agent';
  turns?: number;
  toolCalls?: number;
  artifactAvailable?: boolean;
  nextAttemptAt?: number;
  capabilities?: WorkerCapabilities;
  waitingForSource?: boolean;
  phase?: 'preparing' | 'inference' | 'tool' | 'source_wait';
  reason?: WorkerAgentFailureReason;
  updatedAt?: number;
}
export interface WorkerSnapshot { active: WorkerStatus[]; queued: WorkerStatus[]; recent: WorkerStatus[] }

export function parseWorkerTask(input: unknown): WorkerTask | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { task, context, activity, mode, ownedPaths } = input as Partial<WorkerTask>;
  if (Object.keys(input).some(key => !['task', 'context', 'activity', 'mode', 'ownedPaths'].includes(key))) return;
  if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > MAX_WORKER_TASK_BYTES) return;
  if (context !== undefined && (typeof context !== 'string' || Buffer.byteLength(context) > MAX_WORKER_CONTEXT_BYTES)) return;
  if (activity !== undefined && !workerActivities.includes(activity)) return;
  if (mode !== undefined && mode !== 'proposal' && mode !== 'agent') return;
  if (mode === 'agent') {
    if (!Array.isArray(ownedPaths) || !ownedPaths.length || ownedPaths.length > 32 || ownedPaths.some(path => !validOwnedPath(path))
      || new Set(ownedPaths).size !== ownedPaths.length) return;
  } else if (ownedPaths !== undefined) return;
  return { task, ...(context === undefined ? {} : { context }), ...(activity === undefined ? {} : { activity }),
    ...(mode === undefined ? {} : { mode }), ...(ownedPaths === undefined ? {} : { ownedPaths: [...ownedPaths] }) };
}

interface Job {
  input: WorkerTask;
  status: WorkerStatus;
  controller: AbortController;
  resolve: (result: WorkerResult) => void;
  cleanup: () => void;
  scope?: WorkerTrustedScope;
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
  private artifacts = new Map<string, { scope: WorkerTrustedScope; workspace: WorkerAgentWorkspace; artifact: WorkerArtifact; status: WorkerStatus; ownedPaths: string[] }>();

  constructor(private sources: Pick<Sources, 'complete'>, private timeoutMs = WORKER_TIMEOUT_MS, private options: WorkerPoolOptions = {}) {}

  run(input: unknown, signal: AbortSignal, trustedScope?: WorkerTrustedScope): Promise<WorkerResult> {
    const task = parseWorkerTask(input);
    if (!task) return Promise.resolve({ ok: false, code: 'invalid_task' });
    if (task.mode === 'agent' && (!trustedScope || typeof trustedScope.projectRoot !== 'string' || !isAbsolute(trustedScope.projectRoot))) {
      return Promise.resolve({ ok: false, code: 'invalid_task', reason: 'invalid_workspace' });
    }
    if (task.mode === 'agent' && !this.options.createAgentWorkspace) return Promise.resolve({ ok: false, code: 'unavailable', reason: 'agent_unavailable' });
    if (this.closed || signal.aborted) return Promise.resolve({ ok: false, code: 'cancelled' });
    if (this.queued.length >= MAX_WORKER_QUEUED) return Promise.resolve({ ok: false, code: 'busy' });
    if (task.mode === 'agent') {
      const outstanding = [...this.running.keys(), ...this.queued].filter(job => job.input.mode === 'agent');
      if (this.artifacts.size + outstanding.length >= MAX_WORKER_RECENT) return Promise.resolve({ ok: false, code: 'busy' });
      const readOnly = task.activity === 'review' || task.activity === 'research';
      const overlaps = (paths: string[]) => task.ownedPaths!.some(path => paths.some(other => path === other || path.startsWith(other + '/') || other.startsWith(path + '/')));
      if (!readOnly && (outstanding.some(job => job.scope?.projectRoot === trustedScope!.projectRoot && job.input.activity !== 'review'
        && job.input.activity !== 'research' && overlaps(job.input.ownedPaths!)) || [...this.artifacts.values()].some(entry => entry.scope.projectRoot === trustedScope!.projectRoot
          && entry.status.activity !== 'review' && entry.status.activity !== 'research' && overlaps(entry.ownedPaths)))) return Promise.resolve({ ok: false, code: 'busy' });
    }
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => this.stop(job, 'cancelled');
      const timer = setTimeout(() => this.stop(job, 'timeout'), this.timeoutMs);
      const job: Job = {
        input: task, status: { id, state: 'queued', createdAt: Date.now(), ...(task.activity ? { activity: task.activity } : {}), ...(task.mode ? { mode: task.mode } : {}) }, controller: new AbortController(), resolve,
        ...(task.mode === 'agent' ? { scope: { projectRoot: trustedScope!.projectRoot,
          ...(trustedScope!.initialSnapshot === undefined ? {} : { initialSnapshot: trustedScope!.initialSnapshot.map(file => ({ ...file })) }) } } : {}),
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      };
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      this.queued.push(job);
      this.observe(job, 'queued');
      this.startQueued();
    });
  }

  status(): WorkerSnapshot {
    const copy = (status: WorkerStatus) => ({ ...status, ...(status.capabilities ? { capabilities: { ...status.capabilities } } : {}) });
    return {
      active: [...this.running.keys()].map(job => copy(job.status)),
      queued: this.queued.map(job => copy(job.status)),
      recent: this.recent.map(copy)
    };
  }

  /** Artifact access always requires the same trusted project capability scope. */
  artifact(id: string, scope: WorkerTrustedScope): WorkerArtifact | undefined {
    const entry = this.artifacts.get(id);
    return entry?.scope.projectRoot === scope.projectRoot ? structuredClone(entry.artifact) : undefined;
  }

  retained(scope: WorkerTrustedScope): WorkerStatus[] {
    return [...this.artifacts.values()].filter(entry => entry.scope.projectRoot === scope.projectRoot).map(entry => ({ ...entry.status,
      ...(entry.status.capabilities ? { capabilities: { ...entry.status.capabilities } } : {}) }));
  }

  async discardArtifact(id: string, scope: WorkerTrustedScope): Promise<boolean> {
    const entry = this.artifacts.get(id);
    if (!entry || entry.scope.projectRoot !== scope.projectRoot || [...this.running.keys()].some(job => job.status.id === id)) return false;
    // Do not release the retained entry until explicit cleanup succeeds.
    await entry.workspace.cleanup();
    this.artifacts.delete(id);
    entry.status.artifactAvailable = false;
    entry.status.updatedAt = Date.now();
    return true;
  }

  private observe(job: Job, event: WorkerTransition) {
    job.status.updatedAt = Date.now();
    try {
      const status = { ...job.status, ...(job.status.capabilities ? { capabilities: { ...job.status.capabilities } } : {}) };
      Promise.resolve(this.options.onTransition?.(status, event)).catch(() => {});
    } catch { /* Telemetry cannot alter execution or leak task bodies. */ }
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
      this.observe(job, 'started');
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
      if (job.input.mode === 'agent') {
        const agent = await runWorkerAgent(this.sources, { id, task, ...(context === undefined ? {} : { context }), ownedPaths: job.input.ownedPaths!,
          projectRoot: job.scope!.projectRoot, ...(job.input.activity === 'review' || job.input.activity === 'research' ? { readOnly: true } : {}),
          ...(job.scope!.initialSnapshot === undefined ? {} : { initialSnapshot: job.scope!.initialSnapshot }),
          signal, createWorkspace: this.options.createAgentWorkspace!,
          onSource: source => { job.status.source = source; job.status.waitingForSource = false; this.observe(job, 'source'); },
          onWait: () => { delete job.status.source; job.status.waitingForSource = true; this.observe(job, 'waiting'); },
          onProgress: progress => { Object.assign(job.status, progress); this.observe(job, 'progress'); }
        });
        if (agent.artifact && agent.workspace) {
          job.status.artifactAvailable = true;
          this.artifacts.set(id, { scope: { projectRoot: job.scope!.projectRoot }, workspace: agent.workspace, artifact: structuredClone(agent.artifact), status: job.status,
            ownedPaths: [...job.input.ownedPaths!] });
        }
        const artifact = agent.artifact ? { artifact: agent.artifact } : {};
        if (agent.ok && agent.source && agent.text) result = { ok: true, id, source: agent.source, text: agent.text, ...artifact };
        else result = { ok: false, id, code: agent.code ?? 'unavailable', ...(agent.reason ? { reason: agent.reason } : {}),
          ...(agent.retryAfter === undefined ? {} : { retryAfter: agent.retryAfter }), ...artifact };
      } else {
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
          id, onSource: source => { if (sourceId.test(source)) { job.status.source = source; job.status.waitingForSource = false; this.observe(job, 'source'); } },
          onWait: () => { delete job.status.source; job.status.waitingForSource = true; this.observe(job, 'waiting'); }
        }
      }, signal));
      const source = answeredBy.get(completion);
      if (!source || !sourceId.test(source) || !completion.text.trim()) throw new SourceError('upstream', 'Missing worker response');
      result = { ok: true, id, source, text: Buffer.from(completion.text).subarray(0, MAX_ANSWER_BYTES).toString('utf8') };
      }
    } catch (error) {
      result = sourceFailure(error, id);
    }
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) result = { ok: false, id, code: signal.reason as StopCode, ...('artifact' in result && result.artifact ? { artifact: result.artifact } : {}) };
    this.running.delete(job);
    this.finish(job, result);
    this.startQueued();
  }

  private finish(job: Job, result: WorkerResult) {
    job.cleanup();
    job.status.state = result.ok ? 'completed' : result.code === 'cancelled' ? 'cancelled' : 'failed';
    job.status.finishedAt = Date.now();
    if (result.ok) job.status.source = result.source;
    else {
      job.status.code = result.code;
      if (result.reason) job.status.reason = result.reason;
      if (result.retryAfter) job.status.nextAttemptAt = Date.now() + result.retryAfter * 1000;
    }
    job.status.waitingForSource = false;
    delete job.status.phase;
    this.observe(job, 'finished');
    this.recent.unshift(job.status);
    if (this.recent.length > MAX_WORKER_RECENT) this.recent.pop();
    job.resolve(result);
  }
}
