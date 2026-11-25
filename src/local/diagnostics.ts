import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client, InValue } from '@libsql/client';
import { diagnosticMetricSchema, pruneDiagnosticMetrics, readDiagnosticMetrics, recordDiagnosticMetrics } from './diagnostic-metrics.js';
export type { DiagnosticMetrics, DiagnosticMetricBucket } from './diagnostic-metrics.js';

export const diagnosticTypes = ['request.start', 'request.finish', 'attempt.start', 'attempt.finish', 'route.selection', 'route.skip', 'transport.finish', 'work.start', 'work.finish', 'release.marker'] as const;
export const diagnosticStages = ['task', 'queue', 'setup', 'tool', 'verification', 'collection', 'capture'] as const;
export const diagnosticWorkDispositions = ['fresh', 'reused', 'deduplicated'] as const;
export const diagnosticKinds = ['user', 'setup', 'maintenance', 'diagnostic'] as const;
export const diagnosticReasons = ['not_listed', 'pending_setup', 'cooldown', 'tools_unsupported', 'input_unsupported', 'context_not_approved', 'unavailable', 'sticky', 'weighted', 'explicit', 'fallback', 'local'] as const;
export const diagnosticErrors = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'] as const;
export const diagnosticEndpoints = ['chat.completions', 'models', 'account', 'local.opencode', 'cli'] as const;
export const diagnosticNetworks = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'] as const;
export const diagnosticFailureReasons = [
  'request_body', 'request_tools', 'request_tool_schema', 'request_size',
  'response_body', 'response_json', 'response_choices', 'response_content', 'response_tools',
  'completion_model', 'completion_billing', 'completion_usage', 'completion_attestation', 'completion_protocol',
  'stream_read', 'stream_format', 'stream_incomplete', 'stream_cleanup',
  'turn_limit', 'token_limit', 'price_limit', 'deadline', 'terminated', 'length', 'refusal'
] as const;
export interface SafeDiagnosticMetadata {
  httpStatus?: number; transport?: 'http' | 'cli'; httpMethod?: 'GET' | 'POST';
  endpointLabel?: typeof diagnosticEndpoints[number]; networkCode?: typeof diagnosticNetworks[number]; exitCode?: number;
  failureReason?: typeof diagnosticFailureReasons[number];
}
export interface DiagnosticEvent extends SafeDiagnosticMetadata {
  version: 1; id: string; at: number; type: typeof diagnosticTypes[number]; requestId: string;
  kind: typeof diagnosticKinds[number]; seq?: number; attemptId?: string; source?: string; model?: string;
  outcome?: 'passed' | 'failed' | 'cancelled' | 'skipped'; durationMs?: number;
  errorCode?: typeof diagnosticErrors[number]; retryAfterSeconds?: number; inputTokens?: number; outputTokens?: number; free?: boolean;
  reason?: typeof diagnosticReasons[number];
  actor?: 'client' | 'worker'; workerId?: string;
  stage?: typeof diagnosticStages[number]; parentId?: string; runtimeVersion?: string;
  workDisposition?: typeof diagnosticWorkDispositions[number];
}
export type StoredDiagnosticEvent = DiagnosticEvent & { seq: number };
export interface DiagnosticContext { requestId: string; kind: typeof diagnosticKinds[number]; attemptId?: string; sink?: DiagnosticsStore; requestRecorded?: boolean; local?: boolean; errorCode?: DiagnosticEvent['errorCode']; actor?: DiagnosticEvent['actor']; workerId?: string }
const context = new AsyncLocalStorage<DiagnosticContext>();
export const currentDiagnosticContext = () => context.getStore();
export const withDiagnosticContext = <T>(value: DiagnosticContext, fn: () => T): T => context.run(value, fn);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const publicModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/;
const runtimeVersion = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9][a-zA-Z0-9.-]{0,39})?$/;
const secret = /(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{12,}|AKIA[a-zA-Z0-9]{12,}|vault:|bearer|https?:|[?@\\\s])/i;
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const member = <T extends string>(values: readonly T[], n: unknown): n is T => typeof n === 'string' && values.includes(n as T);
const object = (n: unknown): Record<string, unknown> | undefined => n && typeof n === 'object' && !Array.isArray(n) ? n as Record<string, unknown> : undefined;

/** Construct an allowlisted projection. Never serialize request/error objects. */
export function sanitizeDiagnosticEvent(input: unknown): DiagnosticEvent | null {
  const v = object(input);
  if (!v || v.version !== 1 || typeof v.id !== 'string' || !uuid.test(v.id) || !integer(v.at) || v.at > 8640000000000000
    || typeof v.requestId !== 'string' || !uuid.test(v.requestId) || !member(diagnosticTypes, v.type) || !member(diagnosticKinds, v.kind)) return null;
  const result: DiagnosticEvent = { version: 1, id: v.id, at: v.at, type: v.type, requestId: v.requestId, kind: v.kind };
  if (member(['client', 'worker'] as const, v.actor)) result.actor = v.actor;
  if (result.actor === 'worker' && typeof v.workerId === 'string' && uuid.test(v.workerId)) result.workerId = v.workerId;
  if (integer(v.seq) && v.seq > 0) result.seq = v.seq;
  if (typeof v.attemptId === 'string' && uuid.test(v.attemptId)) result.attemptId = v.attemptId;
  if (typeof v.parentId === 'string' && uuid.test(v.parentId)) result.parentId = v.parentId;
  if (typeof v.runtimeVersion === 'string' && runtimeVersion.test(v.runtimeVersion)) result.runtimeVersion = v.runtimeVersion;
  if (member(diagnosticStages, v.stage)) result.stage = v.stage;
  if (member(diagnosticWorkDispositions, v.workDisposition)) result.workDisposition = v.workDisposition;
  if (typeof v.source === 'string' && identifier.test(v.source) && !secret.test(v.source)) result.source = v.source;
  if (typeof v.model === 'string' && publicModel.test(v.model) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v.model) && !secret.test(v.model)) result.model = v.model;
  if (member(['passed', 'failed', 'cancelled', 'skipped'] as const, v.outcome)) result.outcome = v.outcome;
  if (member(diagnosticErrors, v.errorCode)) result.errorCode = v.errorCode;
  if (member(diagnosticReasons, v.reason)) result.reason = v.reason;
  Object.assign(result, sanitizeSafeDiagnosticMetadata(v));
  if (typeof v.free === 'boolean') result.free = v.free;
  for (const field of ['inputTokens', 'outputTokens'] as const) if (integer(v[field])) result[field] = v[field];
  for (const field of ['durationMs', 'retryAfterSeconds'] as const) if (finite(v[field])) result[field] = v[field];
  return result;
}

export function sanitizeSafeDiagnosticMetadata(input: unknown): SafeDiagnosticMetadata {
  const value = object(input), result: SafeDiagnosticMetadata = {};
  if (!value) return result;
  if (member(['http', 'cli'] as const, value.transport)) result.transport = value.transport;
  if (member(['GET', 'POST'] as const, value.httpMethod)) result.httpMethod = value.httpMethod;
  if (member(diagnosticEndpoints, value.endpointLabel)) result.endpointLabel = value.endpointLabel;
  if (member(diagnosticNetworks, value.networkCode)) result.networkCode = value.networkCode;
  if (integer(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if (Number.isInteger(value.exitCode) && Number(value.exitCode) >= -255 && Number(value.exitCode) <= 255) result.exitCode = Number(value.exitCode);
  if (member(diagnosticFailureReasons, value.failureReason)) result.failureReason = value.failureReason;
  return result;
}

export function recordTransport(input: SafeDiagnosticMetadata & { source: string; durationMs?: number; outcome?: DiagnosticEvent['outcome']; errorCode?: DiagnosticEvent['errorCode']; retryAfterSeconds?: number }) {
  const current = currentDiagnosticContext();
  if (!current?.sink) return;
  try { current.sink.record({ ...sanitizeSafeDiagnosticMetadata(input), version: 1, id: randomUUID(), at: Date.now(), type: 'transport.finish',
    requestId: current.requestId, kind: current.kind, source: input.source, ...(current.attemptId ? { attemptId: current.attemptId } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }), ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}), ...(input.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: input.retryAfterSeconds }) }); }
  catch { /* Observation cannot alter an HTTP or CLI operation. */ }
}
/** Observe metadata only; the fetch input and payload never enter diagnostics. */
export function diagnosticFetch(fetcher: typeof fetch, source: string, endpointLabel: SafeDiagnosticMetadata['endpointLabel']): typeof fetch {
  return async (input, init) => {
    const started = performance.now(), rawMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const method = rawMethod.toUpperCase();
    const base: SafeDiagnosticMetadata & { source: string } = { source, transport: 'http', ...(method === 'GET' || method === 'POST' ? { httpMethod: method } : {}), ...(endpointLabel ? { endpointLabel } : {}) };
    try {
      const response = await fetcher(input, init), value = response.headers.get('retry-after');
      const retry = value === null ? NaN : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
      recordTransport({ ...base, httpStatus: response.status, durationMs: Math.max(0, performance.now() - started), outcome: response.ok ? 'passed' : 'failed',
        ...(!response.ok ? { errorCode: response.status === 401 ? 'logged_out' : response.status === 403 ? 'refused' : [402, 429].includes(response.status) ? 'quota' : 'upstream' } as const : {}),
        ...(Number.isFinite(retry) ? { retryAfterSeconds: Math.max(0, retry) } : {}) });
      return response;
    } catch (error) {
      const value = object(error), cause = object(value?.cause), code = value?.code ?? cause?.code;
      recordTransport({ ...base, durationMs: Math.max(0, performance.now() - started), outcome: 'failed', errorCode: code === 'ETIMEDOUT' ? 'timeout' : 'upstream', ...(member(diagnosticNetworks, code) ? { networkCode: code } : {}) });
      throw error;
    }
  };
}

export interface DiagnosticHealth { enabled: true; available: boolean; queued: number; droppedEvents: number; lastWriteAt?: number; error?: 'storage_unavailable' | 'write_failed' | 'queue_full' }
export interface DiagnosticListOptions { after?: string; limit?: number; source?: string; requestId?: string; outcome?: DiagnosticEvent['outcome'] }
export interface DiagnosticList { events: StoredDiagnosticEvent[]; nextCursor: string | null; streamId: string | null }
export interface DiagnosticAttemptSummary { total: number; succeeded: number; failed: number; cancelled: number; inputTokens: number; outputTokens: number; unknownInput: number; unknownOutput: number }
export interface DiagnosticSummary {
  streamId: string | null;
  window: { since: number; until: number };
  requests: { total: number; succeeded: number; failed: number; cancelled: number };
  attempts: DiagnosticAttemptSummary;
  providers: (DiagnosticAttemptSummary & { source: string })[];
  health: DiagnosticHealth;
}
// Explicit SQLite transactions yield between statements. Serialize sibling stores in
// this process to avoid blocking the event loop on each other's write locks.
const diagnosticWriters = new Map<string, Promise<void>>();
function serializeDiagnosticWriter(key: string, write: () => Promise<void>) {
  const pending = (diagnosticWriters.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  diagnosticWriters.set(key, pending);
  void pending.finally(() => { if (diagnosticWriters.get(key) === pending) diagnosticWriters.delete(key); }).catch(() => {});
  return pending;
}
const attemptSummary = (): DiagnosticAttemptSummary => ({ total: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, unknownInput: 0, unknownOutput: 0 });

export class DiagnosticsStore {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private droppedEvents = 0;
  private lastWriteAt: number | undefined;
  private error: DiagnosticHealth['error'];
  private closed = false;
  private pending: DiagnosticEvent[] = [];
  private pendingLoss = 0;
  private draining = false;
  private constructor(private db: Client | undefined, private options: { maxEvents: number; maxAgeMs: number; now: () => number; runtimeVersion?: string }, private streamId: string | null = null, private writerKey?: string) {
    if (!db) this.error = 'storage_unavailable';
  }
  static async open(options: { directory: string; maxEvents?: number; maxAgeMs?: number; now?: () => number; runtimeVersion?: string }) {
    if (options.runtimeVersion !== undefined && !runtimeVersion.test(options.runtimeVersion)) throw new Error('Invalid runtime version');
    const limits = { maxEvents: Math.min(100000, Math.max(100, options.maxEvents ?? 50000)), maxAgeMs: Math.min(90 * 86400000, Math.max(60000, options.maxAgeMs ?? 30 * 86400000)), now: options.now ?? Date.now, ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}) };
    let db: Client | undefined;
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(options.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700 || await realpath(options.directory) !== resolve(options.directory)) throw new Error('private_storage_required');
      const path = join(resolve(options.directory), 'diagnostics.db');
      try { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 256 * 1024 * 1024) throw new Error('private_storage_required');
      for (const suffix of ['-wal', '-shm']) {
        try { const sidecar = await lstat(path + suffix); if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.uid !== process.getuid?.() || (sidecar.mode & 0o777) !== 0o600) throw new Error('private_storage_required'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      // Passive runtime imports and isolated provider probes do not enable
      // diagnostics storage or need the SQLite driver's runtime dependencies.
      const { createClient } = await import('@libsql/client');
      db = createClient({ url: pathToFileURL(path).href });
      // Sibling Grunt processes share this stream. Brief writer contention
      // must not permanently disable the process that opens the store second.
      let streamId: string | null = null;
      await serializeDiagnosticWriter(path, async () => {
        await db!.execute('PRAGMA busy_timeout=1000');
        await db!.executeMultiple(`PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS diagnostic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS diagnostic_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at INTEGER NOT NULL, request_id TEXT NOT NULL, source TEXT, type TEXT NOT NULL, outcome TEXT, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS diagnostic_events_request ON diagnostic_events(request_id,seq);
          CREATE INDEX IF NOT EXISTS diagnostic_events_time ON diagnostic_events(at);
          CREATE INDEX IF NOT EXISTS diagnostic_events_source ON diagnostic_events(source,seq);
          ${diagnosticMetricSchema}`);
        await chmod(path, 0o600);
        await db!.execute({ sql: 'INSERT OR IGNORE INTO diagnostic_meta(key,value) VALUES(?,?)', args: ['stream_id', randomUUID()] });
        streamId = String((await db!.execute("SELECT value FROM diagnostic_meta WHERE key='stream_id'")).rows[0]?.value);
        if (!uuid.test(streamId)) throw new Error('invalid_diagnostic_identity');
        await db!.execute({ sql: 'INSERT OR IGNORE INTO diagnostic_metric_meta(key,value) VALUES(?,?)', args: ['started_at', String(limits.now())] });
      });
      const value = new DiagnosticsStore(db, limits, streamId, path);
      if (limits.runtimeVersion) value.record({ version: 1, id: randomUUID(), requestId: randomUUID(), at: limits.now(), type: 'release.marker', kind: 'diagnostic' });
      return value;
    } catch { db?.close(); return new DiagnosticsStore(undefined, limits); }
  }
  health(): DiagnosticHealth {
    return { enabled: true, available: !!this.db && !this.error && !this.closed, queued: this.queued, droppedEvents: this.droppedEvents,
      ...(this.lastWriteAt === undefined ? {} : { lastWriteAt: this.lastWriteAt }), ...(this.error ? { error: this.error } : {}) };
  }
  record(input: DiagnosticEvent) {
    const current = currentDiagnosticContext();
    // Context is trusted local routing metadata. Only the matching request may
    // inherit it; unrelated asynchronous writes keep their own attribution.
    const actor = current?.requestId === input.requestId && current.actor !== undefined
      ? { actor: current.actor, workerId: current.actor === 'worker' ? current.workerId : undefined } : {};
    // Version identifies this trusted runtime, never a model-supplied event field.
    const event = sanitizeDiagnosticEvent({ ...input, ...actor, runtimeVersion: this.options.runtimeVersion });
    if (!event || !this.db || this.closed) { this.recordDropped(); return; }
    if (this.queued >= 1000) { this.recordDropped(); this.error = 'queue_full'; return; }
    this.queued++; this.pending.push(event); this.schedule();
  }
  /** Record observation loss without manufacturing an invalid diagnostic event. */
  recordDropped(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new Error('Invalid diagnostic loss count');
    this.droppedEvents += count; this.pendingLoss += count;
    if (count && this.db && !this.closed) this.schedule();
  }
  private schedule() {
    if (!this.draining) {
      this.draining = true;
      this.queue = serializeDiagnosticWriter(this.writerKey!, () => this.drain());
    }
  }
  private async drain() {
    try {
      while (this.pending.length || this.pendingLoss) {
        const batch = this.pending.splice(0, 64), loss = this.pendingLoss; this.pendingLoss = 0;
        try {
          const tx = await this.db!.transaction('write');
          try {
            if (loss) await tx.execute({ sql: "INSERT INTO diagnostic_metric_meta(key,value) VALUES('dropped_events',?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+CAST(excluded.value AS INTEGER)", args: [String(loss)] });
            const accepted: DiagnosticEvent[] = [];
            for (const event of batch) {
              if (event.type === 'release.marker' && event.runtimeVersion) {
                const previous = (await tx.execute("SELECT value FROM diagnostic_metric_meta WHERE key='runtime_version'")).rows[0]?.value;
                if (previous === event.runtimeVersion) continue;
                await tx.execute({ sql: "INSERT INTO diagnostic_metric_meta(key,value) VALUES('runtime_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [event.runtimeVersion] });
              }
              accepted.push(event);
            }
            if (accepted.length) {
              const inserted = await tx.execute({ sql: 'INSERT OR IGNORE INTO diagnostic_events(id,at,request_id,source,type,outcome,data) VALUES ' + accepted.map(() => '(?,?,?,?,?,?,?)').join(',') + ' RETURNING id',
                args: accepted.flatMap(event => [event.id, event.at, event.requestId, event.source ?? null, event.type, event.outcome ?? null, JSON.stringify(event)]) });
              const ids = new Set(inserted.rows.map(row => String(row.id)));
              const fresh = accepted.filter(event => ids.delete(event.id));
              await recordDiagnosticMetrics(tx, fresh, this.options.now());
            }
            await tx.execute({ sql: 'DELETE FROM diagnostic_events WHERE at<? OR seq IN (SELECT seq FROM diagnostic_events ORDER BY seq DESC LIMIT -1 OFFSET ?)', args: [this.options.now() - this.options.maxAgeMs, this.options.maxEvents] });
            await pruneDiagnosticMetrics(tx, this.options.now());
            await tx.commit();
            this.lastWriteAt = this.options.now(); this.error = undefined;
          } catch (error) { await tx.rollback(); throw error; }
          finally { tx.close(); }
        } catch {
          this.error = 'write_failed';
          const discarded = this.pending.splice(0).length; this.queued -= discarded;
          this.droppedEvents += batch.length + discarded; this.pendingLoss += loss + batch.length + discarded;
          break; // Keep the loss count for the next successful write; never spin on a broken database.
        }
        finally { this.queued -= batch.length; }
      }
    } finally { this.draining = false; }
  }
  async flush() {
    if (this.pendingLoss && !this.draining && this.db && !this.closed) this.schedule();
    await this.queue; if (this.writerKey) await diagnosticWriters.get(this.writerKey);
  }
  private async rows(sql: string, args: InValue[]): Promise<StoredDiagnosticEvent[]> {
    await this.flush();
    if (!this.db || this.closed) return [];
    try {
      return (await this.db.execute({ sql, args })).rows.flatMap(row => {
        try { const event = sanitizeDiagnosticEvent(JSON.parse(String(row.data))); const seq = Number(row.seq); return event && integer(seq) && seq > 0 ? [{ ...event, seq }] : []; }
        catch { return []; }
      });
    } catch { this.error = 'write_failed'; return []; }
  }
  async list(options: DiagnosticListOptions = {}): Promise<DiagnosticList> {
    const after = options.after === undefined ? 0 : /^\d{1,16}$/.test(options.after) ? Number(options.after) : NaN;
    if (!integer(after) || (options.source !== undefined && !identifier.test(options.source)) || (options.requestId !== undefined && !uuid.test(options.requestId))) throw new Error('Invalid diagnostic filter');
    const limit = options.limit ?? 200;
    if (!integer(limit) || limit < 1 || limit > 500 || (options.outcome !== undefined && !member(['passed', 'failed', 'cancelled', 'skipped'] as const, options.outcome))) throw new Error('Invalid diagnostic filter');
    const where = ['seq>?', 'at>=?'], args: InValue[] = [after, this.options.now() - this.options.maxAgeMs];
    for (const [key, value] of [['source', options.source], ['request_id', options.requestId], ['outcome', options.outcome]] as const) if (value !== undefined) { where.push(key + '=?'); args.push(value); }
    args.push(limit);
    const events = await this.rows('SELECT seq,data FROM diagnostic_events WHERE ' + where.join(' AND ') + ' ORDER BY seq ASC LIMIT ?', args);
    return { events, nextCursor: events.length ? String(events.at(-1)!.seq) : options.after ?? null, streamId: this.streamId };
  }
  async trace(requestId: string) { return this.list({ requestId, limit: 500 }); }
  async metrics(options: { since?: number; until?: number } = {}) {
    await this.flush();
    const attachHealth = (result: Awaited<ReturnType<typeof readDiagnosticMetrics>>) => {
      result.ingestionHealth = this.health(); result.coverage.droppedEvents += this.pendingLoss;
      result.coverage.available = result.coverage.available && result.ingestionHealth.available;
      return result;
    };
    try { return attachHealth(await readDiagnosticMetrics(this.closed ? undefined : this.db, this.streamId, options, this.options.now())); }
    catch (error) {
      if (error instanceof Error && error.message === 'Invalid diagnostic metrics window') throw error;
      this.error = 'write_failed'; return attachHealth(await readDiagnosticMetrics(undefined, this.streamId, options, this.options.now()));
    }
  }
  async summary(options: { since?: number } = {}): Promise<DiagnosticSummary> {
    const until = this.options.now(), since = options.since ?? until - 86400000;
    if (!finite(since) || since > until) throw new Error('Invalid diagnostic time');
    const rows = await this.rows('SELECT seq,data FROM diagnostic_events WHERE at>=? AND at<=? ORDER BY seq ASC LIMIT ?', [Math.max(since, until - this.options.maxAgeMs), until, this.options.maxEvents]);
    const result: DiagnosticSummary = { streamId: this.streamId, window: { since, until }, requests: { total: 0, succeeded: 0, failed: 0, cancelled: 0 }, attempts: attemptSummary(), providers: [], health: this.health() };
    const providers = new Map<string, DiagnosticAttemptSummary>();
    for (const row of rows) {
      if (row.type === 'request.finish') { result.requests.total++; if (row.outcome === 'passed') result.requests.succeeded++; else if (row.outcome === 'cancelled') result.requests.cancelled++; else result.requests.failed++; }
      if (row.type !== 'attempt.finish') continue;
      const source = row.source ?? 'unknown'; let provider = providers.get(source); if (!provider) { provider = attemptSummary(); providers.set(source, provider); }
      for (const summary of [result.attempts, provider]) {
        summary.total++; if (row.outcome === 'passed') summary.succeeded++; else if (row.outcome === 'cancelled') summary.cancelled++; else summary.failed++;
        if (row.inputTokens === undefined) summary.unknownInput++; else summary.inputTokens += row.inputTokens;
        if (row.outputTokens === undefined) summary.unknownOutput++; else summary.outputTokens += row.outputTokens;
      }
    }
    result.providers = [...providers].map(([source, stats]) => ({ source, ...stats }));
    return result;
  }
  async close() {
    if (this.closed) return;
    await this.flush();
    if (this.pendingLoss) await this.flush(); // One loss-only persistence attempt, never an unbounded retry.
    this.closed = true; this.db?.close();
  }
}
