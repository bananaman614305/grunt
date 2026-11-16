import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000;
export const MAINTENANCE_GAP = 60000;
export const MAINTENANCE_JITTER = 30000;
// The runtime bounds its source check with this signal deadline and still
// awaits native cleanup. A crash reservation covers that bound plus the gap.
export const MAINTENANCE_CHECK_TIMEOUT = 180000;
const CRASH_RESERVATION = MAINTENANCE_CHECK_TIMEOUT + MAINTENANCE_GAP + MAINTENANCE_JITTER;
const DEFER_INTERVAL = 5 * 60000;
const outcomes = new Set(['passed', 'failed', 'deferred']);
const evidence = new Set(['reply', 'metadata', 'local']);
const codes = new Set(['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled', 'busy', 'foreground', 'consent']);
export type MaintenanceCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream' | 'refused' | 'cancelled' | 'busy' | 'foreground' | 'consent';
export interface MaintenanceResult {
  outcome: 'passed' | 'failed' | 'deferred';
  evidence?: 'reply' | 'metadata' | 'local';
  code?: MaintenanceCode;
  retryAt?: number;
  lastSuccessAt?: number;
}
export interface MaintenanceEntry {
  lastAttemptAt?: number;
  lastCheckedAt?: number;
  nextCheckAt: number;
  outcome?: MaintenanceResult['outcome'];
  evidence?: MaintenanceResult['evidence'];
  code?: MaintenanceCode;
}
interface MaintenanceOptions {
  directory: string;
  providers: () => readonly string[];
  check: (id: string, signal: AbortSignal) => Promise<MaintenanceResult>;
  now?: () => number;
  random?: () => number;
  notify?: (message: string) => void;
}
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const unsafeState = () => new Error('Provider maintenance requires private local state');

/** Independent from onboarding: one owned check, followed by a quiet gap. */
export class DailyMaintenance {
  private entries = new Map<string, MaintenanceEntry>();
  private nextStartAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private initialization: Promise<void> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private controller = new AbortController();
  constructor(private options: MaintenanceOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private gap() {
    const random = (this.options.random ?? Math.random)();
    return MAINTENANCE_GAP + Math.floor(Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0)) * MAINTENANCE_JITTER);
  }
  private ids() {
    return [...new Set(this.options.providers().filter(id => idPattern.test(id)))].slice(0, 100);
  }
  private reconcile() {
    const ids = this.ids();
    for (const id of this.entries.keys()) if (!ids.includes(id)) this.entries.delete(id);
    for (const id of ids) if (!this.entries.has(id)) this.entries.set(id, { nextCheckAt: this.now() });
    return ids;
  }
  snapshot(): Record<string, MaintenanceEntry> {
    return Object.fromEntries(this.ids().flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [[id, { ...entry }]] : [];
    }));
  }
  start(): Promise<void> {
    return this.initialization ??= (async () => {
      await this.load();
      if (this.closed) return;
      this.reconcile();
      await this.persist();
      this.schedule();
    })();
  }
  private async directory() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw unsafeState();
  }
  private async load() {
    await this.directory();
    let file;
    try {
      file = await open(join(this.options.directory, 'maintenance.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw unsafeState();
      let value: unknown;
      try { value = JSON.parse(await file.readFile('utf8')); }
      catch { this.nextStartAt = this.now() + MAINTENANCE_GAP; return; }
      const saved = value as { version?: unknown; nextStartAt?: unknown; entries?: unknown } | null;
      if (!saved || saved.version !== 1 || !time(saved.nextStartAt) || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)
        || Object.keys(saved.entries).length > 100) { this.nextStartAt = this.now() + MAINTENANCE_GAP; return; }
      this.nextStartAt = Math.min(saved.nextStartAt, this.now() + CRASH_RESERVATION);
      for (const [id, raw] of Object.entries(saved.entries)) {
        if (!idPattern.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if (!time(item.nextCheckAt)) continue;
        const entry: MaintenanceEntry = { nextCheckAt: item.nextCheckAt };
        for (const key of ['lastAttemptAt', 'lastCheckedAt'] as const) if (time(item[key])) entry[key] = item[key];
        if (typeof item.outcome === 'string' && outcomes.has(item.outcome)) entry.outcome = item.outcome as MaintenanceResult['outcome'];
        if (typeof item.evidence === 'string' && evidence.has(item.evidence)) entry.evidence = item.evidence as MaintenanceResult['evidence'];
        if (typeof item.code === 'string' && codes.has(item.code)) entry.code = item.code as MaintenanceCode;
        this.entries.set(id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafeState();
      this.nextStartAt = this.now();
    } finally { await file?.close(); }
  }
  private async persist() {
    await this.directory();
    const temporary = join(this.options.directory, `maintenance.${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, nextStartAt: this.nextStartAt, entries: Object.fromEntries(this.entries) }));
      await file.close();
      await rename(temporary, join(this.options.directory, 'maintenance.json'));
    } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  private schedule() {
    if (this.closed || this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.reconcile();
    const due = Math.min(...[...this.entries.values()].map(entry => entry.nextCheckAt));
    // Revisit the provider list at least every minute, even if all current
    // providers are checked for today, so registry additions do not wait a day.
    const delay = Math.min(MAINTENANCE_GAP, Math.max(0, Math.max(this.nextStartAt, due) - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.tick().catch(() => {
        this.closed = true;
        this.controller.abort();
        try { this.options.notify?.('Provider maintenance paused; private state could not be updated'); } catch { /* Reporting cannot restart a failed queue. */ }
      }).finally(() => { this.active = undefined; this.schedule(); });
    }, delay);
    this.timer.unref();
  }
  private async tick() {
    if (this.closed || this.nextStartAt > this.now()) return;
    const ids = this.reconcile();
    const id = ids.filter(id => this.entries.get(id)!.nextCheckAt <= this.now())
      .sort((a, b) => this.entries.get(a)!.nextCheckAt - this.entries.get(b)!.nextCheckAt)[0];
    if (!id) return;
    const entry = this.entries.get(id)!;
    entry.lastAttemptAt = this.now();
    // A crash during a check does not replay it immediately on the next boot.
    entry.nextCheckAt = this.now() + DEFER_INTERVAL;
    this.nextStartAt = this.now() + CRASH_RESERVATION;
    await this.persist();
    if (this.closed) return;
    let result: MaintenanceResult;
    try { result = await this.options.check(id, this.controller.signal); }
    catch { result = { outcome: 'failed', code: 'upstream' }; }
    if (this.closed || this.controller.signal.aborted) {
      // close() awaits this write too: the callback may have needed its full
      // cancellation cleanup, so a restart must measure the gap from now.
      this.nextStartAt = this.now() + this.gap();
      await this.persist();
      return;
    }
    const outcome = outcomes.has(result?.outcome) ? result.outcome : 'failed';
    entry.outcome = outcome;
    delete entry.evidence; delete entry.code;
    if (typeof result?.evidence === 'string' && evidence.has(result.evidence)) entry.evidence = result.evidence;
    if (typeof result?.code === 'string' && codes.has(result.code)) entry.code = result.code;
    if (outcome !== 'deferred') entry.lastCheckedAt = this.now();
    const successAt = outcome === 'passed' && result.evidence === 'reply' && time(result.lastSuccessAt)
      && result.lastSuccessAt <= this.now() && result.lastSuccessAt > this.now() - MAINTENANCE_INTERVAL ? result.lastSuccessAt : this.now();
    entry.nextCheckAt = outcome === 'deferred' ? this.now() + DEFER_INTERVAL : successAt + MAINTENANCE_INTERVAL;
    if (time(result?.retryAt)) entry.nextCheckAt = Math.max(entry.nextCheckAt, result.retryAt);
    this.nextStartAt = this.now() + this.gap();
    await this.persist();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    await this.initialization?.catch(() => {});
    // Do not race a timeout against a native process: a new check cannot start
    // until the callback actually settles and its resource cleanup finishes.
    await this.active;
  }
}
