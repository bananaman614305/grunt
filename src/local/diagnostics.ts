import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client, InValue, Transaction } from '@libsql/client';
import { diagnosticMetricSchema, pruneDiagnosticMetrics, readDiagnosticLosses, readDiagnosticMetrics, recordDiagnosticMetrics } from './diagnostic-metrics.js';
export type { DiagnosticMetrics, DiagnosticMetricBucket } from './diagnostic-metrics.js';

const detailTypes = ['request.output', 'attempt.failure', 'route.eligible', 'account.available'] as const;
const observationTypes = ['request.input', 'request.phase', 'attempt.progress', 'attempt.queue', 'attempt.dequeue', 'attempt.dispatch'] as const;
const traceDetailTypes = new Set<string>([...detailTypes, ...observationTypes]);
export const diagnosticTypes = ['request.start', 'request.finish', 'attempt.start', 'attempt.finish', 'route.selection', 'route.skip', 'transport.finish', 'work.start', 'work.finish', 'release.marker', ...detailTypes, ...observationTypes] as const;
export const diagnosticStages = ['task', 'queue', 'setup', 'tool', 'verification', 'collection', 'capture'] as const;
export const diagnosticWorkDispositions = ['fresh', 'reused', 'deduplicated'] as const;
export const diagnosticKinds = ['user', 'setup', 'maintenance', 'diagnostic'] as const;
export const diagnosticReasons = ['not_listed', 'disabled', 'retired', 'trial_in_progress', 'pending_setup', 'cooldown', 'tools_unsupported',
  'input_unsupported', 'context_not_approved', 'unavailable', 'already_attempted', 'request_refused', 'native_tools_preferred',
  'idle_route_preferred', 'weighted_draw', 'sticky_binding', 'sticky', 'weighted', 'explicit', 'fallback', 'local'] as const;
export const diagnosticErrors = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'] as const;
export const diagnosticEndpoints = ['chat.completions', 'models', 'account', 'local.opencode', 'cli'] as const;
export const diagnosticNetworks = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'] as const;
export const diagnosticFailureReasons = [
  'request_body', 'request_tools', 'request_tool_schema', 'request_size',
  'response_body', 'response_json', 'response_choices', 'response_content', 'response_empty', 'response_tools',
  'completion_model', 'completion_billing', 'completion_usage', 'completion_attestation', 'completion_protocol',
  'stream_read', 'stream_format', 'stream_incomplete', 'stream_cleanup',
  'turn_limit', 'token_limit', 'price_limit', 'deadline', 'terminated', 'length', 'refusal'
] as const;
// How a successful reply ended, as a fixed set. Any other provider value is recorded as 'other', never as text.
export const diagnosticFinishReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call', 'other'] as const;
// Exact wire values from supported protocols. Unexpected values can contain
// arbitrary provider data and are represented by the normalized 'other'.
export const providerFinishReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call', 'max_tokens',
  'end_turn', 'stop_sequence', 'tool_use', 'tool-calls', 'content-filter', 'error', 'unknown', 'other', 'model_context_window_exceeded',
  'refusal', 'eos', 'eos_token', 'cancelled', 'canceled', 'max_output_tokens'] as const;
const requestPhases = ['routing', 'checking_routes', 'preparing_handoff'] as const;
const accountSlots = ['configured', 'anonymous', 'vaulted', 'local_session', 'managed'] as const;
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
  // Content-free reply ending on a successful attempt.finish: mapped finish_reason, whether the reply held tool calls, reasoning tokens when reported.
  codingToolTurn?: boolean; dispatchedToolCallPassed?: boolean; firstOutputMs?: number;
  finishReason?: typeof diagnosticFinishReasons[number]; hadToolCalls?: boolean; reasoningTokens?: number;
  providerFinishReason?: typeof providerFinishReasons[number];
  caller?: string; endpoint?: 'chat' | 'messages' | 'responses';
  promptBytes?: number; responseBytes?: number; maxOutputTokens?: number; lastProgressAt?: number;
  phase?: typeof requestPhases[number];
  account?: typeof accountSlots[number];
  reason?: typeof diagnosticReasons[number];
  actor?: 'client' | 'worker'; workerId?: string;
  stage?: typeof diagnosticStages[number]; parentId?: string; runtimeVersion?: string;
  workDisposition?: typeof diagnosticWorkDispositions[number];
  replaySafe?: boolean;
}
export type StoredDiagnosticEvent = DiagnosticEvent & { seq: number };
export interface DiagnosticContext { toolChoiceEvidence?: { allConstrained?: boolean }; requestId: string; kind: typeof diagnosticKinds[number]; attemptId?: string; sink?: DiagnosticsStore; requestRecorded?: boolean; local?: boolean; incomplete?: boolean; responseBytes?: number; errorCode?: DiagnosticEvent['errorCode']; actor?: DiagnosticEvent['actor']; workerId?: string }
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
  if (result.type === 'attempt.failure' && typeof v.replaySafe === 'boolean') result.replaySafe = v.replaySafe;
  Object.assign(result, sanitizeSafeDiagnosticMetadata(v));
  if (typeof v.free === 'boolean') result.free = v.free;
  for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens'] as const) if (integer(v[field])) result[field] = v[field];
  if (member(diagnosticFinishReasons, v.finishReason)) result.finishReason = v.finishReason;
  if (member(providerFinishReasons, v.providerFinishReason)) result.providerFinishReason = v.providerFinishReason;
  if (member(requestPhases, v.phase)) result.phase = v.phase;
  if (member(accountSlots, v.account)) result.account = v.account;
  if (result.type === 'request.start' && typeof v.caller === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v.caller)
    && !secret.test(v.caller) && !/^(sk-|gsk-|nvapi-|xox[baprs]-|eyj)/.test(v.caller)) result.caller = v.caller;
  if (member(['chat', 'messages', 'responses'] as const, v.endpoint)) result.endpoint = v.endpoint;
  for (const field of ['promptBytes', 'responseBytes', 'maxOutputTokens'] as const) if (integer(v[field])) result[field] = v[field];
  if (integer(v.lastProgressAt) && v.lastProgressAt <= 8640000000000000) result.lastProgressAt = v.lastProgressAt;
  if (result.type === 'attempt.finish') {
    if (typeof v.dispatchedToolCallPassed === 'boolean') result.dispatchedToolCallPassed = v.dispatchedToolCallPassed;
    if (typeof v.codingToolTurn === 'boolean') result.codingToolTurn = v.codingToolTurn;
    if (finite(v.firstOutputMs)) result.firstOutputMs = v.firstOutputMs;
  }
  if (typeof v.hadToolCalls === 'boolean') result.hadToolCalls = v.hadToolCalls;
  for (const field of ['durationMs', 'retryAfterSeconds'] as const) if (finite(v[field])) result[field] = v[field];
  return result;
}

export function observeRequestPhase(phase: NonNullable<DiagnosticEvent['phase']>, source?: string) {
  const current = currentDiagnosticContext();
  current?.sink?.record({ version: 1, id: randomUUID(), at: Date.now(), type: 'request.phase', phase,
    requestId: current.requestId, kind: current.kind, ...(source ? { source } : {}) });
}

export function observeAttemptDispatch({ maxOutputTokens, constrained = false, ...details }: Pick<DiagnosticEvent, 'model' | 'account'> & { maxOutputTokens?: number | undefined; constrained?: boolean }) {
  const current = currentDiagnosticContext();
  if (!current?.sink || !current.attemptId) return;
  // A retry or model rotation can issue several inference requests for one attempt.
  if (current.toolChoiceEvidence) current.toolChoiceEvidence.allConstrained = current.toolChoiceEvidence.allConstrained !== false && constrained;
  current.sink.record({ ...details, version: 1, id: randomUUID(), at: Date.now(), type: 'attempt.dispatch',
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    requestId: current.requestId, kind: current.kind, attemptId: current.attemptId });
}

/** The existing queue owns order. Sample it when observing rather than maintaining a second queue. */
export function observeAttemptQueue(position: () => number | null) {
  const current = currentDiagnosticContext();
  if (!current?.sink || !current.attemptId) return;
  current.sink.setQueuePosition(current.requestId, current.attemptId, position);
  current.sink.record({ version: 1, id: randomUUID(), at: Date.now(), type: 'attempt.queue',
    requestId: current.requestId, kind: current.kind, attemptId: current.attemptId });
}

export function observeAttemptDequeue() {
  const current = currentDiagnosticContext();
  if (!current?.sink || !current.attemptId) return;
  current.sink.record({ version: 1, id: randomUUID(), at: Date.now(), type: 'attempt.dequeue',
    requestId: current.requestId, kind: current.kind, attemptId: current.attemptId });
}

// Record the first validated failure or an explicit replay guard at the adapter
// boundary. Untyped errors and ordinary transport observations carry no verdict.
export function recordAttemptFailure(source: string, metadata: SafeDiagnosticMetadata | undefined, replaySafe: boolean) {
  const current = currentDiagnosticContext();
  if (!current?.sink || !current.attemptId) return;
  try {
    current.sink.record({ ...sanitizeSafeDiagnosticMetadata(metadata), version: 1, id: randomUUID(), at: Date.now(),
      type: 'attempt.failure', requestId: current.requestId, kind: current.kind, attemptId: current.attemptId, source, replaySafe });
  } catch { /* Observation cannot change an adapter failure. */ }
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
export interface DiagnosticListOptions { after?: string; limit?: number; source?: string; requestId?: string; outcome?: DiagnosticEvent['outcome']; includeDetails?: boolean }
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

const evictionPriority = "CASE WHEN incident=1 THEN 2 WHEN type='route.skip' THEN 0 ELSE 1 END";
const diagnosticBatchSize = 64;
const maxInFlightRequests = 64;
const maxInFlightEvents = 64;

function isIncidentEvent(event: DiagnosticEvent) {
  return event.outcome === 'failed' || event.type === 'attempt.failure' || event.failureReason === 'length';
}

function insertDiagnosticEvents(tx: Transaction, events: DiagnosticEvent[], incident = 0) {
  return tx.execute({ sql: 'INSERT OR IGNORE INTO diagnostic_events(id,at,request_id,source,type,outcome,data,incident) VALUES '
    + events.map(() => '(?,?,?,?,?,?,?,?)').join(',') + ' RETURNING id',
    args: events.flatMap(event => [event.id, event.at, event.requestId, event.source ?? null, event.type,
      event.outcome ?? null, JSON.stringify(event), incident]) });
}

async function initializeIncidentRetention(tx: Transaction) {
  const { rows } = await tx.execute('PRAGMA table_info(diagnostic_events)');
  if (rows.some(row => row.name === 'incident')) return;
  // Backfill the existing journal without changing its cursor or metrics.
  await tx.executeMultiple(`
    ALTER TABLE diagnostic_events ADD COLUMN incident INTEGER NOT NULL DEFAULT 0;
    UPDATE diagnostic_events SET incident=1 WHERE request_id IN (
      SELECT request_id FROM diagnostic_events GROUP BY request_id
      HAVING max(outcome='failed' OR type='attempt.failure'
        OR (CASE WHEN json_valid(data) THEN json_extract(data,'$.failureReason') END)='length')
        OR sum(type='attempt.start')>1
    );
    CREATE INDEX diagnostic_events_eviction ON diagnostic_events(${evictionPriority},seq);
    CREATE INDEX diagnostic_events_incidents ON diagnostic_events(request_id) WHERE incident=1;
    CREATE TRIGGER diagnostic_events_mark_incident AFTER INSERT ON diagnostic_events
    WHEN NEW.outcome='failed' OR NEW.type='attempt.failure' OR json_extract(NEW.data,'$.failureReason')='length'
      OR EXISTS (SELECT 1 FROM diagnostic_events WHERE request_id=NEW.request_id AND incident=1)
      OR (NEW.type='attempt.start' AND EXISTS (
        SELECT 1 FROM diagnostic_events WHERE request_id=NEW.request_id AND type='attempt.start' AND seq<NEW.seq
      ))
    BEGIN
      UPDATE diagnostic_events SET incident=1 WHERE request_id=NEW.request_id AND incident=0;
    END;
  `);
}

async function pruneDiagnosticEvents(tx: Transaction, cutoff: number, maxEvents: number) {
  await tx.execute({ sql: 'DELETE FROM diagnostic_events WHERE at<?', args: [cutoff] });
  await tx.execute({ sql: `
    DELETE FROM diagnostic_events WHERE seq IN (
      SELECT seq FROM diagnostic_events ORDER BY ${evictionPriority},seq
      LIMIT max(0,(SELECT count(*) FROM diagnostic_events)-?)
    )
  `, args: [maxEvents] });
}

export class DiagnosticsStore {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private droppedEvents = 0;
  private lastWriteAt: number | undefined;
  private error: DiagnosticHealth['error'];
  private closed = false;
  private pending: DiagnosticEvent[] = [];
  private writing: DiagnosticEvent[] = [];
  private pendingLoss = 0;
  private draining = false;
  // Only requests started by this process can be live. A shared journal can
  // contain unfinished traces from other processes or an earlier daemon.
  private active = new Map<string, { events: DiagnosticEvent[]; positions: Map<string, () => number | null>; progress: Map<string, number> }>();
  // Keep the earliest committed events until the finish drains, even if
  // SQLite prunes them before a later batch reveals the request is an incident.
  private inFlight = new Map<string, DiagnosticEvent[]>();
  private constructor(private db: Client | undefined, private options: { maxEvents: number; maxAgeMs: number; now: () => number; runtimeVersion?: string }, private streamId: string | null = null, private writerKey?: string) {
    if (!db) this.error = 'storage_unavailable';
  }
  async adoptionConsentSince(): Promise<number | undefined> {
    const result = await this.db?.execute("SELECT value FROM diagnostic_meta WHERE key='adoption_since'");
    const since = Number(result?.rows[0]?.value);
    return Number.isSafeInteger(since) && since > 0 ? since : undefined;
  }
  static async open(options: { directory: string; adoptionConsent?: boolean; maxEvents?: number; maxAgeMs?: number; now?: () => number; runtimeVersion?: string }) {
    if (options.runtimeVersion !== undefined && !runtimeVersion.test(options.runtimeVersion)) throw new Error('Invalid runtime version');
    const limits = { maxEvents: Math.min(100000, Math.max(0, Math.floor(options.maxEvents ?? 50000))), maxAgeMs: Math.min(90 * 86400000, Math.max(60000, options.maxAgeMs ?? 30 * 86400000)), now: options.now ?? Date.now, ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}) };
    let db: Client | undefined;
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(options.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || !hasOwnerMode(dir, 0o700)) throw new Error('private_storage_required');
      const canonical = await realpath(options.directory), configured = resolve(options.directory);
      if (process.platform === 'win32' ? canonical.toLowerCase() !== configured.toLowerCase() : canonical !== configured) throw new Error('private_storage_required');
      const path = join(canonical, 'diagnostics.db');
      try { const file = await openPrivateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !hasOwnerMode(info, 0o600) || info.size > 256 * 1024 * 1024) throw new Error('private_storage_required');
      for (const suffix of ['-wal', '-shm']) {
        try { const sidecar = await lstat(path + suffix); if (!sidecar.isFile() || sidecar.isSymbolicLink() || !hasOwnerMode(sidecar, 0o600)) throw new Error('private_storage_required'); }
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
        const tx = await db!.transaction('write');
        try {
          await initializeIncidentRetention(tx);
          await pruneDiagnosticEvents(tx, limits.now() - limits.maxAgeMs, limits.maxEvents);
          await tx.commit();
        } catch (error) { await tx.rollback(); throw error; }
        finally { tx.close(); }
        await chmod(path, 0o600);
        // Only daemon startup supplies a consent decision. Other journal readers leave it intact.
        if (options.adoptionConsent === true) {
          await db!.execute({ sql: "INSERT OR IGNORE INTO diagnostic_meta(key,value) VALUES('adoption_since',?)", args: [String(limits.now())] });
        } else if (options.adoptionConsent === false) {
          await db!.execute("DELETE FROM diagnostic_meta WHERE key='adoption_since'");
        }
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
    if (!event || this.closed) { this.recordDropped(); return; }
    if (event.type === 'request.start') this.active.set(event.requestId, { events: [], positions: new Map(), progress: new Map() });
    const active = this.active.get(event.requestId);
    if (active) {
      active.events.push(event);
      if (event.attemptId && ['attempt.dequeue', 'attempt.dispatch', 'attempt.finish'].includes(event.type)) active.positions.delete(event.attemptId);
      if (event.attemptId && event.type === 'attempt.finish') active.progress.delete(event.attemptId);
      if (event.type === 'request.finish') this.active.delete(event.requestId);
    }
    if (!this.db) { this.recordDropped(); return; }
    if (this.queued >= 1000) { this.recordDropped(); this.error = 'queue_full'; return; }
    this.queued++; this.pending.push(event); this.schedule();
  }
  setQueuePosition(requestId: string, attemptId: string, position: () => number | null) {
    this.active.get(requestId)?.positions.set(attemptId, position);
  }
  setAttemptProgress(requestId: string, attemptId: string, at: number) {
    this.active.get(requestId)?.progress.set(attemptId, at);
  }
  async observation(limit: number) {
    if (!integer(limit)) throw new Error('Invalid observation limit');
    // Read the journal and the current write queue. A stalled or contended
    // writer must not hold up live diagnostics or hide a just-completed turn.
    const at = this.options.now();
    const inFlight = [...this.active.values()].map(({ events, positions, progress }) => ({
      events: [...events], positions: new Map([...positions].map(([id, read]) => [id, read()])), progress: new Map(progress)
    }));
    const health = this.health();
    const losses = { persistentDroppedEvents: null as number | null, droppedLateEvents: null as number | null, overflowEvents: null as number | null };
    if (!this.db || this.closed) return { at, inFlight, recent: [], health, losses, historyAvailable: false };
    try {
      const oldest = at - this.options.maxAgeMs;
      const buffered = [...this.writing, ...this.pending].filter(event => event.at >= oldest);
      const finishing = new Set(buffered.filter(event => event.type === 'request.finish').map(event => event.requestId));
      const result = limit ? await this.db.execute({ sql: `
        WITH recent AS (
          SELECT request_id FROM diagnostic_events
          WHERE type='request.finish' AND at>=?
          ORDER BY at DESC, seq DESC LIMIT ?
        ), selected AS (
          SELECT request_id FROM recent UNION SELECT value FROM json_each(?)
        )
        SELECT event.data FROM selected JOIN diagnostic_events AS event
          ON event.request_id=selected.request_id AND event.at>=?
        ORDER BY event.seq
      `, args: [oldest, limit, JSON.stringify([...finishing]), oldest] }) : undefined;
      const recent = (result?.rows ?? []).flatMap(row => {
        try { const event = sanitizeDiagnosticEvent(JSON.parse(String(row.data))); return event ? [event] : []; }
        catch { return []; }
      });
      const known = new Set(recent.map(event => event.id));
      if (limit) for (const event of buffered) if (finishing.has(event.requestId) && !known.has(event.id)) recent.push(event);
      Object.assign(losses, await readDiagnosticLosses(this.db));
      return { at, inFlight, recent, health, losses, historyAvailable: true };
    } catch { return { at, inFlight, recent: [], health, losses, historyAvailable: false }; }
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
  private rememberFlushedEvents(accepted: DiagnosticEvent[], fresh: DiagnosticEvent[]) {
    const inserted = new Set(fresh);
    for (const event of accepted) {
      const { requestId, type } = event;
      if (type === 'request.finish') {
        this.inFlight.delete(requestId);
        continue;
      }
      if (!inserted.delete(event)) continue;
      if (type === 'request.start' && !this.inFlight.has(requestId)) {
        if (this.inFlight.size >= maxInFlightRequests) this.inFlight.delete(this.inFlight.keys().next().value!);
        this.inFlight.set(requestId, []);
      }
      const trace = this.inFlight.get(requestId);
      if (trace && trace.length < maxInFlightEvents && !trace.some(previous => previous.id === event.id)) trace.push(event);
    }
  }
  private async restoreIncidentEvents(tx: Transaction, accepted: DiagnosticEvent[], cutoff: number) {
    const candidates = new Map<string, DiagnosticEvent[]>();
    for (const event of accepted) {
      if (!this.inFlight.has(event.requestId) || (event.type !== 'attempt.start' && !isIncidentEvent(event))) continue;
      const events = candidates.get(event.requestId) ?? [];
      events.push(event);
      candidates.set(event.requestId, events);
    }
    for (const [requestId, incoming] of candidates) {
      const prior = this.inFlight.get(requestId)!.filter(event => event.at >= cutoff);
      if (!prior.length) continue;
      const { rows } = await tx.execute({
        sql: `SELECT id,type FROM diagnostic_events WHERE request_id=?
          AND (type='attempt.start' OR id IN (SELECT value FROM json_each(?)))`,
        args: [requestId, JSON.stringify(prior.map(event => event.id))]
      });
      const retained = new Set(rows.map(row => String(row.id)));
      const firstMissing = prior.findIndex(event => !retained.has(event.id));
      if (firstMissing < 0) continue;
      if (!incoming.some(isIncidentEvent)) {
        const starts = new Set([...prior, ...incoming, ...rows].filter(event => event.type === 'attempt.start').map(event => String(event.id)));
        if (starts.size < 2) continue;
      }
      // Reinsert any surviving rows after the gap so the restored prefix and
      // the new batch retain their causal order in the ascending cursor.
      const restore = prior.slice(firstMissing);
      const surviving = restore.filter(event => retained.has(event.id));
      if (surviving.length) {
        await tx.execute({ sql: 'DELETE FROM diagnostic_events WHERE id IN (SELECT value FROM json_each(?))',
          args: [JSON.stringify(surviving.map(event => event.id))] });
      }
      // The retention trigger promotes the remaining rows for this request.
      await insertDiagnosticEvents(tx, restore, 1);
    }
  }
  private async drain() {
    try {
      while (this.pending.length || this.pendingLoss) {
        const batch = this.pending.splice(0, diagnosticBatchSize), loss = this.pendingLoss; this.pendingLoss = 0;
        this.writing = batch;
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
            const cutoff = this.options.now() - this.options.maxAgeMs;
            let fresh: DiagnosticEvent[] = [];
            if (accepted.length) {
              await this.restoreIncidentEvents(tx, accepted, cutoff);
              // Restored rows already entered metrics in an earlier flush.
              const inserted = await insertDiagnosticEvents(tx, accepted);
              const ids = new Set(inserted.rows.map(row => String(row.id)));
              fresh = accepted.filter(event => ids.delete(event.id));
              await recordDiagnosticMetrics(tx, fresh.filter(event => !traceDetailTypes.has(event.type)), this.options.now());
            }
            await pruneDiagnosticEvents(tx, cutoff, this.options.maxEvents);
            await pruneDiagnosticMetrics(tx, this.options.now());
            await tx.commit();
            this.rememberFlushedEvents(accepted, fresh);
            this.lastWriteAt = this.options.now(); this.error = undefined;
          } catch (error) { await tx.rollback(); throw error; }
          finally { tx.close(); }
        } catch {
          this.error = 'write_failed';
          const discarded = this.pending.splice(0); this.queued -= discarded.length;
          this.rememberFlushedEvents([...batch, ...discarded], []);
          this.droppedEvents += batch.length + discarded.length; this.pendingLoss += loss + batch.length + discarded.length;
          break; // Keep the loss count for the next successful write; never spin on a broken database.
        }
        finally { this.queued -= batch.length; this.writing = []; }
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
    const excluded = options.includeDetails === false ? [...observationTypes, ...detailTypes] : observationTypes;
    where.push('type NOT IN (' + excluded.map(() => '?').join(',') + ')');
    args.push(...excluded);
    args.push(limit);
    const events = await this.rows('SELECT seq,data FROM diagnostic_events WHERE ' + where.join(' AND ') + ' ORDER BY seq ASC LIMIT ?', args);
    return { events, nextCursor: events.length ? String(events.at(-1)!.seq) : options.after ?? null, streamId: this.streamId };
  }
  async trace(requestId: string) { return this.list({ requestId, limit: 500 }); }
  async metrics(options: { since?: number; until?: number } = {}) {
    await this.flush();
    // coverage.retainedFrom is the first aggregate hour. Raw event retention
    // is selective and can leave gaps after the oldest surviving event.
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
    this.closed = true; this.active.clear(); this.inFlight.clear(); this.db?.close();
  }
}
