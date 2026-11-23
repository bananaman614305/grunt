import type { Client } from '@libsql/client';
import { ID_PATTERN } from './registry.js';
import type { Registry } from './registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_MAX_BYTES = 32 * 1024;
export const SCORE_WINDOW_DAYS = 14;
const RETENTION_DAYS = 15;
const HALF_LIFE_DAYS = 3;
// The exact per-route fields a router may send; nothing else is accepted.
export const FEEDBACK_ROUTE_FIELDS = ['id', 'ok', 'failed', 'quota', 'auth', 'latency_ms', 'signup_ok', 'signup_failed', 'retired'] as const;
export const FEEDBACK_FIELDS = ['version', 'install', 'client', 'day', 'routes'] as const;
const COUNT_FIELDS = ['ok', 'failed', 'quota', 'auth', 'signup_ok', 'signup_failed'] as const;
export interface FeedbackRoute { id: string; ok: number; failed: number; quota: number; auth: number; latency_ms: number; signup_ok: number; signup_failed: number; retired: boolean }
export interface FeedbackReport { version: 1; install: string; client: string; day: string; routes: FeedbackRoute[] }
export interface RouteScore {
  score: number | null; state: 'live' | 'dead' | 'unknown'; reliability: number | null; last_ok: string | null;
  installs_7d: number; reports: number; quota_rate: number | null; signup_rate: number; signup_attempts: number; retired_installs: number
}
export interface Scores { computed: string; summary: { entries: number; live: number; median: number | null }; scores: Record<string, RouteScore> }

export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const ageDays = (day: string, today: string) => Math.round((Date.parse(today) - Date.parse(day)) / DAY_MS);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const count = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

// Only today's or yesterday's (UTC) counts. Routes this registry does not list
// (a client release can ship one first) are dropped, not rejected.
export function parseFeedback(value: unknown, registry: Registry, now: number): FeedbackReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const report = value as Record<string, unknown>;
  if (!exactKeys(report, FEEDBACK_FIELDS) || report.version !== 1 || typeof report.install !== 'string' || !/^[0-9a-f]{32}$/.test(report.install)
    || typeof report.client !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(report.client)
    || typeof report.day !== 'string' || ![utcDay(now), utcDay(now - DAY_MS)].includes(report.day)
    || !Array.isArray(report.routes) || !report.routes.length || report.routes.length > 100) return;
  const listed = new Set(registry.adapters.map(adapter => adapter.id)), seen = new Set<string>(), routes: FeedbackRoute[] = [];
  for (const item of report.routes as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const route = item as Record<string, unknown>;
    if (!exactKeys(route, FEEDBACK_ROUTE_FIELDS) || typeof route.id !== 'string' || !ID_PATTERN.test(route.id) || seen.has(route.id)
      || !COUNT_FIELDS.every(field => count(route[field], 1_000_000)) || !count(route.latency_ms, 3_600_000) || typeof route.retired !== 'boolean') return;
    seen.add(route.id);
    if (listed.has(route.id)) routes.push(route as unknown as FeedbackRoute);
  }
  return { ...(value as FeedbackReport), routes };
}

interface Row { day: string; install: string; id: string; ok: number; failed: number; quota: number; auth: number; signup_ok: number; signup_failed: number; retired: number }
// A decaying 0–100 liveliness score per entry from the last 14 UTC days.
export function computeScores(rows: readonly Row[], ids: readonly string[], now: number): Scores {
  const today = utcDay(now), scores: Record<string, RouteScore> = {};
  for (const id of ids) {
    let s = 0, f = 0, quota = 0, attempts = 0, signupOk = 0, signupFailed = 0, reports = 0, lastOk: string | undefined;
    const installs = new Set<string>(), retired = new Set<string>();
    for (const row of rows) {
      const age = ageDays(row.day, today);
      if (row.id !== id || age < 0 || age >= SCORE_WINDOW_DAYS) continue;
      reports++;
      // One heavy install cannot dominate; older days count less.
      const k = Math.min(1, 200 / Math.max(1, row.ok + row.failed)), w = 0.5 ** (age / HALF_LIFE_DAYS);
      s += w * k * row.ok; f += w * k * row.failed;
      quota += row.quota; attempts += row.ok + row.failed + row.quota;
      signupOk += row.signup_ok; signupFailed += row.signup_failed;
      if (row.ok > 0 && (!lastOk || row.day > lastOk)) lastOk = row.day;
      if (row.ok > 0 && age < 7) installs.add(row.install);
      if (row.retired && age <= 1) retired.add(row.install);
    }
    const reliability = reports ? (s + 1) / (s + f + 2) : null;
    const since = lastOk === undefined ? undefined : ageDays(lastOk, today);
    const freshness = since === undefined ? 0 : 0.5 ** (since / HALF_LIFE_DAYS);
    scores[id] = {
      score: reliability === null ? null : Math.round(100 * reliability * freshness),
      state: !reports ? 'unknown' : since === undefined || since >= 3 ? 'dead' : 'live',
      reliability: reliability === null ? null : Math.round(reliability * 1000) / 1000, last_ok: lastOk ?? null,
      installs_7d: installs.size, reports, quota_rate: attempts ? Math.round(quota / attempts * 1000) / 1000 : null,
      signup_rate: Math.round((signupOk + 1) / (signupOk + signupFailed + 2) * 1000) / 1000, signup_attempts: signupOk + signupFailed,
      retired_installs: retired.size
    };
  }
  const known = Object.values(scores).map(score => score.score).filter((score): score is number => score !== null).sort((a, b) => a - b);
  const median = known.length ? known.length % 2 ? known[(known.length - 1) / 2]! : Math.round((known[known.length / 2 - 1]! + known[known.length / 2]!) / 2) : null;
  return { computed: new Date(now).toISOString(), summary: { entries: ids.length, live: Object.values(scores).filter(score => score.state === 'live').length, median }, scores };
}

// Registry write history and router feedback, in the gateway's existing SQLite database.
export class RegistryStore {
  constructor(readonly db: Client, private now: () => number = Date.now) {}
  async init() {
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS registry_writes(at INTEGER NOT NULL,login TEXT NOT NULL,id TEXT NOT NULL,before_json TEXT,after_json TEXT);
      CREATE TABLE IF NOT EXISTS registry_feedback(day TEXT NOT NULL,install TEXT NOT NULL,id TEXT NOT NULL,ok INTEGER NOT NULL,failed INTEGER NOT NULL,
        quota INTEGER NOT NULL,auth INTEGER NOT NULL,latency_ms INTEGER NOT NULL,signup_ok INTEGER NOT NULL,signup_failed INTEGER NOT NULL,retired INTEGER NOT NULL,
        PRIMARY KEY(day,install,id));
    `);
  }
  async recordWrite(login: string, id: string, before: unknown, after: unknown) {
    const result = await this.db.execute({ sql: 'INSERT INTO registry_writes VALUES (?,?,?,?,?)',
      args: [this.now(), login, id, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)] });
    return Number(result.lastInsertRowid);
  }
  async writes() {
    return (await this.db.execute('SELECT rowid AS write,at,login,id,before_json,after_json FROM registry_writes ORDER BY rowid')).rows as unknown as { write: number; at: number; login: string; id: string; before_json: string | null; after_json: string | null }[];
  }
  async beforeWrite(write: number) {
    const result = await this.db.execute({ sql: 'SELECT before_json FROM registry_writes WHERE rowid = ?', args: [write] });
    return result.rows[0]?.before_json as string | null | undefined;
  }
  // A report carries cumulative day totals, so a replay replaces rather than adds.
  async recordFeedback(report: FeedbackReport) {
    if (!report.routes.length) return;
    await this.db.batch([
      ...report.routes.map(route => ({ sql: 'INSERT OR REPLACE INTO registry_feedback VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        args: [report.day, report.install, route.id, route.ok, route.failed, route.quota, route.auth, route.latency_ms, route.signup_ok, route.signup_failed, route.retired ? 1 : 0] })),
      { sql: 'DELETE FROM registry_feedback WHERE day < ?', args: [utcDay(this.now() - RETENTION_DAYS * DAY_MS)] }
    ], 'write');
  }
  async scores(registry: Registry): Promise<Scores> {
    const rows = (await this.db.execute({ sql: 'SELECT day,install,id,ok,failed,quota,auth,signup_ok,signup_failed,retired FROM registry_feedback WHERE day >= ?',
      args: [utcDay(this.now() - (SCORE_WINDOW_DAYS - 1) * DAY_MS)] })).rows as unknown as Row[];
    return computeScores(rows.map(row => ({ ...row, ok: Number(row.ok), failed: Number(row.failed), quota: Number(row.quota), auth: Number(row.auth),
      signup_ok: Number(row.signup_ok), signup_failed: Number(row.signup_failed), retired: Number(row.retired) })), registry.adapters.map(adapter => adapter.id), this.now());
  }
}
