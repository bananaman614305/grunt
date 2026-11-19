import { sellerQuota } from '../local/quota-policy.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cpus, freemem, homedir, loadavg, platform, totalmem, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configRoot, gruntEnv } from '../brand.js';
import { knownAdapters, localOptInAdapterIds } from '../registry.js';
import { sanitizeDiagnosticEvent } from '../local/diagnostics.js';
import type { DiagnosticEvent } from '../local/diagnostics.js';
import { isAdminModelId, projectAdminWorkers, validateAdminBatch } from './types.js';
import type { AdminBatch } from './types.js';

const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 200;
const POLL_MS = 25000;
const ids = new Set([...knownAdapters, ...localOptInAdapterIds, 'freellmapi', 'codex', 'dots']);
const states = new Set(['unknown', 'available', 'ready', 'answering', 'connecting', 'verifying', 'approval', 'limited', 'error', 'disabled', 'unavailable']);
const errors = new Set(['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled']);
const maintenanceErrors = new Set([...errors, 'busy', 'foreground', 'consent']);
const candidateStates = new Set(['researched', 'rejected', 'needs_approval', 'setup_blocked', 'integration_pending', 'ready_for_review']);
const pipelineStates = new Set(['blocked', 'deferred', 'released', 'ci_pending', 'publication_pending', 'superseded', 'disabled', 'needs_approval']);
const scoutStates = new Set(['running', 'completed', 'failed', 'cancelled', 'skipped', 'unavailable']);
const scoutPhases = new Set(['validated', 'reviewed', 'checked', 'probed', 'approved', 'promotion', 'superseded']);
const scoutReasonCodes: Readonly<Record<string, string>> = {
  upstream_capacity_429_during_preliminary_qualification: 'upstream_capacity', upstream_capacity_429: 'upstream_capacity',
  pre_execution_review_not_approved: 'review_rejected', post_validation_review_not_approved: 'review_rejected',
  exact_head_ci_pending: 'ci_pending', canonical_ci_check_not_reported: 'ci_pending',
  candidate_validation_failed: 'validation_failed', candidate_changed_requires_fresh_review: 'validation_failed',
  awaiting_public_npm_verification: 'publication_pending', npm_publisher_approval_or_login_required: 'approval_required',
  local_checks_not_passed: 'validation_failed', trusted_probe_not_passed: 'pipeline_failed',
  pipeline_stage_failed: 'pipeline_failed', pipeline_budget_exhausted: 'pipeline_failed',
  quota: 'quota', setup_blocked: 'setup_required'
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const instancePattern = /^[a-z][a-z0-9-]{0,63}$/;
const semver = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown): value is number => count(value) && value <= 8640000000000000;
const cursor = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value));
const safeModel = isAdminModelId;
type CollectorIssue = 'daemon_unavailable' | 'diagnostics_unavailable' | 'maintenance_unavailable' | 'scout_unavailable';

/** Error text is deliberately fixed: upstream content and private paths never escape. */
export class CollectorError extends Error {
  constructor(readonly code: 'invalid_configuration' | 'private_state_required' | 'invalid_local_data' | 'upload_failed' | 'invalid_acknowledgment' | 'cancelled') {
    super(`Grunt admin collector: ${code}`);
  }
}

export interface CollectorConfig {
  url: string;
  ingestKey: string;
  instanceId: string;
  directory: string;
  daemonPort: number;
  scoutDirectory: string;
}

function destination(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new CollectorError('invalid_configuration'); }
  // This is an owned Grunt service, not a general URL-fetching facility.
  if (url.protocol !== 'https:' || !['api.grunt.run', 'milo-gateway.fly.dev'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/admin/ingest') throw new CollectorError('invalid_configuration');
  return url.href;
}

export function collectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const ingestKey = env.GRUNT_ADMIN_INGEST_KEY ?? '';
  const instanceId = env.GRUNT_ADMIN_INSTANCE_ID ?? '';
  const port = env.GRUNT_ADMIN_DAEMON_PORT ?? gruntEnv('PORT', env) ?? '8792';
  if (!ingestKey.trim() || ingestKey.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(ingestKey)
    || !instancePattern.test(instanceId) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new CollectorError('invalid_configuration');
  return {
    url: destination(env.GRUNT_ADMIN_COLLECTOR_URL ?? 'https://api.grunt.run/admin/ingest'),
    ingestKey, instanceId, directory: configRoot(env), daemonPort: Number(port),
    scoutDirectory: join(homedir(), '.local/state/usegrunt-scout')
  };
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await existingPrivateDirectory(directory);
}

async function existingPrivateDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700
    || await realpath(directory) !== resolve(directory)) throw new CollectorError('private_state_required');
}

async function privateJson(path: string, maximum = MAX_BYTES): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > maximum) throw new CollectorError('private_state_required');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
    await response.body?.cancel(); throw new CollectorError('invalid_local_data');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > MAX_BYTES) throw new CollectorError('invalid_local_data');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Project the daemon snapshot from scratch; free-form detail never leaves Chad. */
export function projectCollectorSnapshot(value: unknown) {
  const raw = object(value);
  if (!raw || raw.version !== 1 || !time(raw.updatedAt) || !count(raw.activeRequests) || !Array.isArray(raw.sources) || raw.sources.length > 100) throw new CollectorError('invalid_local_data');
  const sources: Record<string, unknown>[] = [];
  for (const input of raw.sources) {
    const source = object(input);
    if (!source || typeof source.id !== 'string' || !ids.has(source.id) || typeof source.state !== 'string' || !states.has(source.state) || !count(source.active)) continue;
    const item: Record<string, unknown> = { id: source.id, state: source.state, active: source.active };
    if (safeModel(source.model)) item.model = source.model;
    if (source.modelKind === 'registry') item.modelKind = 'registry';
    if (typeof source.errorCode === 'string' && errors.has(source.errorCode)) item.errorCode = source.errorCode;
    for (const key of ['lastReplyMs', 'lastSuccessAt', 'retryAt'] as const) if (time(source[key])) item[key] = source[key];
    const window = object(source.quotaWindow);
    if (time(window?.startedAt) && time(window?.resetAt) && window.startedAt > 0 && window.startedAt <= raw.updatedAt + 300000
        && window.resetAt > window.startedAt && window.resetAt - window.startedAt <= 31 * 86400000) {
      item.quotaWindow = { startedAt: window.startedAt, resetAt: window.resetAt };
    }
    const limits = source.id === 'antseed-vikey' ? sellerQuota(source.sellerQuota) : undefined;
    if (limits) item.sellerQuota = limits;
    sources.push(item);
  }
  let workers;
  if (raw.workers !== undefined) {
    try { workers = projectAdminWorkers(raw.workers, raw.updatedAt); }
    catch { /* Older or invalid worker metadata must not interrupt source reporting. */ }
  }
  return { version: 1 as const, updatedAt: raw.updatedAt, activeRequests: raw.activeRequests, sources,
    ...(workers ? { workers } : {}) };
}

export function projectCollectorMaintenance(value: unknown) {
  const raw = object(value), entries = object(raw?.entries);
  if (!raw || raw.version !== 1 || !entries || Object.keys(entries).length > 100) throw new CollectorError('invalid_local_data');
  const projected: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(entries)) {
    const item = object(value); if (!ids.has(id) || !item || !time(item.nextCheckAt)) continue;
    const entry: Record<string, unknown> = { nextCheckAt: item.nextCheckAt };
    for (const field of ['lastAttemptAt', 'lastCheckedAt'] as const) if (time(item[field])) entry[field] = item[field];
    if (['passed', 'failed', 'deferred'].includes(String(item.outcome))) entry.outcome = item.outcome;
    if (['reply', 'metadata', 'local'].includes(String(item.evidence))) entry.evidence = item.evidence;
    if (typeof item.code === 'string' && maintenanceErrors.has(item.code)) entry.code = item.code;
    projected[id] = entry;
  }
  return { version: 1 as const, entries: projected };
}

function instant(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/.test(value)) return undefined;
  const result = Date.parse(value); return time(result) ? result : undefined;
}

export function projectCollectorScout(lastRun: unknown, ledger: unknown) {
  const raw = object(lastRun), candidates = object(object(ledger)?.candidates);
  if (!raw || typeof raw.status !== 'string' || !scoutStates.has(raw.status)) throw new CollectorError('invalid_local_data');
  const result: Record<string, unknown> = { status: raw.status, candidates: [] };
  if (typeof raw.id === 'string' && /^\d{8}T\d{12}Z$/.test(raw.id)) result.runId = raw.id;
  for (const [from, to] of [['started_at', 'startedAt'], ['finished_at', 'finishedAt'], ['heartbeat_at', 'heartbeatAt']] as const) {
    const value = instant(raw[from]); if (value !== undefined) result[to] = value;
  }
  result.candidates = Object.entries(candidates ?? {}).slice(-200).flatMap(([id, value]) => {
    const item = object(value);
    if (!/^[a-f0-9]{24}$/.test(id) || !item || typeof item.status !== 'string' || !candidateStates.has(item.status)) return [];
    const candidate: Record<string, unknown> = { id, status: item.status };
    if (safeModel(item.model)) candidate.model = item.model;
    if (typeof item.pipeline_status === 'string' && pipelineStates.has(item.pipeline_status)) candidate.pipelineStatus = item.pipeline_status;
    if (typeof item.pipeline_reason === 'string' && Object.hasOwn(scoutReasonCodes, item.pipeline_reason)) candidate.reasonCode = scoutReasonCodes[item.pipeline_reason];
    return [candidate];
  });
  return result;
}

interface Checkpoint { version: 1; instanceId: string; destination: string; cursor: string | null; streamId: string | null; lastAcknowledgedAt?: number }
export interface CollectorOptions extends CollectorConfig {
  fetcher?: typeof fetch;
  now?: () => number;
  random?: () => number;
  system?: () => Record<string, unknown>;
  notify?: (status: 'connected' | 'retrying') => void;
}

export class AdminCollector {
  private checkpoint: Checkpoint;
  private initialization: Promise<void> | undefined;
  private active: Promise<{ uploadedEvents: number; daemonReachable: boolean }> | undefined;
  private controller = new AbortController();
  constructor(private options: CollectorOptions) {
    if (!instancePattern.test(options.instanceId) || !options.ingestKey.trim() || options.ingestKey.length > 8192
      || /[\s\u0000-\u001f\u007f]/.test(options.ingestKey) || !Number.isInteger(options.daemonPort) || options.daemonPort < 1 || options.daemonPort > 65535) throw new CollectorError('invalid_configuration');
    options.url = destination(options.url);
    this.checkpoint = { version: 1, instanceId: options.instanceId, destination: options.url, cursor: null, streamId: null };
  }
  private statePath() { return join(this.options.directory, 'admin-collector-state.json'); }
  private now() { return (this.options.now ?? Date.now)(); }
  private load() {
    return this.initialization ??= (async () => {
      await privateDirectory(this.options.directory);
      try {
        const raw = object(await privateJson(this.statePath(), 4096));
        if (!raw || raw.version !== 1 || !instancePattern.test(String(raw.instanceId)) || typeof raw.destination !== 'string'
          || (raw.cursor !== null && !cursor(raw.cursor)) || (raw.streamId !== null && (typeof raw.streamId !== 'string' || !uuid.test(raw.streamId)))) throw new CollectorError('private_state_required');
        if (raw.instanceId === this.options.instanceId && raw.destination === this.options.url) {
          this.checkpoint = { ...this.checkpoint, cursor: raw.cursor as string | null, streamId: raw.streamId as string | null };
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CollectorError('private_state_required'); }
    })();
  }
  private async save(next: Checkpoint) {
    await privateDirectory(this.options.directory);
    // Do not overwrite a path that has become a symlink, FIFO or public file.
    try { await privateJson(this.statePath(), 4096); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CollectorError('private_state_required'); }
    const temporary = join(this.options.directory, `admin-collector.${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); await file.close(); await rename(temporary, this.statePath()); }
    finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
    this.checkpoint = next;
  }
  private async local(path: string) {
    const response = await (this.options.fetcher ?? fetch)(`http://127.0.0.1:${this.options.daemonPort}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)])
    });
    return jsonResponse(response);
  }
  private async events(after: string | null, expectedStream?: string): Promise<{ events: DiagnosticEvent[]; nextCursor: string | null; streamId: string }> {
    const raw = object(await this.local(`/v1/diagnostics/events?limit=${MAX_EVENTS}${after ? `&after=${encodeURIComponent(after)}` : ''}`));
    if (!raw || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS || typeof raw.streamId !== 'string' || !uuid.test(raw.streamId)
      || (raw.nextCursor !== null && !cursor(raw.nextCursor))) throw new CollectorError('invalid_local_data');
    if (after !== null && expectedStream !== undefined && raw.streamId !== expectedStream) return this.events(null);
    const projected: DiagnosticEvent[] = [];
    let previous = Number(after ?? 0);
    for (const input of raw.events) {
      const event = sanitizeDiagnosticEvent(input);
      if (!event || !count(event.seq) || event.seq <= previous || event.source && !ids.has(event.source)) throw new CollectorError('invalid_local_data');
      if (event.model !== undefined && !safeModel(event.model)) delete event.model;
      previous = event.seq; projected.push(event);
    }
    if (projected.length && raw.nextCursor !== String(previous)) throw new CollectorError('invalid_local_data');
    if (!projected.length && raw.nextCursor !== after) throw new CollectorError('invalid_local_data');
    return { events: projected, nextCursor: raw.nextCursor as string | null, streamId: raw.streamId };
  }
  private async system(daemonReachable: boolean, diagnosticsAvailable: boolean, collectorErrors: CollectorIssue[]) {
    let version = '0.0.0';
    try {
      const raw = object(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')));
      if (typeof raw?.version === 'string' && semver.test(raw.version)) version = raw.version;
    } catch { /* A source-only preview need not include package metadata. */ }
    return this.options.system?.() ?? {
      version, nodeVersion: process.version, platform: platform(), systemUptimeSeconds: uptime(), collectorUptimeSeconds: process.uptime(),
      cpuCount: cpus().length, loadAverage: loadavg(), memoryTotalBytes: totalmem(), memoryFreeBytes: freemem(), daemonReachable, diagnosticsAvailable, collectorErrors
    };
  }
  private async scout() {
    await existingPrivateDirectory(this.options.scoutDirectory);
    const [lastRun, ledger] = await Promise.all([privateJson(join(this.options.scoutDirectory, 'last-run.json'), 65536), privateJson(join(this.options.scoutDirectory, 'ledger.json'))]);
    const result = projectCollectorScout(lastRun, ledger);
    const rows = result.candidates as Record<string, unknown>[];
    const candidates = object(object(ledger)?.candidates) ?? {};
    const releases = join(this.options.scoutDirectory, 'releases');
    for (const row of rows) {
      const original = object(candidates[String(row.id)]), request = object(original?.release_request), head = request?.head_sha;
      if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) continue;
      // Only the exact current head may supply release evidence. Old review
      // results must not appear to describe a repaired/rebased candidate.
      try {
        const directory = join(releases, `pipeline-${head}`);
        await existingPrivateDirectory(releases); await existingPrivateDirectory(directory);
        const checkpoint = object(await privateJson(join(directory, 'checkpoint.json'))), receipt = object(checkpoint?.receipt);
        if (!checkpoint || !receipt || receipt.head_sha !== head || receipt.model !== original?.model || receipt.source_id !== request?.source_id) continue;
        if (typeof checkpoint.phase === 'string' && scoutPhases.has(checkpoint.phase)) row.phase = checkpoint.phase;
        const checks = object(receipt.checks), commands = Array.isArray(checks?.commands) ? checks.commands.map(object) : [];
        row.checksPassed = checks?.passed === true && checks.head_sha === head && commands.length === 4 && commands.every(c => c?.passed === true) ? true
          : commands.some(c => c?.passed === false) ? false : null;
        const resultValue = object(checkpoint.result);
        row.supervisorProbePassed = receipt.probe_verified_by_supervisor === true ? true : resultValue?.reason === 'trusted_probe_not_passed' ? false : null;
        row.approvedReviewCount = Math.min(2, new Set((Array.isArray(receipt.reviews) ? receipt.reviews : []).flatMap(value => {
          const review = object(value), reviewed = object(review?.checks);
          return review?.verdict === 'approve' && review.independent === true && review.head_sha === head
            && typeof review.review_id === 'string' && /^[a-f0-9]{32}$/.test(review.review_id)
            && reviewed && ['model', 'context', 'free_access', 'terms', 'signup', 'consent', 'code_scope'].every(key => reviewed[key] === true) ? [review.review_id] : [];
        })).size);
        if (resultValue?.status === 'released' && resultValue.head_sha === head && resultValue.source_id === request?.source_id) row.published = true;
      } catch { /* Missing or unsafe protected evidence remains unknown. */ }
    }
    return result;
  }
  cycle() {
    if (this.active) return this.active;
    const operation = this.collect();
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; }).catch(() => {});
    return operation;
  }
  private async collect() {
    await this.load(); this.controller.signal.throwIfAborted();
    const collectorErrors: CollectorIssue[] = [];
    let snapshot: ReturnType<typeof projectCollectorSnapshot> | null = null;
    try { snapshot = projectCollectorSnapshot(await this.local('/v1/status')); } catch { collectorErrors.push('daemon_unavailable'); }
    let eventBatch = { events: [] as DiagnosticEvent[], nextCursor: this.checkpoint.cursor, streamId: this.checkpoint.streamId };
    let diagnosticsAvailable = false;
    try {
      const summary = object(await this.local('/v1/diagnostics/summary'));
      if (!summary || typeof summary.streamId !== 'string' || !uuid.test(summary.streamId)) throw new CollectorError('invalid_local_data');
      const after = summary.streamId === this.checkpoint.streamId ? this.checkpoint.cursor : null;
      // A reset between summary and events restarts at the oldest retained
      // event; an obsolete cursor cannot skip the new database's first events.
      eventBatch = await this.events(after, summary.streamId);
      diagnosticsAvailable = true;
    } catch { collectorErrors.push('diagnostics_unavailable'); }
    let maintenance: ReturnType<typeof projectCollectorMaintenance> | undefined;
    try { maintenance = projectCollectorMaintenance(await privateJson(join(this.options.directory, 'maintenance.json'), 65536)); }
    catch { collectorErrors.push('maintenance_unavailable'); }
    let scout: ReturnType<typeof projectCollectorScout> | undefined;
    try { scout = await this.scout(); } catch { collectorErrors.push('scout_unavailable'); }
    const batch: AdminBatch = validateAdminBatch({ version: 1, instanceId: this.options.instanceId, observedAt: this.now(), snapshot,
      events: eventBatch.events, system: await this.system(snapshot !== null, diagnosticsAvailable, collectorErrors),
      ...(maintenance ? { maintenance } : {}), ...(scout ? { scout } : {}) }, this.now());
    const body = JSON.stringify(batch); if (Buffer.byteLength(body) > MAX_BYTES) throw new CollectorError('invalid_local_data');
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(this.options.url, { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${this.options.ingestKey}`, 'Content-Type': 'application/json' }, body });
    } catch { throw new CollectorError(this.controller.signal.aborted ? 'cancelled' : 'upload_failed'); }
    if (!response.ok) { await response.body?.cancel(); throw new CollectorError('upload_failed'); }
    let ack: Record<string, unknown> | undefined;
    try { ack = object(await jsonResponse(response)); } catch { throw new CollectorError('invalid_acknowledgment'); }
    const lastId = eventBatch.events.at(-1)?.id;
    if (ack?.accepted !== true || !count(ack.acceptedEvents) || ack.acceptedEvents > eventBatch.events.length
      || (ack.lastEventId !== undefined && ack.lastEventId !== lastId)) throw new CollectorError('invalid_acknowledgment');
    await this.save({ ...this.checkpoint, cursor: eventBatch.nextCursor, streamId: eventBatch.streamId, lastAcknowledgedAt: this.now() });
    return { uploadedEvents: eventBatch.events.length, daemonReachable: snapshot !== null };
  }
  async run() {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try { await this.cycle(); failures = 0; this.options.notify?.('connected'); }
      catch { if (this.controller.signal.aborted) break; failures++; this.options.notify?.('retrying'); }
      const random = (this.options.random ?? Math.random)();
      const jitter = Math.floor(Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0)) * 5000);
      const delay = Math.min(300000, POLL_MS * 2 ** Math.min(failures, 4)) + jitter;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay); this.controller.signal.addEventListener('abort', finish, { once: true });
        if (this.controller.signal.aborted) finish();
      });
    }
  }
  stop() { this.controller.abort(); }
}

export async function runCollector(env: NodeJS.ProcessEnv = process.env) {
  const collector = new AdminCollector({ ...collectorConfig(env), notify: status => console.error(`Grunt admin collector: ${status}`) });
  const stop = () => collector.stop(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await collector.run(); } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCollector().catch(() => {
    console.error('Grunt admin collector could not start. Configure its private owner-only destination, ingestion key and instance ID.');
    process.exitCode = 1;
  });
}
