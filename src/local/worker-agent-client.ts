import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { parseWorkerTask, workerActivities } from './worker-pool.js';
import type { WorkerAgentFailureReason } from './worker-agent.js';
import type { WorkerArtifact, WorkerResult, WorkerTask } from './worker-pool.js';
import { captureWorkerInitialSnapshot } from './worker-workspace.js';
import { applyWorkerArtifact } from './worker-integration.js';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reasons = new Set(['invalid_workspace', 'agent_unavailable', 'unsupported_sandbox', 'workspace_failed', 'invalid_completion', 'turn_limit', 'tool_limit', 'output_limit', 'context_limit']);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxResponse = 4 * 1024 * 1024;
const batchIdOf = (input: unknown) => {
  const value = record(input);
  if (Object.keys(value).length !== 1 || typeof value.batchId !== 'string' || !uuid.test(value.batchId)) throw new Error('Provide the batchId returned by grunt_spawn.');
  return value.batchId;
};
function tasksOf(input: unknown): WorkerTask[] {
  const value = record(input);
  if (Object.keys(value).length !== 1 || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 2) throw new Error('Provide one or two scoped worker tasks.');
  return value.tasks.map(task => {
    const row = record(task);
    if (Object.keys(row).some(key => !['task', 'context', 'activity', 'ownedPaths'].includes(key))) throw new Error('Worker tasks cannot select a project or runtime.');
    const parsed = parseWorkerTask({ ...row, mode: 'agent' });
    if (!parsed) throw new Error('Each worker needs a task and one to 32 relative ownedPaths.');
    return parsed;
  });
}
function artifactOf(value: unknown): WorkerArtifact {
  const row = record(value);
  if (typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.complete !== 'boolean' || typeof row.truncated !== 'boolean' || !Array.isArray(row.files) || row.files.length > 5000) throw new Error('Invalid retained worker artifact');
  // The integration helper independently validates every path, hash and content before writing.
  for (const entry of row.files) {
    const file = record(entry);
    if (typeof file.path !== 'string' || file.path.length > 4096 || ![file.beforeSha256, file.afterSha256].every(hash => hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || file.content !== undefined && typeof file.content !== 'string' || file.binary !== undefined && typeof file.binary !== 'boolean' || file.deleted !== undefined && typeof file.deleted !== 'boolean') throw new Error('Invalid retained worker artifact');
  }
  return { id: row.id, complete: row.complete, truncated: row.truncated, files: row.files as WorkerArtifact['files'], ...(typeof row.summary === 'string' ? { summary: row.summary.slice(0, 4096) } : {}) };
}
function resultOf(value: unknown): WorkerResult {
  const row = record(value);
  if (row.ok !== true && row.ok !== false) throw new Error('Invalid Grunt worker response');
  if (row.id !== undefined && (typeof row.id !== 'string' || !uuid.test(row.id))) throw new Error('Invalid Grunt worker response');
  const artifact = row.artifact === undefined ? undefined : artifactOf(row.artifact);
  if (row.ok === true && typeof row.id === 'string' && typeof row.source === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(row.source) && typeof row.text === 'string') return { ok: true, id: row.id, source: row.source, text: row.text, ...(artifact ? { artifact } : {}) };
  if (row.ok === false && ['invalid_task', 'busy', 'cancelled', 'timeout', 'quota', 'unavailable'].includes(String(row.code))) return { ok: false, code: row.code as 'unavailable', ...(typeof row.id === 'string' ? { id: row.id } : {}), ...(typeof row.retryAfter === 'number' && Number.isSafeInteger(row.retryAfter) && row.retryAfter > 0 ? { retryAfter: row.retryAfter } : {}), ...(typeof row.reason === 'string' && reasons.has(row.reason) ? { reason: row.reason as WorkerAgentFailureReason } : {}), ...(artifact ? { artifact } : {}) };
  throw new Error('Invalid Grunt worker response');
}
interface AgentBatch { controller: AbortController; results?: WorkerResult[]; done?: Promise<void>; }
/** A trusted frontend instance binds exactly one harness-supplied project. Tokens never enter tool arguments or output. */
export class AgentWorkerBatches {
  private lease: Promise<{ token: string; root: string; expiresAt: number }> | undefined;
  private batches = new Map<string, AgentBatch>();
  private closed = false;
  private starting = 0;
  constructor(private port: number, private projectRoot: string, private fetcher = fetch) {
    if (!isAbsolute(projectRoot)) throw new Error('Agent workers require a trusted absolute project directory.');
  }
  private async json(path: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body && Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Worker request is too large.');
    const response = await this.fetcher(`http://127.0.0.1:${this.port}/v1/workers${path}`, { redirect: 'error', signal: options.signal ?? AbortSignal.timeout(10000), method: options.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, ...(body ? { body } : {}) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty Grunt worker response');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxResponse) throw new Error('Worker response is too large.'); chunks.push(value); }
      if (!response.ok) throw new Error(`Grunt worker request failed (${response.status}).`);
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private scope(): Promise<{ token: string; root: string; expiresAt: number }> {
    if (this.closed) throw new Error('This worker session is closed.');
    return (this.lease ??= this.register().catch(error => { this.lease = undefined; throw error; })).then(scope => {
      if (scope.expiresAt > Date.now() + 10000) return scope;
      this.lease = undefined; return this.scope();
    });
  }
  private async register() {
    const root = await realpath(this.projectRoot);
    const challenge = record(await this.json('/projects/challenge', { method: 'POST', body: { projectRoot: root } }));
    if (typeof challenge.challengeId !== 'string' || !uuid.test(challenge.challengeId) || typeof challenge.fileName !== 'string' || !/^\.grunt-workspace-[a-f0-9-]{36}\.proof$/.test(challenge.fileName) || typeof challenge.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(challenge.nonce)) throw new Error('Invalid project authorization challenge');
    const proof = join(root, challenge.fileName);
    const file = await open(proof, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(challenge.nonce); await file.sync();
      const lease = record(await this.json('/projects/register', { method: 'POST', body: { challengeId: challenge.challengeId } }));
      if (typeof lease.token !== 'string' || !/^[a-f0-9]{64}$/.test(lease.token)) throw new Error('Invalid project authorization lease');
      if (typeof lease.expiresAt !== 'number' || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now()) throw new Error('Invalid project authorization expiry');
      return { root, token: lease.token, expiresAt: lease.expiresAt };
    } finally {
      // Only remove our original proof inode; never delete a replacement file.
      const original = await file.stat();
      await file.close();
      const current = await open(proof, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (current) { const info = await current.stat(); await current.close(); if (info.dev === original.dev && info.ino === original.ino) await unlink(proof).catch(() => {}); }
    }
  }
  async start(input: unknown, signal = new AbortController().signal) {
    const tasks = tasksOf(input);
    if (this.starting + this.batches.size >= 8 && ![...this.batches.values()].some(batch => batch.results)) throw new Error('Collect or cancel existing worker batches before starting more.');
    this.starting++;
    try {
    if (this.batches.size >= 8) {
      const completed = [...this.batches].find(([, batch]) => batch.results);
      if (!completed) throw new Error('Collect or cancel existing worker batches before starting more.');
      this.batches.delete(completed[0]);
    }
    signal.throwIfAborted();
    const scope = await this.scope(); signal.throwIfAborted();
    const capability = record(await this.json('/capabilities', { signal }));
    if (typeof capability.initialSnapshotRequired !== 'boolean') throw new Error('Update the Grunt daemon to enable scoped workers.');
    const initialSnapshot = capability.initialSnapshotRequired ? await captureWorkerInitialSnapshot(scope.root, { maxSnapshotBytes: 4 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024 }, signal) : undefined;
    signal.throwIfAborted();
    if (this.closed) throw new Error('This worker session is closed.');
    if (this.batches.size >= 8) {
      const completed = [...this.batches].find(([, batch]) => batch.results);
      if (!completed) throw new Error('Too many active scoped worker batches.');
      this.batches.delete(completed[0]);
    }
    const batchId = randomUUID(), batch: AgentBatch = { controller: new AbortController() };
    this.batches.set(batchId, batch);
    batch.done = Promise.all(tasks.map(async task => {
      try { return resultOf(await this.json('/run', { method: 'POST', body: { ...task, ...(initialSnapshot ? { initialSnapshot } : {}) }, token: scope.token, signal: AbortSignal.any([batch.controller.signal, AbortSignal.timeout(330000)]) })); }
      catch { return { ok: false as const, code: batch.controller.signal.aborted ? 'cancelled' as const : 'unavailable' as const }; }
    })).then(results => { batch.results = results; });
    return { batchId, state: 'running' as const };
    } finally { this.starting--; }
  }
  async wait(input: unknown, signal: AbortSignal) {
    const batch = this.batches.get(batchIdOf(input));
    if (!batch) throw new Error('Unknown scoped worker batch.');
    signal.throwIfAborted();
    let abort!: () => void;
    try { await Promise.race([batch.done, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); })]); }
    finally { signal.removeEventListener('abort', abort); }
    signal.throwIfAborted();
    return this.result(input);
  }
  has(input: unknown) { return this.batches.has(batchIdOf(input)); }
  result(input: unknown) {
    const batchId = batchIdOf(input), batch = this.batches.get(batchId);
    if (!batch) throw new Error('Unknown scoped worker batch. Retained artifacts can be recovered with usegrunt workers retained --project <directory>.');
    return { batchId, state: batch.results ? 'completed' as const : 'running' as const, ...(batch.results ? { results: batch.results } : {}) };
  }
  cancel(input: unknown) {
    const batchId = batchIdOf(input), batch = this.batches.get(batchId);
    if (!batch) throw new Error('Unknown scoped worker batch.');
    batch.controller.abort();
    return { batchId, state: 'cancelled' as const, artifactsRetained: true };
  }
  async retained() { const scope = await this.scope(); return this.json('/retained', { token: scope.token }); }
  async artifact(id: string) {
    if (!uuid.test(id)) throw new Error('Provide a worker job UUID.');
    const scope = await this.scope();
    const payload = record(await this.json(`/artifacts/${id}`, { token: scope.token }));
    const ownedPaths = payload.ownedPaths;
    if (!Array.isArray(ownedPaths) || !ownedPaths.length || ownedPaths.length > 32 || ownedPaths.some(path => typeof path !== 'string')) throw new Error('Missing original worker ownership; update Grunt before integrating.');
    return { artifact: artifactOf(payload.artifact), ownedPaths: ownedPaths as string[] };
  }
  async discard(id: string) {
    if (!uuid.test(id)) throw new Error('Provide a worker job UUID.');
    const scope = await this.scope(); return this.json(`/artifacts/${id}/discard`, { method: 'POST', body: {}, token: scope.token });
  }
  async apply(id: string, signal?: AbortSignal) {
    const scope = await this.scope(), retained = await this.artifact(id);
    return applyWorkerArtifact(scope.root, retained.artifact, { ownedPaths: retained.ownedPaths }, signal);
  }
  async close() {
    this.closed = true;
    for (const batch of this.batches.values()) if (!batch.results) batch.controller.abort();
    await Promise.allSettled([...this.batches.values()].map(batch => batch.done));
    const lease = await this.lease?.catch(() => undefined);
    if (lease) await this.json('/projects/revoke', { method: 'POST', body: {}, token: lease.token }).catch(() => {});
  }
}
export const gruntSpawnTool = {
  name: 'grunt_spawn', description: 'Start one or two tool-using workers in private copies of the current project. Workers use vetted free sources, edit only ownedPaths, and return reviewable artifacts. Continue independent work, then collect results. Review and apply artifacts through your normal approved shell with usegrunt workers apply. Commands may be unavailable on platforms without an isolated command sandbox.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['task', 'ownedPaths'], properties: { task: { type: 'string', minLength: 1, maxLength: 8192 }, context: { type: 'string', maxLength: 32768 }, activity: { type: 'string', enum: [...workerActivities] }, ownedPaths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } } } } } } },
  annotations: { title: 'Start scoped Grunt workers', readOnlyHint: false, destructiveHint: false, openWorldHint: true }
} satisfies Tool;
