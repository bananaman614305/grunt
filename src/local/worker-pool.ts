import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, lstat, realpath, readdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { withDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError } from './source.js';
import type { Sources } from './source.js';
import { runWorkerAgent, safeWorkerArtifact, readWorkerArtifact, validOwnedPath, MAX_AGENT_ARTIFACT_BYTES } from './worker-agent.js';
import type { WorkerAgentFailureReason, WorkerAgentWorkspace, WorkerArtifact, WorkerCapabilities, WorkerInitialFile, WorkerWorkspaceFactory, WorkerWorkspaceRestorer } from './worker-agent.js';
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
export interface WorkerTrustedScope { projectRoot: string; projectIdentity?: string; initialSnapshot?: WorkerInitialFile[] }
export type WorkerTransition = 'queued' | 'started' | 'source' | 'waiting' | 'progress' | 'finished';
export interface WorkerPoolOptions {
  createAgentWorkspace?: WorkerWorkspaceFactory;
  retentionDirectory?: string;
  restoreAgentWorkspace?: WorkerWorkspaceRestorer;
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
type RetainedEntry = { scope: WorkerTrustedScope; workspace: WorkerAgentWorkspace; artifact: WorkerArtifact; status: WorkerStatus; ownedPaths: string[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recoveryId = /^worker-[A-Za-z0-9_-]{1,128}$/;
const recordLimit = MAX_AGENT_ARTIFACT_BYTES + 64 * 1024;
function sameScope(left: WorkerTrustedScope, right: WorkerTrustedScope) { return left.projectRoot === right.projectRoot && left.projectIdentity === right.projectIdentity; }
function privateScope(scope: WorkerTrustedScope): WorkerTrustedScope { return { projectRoot: scope.projectRoot, ...(scope.projectIdentity === undefined ? {} : { projectIdentity: scope.projectIdentity }) }; }
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Recovery journals contain private scope metadata, never tasks or credentials. */
function recoveryRecord(raw: unknown): { jobId: string; workspaceId: string; recoveryId: string; scope: WorkerTrustedScope; ownedPaths: string[]; status: WorkerStatus; artifact: WorkerArtifact } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid worker recovery record');
  const value = raw as Record<string, unknown>, status = value.status as WorkerStatus;
  if (value.schema !== 'grunt-worker-retention/v1' || typeof value.jobId !== 'string' || !uuid.test(value.jobId)
    || typeof value.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.workspaceId)
    || typeof value.recoveryId !== 'string' || !recoveryId.test(value.recoveryId)
    || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot)
    || value.projectIdentity !== undefined && (typeof value.projectIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectIdentity))
    || !Array.isArray(value.ownedPaths) || !value.ownedPaths.length || value.ownedPaths.length > 32 || value.ownedPaths.some(path => !validOwnedPath(path))
    || !status || status.id !== value.jobId || status.mode !== 'agent' || !Number.isSafeInteger(status.createdAt)
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(status.state)) throw new Error('Invalid worker recovery record');
  const safeStatus: WorkerStatus = { id: status.id, mode: 'agent', state: status.state, createdAt: status.createdAt };
  for (const key of ['startedAt', 'finishedAt', 'updatedAt', 'turns', 'toolCalls', 'nextAttemptAt'] as const) {
    if (status[key] !== undefined) { if (!Number.isSafeInteger(status[key]) || status[key]! < 0) throw new Error('Invalid worker recovery counter'); safeStatus[key] = status[key]; }
  }
  if (status.activity && workerActivities.includes(status.activity)) safeStatus.activity = status.activity;
  if (status.source && sourceId.test(status.source)) safeStatus.source = status.source;
  if (status.code && ['invalid_task', 'busy', 'cancelled', 'timeout', 'quota', 'unavailable'].includes(status.code)) safeStatus.code = status.code;
  if (status.reason && ['invalid_workspace', 'agent_unavailable', 'unsupported_sandbox', 'workspace_failed', 'invalid_completion', 'turn_limit', 'tool_limit', 'output_limit', 'context_limit'].includes(status.reason)) safeStatus.reason = status.reason;
  if (status.capabilities && typeof status.capabilities === 'object') safeStatus.capabilities = { filesystem: status.capabilities.filesystem === true, commands: status.capabilities.commands === true,
    ...(status.capabilities.sandbox === 'bubblewrap' || status.capabilities.sandbox === 'filesystem' ? { sandbox: status.capabilities.sandbox } : {}) };
  const ownedPaths = [...value.ownedPaths] as string[];
  return { jobId: value.jobId, workspaceId: value.workspaceId, recoveryId: value.recoveryId, scope: { projectRoot: value.projectRoot, ...(typeof value.projectIdentity === 'string' ? { projectIdentity: value.projectIdentity } : {}) }, ownedPaths,
    status: safeStatus, artifact: safeWorkerArtifact(value.artifact, value.workspaceId, ownedPaths) };
}

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
  private artifacts = new Map<string, RetainedEntry>();
  private readyPromise?: Promise<void>;
  private durabilityFailed = false;
  private journalWrites = new Map<string, Promise<void>>();

  constructor(private sources: Pick<Sources, 'complete'>, private timeoutMs = WORKER_TIMEOUT_MS, private options: WorkerPoolOptions = {}) {}

  /** Await at daemon startup before exposing synchronous retained/artifact reads. */
  ready(): Promise<void> {
    return this.readyPromise ??= this.restoreRetained();
  }

  private async restoreRetained() {
    const directory = this.options.retentionDirectory;
    if (!directory) return;
    if (!isAbsolute(directory) || !this.options.restoreAgentWorkspace) throw new Error('Durable worker recovery requires a trusted directory and restorer');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()
      || await realpath(directory) !== resolve(directory)) throw new Error('Worker retention directory must be private and owned');
    const names = await readdir(directory);
    if (names.length > 100) throw new Error('Worker retention directory exceeds recovery bounds');
    const files = names.filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'));
    if (files.length > MAX_WORKER_RECENT || names.some(name => !files.includes(name) && !/^\.[a-f0-9-]+\.[a-f0-9-]+\.tmp$/.test(name))) throw new Error('Worker recovery records exceed bounds or contain unexpected entries');
    for (const name of files) {
      const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: unknown;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > recordLimit || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Unsafe worker recovery record');
        const data = await handle.readFile('utf8');
        if (Buffer.byteLength(data) > recordLimit) throw new Error('Oversized worker recovery record');
        raw = JSON.parse(data);
      } finally { await handle.close(); }
      const record = recoveryRecord(raw);
      if (name !== `${record.jobId}.json`) throw new Error('Worker recovery identity mismatch');
      const workspace = await this.options.restoreAgentWorkspace({ recoveryId: record.recoveryId, workspaceId: record.workspaceId }, AbortSignal.timeout(5000));
      if (workspace.id !== record.workspaceId || workspace.recoveryId !== record.recoveryId) throw new Error('Worker recovery workspace mismatch');
      const status = { ...record.status, artifactAvailable: true, waitingForSource: false };
      if (status.state === 'running' || status.state === 'queued') Object.assign(status, { state: 'cancelled', code: 'cancelled', finishedAt: Date.now(), updatedAt: Date.now() });
      const entry = { scope: record.scope, workspace, artifact: await readWorkerArtifact(workspace, record.ownedPaths), status, ownedPaths: record.ownedPaths };
      this.artifacts.set(record.jobId, entry); this.recent.push(status);
      await this.persist(entry);
    }
    this.recent.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  }

  private persist(entry: RetainedEntry, status = entry.status): Promise<void> {
    const directory = this.options.retentionDirectory;
    if (!directory) return Promise.resolve();
    if (!entry.workspace.recoveryId || !recoveryId.test(entry.workspace.recoveryId)) return Promise.reject(new Error('Workspace has no safe recovery identity'));
    const data = JSON.stringify({ schema: 'grunt-worker-retention/v1', jobId: status.id, workspaceId: entry.workspace.id,
      recoveryId: entry.workspace.recoveryId, ...privateScope(entry.scope), ownedPaths: entry.ownedPaths, status, artifact: entry.artifact });
    if (Buffer.byteLength(data) > recordLimit) return Promise.reject(new Error('Worker recovery record exceeds bounds'));
    const previous = this.journalWrites.get(status.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const temporary = join(directory, `.${status.id}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, join(directory, `${status.id}.json`));
        await syncDirectory(directory);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.journalWrites.set(status.id, next);
    return next.catch(error => { this.durabilityFailed = true; throw error; });
  }

  run(input: unknown, signal: AbortSignal, trustedScope?: WorkerTrustedScope): Promise<WorkerResult> {
    if (this.options.retentionDirectory) return this.ready().then(() => this.enqueue(input, signal, trustedScope), () => ({ ok: false, code: 'unavailable', reason: 'workspace_failed' }));
    return this.enqueue(input, signal, trustedScope);
  }

  private enqueue(input: unknown, signal: AbortSignal, trustedScope?: WorkerTrustedScope): Promise<WorkerResult> {
    const task = parseWorkerTask(input);
    if (!task) return Promise.resolve({ ok: false, code: 'invalid_task' });
    if (task.mode === 'agent' && (!trustedScope || typeof trustedScope.projectRoot !== 'string' || !isAbsolute(trustedScope.projectRoot)
      || trustedScope.projectIdentity !== undefined && (typeof trustedScope.projectIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(trustedScope.projectIdentity)))) {
      return Promise.resolve({ ok: false, code: 'invalid_task', reason: 'invalid_workspace' });
    }
    if (task.mode === 'agent' && !this.options.createAgentWorkspace) return Promise.resolve({ ok: false, code: 'unavailable', reason: 'agent_unavailable' });
    if (task.mode === 'agent' && this.durabilityFailed) return Promise.resolve({ ok: false, code: 'unavailable', reason: 'workspace_failed' });
    if (this.closed || signal.aborted) return Promise.resolve({ ok: false, code: 'cancelled' });
    if (this.queued.length >= MAX_WORKER_QUEUED) return Promise.resolve({ ok: false, code: 'busy' });
    if (task.mode === 'agent') {
      const outstanding = [...this.running.keys(), ...this.queued].filter(job => job.input.mode === 'agent');
      if (this.artifacts.size + outstanding.filter(job => !this.artifacts.has(job.status.id)).length >= MAX_WORKER_RECENT) return Promise.resolve({ ok: false, code: 'busy' });
      const readOnly = task.activity === 'review' || task.activity === 'research';
      const overlaps = (paths: string[]) => task.ownedPaths!.some(path => paths.some(other => path === other || path.startsWith(other + '/') || other.startsWith(path + '/')));
      if (!readOnly && (outstanding.some(job => job.scope && sameScope(job.scope, trustedScope!) && job.input.activity !== 'review'
        && job.input.activity !== 'research' && overlaps(job.input.ownedPaths!)) || [...this.artifacts.values()].some(entry => sameScope(entry.scope, trustedScope!)
          && entry.status.activity !== 'review' && entry.status.activity !== 'research' && overlaps(entry.ownedPaths)))) return Promise.resolve({ ok: false, code: 'busy' });
    }
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => this.stop(job, 'cancelled');
      const timer = setTimeout(() => this.stop(job, 'timeout'), this.timeoutMs);
      const job: Job = {
        input: task, status: { id, state: 'queued', createdAt: Date.now(), ...(task.activity ? { activity: task.activity } : {}), ...(task.mode ? { mode: task.mode } : {}) }, controller: new AbortController(), resolve,
        ...(task.mode === 'agent' ? { scope: { ...privateScope(trustedScope!),
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
    return entry && sameScope(entry.scope, scope) ? structuredClone(entry.artifact) : undefined;
  }

  artifactOwnership(id: string, scope: WorkerTrustedScope): string[] | undefined {
    const entry = this.artifacts.get(id);
    return entry && sameScope(entry.scope, scope) ? [...entry.ownedPaths] : undefined;
  }

  retained(scope: WorkerTrustedScope): WorkerStatus[] {
    return [...this.artifacts.values()].filter(entry => sameScope(entry.scope, scope)).map(entry => ({ ...entry.status,
      ...(entry.status.capabilities ? { capabilities: { ...entry.status.capabilities } } : {}) }));
  }

  async discardArtifact(id: string, scope: WorkerTrustedScope): Promise<boolean> {
    const entry = this.artifacts.get(id);
    if (!entry || !sameScope(entry.scope, scope) || [...this.running.keys()].some(job => job.status.id === id)) return false;
    // An explicit discard authorizes removing the journal before deleting the
    // copy, so a crash cannot resurrect a workspace already deleted on disk.
    await this.journalWrites.get(id);
    if (this.options.retentionDirectory) { await unlink(join(this.options.retentionDirectory, `${id}.json`)); await syncDirectory(this.options.retentionDirectory); }
    try { await entry.workspace.cleanup(); }
    catch (error) { await this.persist(entry); throw error; }
    this.artifacts.delete(id);
    this.journalWrites.delete(id);
    entry.status.artifactAvailable = false;
    entry.status.updatedAt = Date.now();
    return true;
  }

  private observe(job: Job, event: WorkerTransition) {
    job.status.updatedAt = Date.now();
    const entry = this.artifacts.get(job.status.id);
    if (entry) void this.persist(entry).catch(() => {});
    try {
      const status = { ...job.status, ...(job.status.capabilities ? { capabilities: { ...job.status.capabilities } } : {}) };
      Promise.resolve(this.options.onTransition?.(status, event)).catch(() => {});
    } catch { /* Telemetry cannot alter execution or leak task bodies. */ }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queued, ...this.running.keys()]) this.stop(job, 'cancelled');
    await Promise.all(this.running.values());
    await Promise.all(this.journalWrites.values());
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
          ...(this.options.retentionDirectory ? { onWorkspace: async (workspace: WorkerAgentWorkspace) => {
            const entry = { scope: privateScope(job.scope!), workspace, ownedPaths: [...job.input.ownedPaths!], status: job.status,
              artifact: { id: workspace.id, files: [], complete: false, truncated: true, summary: 'Worker was interrupted before its final checkpoint.' } };
            this.artifacts.set(id, entry);
            await this.persist(entry);
          } } : {}),
          onSource: source => { job.status.source = source; job.status.waitingForSource = false; this.observe(job, 'source'); },
          onWait: () => { delete job.status.source; job.status.waitingForSource = true; this.observe(job, 'waiting'); },
          onProgress: progress => { Object.assign(job.status, progress); this.observe(job, 'progress'); }
        });
        if (agent.artifact && agent.workspace) {
          job.status.artifactAvailable = true;
          this.artifacts.set(id, { scope: privateScope(job.scope!), workspace: agent.workspace, artifact: structuredClone(agent.artifact), status: job.status,
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
    this.finish(job, result, false);
    const retained = this.artifacts.get(id);
    if (retained) await this.persist(retained).catch(() => {});
    job.resolve(result);
    this.startQueued();
  }

  private finish(job: Job, result: WorkerResult, resolveResult = true) {
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
    if (resolveResult) job.resolve(result);
  }
}
