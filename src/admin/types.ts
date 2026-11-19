// Only these metadata fields may cross the collector boundary. Payloads,
// credentials, paths and arbitrary upstream messages are intentionally absent.
import { sellerQuota } from '../local/quota-policy.js';
import type { SellerQuota } from '../local/quota-policy.js';
import { diagnosticFailureReasons } from '../local/diagnostics.js';
import { knownAdapters, localOptInAdapterIds } from '../registry.js';
import { MAX_WORKER_ACTIVE, MAX_WORKER_QUEUED, MAX_WORKER_RECENT, workerActivities } from '../local/worker-pool.js';

export type DiagnosticKind = 'user' | 'setup' | 'maintenance' | 'diagnostic';
export type DiagnosticEventType = 'request.start' | 'request.finish' | 'attempt.start' | 'attempt.finish' | 'route.selection' | 'route.skip' | 'transport.finish';
export type DiagnosticOutcome = 'passed' | 'failed' | 'cancelled' | 'skipped';
export type DiagnosticErrorCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream' | 'refused' | 'cancelled';
export interface AdminDiagnosticEvent {
  version: 1; id: string; at: number; type: DiagnosticEventType; requestId: string; kind: DiagnosticKind;
  seq?: number; attemptId?: string; source?: string; model?: string; outcome?: DiagnosticOutcome;
  durationMs?: number; httpStatus?: number; errorCode?: DiagnosticErrorCode; retryAfterSeconds?: number;
  inputTokens?: number; outputTokens?: number; transport?: 'http' | 'cli'; httpMethod?: 'GET' | 'POST';
  endpointLabel?: 'chat.completions' | 'models' | 'account' | 'local.opencode' | 'cli'; networkCode?: string;
  exitCode?: number; reason?: string;
  failureReason?: typeof diagnosticFailureReasons[number];
}
export type AdminSourceState = 'unknown' | 'available' | 'ready' | 'answering' | 'connecting' | 'verifying' | 'approval' | 'limited' | 'error' | 'disabled' | 'unavailable';
export interface AdminSourceSnapshot {
  id: string; state: AdminSourceState; active: number; model?: string; modelKind?: 'registry';
  lastReplyMs?: number; lastSuccessAt?: number; retryAt?: number; errorCode?: DiagnosticErrorCode;
  quotaWindow?: { startedAt: number; resetAt: number };
  sellerQuota?: SellerQuota;
}
export interface AdminWorker {
  id: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number; startedAt?: number; finishedAt?: number; source?: string; activity?: typeof workerActivities[number];
}
export interface AdminWorkers { active: AdminWorker[]; queued: AdminWorker[]; recent: AdminWorker[] }
export interface AdminPoolSnapshot { version: 1; updatedAt: number; activeRequests: number; sources: AdminSourceSnapshot[]; workers?: AdminWorkers }
export interface AdminSystem {
  version?: string; nodeVersion?: string; platform?: string; systemUptimeSeconds?: number; collectorUptimeSeconds?: number;
  cpuCount?: number; loadAverage?: number[]; memoryTotalBytes?: number; memoryFreeBytes?: number;
  daemonReachable?: boolean; diagnosticsAvailable?: boolean; collectorErrors?: string[];
}
export interface AdminMaintenanceEntry {
  nextCheckAt: number; lastAttemptAt?: number; lastCheckedAt?: number; outcome?: 'passed' | 'failed' | 'deferred';
  evidence?: 'reply' | 'metadata' | 'local'; code?: string;
}
export interface AdminMaintenance { version: 1; entries: Record<string, AdminMaintenanceEntry> }
export interface AdminScoutCandidate {
  id: string; model?: string; status: string; pipelineStatus?: string; reasonCode?: string; phase?: string;
  checksPassed?: boolean | null; supervisorProbePassed?: boolean | null; approvedReviewCount?: number; published?: true;
}
export interface AdminScout {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'unavailable'; runId?: string;
  startedAt?: number; finishedAt?: number; heartbeatAt?: number; candidates: AdminScoutCandidate[];
}
export interface AdminBatch {
  version: 1; instanceId: string; observedAt: number; snapshot: AdminPoolSnapshot | null; events: AdminDiagnosticEvent[];
  system?: AdminSystem; maintenance?: AdminMaintenance; scout?: AdminScout;
}
export interface AdminRequestSummary {
  id: string; instanceId: string; startedAt: number; finishedAt?: number; durationMs?: number; kind: DiagnosticKind;
  model?: string; outcome: 'passed' | 'failed' | 'cancelled' | 'pending'; source?: string; sources: string[];
  attemptCount: number; httpStatus?: number; errorCode?: DiagnosticErrorCode; inputTokens?: number; outputTokens?: number;
}
export interface AdminRequestFilters { limit?: number; source?: string; outcome?: string; before?: string; instanceId?: string }
export interface AdminUsage {
  since: number; inputTokens: number | null; outputTokens: number | null; knownInputEvents: number; unknownInputEvents: number;
  knownOutputEvents: number; unknownOutputEvents: number; requests: number; attempts: number; failures: number;
}
export class AdminDataError extends Error { constructor(readonly code = 'invalid_admin_batch') { super(code); } }
function fail(): never { throw new AdminDataError(); }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const secret = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,}|vault:|bearer|https?:|[?@\\\s])/i;
const sourcePattern = /^[a-z][a-z0-9-]{0,63}$/;
export const isAdminSourceId = (value: unknown): value is string => typeof value === 'string' && sourcePattern.test(value) && !secret.test(value);
const id = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : fail();
export const isAdminModelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) && !secret.test(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : fail();
const member = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === 'string' && values.includes(value as T) ? value as T : fail();
const timestamp = (value: unknown, now: number, oldest = 0): number => integer(value, oldest, now + 300000);
const errorCodes: readonly DiagnosticErrorCode[] = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'];
const maintenanceCodes = [...errorCodes, 'busy', 'foreground', 'consent'] as const;
const states: readonly AdminSourceState[] = ['unknown', 'available', 'ready', 'answering', 'connecting', 'verifying', 'approval', 'limited', 'error', 'disabled', 'unavailable'];
const kinds: readonly DiagnosticKind[] = ['user', 'setup', 'maintenance', 'diagnostic'];
const eventTypes: readonly DiagnosticEventType[] = ['request.start', 'request.finish', 'attempt.start', 'attempt.finish', 'route.selection', 'route.skip', 'transport.finish'];
const optional = (from: Record<string, unknown>, name: string, parse: (value: unknown) => unknown, to: object) => {
  if (from[name] !== undefined) Object.assign(to, { [name]: parse(from[name]) });
};
export function validateAdminEvent(value: unknown, now = Date.now()): AdminDiagnosticEvent {
  const raw = record(value); if (raw.version !== 1) fail();
  const event: AdminDiagnosticEvent = { version: 1, id: id(raw.id), at: timestamp(raw.at, now, Math.max(0, now - 30 * 86400000)), type: member(raw.type, eventTypes), requestId: id(raw.requestId), kind: member(raw.kind, kinds) };
  optional(raw, 'seq', v => integer(v, 1), event); optional(raw, 'attemptId', id, event);
  optional(raw, 'source', v => isAdminSourceId(v) ? v : fail(), event);
  optional(raw, 'model', v => isAdminModelId(v) ? v : fail(), event);
  optional(raw, 'outcome', v => member(v, ['passed', 'failed', 'cancelled', 'skipped']), event);
  for (const key of ['inputTokens', 'outputTokens']) optional(raw, key, v => integer(v), event);
  for (const key of ['durationMs', 'retryAfterSeconds']) optional(raw, key, finite, event);
  optional(raw, 'httpStatus', v => integer(v, 100, 599), event);
  optional(raw, 'errorCode', v => member(v, errorCodes), event);
  optional(raw, 'transport', v => member(v, ['http', 'cli']), event);
  optional(raw, 'httpMethod', v => member(v, ['GET', 'POST']), event);
  optional(raw, 'endpointLabel', v => member(v, ['chat.completions', 'models', 'account', 'local.opencode', 'cli']), event);
  optional(raw, 'networkCode', v => member(v, ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']), event);
  optional(raw, 'exitCode', v => integer(v, -255, 255), event);
  optional(raw, 'failureReason', v => member(v, diagnosticFailureReasons), event);
  optional(raw, 'reason', v => member(v, ['not_listed', 'pending_setup', 'cooldown', 'tools_unsupported', 'input_unsupported', 'unavailable', 'sticky', 'weighted', 'explicit', 'fallback', 'local']), event);
  return event;
}
export function projectAdminWorkers(value: unknown, now: number): AdminWorkers {
  const raw = record(value);
  const group = (name: keyof AdminWorkers, allowed: readonly AdminWorker['state'][], maximum: number) => {
    const rows = raw[name];
    if (!Array.isArray(rows) || rows.length > maximum) fail();
    return rows.map((value: unknown) => {
      const row = record(value);
      const result: AdminWorker = { id: id(row.id), state: member(row.state, allowed), createdAt: timestamp(row.createdAt, now) };
      optional(row, 'activity', v => member(v, workerActivities), result);
      optional(row, 'startedAt', v => timestamp(v, now, result.createdAt), result);
      optional(row, 'finishedAt', v => timestamp(v, now, result.startedAt ?? result.createdAt), result);
      optional(row, 'source', v => isAdminSourceId(v) && (knownAdapters.has(v) || localOptInAdapterIds.has(v)) ? v : fail(), result);
      return result;
    });
  };
  const workers = { active: group('active', ['running'], MAX_WORKER_ACTIVE), queued: group('queued', ['queued'], MAX_WORKER_QUEUED),
    recent: group('recent', ['completed', 'failed', 'cancelled'], MAX_WORKER_RECENT) };
  const rows = [...workers.active, ...workers.queued, ...workers.recent];
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  return workers;
}
function snapshot(value: unknown, now: number): AdminPoolSnapshot | null {
  if (value === null) return null;
  const raw = record(value); if (raw.version !== 1 || !Array.isArray(raw.sources) || raw.sources.length > 64) fail();
  const sources = raw.sources.map(value => {
    const row = record(value); if (!isAdminSourceId(row.id)) fail();
    const result: AdminSourceSnapshot = { id: row.id, state: member(row.state, states), active: integer(row.active, 0, 10000) };
    optional(row, 'model', v => isAdminModelId(v) ? v : fail(), result);
    optional(row, 'modelKind', v => member(v, ['registry']), result);
    optional(row, 'lastReplyMs', finite, result);
    optional(row, 'lastSuccessAt', v => timestamp(v, now, 0), result);
    optional(row, 'retryAt', v => integer(v, 0, now + 31 * 86400000), result);
    optional(row, 'quotaWindow', v => {
      const window = record(v);
      const startedAt = timestamp(window.startedAt, now, 1);
      const resetAt = integer(window.resetAt, startedAt + 1, startedAt + 31 * 86400000);
      return { startedAt, resetAt };
    }, result);
    if (row.id === 'antseed-vikey') optional(row, 'sellerQuota', v => sellerQuota(v) ?? fail(), result);
    optional(row, 'errorCode', v => member(v, errorCodes), result);
    return result;
  });
  if (new Set(sources.map(row => row.id)).size !== sources.length) fail();
  return { version: 1, updatedAt: timestamp(raw.updatedAt, now), activeRequests: integer(raw.activeRequests, 0, 10000), sources,
    ...(raw.workers === undefined ? {} : { workers: projectAdminWorkers(raw.workers, now) }) };
}
function system(value: unknown): AdminSystem {
  const raw = record(value), result: AdminSystem = {};
  const semver = (v: unknown) => typeof v === 'string' && /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,40})?$/.test(v) ? v : fail();
  optional(raw, 'version', semver, result); optional(raw, 'nodeVersion', semver, result);
  optional(raw, 'platform', v => member(v, ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32']), result);
  for (const key of ['systemUptimeSeconds', 'collectorUptimeSeconds']) optional(raw, key, finite, result);
  optional(raw, 'cpuCount', v => integer(v, 1, 65536), result);
  for (const key of ['memoryTotalBytes', 'memoryFreeBytes']) optional(raw, key, v => integer(v, 0, 2 ** 50), result);
  for (const key of ['daemonReachable', 'diagnosticsAvailable']) optional(raw, key, v => typeof v === 'boolean' ? v : fail(), result);
  optional(raw, 'loadAverage', v => Array.isArray(v) && v.length === 3 ? v.map(finite) : fail(), result);
  optional(raw, 'collectorErrors', v => Array.isArray(v) && v.length <= 4 ? [...new Set(v.map(item => member(item, ['daemon_unavailable', 'diagnostics_unavailable', 'maintenance_unavailable', 'scout_unavailable'])))] : fail(), result);
  return result;
}
function maintenance(value: unknown, now: number): AdminMaintenance {
  const raw = record(value); if (raw.version !== 1) fail(); const entries = record(raw.entries);
  if (Object.keys(entries).length > 64) fail(); const result: AdminMaintenance = { version: 1, entries: {} };
  for (const [key, value] of Object.entries(entries)) {
    if (!isAdminSourceId(key)) fail(); const row = record(value);
    const entry: AdminMaintenanceEntry = { nextCheckAt: integer(row.nextCheckAt, 0, now + 8 * 86400000) };
    for (const field of ['lastAttemptAt', 'lastCheckedAt']) optional(row, field, v => timestamp(v, now), entry);
    optional(row, 'outcome', v => member(v, ['passed', 'failed', 'deferred']), entry);
    optional(row, 'evidence', v => member(v, ['reply', 'metadata', 'local']), entry);
    optional(row, 'code', v => member(v, maintenanceCodes), entry);
    result.entries[key] = entry;
  }
  return result;
}
function scout(value: unknown, now: number): AdminScout {
  const raw = record(value);
  if (!Array.isArray(raw.candidates) || raw.candidates.length > 200) fail();
  const result: AdminScout = { status: member(raw.status, ['running', 'completed', 'failed', 'cancelled', 'skipped', 'unavailable']), candidates: raw.candidates.map(value => {
    const row = record(value); if (typeof row.id !== 'string' || !/^[a-f0-9]{24}$/.test(row.id)) fail();
    const candidate: AdminScoutCandidate = { id: row.id, status: member(row.status, ['researched', 'rejected', 'needs_approval', 'setup_blocked', 'integration_pending', 'ready_for_review']) };
    optional(row, 'model', v => isAdminModelId(v) ? v : fail(), candidate);
    optional(row, 'pipelineStatus', v => member(v, ['blocked', 'deferred', 'released', 'ci_pending', 'publication_pending', 'superseded', 'disabled', 'needs_approval', 'reviewed', 'ready']), candidate);
    optional(row, 'reasonCode', v => member(v, ['upstream_capacity', 'review_rejected', 'ci_pending', 'validation_failed', 'publication_pending', 'approval_required', 'quota', 'setup_required', 'pipeline_failed']), candidate);
    optional(row, 'phase', v => member(v, ['validated', 'reviewed', 'checked', 'probed', 'approved', 'promotion', 'superseded']), candidate);
    for (const key of ['checksPassed', 'supervisorProbePassed']) optional(row, key, v => v === null || typeof v === 'boolean' ? v : fail(), candidate);
    optional(row, 'approvedReviewCount', v => integer(v, 0, 2), candidate);
    optional(row, 'published', v => v === true ? true : fail(), candidate);
    return candidate;
  }) };
  optional(raw, 'runId', v => typeof v === 'string' && /^\d{8}T\d{6,12}Z$/.test(v) ? v : fail(), result);
  for (const field of ['startedAt', 'finishedAt', 'heartbeatAt']) optional(raw, field, v => timestamp(v, now), result);
  return result;
}
export function validateAdminBatch(value: unknown, now = Date.now()): AdminBatch {
  const raw = record(value); if (raw.version !== 1 || !isAdminSourceId(raw.instanceId) || !Array.isArray(raw.events) || raw.events.length > 200) fail();
  const result: AdminBatch = { version: 1, instanceId: raw.instanceId, observedAt: timestamp(raw.observedAt, now, Math.max(0, now - 30 * 86400000)), snapshot: snapshot(raw.snapshot, now), events: raw.events.map(value => validateAdminEvent(value, now)) };
  if (new Set(result.events.map(event => event.id)).size !== result.events.length) fail();
  optional(raw, 'system', system, result); optional(raw, 'maintenance', v => maintenance(v, now), result); optional(raw, 'scout', v => scout(v, now), result);
  return result;
}
