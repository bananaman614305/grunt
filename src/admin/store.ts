import type { Client, InValue } from '@libsql/client';
import { AdminDataError, validateAdminBatch } from './types.js';
import type { AdminDiagnosticEvent, AdminMaintenance, AdminPoolSnapshot, AdminRequestFilters, AdminRequestSummary, AdminScout, AdminSystem, AdminUsage } from './types.js';

export interface AdminLoginState { nonce: string; verifier: string; createdAt: number; expiresAt: number }
export interface AdminSession { email: string; subject: string; createdAt: number; expiresAt: number }
interface EventRow { instance_id: string; payload: string }
interface InstanceRow { id: string; observed_at: number; received_at: number; snapshot_at: number | null; snapshot: string | null; system: string | null; maintenance: string | null; scout: string | null }
const day = 86400000;
const boundedLimit = (value: number | undefined, fallback = 50, max = 200) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= max ? value : (() => { throw new AdminDataError('invalid_admin_filter'); })();
const parse = <T>(value: string | null): T | undefined => value === null ? undefined : JSON.parse(value) as T;
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const authString = (value: string) => /^[A-Za-z0-9_-]{32,128}$/.test(value);
const validIdentity = (email: string, subject: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && /^[A-Za-z0-9_-]{1,255}$/.test(subject);
const requestLifecycle = (event: AdminDiagnosticEvent) => ['request.start', 'request.finish', 'attempt.start', 'attempt.finish'].includes(event.type);

function summarize(instanceId: string, events: AdminDiagnosticEvent[]): AdminRequestSummary {
  const ordered = [...events].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  const first = ordered.find(requestLifecycle)!, requestStart = ordered.find(e => e.type === 'request.start'), start = requestStart ?? first;
  const attemptEvents = ordered.filter(e => e.type === 'attempt.start' || e.type === 'attempt.finish');
  const attempts = ordered.filter(e => e.type === 'attempt.finish');
  const finish = ordered.filter(e => e.type === 'request.finish').at(-1)
    ?? (!requestStart && attempts.length >= ordered.filter(e => e.type === 'attempt.start').length ? attempts.at(-1) : undefined);
  const passed = attempts.filter(e => e.outcome === 'passed').at(-1);
  const outcome = finish?.outcome;
  const result: AdminRequestSummary = {
    id: first.requestId, instanceId, startedAt: start.at, kind: start.kind,
    outcome: outcome === 'passed' || outcome === 'failed' || outcome === 'cancelled' ? outcome : finish ? 'failed' : 'pending',
    sources: [...new Set(attemptEvents.length ? attemptEvents.flatMap(e => e.source ? [e.source] : []) : finish?.source ? [finish.source] : [])],
    attemptCount: new Set(ordered.filter(e => e.type === 'attempt.start' || e.type === 'attempt.finish').flatMap(e => e.attemptId ? [e.attemptId] : [])).size
      + Math.max(ordered.filter(e => e.type === 'attempt.start' && !e.attemptId).length, ordered.filter(e => e.type === 'attempt.finish' && !e.attemptId).length)
  };
  const model = finish?.model ?? passed?.model ?? start.model;
  if (model !== undefined) result.model = model;
  if (finish) { result.finishedAt = finish.at; result.durationMs = finish.durationMs ?? Math.max(0, finish.at - start.at); }
  if (passed?.source) result.source = passed.source;
  else if (!attemptEvents.length && finish?.source) result.source = finish.source;
  if (finish?.httpStatus !== undefined) result.httpStatus = finish.httpStatus;
  if (finish?.errorCode !== undefined) result.errorCode = finish.errorCode;
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const value = finish?.[key] ?? passed?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export class AdminStore {
  private now: () => number;
  private retentionMs: number;
  constructor(readonly db: Client, options: { now?: () => number; retentionMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(day, Math.min(30 * day, options.retentionMs ?? 30 * day));
  }
  async init() {
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS admin_instances(id TEXT PRIMARY KEY,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL DEFAULT 0,snapshot_at INTEGER,snapshot TEXT,system TEXT,maintenance TEXT,scout TEXT);
      CREATE TABLE IF NOT EXISTS admin_events(instance_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,request_id TEXT NOT NULL,source TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(instance_id,id));
      CREATE INDEX IF NOT EXISTS admin_event_time ON admin_events(at);
      CREATE INDEX IF NOT EXISTS admin_event_request ON admin_events(instance_id,request_id,at);
      CREATE TABLE IF NOT EXISTS admin_login_states(hash TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions(hash TEXT PRIMARY KEY,email TEXT NOT NULL,subject TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    `);
    const columns = await this.rows<{ name: string }>('PRAGMA table_info(admin_instances)');
    if (!columns.some(column => column.name === 'received_at')) await this.db.execute('ALTER TABLE admin_instances ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0');
    await this.clean();
  }
  private async rows<T>(sql: string, args: InValue[] = []): Promise<T[]> {
    return (await this.db.execute({ sql, args })).rows as unknown as T[];
  }
  private async clean() {
    const now = this.now();
    await this.db.batch([
      { sql: 'DELETE FROM admin_events WHERE at<?', args: [now - this.retentionMs] },
      { sql: 'DELETE FROM admin_instances WHERE observed_at<? OR received_at<?', args: [now - this.retentionMs, now - this.retentionMs] },
      { sql: 'DELETE FROM admin_login_states WHERE expires_at<=?', args: [now] },
      { sql: 'DELETE FROM admin_sessions WHERE expires_at<=?', args: [now] },
      { sql: 'DELETE FROM admin_events WHERE rowid IN (SELECT rowid FROM admin_events ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 50000)', args: [] }
    ], 'write');
  }
  async ingest(input: unknown): Promise<{ accepted: true; acceptedEvents: number; lastEventId?: string }> {
    const batch = validateAdminBatch(input, this.now());
    const tx = await this.db.transaction('write');
    let acceptedEvents = 0;
    try {
      await tx.execute({ sql: `INSERT INTO admin_instances(id,observed_at,received_at,snapshot_at,snapshot,system,maintenance,scout) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,received_at=excluded.received_at,
        snapshot_at=COALESCE(excluded.snapshot_at,admin_instances.snapshot_at),snapshot=COALESCE(excluded.snapshot,admin_instances.snapshot),
        system=excluded.system,maintenance=COALESCE(excluded.maintenance,admin_instances.maintenance),scout=COALESCE(excluded.scout,admin_instances.scout)
        WHERE excluded.observed_at>=admin_instances.observed_at`, args: [batch.instanceId, batch.observedAt, this.now(), batch.snapshot ? batch.observedAt : null, batch.snapshot ? JSON.stringify(batch.snapshot) : null, batch.system ? JSON.stringify(batch.system) : null, batch.maintenance ? JSON.stringify(batch.maintenance) : null, batch.scout ? JSON.stringify(batch.scout) : null] });
      for (const event of batch.events) {
        const result = await tx.execute({ sql: 'INSERT OR IGNORE INTO admin_events(instance_id,id,at,request_id,source,type,payload) VALUES(?,?,?,?,?,?,?)', args: [batch.instanceId, event.id, event.at, event.requestId, event.source ?? null, event.type, JSON.stringify(event)] });
        acceptedEvents += result.rowsAffected;
      }
      await tx.commit();
    } catch { await tx.rollback(); throw new AdminDataError('admin_storage_unavailable'); }
    finally { tx.close(); }
    await this.clean();
    return { accepted: true, acceptedEvents, ...(batch.events.length ? { lastEventId: batch.events.at(-1)!.id } : {}) };
  }
  private async instances(instanceId?: string) {
    const rows = await this.rows<InstanceRow>(`SELECT * FROM admin_instances WHERE observed_at>=? AND received_at>=?${instanceId ? ' AND id=?' : ''} ORDER BY id`, [this.now() - this.retentionMs, this.now() - this.retentionMs, ...(instanceId ? [instanceId] : [])]);
    return rows.map(row => ({ id: row.id, lastSeenAt: row.received_at, observedAt: row.observed_at, connected: row.received_at >= this.now() - 90000,
      snapshotObservedAt: row.snapshot_at, snapshot: parse<AdminPoolSnapshot>(row.snapshot) ?? null,
      ...(row.system ? { system: parse<AdminSystem>(row.system)! } : {}), ...(row.maintenance ? { maintenance: parse<AdminMaintenance>(row.maintenance)! } : {}), ...(row.scout ? { scout: parse<AdminScout>(row.scout)! } : {}) }));
  }
  private async eventRows(instanceId?: string, since = this.now() - day) {
    return this.rows<EventRow>(`SELECT instance_id,payload FROM admin_events WHERE at>=?${instanceId ? ' AND instance_id=?' : ''} ORDER BY at ASC,rowid ASC LIMIT 50000`, [since, ...(instanceId ? [instanceId] : [])]);
  }
  private async usage(instanceId?: string): Promise<AdminUsage> {
    const since = this.now() - day, rows = await this.eventRows(instanceId, since);
    const events = rows.map(row => ({ instanceId: row.instance_id, event: JSON.parse(row.payload) as AdminDiagnosticEvent }));
    const allAttempts = events.filter(row => row.event.type === 'attempt.finish');
    const requestIds = new Set(events.filter(row => requestLifecycle(row.event)).map(row => `${row.instanceId}:${row.event.requestId}`));
    const withAttempts = new Set(allAttempts.map(row => `${row.instanceId}:${row.event.requestId}`));
    const usageEvents = [...allAttempts, ...events.filter(row => row.event.type === 'request.finish' && !withAttempts.has(`${row.instanceId}:${row.event.requestId}`))];
    const result: AdminUsage = { since, inputTokens: null, outputTokens: null, knownInputEvents: 0, unknownInputEvents: 0, knownOutputEvents: 0, unknownOutputEvents: 0, requests: requestIds.size, attempts: allAttempts.length, failures: allAttempts.filter(row => row.event.outcome === 'failed').length };
    for (const { event } of usageEvents) {
      if (event.inputTokens === undefined) result.unknownInputEvents++; else { result.knownInputEvents++; result.inputTokens = (result.inputTokens ?? 0) + event.inputTokens; }
      if (event.outputTokens === undefined) result.unknownOutputEvents++; else { result.knownOutputEvents++; result.outputTokens = (result.outputTokens ?? 0) + event.outputTokens; }
    }
    return result;
  }
  async providers(instanceId?: string) {
    const instances = await this.instances(instanceId);
    return { providers: instances.flatMap(instance => (instance.snapshot?.sources ?? []).map(source => ({ ...source, instanceId: instance.id, lastObservedAt: instance.snapshotObservedAt ?? instance.observedAt }))) };
  }
  async overview(instanceId?: string) {
    const instances = await this.instances(instanceId), { providers } = await this.providers(instanceId), usage = await this.usage(instanceId);
    const activeIds = new Set(instances.filter(instance => instance.connected && instance.system?.daemonReachable !== false).map(instance => instance.id));
    const live = providers.filter(provider => activeIds.has(provider.instanceId));
    const readyProviders = live.filter(provider => provider.state === 'ready' || provider.state === 'answering').length;
    const limitedProviders = live.filter(provider => provider.state === 'limited').length, errorProviders = live.filter(provider => ['error', 'unavailable'].includes(provider.state)).length;
    const status = !instances.length ? 'no_data' : !activeIds.size ? 'offline' : readyProviders && !limitedProviders && !errorProviders && activeIds.size === instances.length ? 'healthy' : 'degraded';
    return { instances, providers, usage, health: { status, connectedInstances: instances.filter(instance => instance.connected).length, totalInstances: instances.length, readyProviders, limitedProviders, errorProviders }, lastUpdated: instances.length ? Math.max(...instances.map(instance => instance.lastSeenAt)) : null };
  }
  async requests(filters: AdminRequestFilters = {}) {
    const limit = boundedLimit(filters.limit), since = this.now() - this.retentionMs, rows = await this.eventRows(filters.instanceId, since);
    const grouped = new Map<string, { instanceId: string; events: AdminDiagnosticEvent[] }>();
    for (const row of rows) {
      const event = JSON.parse(row.payload) as AdminDiagnosticEvent, key = `${row.instance_id}:${event.requestId}`;
      const group = grouped.get(key) ?? { instanceId: row.instance_id, events: [] }; group.events.push(event); grouped.set(key, group);
    }
    let before: { at: number; id: string; instanceId: string } | undefined;
    if (filters.before) {
      try {
        before = JSON.parse(Buffer.from(filters.before, 'base64url').toString());
        if (!before || !Number.isSafeInteger(before.at) || typeof before.id !== 'string' || typeof before.instanceId !== 'string') throw new Error();
      } catch { throw new AdminDataError('invalid_admin_filter'); }
    }
    const sort = (a: AdminRequestSummary, b: AdminRequestSummary) => b.startedAt - a.startedAt || b.instanceId.localeCompare(a.instanceId) || b.id.localeCompare(a.id);
    const results = [...grouped.values()].filter(group => group.events.some(requestLifecycle)).map(group => summarize(group.instanceId, group.events))
      .filter(row => (!filters.source || row.sources.includes(filters.source)) && (!filters.outcome || row.outcome === filters.outcome)
        && (!before || sort(row, { startedAt: before.at, id: before.id, instanceId: before.instanceId } as AdminRequestSummary) > 0)).sort(sort);
    const requests = results.slice(0, limit), last = requests.at(-1);
    return { requests, nextCursor: results.length > limit && last ? Buffer.from(JSON.stringify({ at: last.startedAt, id: last.id, instanceId: last.instanceId })).toString('base64url') : null };
  }
  async request(id: string, instanceId?: string) {
    const rows = await this.rows<EventRow>(`SELECT instance_id,payload FROM admin_events WHERE request_id=?${instanceId ? ' AND instance_id=?' : ''} AND at>=? ORDER BY at ASC,rowid ASC LIMIT 2001`, [id, ...(instanceId ? [instanceId] : []), this.now() - this.retentionMs]);
    if (!rows.length) return null;
    const grouped = new Map<string, AdminDiagnosticEvent[]>();
    for (const row of rows) {
      const events = grouped.get(row.instance_id) ?? [];
      events.push(JSON.parse(row.payload) as AdminDiagnosticEvent); grouped.set(row.instance_id, events);
    }
    const lifecycleGroups = [...grouped.entries()].filter(([, events]) => events.some(requestLifecycle));
    if (!lifecycleGroups.length) return null;
    // An unscoped UUID collision must not silently merge two logical traces.
    if (lifecycleGroups.length !== 1) throw new AdminDataError('ambiguous_admin_request');
    const [selectedInstance, allEvents] = lifecycleGroups[0]!, events = allEvents.slice(0, 2000);
    return { request: summarize(selectedInstance, allEvents), events, truncated: allEvents.length > 2000 };
  }
  async runs(instanceId?: string) {
    const instances = await this.instances(instanceId);
    return { maintenance: instances.flatMap(instance => Object.entries(instance.maintenance?.entries ?? {}).map(([source, entry]) => ({ instanceId: instance.id, source, ...entry }))), scout: instances.flatMap(instance => instance.scout ? [{ instanceId: instance.id, ...instance.scout }] : []) };
  }
  async exportData(instanceId?: string) {
    const instances = await this.instances(instanceId), rows = await this.eventRows(instanceId, this.now() - this.retentionMs), runs = await this.runs(instanceId);
    return { version: 1 as const, exportedAt: this.now(), instances, events: rows.map(row => ({ instanceId: row.instance_id, ...JSON.parse(row.payload) as AdminDiagnosticEvent })), ...runs };
  }
  async putState(hash: string, value: AdminLoginState) {
    const now = this.now();
    if (!validHash(hash) || !authString(value.nonce) || !authString(value.verifier) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.createdAt > now || value.createdAt < now - 600000 || value.expiresAt <= now || value.expiresAt > value.createdAt + 600000) throw new AdminDataError('invalid_admin_state');
    await this.clean();
    await this.db.execute({ sql: 'INSERT INTO admin_login_states(hash,nonce,verifier,created_at,expires_at) VALUES(?,?,?,?,?)', args: [hash, value.nonce, value.verifier, value.createdAt, value.expiresAt] });
    await this.db.execute('DELETE FROM admin_login_states WHERE rowid IN (SELECT rowid FROM admin_login_states ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000)');
  }
  async consumeState(hash: string): Promise<AdminLoginState | undefined> {
    if (!validHash(hash)) return undefined;
    const row = (await this.rows<{ nonce: string; verifier: string; created_at: number; expires_at: number }>('DELETE FROM admin_login_states WHERE hash=? RETURNING nonce,verifier,created_at,expires_at', [hash]))[0];
    return row && row.expires_at > this.now() ? { nonce: row.nonce, verifier: row.verifier, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
  }
  async putSession(hash: string, value: AdminSession) {
    const now = this.now();
    if (!validHash(hash) || !validIdentity(value.email, value.subject) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.createdAt > now || value.createdAt < now - 600000 || value.expiresAt <= now || value.expiresAt > value.createdAt + 12 * 3600000) throw new AdminDataError('invalid_admin_session');
    await this.clean();
    await this.db.execute({ sql: 'INSERT INTO admin_sessions(hash,email,subject,created_at,expires_at) VALUES(?,?,?,?,?)', args: [hash, value.email.toLowerCase(), value.subject, value.createdAt, value.expiresAt] });
    await this.db.execute('DELETE FROM admin_sessions WHERE rowid IN (SELECT rowid FROM admin_sessions ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000)');
  }
  async session(hash: string): Promise<AdminSession | undefined> {
    if (!validHash(hash)) return undefined;
    const row = (await this.rows<{ email: string; subject: string; created_at: number; expires_at: number }>('SELECT email,subject,created_at,expires_at FROM admin_sessions WHERE hash=? AND expires_at>?', [hash, this.now()]))[0];
    return row ? { email: row.email, subject: row.subject, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
  }
  async deleteSession(hash: string) { if (validHash(hash)) await this.db.execute({ sql: 'DELETE FROM admin_sessions WHERE hash=?', args: [hash] }); }
}
