import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client, Transaction } from '@libsql/client';
import { sanitizeSafeDiagnosticMetadata } from './diagnostics.js';
import type { ErrorCode, ModelRequest, SourceError } from './source.js';

export const RETIRE_AFTER_FAILURES = 5;
export const ROUTING_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ADAPTIVE_BACKOFF_SECONDS = 2 * 60 * 60;
// A retired route is not dead forever: after a bounded wait it may take ONE real routed request.
// Success clears the retirement; a failed trial doubles the next wait, up to the cap.
export const RETIRED_REOPEN_MS = 15 * 60 * 1000;
export const MAX_RETIRED_REOPEN_MS = 4 * 60 * 60 * 1000;
export const retiredReopenDelay = (trials: number) => Math.min(MAX_RETIRED_REOPEN_MS, RETIRED_REOPEN_MS * 2 ** Math.min(Math.max(0, trials), 10));
export const routingWorkloads = ['interactive-text', 'interactive-tools', 'background-text', 'background-tools'] as const;
export type RoutingWorkload = typeof routingWorkloads[number];
export type RoutingProfile = RoutingWorkload | 'all';
export interface RoutingPerformance { samples: number; reliability: number; latencyMs: number; failureCostMs: number; at: number; lastSuccessAt?: number }
export interface RoutingBackoff { code: ErrorCode; signature: string; streak: number; at: number; until: number; quotaUntil?: number; trials?: number }
export interface RoutingHistorySnapshot { performance: { source: string; profile: RoutingProfile; value: RoutingPerformance }[]; backoff: { source: string; value: RoutingBackoff }[] }
const workloads = new AsyncLocalStorage<RoutingWorkload>();
export const activeRoutingWorkload = () => workloads.getStore();
export const toolFailureSignature = (signature?: string) => signature?.split(':')[2] === 'response_tools';
export const withRoutingWorkload = <T>(workload: RoutingWorkload, run: () => T) => workloads.run(workload, run);
export function routingWorkload(request: ModelRequest, background = false): RoutingWorkload {
  return `${background ? 'background' : 'interactive'}-${request.tools.some(tool => tool.type === 'function') ? 'tools' : 'text'}`;
}
export const currentRoutingWorkload = (request: ModelRequest) => workloads.getStore() ?? routingWorkload(request);
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const profiles = new Set<string>(['all', ...routingWorkloads]);
const backoffCodes = new Set<ErrorCode>(['quota', 'upstream', 'timeout', 'refused']);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const CONTENTION_RETRY_MS = 2000;
const unsafe = () => new Error('Routing history requires bounded private local state');

export function nextRoutingPerformance(previous: RoutingPerformance | undefined, success: boolean, durationMs: number, at: number): RoutingPerformance {
  // Completions can queue behind a sibling captured a few milliseconds later.
  if (previous && previous.at - at > 5000) return success
    ? { ...previous, lastSuccessAt: Math.max(at, previous.lastSuccessAt ?? 0) } : previous;
  const old = previous && at - previous.at <= ROUTING_HISTORY_TTL_MS ? previous : undefined;
  const observedAt = Math.max(at, old?.at ?? at);
  const duration = Math.max(250, Math.min(30 * 60 * 1000, Number.isFinite(durationMs) ? durationMs : 10000));
  return { samples: Math.min(1000, (old?.samples ?? 0) + 1),
    reliability: old ? old.reliability * .8 + Number(success) * .2 : Number(success),
    latencyMs: success ? old ? old.latencyMs * .7 + duration * .3 : duration : old?.latencyMs ?? 10000,
    failureCostMs: old ? old.failureCostMs * .8 + (success ? 0 : duration) * .2 : success ? 0 : duration,
    at: observedAt, ...(success ? { lastSuccessAt: Math.max(at, old?.lastSuccessAt ?? 0) } : old?.lastSuccessAt !== undefined ? { lastSuccessAt: old.lastSuccessAt } : {}) };
}
// A request-shape refusal never reached the provider: the request or Grunt is at fault, not the route.
export function localRequestRefusal(error: SourceError) {
  return sanitizeSafeDiagnosticMetadata(error.diagnostics).failureReason?.startsWith('request_') === true;
}
// A valid server retry hint supplies the delay independently of the failure class.
export function upstreamRetryHint(error: SourceError) {
  const status = error.diagnostics?.httpStatus, retry = error.retryAfter;
  return error.code === 'upstream' && status !== undefined && Number.isInteger(status) && status >= 500 && status < 600
    && retry !== undefined && Number.isFinite(retry) && retry >= 0;
}
// A failure that means a congested or slow provider rather than a refusal: gateway errors, a reset or cut
// stream, or an output deadline. Used by sources that opt into a SlowUpstreamPolicy.
export function slowUpstreamFailure(error: SourceError) {
  if (error.code === 'timeout') return true;
  if (error.code !== 'upstream') return false;
  const safe = sanitizeSafeDiagnosticMetadata(error.diagnostics);
  return [502, 503, 504, 524].includes(safe.httpStatus ?? 0) || safe.networkCode === 'ECONNRESET' || safe.networkCode === 'ETIMEDOUT'
    || safe.failureReason === 'stream_read' || safe.failureReason === 'stream_incomplete';
}
export function routingFailureSignature(error: SourceError) {
  if (slowUpstreamFailure(error)) return 'outage:::';
  const safe = sanitizeSafeDiagnosticMetadata(error.diagnostics);
  return [error.code, safe.httpStatus ?? '', safe.failureReason ?? '', safe.networkCode ?? ''].join(':').toLowerCase();
}
// Parallel admitted calls can finish out of order. A quota is an absolute reset
// deadline, not a delay to restart when another failure arrives.
export function mergeRoutingBackoff(previous: RoutingBackoff | undefined, incoming: RoutingBackoff): RoutingBackoff {
  if (!previous) return incoming;
  const until = Math.max(previous.until, incoming.until);
  const quotaUntil = Math.max(previous.code === 'quota' ? previous.quotaUntil ?? previous.until : 0,
    incoming.code === 'quota' ? incoming.quotaUntil ?? incoming.until : 0);
  const quota = quotaUntil > Math.max(previous.at, incoming.at);
  if (previous.streak >= RETIRE_AFTER_FAILURES) return { ...previous, ...(quota ? { code: 'quota' as const, quotaUntil } : {}), until };
  const code = quota ? 'quota' : incoming.code;
  if (incoming.streak >= RETIRE_AFTER_FAILURES) return { ...incoming, code, until, ...(quota ? { quotaUntil } : {}) };
  if (incoming.at < previous.at) {
    if (incoming.code === 'quota' && quota) return { ...previous, code: 'quota', quotaUntil, until };
    return previous;
  }
  return { ...incoming, code, until, ...(quota ? { quotaUntil } : {}) };
}
export function quotaAfterRecovery(value: RoutingBackoff): RoutingBackoff {
  return { ...value, until: value.quotaUntil ?? value.until, signature: 'quota:::', streak: 1 };
}
export function nextRoutingBackoff(previous: RoutingBackoff | undefined, error: SourceError, seconds: number, adaptive: boolean, at: number): RoutingBackoff {
  const hintOnly = upstreamRetryHint(error) && !slowUpstreamFailure(error);
  if (previous && previous.streak >= RETIRE_AFTER_FAILURES && error.code !== 'quota') {
    // Half-open: only a failure at or after the reopen time is a failed trial. Earlier stragglers change nothing.
    if (at < previous.until) return previous;
    if (hintOnly) return { ...previous, until: Math.max(previous.until, at + seconds * 1000) };
    const trials = (previous.trials ?? 0) + 1;
    return { ...previous, at: Math.max(previous.at, at), until: at + Math.max(retiredReopenDelay(trials), slowUpstreamFailure(error) ? seconds * 1000 : 0), trials };
  }
  if (hintOnly) {
    const until = at + seconds * 1000;
    return previous ? { ...previous, until: Math.max(previous.until, until) } : { code: error.code, signature: 'hint:::', streak: 1, at, until };
  }
  const signature = routingFailureSignature(error);
  const repeated = error.code !== 'quota' && previous?.signature === signature && at >= previous.at && at - previous.at <= ROUTING_HISTORY_TTL_MS;
  const streak = repeated ? Math.min(RETIRE_AFTER_FAILURES, previous.streak + 1) : 1;
  // Explicit provider/reset hints bypass adaptive multiplication, including zero.
  const delay = adaptive && !upstreamRetryHint(error) ? Math.min(MAX_ADAPTIVE_BACKOFF_SECONDS, seconds * 2 ** (streak - 1)) : seconds;
  const retiring = error.code !== 'quota' && streak >= RETIRE_AFTER_FAILURES;
  return mergeRoutingBackoff(previous, { code: error.code, signature, streak, at, until: at + (retiring ? Math.max(RETIRED_REOPEN_MS, signature === 'outage:::' ? delay * 1000 : 0) : delay * 1000) });
}
function performanceValue(raw: unknown): RoutingPerformance | undefined {
  const value = object(raw);
  if (!Number.isSafeInteger(value.samples) || Number(value.samples) < 1 || Number(value.samples) > 1000
    || typeof value.reliability !== 'number' || !Number.isFinite(value.reliability) || value.reliability < 0 || value.reliability > 1
    || typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 250 || value.latencyMs > 1800000
    || typeof value.failureCostMs !== 'number' || !Number.isFinite(value.failureCostMs) || value.failureCostMs < 0 || value.failureCostMs > 1800000 || !validTime(value.at) || value.lastSuccessAt !== undefined && (!validTime(value.lastSuccessAt) || value.lastSuccessAt > value.at)) return;
  return { samples: Number(value.samples), reliability: value.reliability as number, latencyMs: value.latencyMs as number, failureCostMs: value.failureCostMs as number, at: value.at as number, ...(value.lastSuccessAt !== undefined ? { lastSuccessAt: value.lastSuccessAt as number } : {}) };
}
function backoffValue(raw: unknown): RoutingBackoff | undefined {
  const value = object(raw);
  if (!backoffCodes.has(value.code as ErrorCode) || typeof value.signature !== 'string' || !/^[a-z0-9_:]{1,200}$/.test(value.signature)
    || !Number.isSafeInteger(value.streak) || Number(value.streak) < 1 || Number(value.streak) > RETIRE_AFTER_FAILURES
    || !validTime(value.at) || !validTime(value.until) || value.until < value.at || value.until - value.at > 32 * 86400000
    || value.quotaUntil !== undefined && (value.code !== 'quota' || !validTime(value.quotaUntil) || value.quotaUntil < value.at || value.quotaUntil > value.until)) return;
  return { code: value.code as ErrorCode, signature: value.signature as string, streak: Number(value.streak), at: value.at as number, until: value.until as number, ...(value.quotaUntil !== undefined ? { quotaUntil: value.quotaUntil as number } : {}), ...(Number.isSafeInteger(value.trials) && Number(value.trials) > 0 && Number(value.trials) <= 1000 ? { trials: Number(value.trials) } : {}) };
}

/** Only fixed source/workload IDs, bounded numbers and allowlisted failure classes. */
const localQueues = new Map<string, { pending: Promise<unknown>; users: number }>();
export class RoutingHistory {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private serial: { pending: Promise<unknown>; users: number };
  private constructor(private client: Client, private path: string) {
    this.serial = localQueues.get(path) ?? { pending: Promise.resolve(), users: 0 };
    this.serial.users++; localQueues.set(path, this.serial);
  }
  static async open(directory: string): Promise<RoutingHistory> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) throw unsafe();
    const path = resolve(directory, 'routing-history.db');
    try { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe(); }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw unsafe();
    } finally { await file.close(); }
    const { createClient } = await import('@libsql/client');
    let client = createClient({ url: pathToFileURL(path).href, concurrency: 1 });
    try {
      await client.execute('PRAGMA busy_timeout=0');
      const { version, journalMode } = await (async () => {
        const deadline = Date.now() + CONTENTION_RETRY_MS;
        for (let attempt = 0; ; attempt++) {
          try {
            const mode = (await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode;
            const version = Number((await client.execute('PRAGMA user_version')).rows[0]?.user_version);
            return { version, journalMode: String(mode).toLowerCase() };
          } catch (error) {
            if (Date.now() >= deadline || !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: unknown }).code))) throw error;
            // Retry only idempotent metadata reads. A failed native read can
            // leave a statement attached, so start with a fresh connection.
            client.close();
            client = createClient({ url: pathToFileURL(path).href, concurrency: 1 });
            await client.execute('PRAGMA busy_timeout=0');
            await new Promise(resolve => setTimeout(resolve, Math.min(25, 2 ** (attempt + 1))));
          }
        }
      })();
      if (journalMode !== 'delete') await client.execute('PRAGMA journal_mode=DELETE');
      if (version !== 0 && version !== 1 && version !== 2) throw unsafe();
      if (version < 2) await client.batch([
        'CREATE TABLE IF NOT EXISTS routing_performance (source TEXT NOT NULL, profile TEXT NOT NULL, value TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(source,profile))',
        'CREATE TABLE IF NOT EXISTS routing_backoff (source TEXT PRIMARY KEY, value TEXT NOT NULL, at REAL NOT NULL)',
        "DELETE FROM routing_backoff WHERE source='kilo' AND json_valid(value) AND json_extract(value,'$.code')='quota' AND (SELECT user_version FROM pragma_user_version)<2",
        'PRAGMA user_version=2'
      ], 'write');
      return new RoutingHistory(client, path);
    } catch (error) { client.close(); throw error; }
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(unsafe());
    const next = this.serial.pending.catch(() => {}).then(work);
    this.serial.pending = next; this.pending = next;
    return next;
  }
  private async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    let tx: Transaction | undefined;
    const deadline = performance.now() + CONTENTION_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try { tx = await this.client.transaction('write'); break; }
      catch (error) {
        if (performance.now() >= deadline || !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: unknown }).code))) throw error;
        // libsql can retain the failed BEGIN statement on this connection, so a
        // later COMMIT reports statements in progress even after the lock ends.
        // No work() has run: discard only the poisoned connection before retry.
        this.client.close();
        const { createClient } = await import('@libsql/client');
        this.client = createClient({ url: pathToFileURL(this.path).href, concurrency: 1 });
        await this.client.execute('PRAGMA busy_timeout=0');
        // Yield instead of blocking the event loop while a sibling commits.
        await new Promise(resolve => setTimeout(resolve, Math.min(25, 2 ** (attempt + 1))));
      }
    }
    try {
      const result = await work(tx);
      for (let attempt = 0; ; attempt++) {
        try {
          // libsql's commit() settles even on SQLITE_BUSY. Its prepared COMMIT
          // can also remain attached after failure. exec keeps this transaction
          // owned and cleans the failed statement so only COMMIT is retried.
          await tx.executeMultiple('COMMIT');
          return result;
        } catch (error) {
          if (performance.now() >= deadline || !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: unknown }).code))) throw error;
          // DELETE-journal readers may outlive BEGIN IMMEDIATE and block only
          // the final exclusive lock. Never replay the completed observations.
          await new Promise(resolve => setTimeout(resolve, Math.min(25, 2 ** (attempt + 1))));
        }
      }
    } finally {
      try { if (!tx.closed) await tx.executeMultiple('ROLLBACK'); }
      finally { tx.close(); }
    }
  }
  snapshot(now = Date.now()): Promise<RoutingHistorySnapshot> {
    return this.run(async () => {
      const cutoff = now - ROUTING_HISTORY_TTL_MS;
      const result: RoutingHistorySnapshot = { performance: [], backoff: [] };
      for (const row of (await this.client.execute({ sql: 'SELECT source,profile,value FROM routing_performance WHERE at>=? AND at<=? ORDER BY at DESC LIMIT 500', args: [cutoff, now] })).rows) {
        if (typeof row.source !== 'string' || !identifier.test(row.source) || typeof row.profile !== 'string' || !profiles.has(row.profile)) continue;
        let value; try { value = performanceValue(JSON.parse(String(row.value))); } catch { continue; }
        if (value && value.at >= cutoff && value.at <= now) result.performance.push({ source: row.source, profile: row.profile as RoutingProfile, value });
      }
      for (const row of (await this.client.execute({ sql: 'SELECT source,value FROM routing_backoff ORDER BY at DESC LIMIT 100' })).rows) {
        if (typeof row.source !== 'string' || !identifier.test(row.source)) continue;
        let value; try { value = backoffValue(JSON.parse(String(row.value))); } catch { continue; }
        if (value && value.at <= now && (value.at >= cutoff || value.until > now)) result.backoff.push({ source: row.source, value });
      }
      return result;
    });
  }
  record(source: string, profile: RoutingWorkload, success: boolean, durationMs: number, now: number): Promise<RoutingHistorySnapshot['performance']> {
    if (!identifier.test(source) || !(routingWorkloads as readonly string[]).includes(profile) || !validTime(now)) return Promise.reject(unsafe());
    return this.run(() => this.transaction(async tx => {
      const result: RoutingHistorySnapshot['performance'] = [];
      for (const key of ['all', profile] as const) {
        const row = (await tx.execute({ sql: 'SELECT value FROM routing_performance WHERE source=? AND profile=?', args: [source, key] })).rows[0];
        let old; try { old = performanceValue(JSON.parse(String(row?.value))); } catch { /* Corrupt observations are not routing authority. */ }
        const value = nextRoutingPerformance(old, success, durationMs, now);
        await tx.execute({ sql: 'INSERT INTO routing_performance(source,profile,value,at) VALUES (?,?,?,?) ON CONFLICT(source,profile) DO UPDATE SET value=excluded.value,at=excluded.at', args: [source, key, JSON.stringify(value), value.at] });
        result.push({ source, profile: key, value });
      }
      if (success) {
        await tx.execute({ sql: "DELETE FROM routing_backoff WHERE source=? AND json_extract(value,'$.code')<>'quota' AND at<? AND (? OR json_extract(value,'$.signature') NOT GLOB '*:*:response_tools:*')", args: [source, now, Number(profile.endsWith('-tools'))] });
        await tx.execute({ sql: "UPDATE routing_backoff SET value=json_set(value,'$.until',COALESCE(json_extract(value,'$.quotaUntil'),json_extract(value,'$.until')),'$.signature','quota:::','$.streak',1) WHERE source=? AND json_extract(value,'$.code')='quota' AND at<? AND (? OR json_extract(value,'$.signature') NOT GLOB '*:*:response_tools:*')", args: [source, now, Number(profile.endsWith('-tools'))] });
      }
      await tx.execute({ sql: 'DELETE FROM routing_performance WHERE rowid NOT IN (SELECT rowid FROM routing_performance ORDER BY at DESC LIMIT 500)', args: [] });
      return result;
    }));
  }
  failure(source: string, error: SourceError, seconds: number, adaptive: boolean, now: number): Promise<RoutingBackoff> {
    if (!identifier.test(source) || !backoffCodes.has(error.code) || !validTime(now) || !Number.isFinite(seconds) || seconds < 0 || seconds > 32 * 86400) return Promise.reject(unsafe());
    return this.run(() => this.transaction(async tx => {
      const row = (await tx.execute({ sql: 'SELECT value FROM routing_backoff WHERE source=?', args: [source] })).rows[0];
      let old; try { old = backoffValue(JSON.parse(String(row?.value))); } catch { /* Discard corrupt advisory state. */ }
      if (error.code !== 'quota') {
        const matching = toolFailureSignature(routingFailureSignature(error)) ? "profile IN ('interactive-tools','background-tools')" : "profile='all'";
        const rows = await tx.execute({ sql: `SELECT value FROM routing_performance WHERE source=? AND ${matching}`, args: [source] });
        let recoveredAt = 0;
        for (const row of rows.rows) {
          try { recoveredAt = Math.max(recoveredAt, performanceValue(JSON.parse(String(row.value)))?.lastSuccessAt ?? 0); }
          catch { /* Invalid recovery is not authority. */ }
        }
        if (recoveredAt > now) {
          if (old?.code === 'quota' && old.until > now) return old;
          if (old && old.at >= recoveredAt) return old;
          // Report no active hold without resurrecting a late pre-recovery failure.
          return { code: error.code, signature: routingFailureSignature(error), streak: 1, at: now, until: now };
        }
      }
      const value = nextRoutingBackoff(old, error, seconds, adaptive, now);
      await tx.execute({ sql: 'INSERT INTO routing_backoff(source,value,at) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value,at=excluded.at', args: [source, JSON.stringify(value), value.at] });
      await tx.execute('DELETE FROM routing_backoff WHERE rowid NOT IN (SELECT rowid FROM routing_backoff ORDER BY at DESC LIMIT 100)');
      return value;
    }));
  }
  clear(source: string): Promise<void> {
    return this.run(async () => { await this.client.execute({ sql: 'DELETE FROM routing_backoff WHERE source=?', args: [source] }); });
  }
  async flush() { await this.pending.catch(() => {}); }
  close(): Promise<void> { return this.closing ??= (async () => { this.closed = true; await this.flush(); this.client.close(); if (--this.serial.users === 0) localQueues.delete(this.path); })(); }
}
