import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOB_CATEGORIES = ['test', 'build', 'render', 'download', 'other'] as const;
export type JobCategory = typeof JOB_CATEGORIES[number];
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobCode = 'cancelled' | 'timeout' | 'output_limit' | 'interrupted' | 'execution_failed';
export const MAX_JOB_ACTIVE = 2;
export const MAX_JOB_QUEUED = 16;
export const MAX_JOB_OUTPUT_BYTES = 64 * 1024;
export const MAX_JOB_TIMEOUT_SECONDS = 1800;
const MAX_RECENT = 100, MAX_RETAINED = 128;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
const headPattern = /^[a-f0-9]{40}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export interface JobInput { command: string; category: JobCategory; timeoutSeconds: number }
export interface JobStatus {
  id: string; category: JobCategory; state: JobState; createdAt: number; ownerPid: number;
  startedAt?: number; finishedAt?: number; collectedAt?: number; exitCode?: number; code?: JobCode;
  headAtStart?: string; headAtFinish?: string; cleanAtStart?: boolean; cleanAtFinish?: boolean;
}
export interface JobWait { id: string; state: 'waiting'; startedAt: number; deadlineAt: number }
export interface JobSnapshot { version: 1; observedAt: number; ownerPid: number; active: JobStatus[]; queued: JobStatus[]; recent: JobStatus[]; waiting: JobWait[] }
export interface JobExecution {
  stdout: string; stderr: string; exitCode?: number; code?: JobCode; truncated?: boolean;
  headAtStart?: string; headAtFinish?: string; cleanAtStart?: boolean; cleanAtFinish?: boolean;
}
export type JobResult = JobStatus & Partial<JobExecution>;
export interface JobRunRequest { id: string; cwd: string; command: string; timeoutMs: number; maxOutputBytes: number; ownerPid: number; directory: string; signal: AbortSignal }
export type JobRunner = (request: JobRunRequest) => Promise<JobExecution>;
export interface JobExec { (command: string, args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }> }
interface InternalJob { status: JobStatus; input?: JobInput; cwd?: string; controller?: AbortController; promise?: Promise<void>; result?: JobExecution }

export function parseJobInput(value: unknown): JobInput {
  const v = object(value);
  if (Object.keys(v).some(k => !['command', 'category', 'timeoutSeconds'].includes(k)) || typeof v.command !== 'string' || !v.command.trim() || Buffer.byteLength(v.command) > 8192 || v.command.includes('\0')) throw new Error('Provide a nonempty command of at most 8 KiB; the current interface supplies its working directory.');
  const category = v.category === undefined ? 'other' : JOB_CATEGORIES.find(c => c === v.category);
  const timeoutSeconds = v.timeoutSeconds ?? 900;
  if (!category || !Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > MAX_JOB_TIMEOUT_SECONDS) throw new Error('Use a known job category and a timeout from 1 to 1800 seconds.');
  return { command: v.command, category, timeoutSeconds: Number(timeoutSeconds) };
}
export function parseJobId(value: unknown) {
  const v = typeof value === 'string' ? { id: value } : object(value);
  if (Object.keys(v).length !== 1 || typeof v.id !== 'string' || !idPattern.test(v.id)) throw new Error('Provide the id returned by grunt_job_start.');
  return v.id;
}
export function jobsStateDirectory(env = process.env, home = homedir()) {
  const path = env.GRUNT_JOBS_STATE_DIR ?? join(home, '.cache', 'grunt', 'jobs');
  if (!isAbsolute(path)) throw new Error('GRUNT_JOBS_STATE_DIR must be an absolute private directory.');
  return resolve(path);
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid() || process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error('Grunt job state must be a private owned directory.');
}
async function privateJSON(path: string, limit = 1024 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || process.getuid && st.uid !== process.getuid() || process.platform !== 'win32' && (st.mode & 0o077) !== 0 || st.size > limit) throw new Error('Unsafe or oversized Grunt job state.');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
async function atomicJSON(path: string, value: unknown) {
  const staged = join(dirname(path), `.job-${randomUUID()}.tmp`);
  try { await writeFile(staged, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(staged, path); }
  finally { await rm(staged, { force: true }); }
}
async function exclusiveJSON(path: string, value: unknown) {
  const staged = join(dirname(path), `.lease-${randomUUID()}.tmp`);
  try {
    await writeFile(staged, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    // Publish an already complete file atomically without replacing any owner.
    await link(staged, path);
  } finally { await rm(staged, { force: true }); }
}
function alive(pid: unknown) {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
interface OwnerLease { ownerPid: number; token: string }
function ownerLease(value: unknown): OwnerLease {
  const v = object(value);
  if (!Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0 || typeof v.token !== 'string' || !v.token || v.token.length > 128) throw new Error('Invalid Grunt job owner lease; refusing unsafe recovery.');
  return { ownerPid: Number(v.ownerPid), token: v.token };
}
function leaseDigest(lease: OwnerLease) { return createHash('sha256').update(JSON.stringify(lease)).digest('hex'); }
async function claimStaleOwner(directory: string, previous: OwnerLease, token: string) {
  const claims = join(directory, 'takeovers'); await privateDirectory(claims);
  let observed = previous;
  // Immutable per-generation claims fence delayed contenders. An abandoned claim is
  // recovered by claiming its own generation, never by unlinking a shared lock.
  for (let depth = 0; depth < 128; depth++) {
    const path = join(claims, `${leaseDigest(observed)}.json`);
    try {
      await exclusiveJSON(path, { ownerPid: process.pid, token });
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    observed = ownerLease(await privateJSON(path, 2048));
    if (alive(observed.ownerPid)) throw new Error('This Grunt job session already has a live recovery owner.');
  }
  throw new Error('Grunt job recovery claim chain exceeded its safety limit.');
}
function statusProjection(value: unknown): JobStatus | undefined {
  const v = object(value), category = JOB_CATEGORIES.find(c => c === v.category);
  if (typeof v.id !== 'string' || !idPattern.test(v.id) || !category || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(v.state)) || !Number.isSafeInteger(v.createdAt) || !Number.isSafeInteger(v.ownerPid)) return;
  const out: JobStatus = { id: v.id, category, state: v.state as JobState, createdAt: Number(v.createdAt), ownerPid: Number(v.ownerPid) };
  for (const key of ['startedAt', 'finishedAt', 'collectedAt', 'exitCode'] as const) if (Number.isSafeInteger(v[key]) && Number(v[key]) >= 0) out[key] = Number(v[key]);
  if (['cancelled', 'timeout', 'output_limit', 'interrupted', 'execution_failed'].includes(String(v.code))) out.code = v.code as JobCode;
  for (const key of ['headAtStart', 'headAtFinish'] as const) if (typeof v[key] === 'string' && headPattern.test(v[key])) out[key] = v[key];
  for (const key of ['cleanAtStart', 'cleanAtFinish'] as const) if (typeof v[key] === 'boolean') out[key] = v[key];
  return out;
}

/** Session-owned scheduler. The runner is explicitly injected by a trusted interface, never an HTTP caller. */
export class JobScheduler {
  private jobs = new Map<string, InternalJob>();
  private running = new Set<InternalJob>();
  private queued: InternalJob[] = [];
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private admissions: Promise<void> = Promise.resolve();
  private heartbeat: NodeJS.Timeout;
  private token = randomUUID();
  private waiters = new Map<string, Set<() => void>>();
  private waiting = new Map<string, JobWait>();
  private constructor(private options: { directory: string; runner: JobRunner; now: () => number; active: number; outputBytes: number }) {
    this.heartbeat = setInterval(() => { if (this.running.size || this.queued.length) void this.persist().catch(() => {}); }, 5000).unref();
  }
  static async open(options: { stateDirectory?: string; sessionId: string; runner: JobRunner; now?: () => number; maxActive?: number; maxOutputBytes?: number }) {
    if (!sessionPattern.test(options.sessionId)) throw new Error('Invalid Grunt job session.');
    const root = options.stateDirectory ?? jobsStateDirectory();
    if (!isAbsolute(root)) throw new Error('Grunt job state directory must be absolute.');
    const directory = join(root, 'sessions', options.sessionId);
    await privateDirectory(root); await privateDirectory(join(root, 'sessions')); await privateDirectory(directory); await privateDirectory(join(directory, 'jobs')); await privateDirectory(join(directory, 'receipts'));
    const out = new JobScheduler({ directory, runner: options.runner, now: options.now ?? Date.now,
      active: Math.min(MAX_JOB_ACTIVE, Math.max(1, options.maxActive ?? MAX_JOB_ACTIVE)), outputBytes: Math.min(256 * 1024, Math.max(1, options.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES)) });
    try {
      const lock = join(directory, 'owner.json');
      try {
        const previous = ownerLease(await privateJSON(lock, 2048));
        if (alive(previous.ownerPid)) throw new Error('This Grunt job session already has a live owner.');
        await claimStaleOwner(directory, previous, out.token);
        const current = ownerLease(await privateJSON(lock, 2048));
        if (current.token !== previous.token || current.ownerPid !== previous.ownerPid || alive(current.ownerPid)) throw new Error('Grunt job owner changed during recovery; refusing to remove its lease.');
        await rm(lock);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await exclusiveJSON(lock, { ownerPid: process.pid, token: out.token });
      for (const entry of (await readdir(join(directory, 'jobs'), { withFileTypes: true })).slice(0, MAX_RETAINED)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !idPattern.test(entry.name)) continue;
        try {
          const status = statusProjection(await privateJSON(join(directory, 'jobs', entry.name, 'receipt.json'), 8192));
          if (!status) continue;
          if (status.state === 'queued' || status.state === 'running') { status.state = 'cancelled'; status.code = 'interrupted'; status.finishedAt = out.options.now(); }
          out.jobs.set(status.id, { status });
          await atomicJSON(join(directory, 'jobs', status.id, 'receipt.json'), status);
        } catch { /* Do not execute or trust damaged state during recovery. */ }
      }
      await out.persist(); return out;
    } catch (error) { clearInterval(out.heartbeat); throw error; }
  }
  get directory() { return this.options.directory; }
  snapshot(): JobSnapshot {
    const rows = [...this.jobs.values()].map(j => ({ ...j.status }));
    return { version: 1, observedAt: this.options.now(), ownerPid: process.pid,
      active: rows.filter(x => x.state === 'running'), queued: rows.filter(x => x.state === 'queued'),
      waiting: [...this.waiting.values()].map(row => ({ ...row })),
      recent: rows.filter(x => !['running', 'queued'].includes(x.state)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, MAX_RECENT) };
  }
  private persist() {
    const snapshot = this.snapshot();
    const work = () => atomicJSON(join(this.directory, 'snapshot.json'), snapshot);
    this.writes = this.writes.then(work, work); return this.writes;
  }
  async start(input: unknown, trustedCwd: string) {
    const parsed = parseJobInput(input);
    const pending = this.admissions.then(() => this.admit(parsed, trustedCwd));
    this.admissions = pending.then(() => {}, () => {});
    return pending;
  }
  private async admit(parsed: JobInput, trustedCwd: string) {
    if (this.closed) throw new Error('Grunt jobs are shutting down.');
    if (!isAbsolute(trustedCwd) || !(await lstat(await realpath(trustedCwd))).isDirectory()) throw new Error('The coding interface must supply an existing working directory.');
    if (this.jobs.size >= MAX_RETAINED) await this.pruneCollected();
    if (this.queued.length >= MAX_JOB_QUEUED || this.jobs.size >= MAX_RETAINED) throw new Error('Grunt job capacity reached; retrieve completed results or start a new session.');
    const id = randomUUID(), directory = join(this.directory, 'jobs', id); await privateDirectory(directory);
    const status: JobStatus = { id, category: parsed.category, state: 'queued', createdAt: this.options.now(), ownerPid: process.pid };
    const job: InternalJob = { status, input: parsed, cwd: await realpath(trustedCwd), controller: new AbortController() };
    await atomicJSON(join(directory, 'receipt.json'), status);
    this.jobs.set(id, job); this.queued.push(job); await this.persist(); this.pump();
    return { id, state: job.status.state };
  }
  private async pruneCollected() {
    const oldest = [...this.jobs.values()].filter(j => !this.running.has(j) && j.status.collectedAt !== undefined && !['queued', 'running'].includes(j.status.state))
      .sort((a, b) => (a.status.finishedAt ?? 0) - (b.status.finishedAt ?? 0))[0];
    if (!oldest) return;
    const archive = join(this.directory, 'receipts');
    await atomicJSON(join(archive, `${String(oldest.status.finishedAt ?? this.options.now()).padStart(13, '0')}-${oldest.status.id}.json`), oldest.status);
    // Only results already retrieved by the parent are evicted. Keep bounded metadata receipts.
    await rm(join(this.directory, 'jobs', oldest.status.id), { recursive: true, force: true }); this.jobs.delete(oldest.status.id);
    const receipts = (await readdir(archive)).filter(name => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name)).sort();
    for (const name of receipts.slice(0, Math.max(0, receipts.length - 512))) await rm(join(archive, name), { force: true });
  }
  private pump() {
    while (!this.closed && this.running.size < this.options.active) {
      const job = this.queued.shift(); if (!job) break;
      this.running.add(job); job.status.state = 'running'; job.status.startedAt = this.options.now();
      job.promise = this.execute(job);
    }
  }
  private async execute(job: InternalJob) {
    const directory = join(this.directory, 'jobs', job.status.id);
    try {
      await atomicJSON(join(directory, 'receipt.json'), job.status); await this.persist();
      if (await cancellationRequested(directory)) job.controller!.abort('cancelled');
      job.controller!.signal.throwIfAborted();
      const input = job.input!;
      const result = await this.options.runner({ id: job.status.id, cwd: job.cwd!, command: input.command, timeoutMs: input.timeoutSeconds * 1000,
        maxOutputBytes: this.options.outputBytes, ownerPid: process.pid, directory, signal: job.controller!.signal });
      job.result = safeExecution(result, this.options.outputBytes);
      Object.assign(job.status, metadata(job.result));
      if (job.controller!.signal.aborted) { job.status.state = 'cancelled'; job.status.code = job.controller!.signal.reason === 'interrupted' ? 'interrupted' : 'cancelled'; }
      else if (job.result.code) { job.status.state = job.result.code === 'cancelled' || job.result.code === 'interrupted' ? 'cancelled' : 'failed'; job.status.code = job.result.code; }
      else job.status.state = job.result.exitCode === 0 ? 'completed' : 'failed';
    } catch {
      job.status.state = job.controller?.signal.aborted ? 'cancelled' : 'failed'; job.status.code = job.controller?.signal.aborted ? job.controller.signal.reason === 'interrupted' ? 'interrupted' : 'cancelled' : 'execution_failed';
    } finally {
      job.status.finishedAt = this.options.now();
      await atomicJSON(join(directory, 'result.json'), { ...job.status, ...(job.result ?? { stdout: '', stderr: '' }) }).catch(() => {});
      await atomicJSON(join(directory, 'receipt.json'), job.status).catch(() => {});
      this.running.delete(job); await this.persist().catch(() => {}); this.notify(job.status.id); this.pump();
    }
  }
  async result(input: unknown): Promise<JobResult> {
    const id = parseJobId(input), job = this.jobs.get(id);
    if (!job) throw new Error('This job is not available in the current session.');
    if (job.status.state === 'queued' || job.status.state === 'running') return { ...job.status };
    if (job.status.collectedAt === undefined) { job.status.collectedAt = this.options.now(); await atomicJSON(join(this.directory, 'jobs', id, 'receipt.json'), job.status); await this.persist(); }
    let result = job.result;
    if (!result) { try { result = safeExecution(await privateJSON(join(this.directory, 'jobs', id, 'result.json')), this.options.outputBytes); } catch { /* A recovered interrupted job has metadata but may lack output. */ } }
    return { ...(result ?? {}), ...job.status };
  }
  cancel(input: unknown, code: 'cancelled' | 'interrupted' = 'cancelled') {
    const id = parseJobId(input), job = this.jobs.get(id);
    if (!job) throw new Error('This job is not available in the current session.');
    if (!['queued', 'running'].includes(job.status.state)) return { ...job.status };
    job.controller?.abort(code);
    if (job.status.state === 'queued') {
      this.queued = this.queued.filter(x => x !== job); job.status.state = 'cancelled'; job.status.code = code; job.status.finishedAt = this.options.now();
      const status = { ...job.status }, work = () => atomicJSON(join(this.directory, 'jobs', id, 'receipt.json'), status);
      this.writes = this.writes.then(work, work); void this.persist().catch(() => {}); this.notify(id);
    }
    return { ...job.status };
  }
  private notify(id: string) { for (const ready of [...this.waiters.get(id) ?? []]) ready(); }
  async wait(input: unknown, options: { timeoutMs?: number; signal?: AbortSignal; track?: boolean } = {}): Promise<JobResult> {
    const id = parseJobId(input), job = this.jobs.get(id);
    if (!job) throw new Error('This job is not available in the current session.');
    options.signal?.throwIfAborted();
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)) throw new Error('Wait at most 120 seconds before checking for ready work.');
    if (!['queued', 'running'].includes(job.status.state)) return this.result(id);
    const token = randomUUID(), startedAt = this.options.now();
    if (options.track) {
      if (this.waiting.size >= 16 || options.timeoutMs === undefined) throw new Error('Too many managed waits or missing wait deadline.');
      this.waiting.set(token, { id, state: 'waiting', startedAt, deadlineAt: startedAt + options.timeoutMs });
      await this.persist();
    }
    try {
      await new Promise<void>((resolveWait, rejectWait) => {
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: unknown) => {
          if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
          const listeners = this.waiters.get(id); listeners?.delete(ready); if (!listeners?.size) this.waiters.delete(id);
          if (error !== undefined) rejectWait(error); else resolveWait();
        };
        const ready = () => finish(), abort = () => finish(options.signal?.reason ?? new Error('Job wait cancelled.'));
        const listeners = this.waiters.get(id) ?? new Set<() => void>(); listeners.add(ready); this.waiters.set(id, listeners);
        if (options.timeoutMs !== undefined) timer = setTimeout(ready, options.timeoutMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        // Completion may have happened while publishing the wait projection.
        if (options.signal?.aborted) abort(); else if (!['queued', 'running'].includes(job.status.state)) ready();
      });
      return this.result(id);
    } finally { if (this.waiting.delete(token)) await this.persist(); }
  }
  async flush() { await this.writes; }
  async close() {
    this.closed = true; clearInterval(this.heartbeat); await this.admissions;
    for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.status.state)) this.cancel(job.status.id, 'interrupted');
    await Promise.allSettled([...this.running].map(j => j.promise)); await this.persist();
    const path = join(this.directory, 'owner.json');
    try { if (object(await privateJSON(path, 2048)).token === this.token) await rm(path); } catch { /* Never remove another owner's lease. */ }
  }
}
function metadata(value: JobExecution): Partial<JobStatus> {
  const out: Partial<JobStatus> = {};
  if (value.exitCode !== undefined) out.exitCode = value.exitCode;
  for (const key of ['headAtStart', 'headAtFinish', 'cleanAtStart', 'cleanAtFinish'] as const) if (value[key] !== undefined) Object.assign(out, { [key]: value[key] });
  return out;
}
function safeExecution(input: unknown, bytes = MAX_JOB_OUTPUT_BYTES): JobExecution {
  const v = object(input); let left = bytes, clipped = false;
  const bounded = (value: unknown) => { if (typeof value !== 'string') return ''; const data = Buffer.from(value); let text = data.subarray(0, left).toString(); clipped ||= data.length > left; while (Buffer.byteLength(text) > left) text = text.slice(0, -1); left -= Buffer.byteLength(text); return text; };
  const out: JobExecution = { stdout: bounded(v.stdout), stderr: bounded(v.stderr) };
  if (Number.isSafeInteger(v.exitCode) && Number(v.exitCode) >= 0 && Number(v.exitCode) <= 255) out.exitCode = Number(v.exitCode);
  if (['cancelled', 'timeout', 'output_limit', 'interrupted', 'execution_failed'].includes(String(v.code))) out.code = v.code as JobCode;
  if (v.truncated === true || clipped) out.truncated = true;
  for (const key of ['headAtStart', 'headAtFinish'] as const) if (typeof v[key] === 'string' && headPattern.test(v[key])) out[key] = v[key];
  for (const key of ['cleanAtStart', 'cleanAtFinish'] as const) if (typeof v[key] === 'boolean') out[key] = v[key];
  return out;
}
async function cancellationRequested(directory: string) {
  try { const st = await lstat(join(directory, 'cancel.request')); return st.isFile() && !st.isSymbolicLink() && (!process.getuid || st.uid === process.getuid()); }
  catch { return false; }
}
export function jobEnvironment(env = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SYSTEMROOT', 'WINDIR']) if (env[key] !== undefined) out[key] = env[key];
  return { ...out, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', NPM_CONFIG_USERCONFIG: '/dev/null' };
}
function gitMetadata(cwd: string, env: NodeJS.ProcessEnv) {
  const options = { cwd, env, timeout: 2000, maxBuffer: 65536, encoding: 'utf8' as const, windowsHide: true };
  const prefix = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const rev = spawnSync('git', [...prefix, 'rev-parse', '--verify', 'HEAD'], options), head = rev.status === 0 && headPattern.test(rev.stdout.trim()) ? rev.stdout.trim() : undefined;
  const dirty = spawnSync('git', [...prefix, 'status', '--porcelain=v1', '--untracked-files=normal'], options);
  return { ...(head ? { head } : {}), ...(dirty.status === 0 ? { clean: dirty.stdout.trim() === '' } : {}) };
}

/** Runs only through an explicitly chosen local/parent-interface runner. No daemon host execution endpoint calls this. */
export async function runJobCommand(request: JobRunRequest): Promise<JobExecution> {
  if (process.platform === 'win32') return { stdout: '', stderr: 'Managed process-group jobs currently require a POSIX coding interface.', code: 'execution_failed' };
  request.signal.throwIfAborted();
  const env = jobEnvironment(), before = gitMetadata(request.cwd, env), controller = new AbortController();
  let reason: JobCode | undefined;
  const stop = (code: JobCode) => { reason ??= code; controller.abort(); };
  const abort = () => stop('cancelled'); request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
  const parent = setInterval(() => { if (process.ppid !== request.ownerPid) stop('interrupted'); void cancellationRequested(request.directory).then(cancel => { if (cancel) stop('cancelled'); }); }, 200).unref();
  try {
    const output = await new Promise<JobExecution>(resolveResult => {
      const child = spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [], errors: Buffer[] = []; let captured = 0;
      const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* The owned group already exited. */ } } };
      let force: NodeJS.Timeout | undefined;
      const stopping = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 500).unref(); };
      controller.signal.addEventListener('abort', stopping, { once: true }); if (controller.signal.aborted) stopping();
      const consume = (chunk: Buffer, target: Buffer[]) => { const remaining = Math.max(0, request.maxOutputBytes - captured); if (remaining) { const part = chunk.subarray(0, remaining); target.push(part); captured += part.length; } if (chunk.length > remaining) stop('output_limit'); };
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, chunks)); child.stderr.on('data', (chunk: Buffer) => consume(chunk, errors));
      child.once('error', () => { reason ??= 'execution_failed'; });
      child.once('exit', () => kill('SIGKILL')); // Reap background descendants before inherited pipes delay close.
      child.once('close', code => {
        controller.signal.removeEventListener('abort', stopping); if (force) clearTimeout(force); kill('SIGKILL');
        resolveResult({ stdout: Buffer.concat(chunks).toString(), stderr: Buffer.concat(errors).toString(), ...(code !== null ? { exitCode: code } : {}), ...(reason ? { code: reason } : {}), ...(reason === 'output_limit' ? { truncated: true } : {}) });
      });
    });
    const after = gitMetadata(request.cwd, env);
    return { ...output, ...(before.head ? { headAtStart: before.head } : {}), ...(after.head ? { headAtFinish: after.head } : {}),
      ...(before.clean !== undefined ? { cleanAtStart: before.clean } : {}), ...(after.clean !== undefined ? { cleanAtFinish: after.clean } : {}) };
  } finally { clearTimeout(timer); clearInterval(parent); request.signal.removeEventListener('abort', abort); }
}
async function prepareRun(request: JobRunRequest) {
  const path = join(request.directory, 'request.json');
  await atomicJSON(path, { version: 1, id: request.id, cwd: request.cwd, command: request.command, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, ownerPid: request.ownerPid });
  return path;
}
export function createPiJobRunner(exec: JobExec, options: { helperEntry?: string } = {}): JobRunner {
  return async request => {
    const path = await prepareRun(request);
    const result = await exec(process.execPath, [options.helperEntry ?? fileURLToPath(import.meta.url), '--execute-job', path], { cwd: request.cwd, signal: request.signal, timeout: request.timeoutMs + 5000 });
    try { return safeExecution(await privateJSON(join(request.directory, 'runner-result.json')), request.maxOutputBytes); }
    catch { return { stdout: '', stderr: '', code: request.signal.aborted ? 'cancelled' : result.killed ? 'timeout' : 'execution_failed' }; }
  };
}
export function createLocalJobRunner(options: { helperEntry?: string } = {}): JobRunner {
  return createPiJobRunner(async (command, args, options) => new Promise(resolveResult => {
    const child = spawn(command, args, { cwd: options.cwd, env: jobEnvironment(), stdio: ['ignore', 'ignore', 'ignore'] });
    const abort = () => child.kill('SIGTERM'); options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.once('error', () => resolveResult({ stdout: '', stderr: '', code: 1 }));
    child.once('close', code => { options.signal.removeEventListener('abort', abort); resolveResult({ stdout: '', stderr: '', code: code ?? 1 }); });
  }), options);
}
async function executeHelper(path: string) {
  const v = object(await privateJSON(path, 32768));
  if (v.version !== 1 || typeof v.id !== 'string' || !idPattern.test(v.id) || basename(path) !== 'request.json' || basename(dirname(path)) !== v.id || typeof v.cwd !== 'string' || !isAbsolute(v.cwd) || typeof v.command !== 'string' || Buffer.byteLength(v.command) > 8192 || !Number.isSafeInteger(v.timeoutMs) || Number(v.timeoutMs) < 1000 || Number(v.timeoutMs) > MAX_JOB_TIMEOUT_SECONDS * 1000 || !Number.isSafeInteger(v.maxOutputBytes) || Number(v.maxOutputBytes) < 1 || Number(v.maxOutputBytes) > 256 * 1024 || !Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0) throw new Error('Invalid private Grunt job request.');
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const result = await runJobCommand({ id: v.id, command: v.command, cwd: v.cwd, timeoutMs: Number(v.timeoutMs), maxOutputBytes: Number(v.maxOutputBytes), ownerPid: Number(v.ownerPid), directory: dirname(path), signal: controller.signal });
    await atomicJSON(join(dirname(path), 'runner-result.json'), result);
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

export async function readJobSession(stateDirectory: string, sessionId: string): Promise<JobSnapshot | undefined> {
  if (!sessionPattern.test(sessionId)) throw new Error('Invalid Grunt job session.');
  try {
    const raw = object(await privateJSON(join(stateDirectory, 'sessions', sessionId, 'snapshot.json')));
    if (raw.version !== 1 || !Number.isSafeInteger(raw.observedAt) || !Number.isSafeInteger(raw.ownerPid)) return;
    const list = (v: unknown) => Array.isArray(v) ? v.slice(0, MAX_RETAINED).map(statusProjection).filter((x): x is JobStatus => !!x) : [];
    const waiting: JobWait[] = [];
    if (Array.isArray(raw.waiting)) for (const value of raw.waiting.slice(0, 16)) {
      const row = object(value);
      if (typeof row.id === 'string' && idPattern.test(row.id) && row.state === 'waiting' && Number.isSafeInteger(row.startedAt) && Number.isSafeInteger(row.deadlineAt)) waiting.push({ id: row.id, state: 'waiting', startedAt: Number(row.startedAt), deadlineAt: Number(row.deadlineAt) });
    }
    return { version: 1, observedAt: Number(raw.observedAt), ownerPid: Number(raw.ownerPid), active: list(raw.active), queued: list(raw.queued), recent: list(raw.recent), waiting };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function findJob(stateDirectory: string, idInput: unknown): Promise<{ directory: string; status: JobStatus } | undefined> {
  const id = parseJobId(idInput), sessions = join(stateDirectory, 'sessions');
  let names;
  try { names = await readdir(sessions, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const item of names.slice(0, 100)) {
    if (!item.isDirectory() || item.isSymbolicLink() || !sessionPattern.test(item.name)) continue;
    try {
      const directory = join(sessions, item.name, 'jobs', id), status = statusProjection(await privateJSON(join(directory, 'receipt.json'), 8192));
      if (status) return { directory, status };
    } catch { /* Unknown or unsafe jobs never become executable. */ }
  }
}
export async function readJobResult(stateDirectory: string, id: unknown): Promise<JobResult> {
  const found = await findJob(stateDirectory, id); if (!found) throw new Error('Unknown Grunt job.');
  try { return { ...safeExecution(await privateJSON(join(found.directory, 'result.json'))), ...found.status }; }
  catch { return { ...found.status }; }
}
export async function requestJobCancel(stateDirectory: string, id: unknown) {
  const found = await findJob(stateDirectory, id); if (!found) throw new Error('Unknown Grunt job.');
  if (['queued', 'running'].includes(found.status.state)) await writeFile(join(found.directory, 'cancel.request'), 'cancel\n', { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  return { id: found.status.id, state: found.status.state, cancellationRequested: ['queued', 'running'].includes(found.status.state) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--execute-job') {
  void executeHelper(process.argv[3] ?? '').catch(() => { process.exitCode = 1; });
}
