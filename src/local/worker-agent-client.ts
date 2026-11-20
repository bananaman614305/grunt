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
import { workerSnapshotTransport } from './worker-transport.js';

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
/** Tool messages summarize retained edits; full file contents belong in explicit artifact inspection, not model history. */
export function workerResultView(result: WorkerResult) {
  const text = (value: string, bytes: number) => {
    if (Buffer.byteLength(JSON.stringify(value)) <= bytes) return value;
    let low = 0, high = value.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(value.slice(0, middle) + '…')) <= bytes) low = middle; else high = middle - 1; }
    return value.slice(0, low) + '…';
  };
  const { artifact, ...base } = result;
  const bounded = result.ok ? { ...base, text: text(result.text, 8192) } : base;
  if (!artifact) return bounded;
  const files = [];
  let bytes = 0;
  for (const file of artifact.files) {
    const summary = { path: file.path, beforeSha256: file.beforeSha256, afterSha256: file.afterSha256,
      ...(file.deleted ? { deleted: true } : {}), ...(file.binary ? { binary: true } : {}) };
    const size = Buffer.byteLength(JSON.stringify(summary));
    if (files.length >= 128 || bytes + size > 12288) break;
    files.push(summary); bytes += size;
  }
  return { ...bounded, artifact: { id: artifact.id, complete: artifact.complete, truncated: artifact.truncated,
    view: 'summary' as const, fileCount: artifact.files.length, files, omittedFiles: artifact.files.length - files.length,
    ...(artifact.summary ? { summary: text(artifact.summary, 2048) } : {}),
    inspect: `usegrunt workers artifact ${result.id ?? '<job-id>'} --project <current-project>`,
    integration: 'Review the full retained artifact and use the approved workers apply command; discard only after integration or deliberate abandonment.' } };
}
class InvalidWorkerScope extends Error {}
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
  private async json(path: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal; maxBodyBytes?: number } = {}): Promise<unknown> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body && Buffer.byteLength(body) > (options.maxBodyBytes ?? 8 * 1024 * 1024)) throw new Error('Worker request is too large.');
    const signal = options.signal ?? AbortSignal.timeout(10000);
    signal.throwIfAborted();
    const response = await this.fetcher(`http://127.0.0.1:${this.port}/v1/workers${path}`, { redirect: 'error', signal, method: options.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, ...(body ? { body } : {}) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty Grunt worker response');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxResponse) throw new Error('Worker response is too large.'); chunks.push(value); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = record(payload);
      if (response.status === 403 && row.ok === false && row.code === 'invalid_scope' && Object.keys(row).every(key => key === 'ok' || key === 'code')) throw new InvalidWorkerScope('The daemon no longer recognizes this project authorization.');
      if (!response.ok) {
        if (path === '/run') {
          const result = resultOf(payload);
          const status = { invalid_task: 400, busy: 429, cancelled: 409, timeout: 504, quota: 429, unavailable: 503 };
          if (!result.ok && status[result.code] === response.status) return result;
        }
        throw new Error(`Grunt worker request failed (${response.status}).`);
      }
      return payload;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async scopedJson(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; maxBodyBytes?: number } = {}) {
    const original = await this.scope();
    try { return await this.json(path, { ...options, token: original.token }); }
    catch (error) {
      // Only this explicit pre-admission rejection proves that no job was accepted.
      // Network errors, timeouts and structured job failures must never replay work.
      if (!(error instanceof InvalidWorkerScope) || this.closed || options.signal?.aborted) throw error;
      const cached = this.lease, lease = await cached?.catch(() => undefined);
      if (this.lease === cached && lease?.token === original.token) this.lease = undefined;
      const renewed = await this.scope();
      return this.json(path, { ...options, token: renewed.token });
    }
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
    const transport = workerSnapshotTransport(capability.snapshotTransport);
    const initialSnapshot = capability.initialSnapshotRequired ? await captureWorkerInitialSnapshot(scope.root, { maxSnapshotBytes: transport.maxSnapshotBytes, maxFileBytes: transport.maxFileBytes }, signal) : undefined;
    // Text escaping/base64 plus task metadata can exceed the wire bound even
    // when decoded files fit. Reject the whole batch before any task is sent.
    for (const task of tasks) if (Buffer.byteLength(JSON.stringify({ ...task, ...(initialSnapshot ? { initialSnapshot } : {}) })) > transport.maxRequestBytes) throw new Error('Complete worker snapshot exceeds the request transport limit; no tasks were submitted.');
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
      const deadline = AbortSignal.timeout(330000);
      try { return resultOf(await this.scopedJson('/run', { method: 'POST', body: { ...task, ...(initialSnapshot ? { initialSnapshot } : {}) }, maxBodyBytes: transport.maxRequestBytes, signal: AbortSignal.any([batch.controller.signal, deadline]) })); }
      catch { return { ok: false as const, code: batch.controller.signal.aborted ? 'cancelled' as const : deadline.aborted ? 'timeout' as const : 'unavailable' as const }; }
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
    return { batchId, state: batch.results ? 'completed' as const : 'running' as const, ...(batch.results ? { results: batch.results.map(workerResultView) } : {}) };
  }
  cancel(input: unknown) {
    const batchId = batchIdOf(input), batch = this.batches.get(batchId);
    if (!batch) throw new Error('Unknown scoped worker batch.');
    batch.controller.abort();
    return { batchId, state: 'cancelled' as const, artifactsRetained: true };
  }
  async retained() { return this.scopedJson('/retained'); }
  async artifact(id: string) {
    if (!uuid.test(id)) throw new Error('Provide a worker job UUID.');
    const payload = record(await this.scopedJson(`/artifacts/${id}`));
    const ownedPaths = payload.ownedPaths;
    if (!Array.isArray(ownedPaths) || !ownedPaths.length || ownedPaths.length > 32 || ownedPaths.some(path => typeof path !== 'string')) throw new Error('Missing original worker ownership; update Grunt before integrating.');
    return { artifact: artifactOf(payload.artifact), ownedPaths: ownedPaths as string[] };
  }
  async discard(id: string) {
    if (!uuid.test(id)) throw new Error('Provide a worker job UUID.');
    return this.scopedJson(`/artifacts/${id}/discard`, { method: 'POST', body: {} });
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
