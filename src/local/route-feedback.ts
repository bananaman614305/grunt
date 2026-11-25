import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ErrorCode } from './source.js';

// Daily per-route counts this router sends to the registry, and the registry's
// liveliness scores it reads back. Never sent: prompts, responses, keys,
// provider error text, model names, paths or hosts.
const DAY_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_ROUTE_KEYS = ['id', 'ok', 'failed', 'quota', 'auth', 'latency_ms', 'signup_ok', 'signup_failed', 'retired'] as const;
interface Counts { ok: number; failed: number; quota: number; auth: number; latencyMs?: number; signupOk: number; signupFailed: number }
export interface RouteFeedbackOptions {
  directory: string;
  // Registry endpoints, best first, for example https://api.grunt.run/v1/registry.
  urls: readonly string[];
  // Routes the current registry lists; the registry drops counts for other ids.
  listed: () => readonly string[];
  retired: (id: string) => boolean;
  client?: string;
  fleet?: (token: string) => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
export class RouteFeedback {
  private days = new Map<string, Map<string, Counts>>();
  private scores = new Map<string, number | null>();
  private install: Promise<string> | undefined;
  constructor(private options: RouteFeedbackOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private counts(id: string) {
    const day = utcDay(this.now());
    let routes = this.days.get(day);
    if (!routes) this.days.set(day, routes = new Map());
    let counts = routes.get(id);
    if (!counts) routes.set(id, counts = { ok: 0, failed: 0, quota: 0, auth: 0, signupOk: 0, signupFailed: 0 });
    return counts;
  }
  // One routed reply. Cancellation is not provider health.
  record(id: string, outcome: 'ok' | ErrorCode, latencyMs = 0) {
    if (outcome === 'cancelled') return;
    const counts = this.counts(id);
    if (outcome === 'ok') {
      counts.ok++;
      counts.latencyMs = counts.latencyMs === undefined ? latencyMs : counts.latencyMs * .7 + latencyMs * .3;
    } else if (outcome === 'quota') counts.quota++;
    else if (outcome === 'logged_out' || outcome === 'not_installed') counts.auth++;
    else counts.failed++;
  }
  signup(id: string, ok: boolean) { if (ok) this.counts(id).signupOk++; else this.counts(id).signupFailed++; }
  // The registry's 0–100 score for a route; null or undefined when it has none.
  score(id: string) { return this.scores.get(id); }
  private installId() {
    const path = join(this.options.directory, 'registry-install');
    return this.install ??= readFile(path, 'utf8').then(value => {
      if (!/^[0-9a-f]{32}$/.test(value.trim())) throw new Error('invalid install id');
      return value.trim();
    }).catch(async () => {
      const id = randomBytes(16).toString('hex');
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await writeFile(path, id, { mode: 0o600 });
      return id;
    }).catch(error => { this.install = undefined; throw error; });
  }
  // The enrollment proof is separate from the ID stored with legacy feedback.
  // Publish a fully written private file even when two daemons enroll at once.
  private async fleetProof() {
    const path = join(this.options.directory, 'fleet-enrollment');
    const readProof = async () => {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size !== 64) throw new Error('Unsafe fleet enrollment state');
        return await file.readFile('utf8');
      } finally { await file.close(); }
    };
    try { return await readProof(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const temporary = path + '.' + randomBytes(12).toString('hex');
    try {
      await writeFile(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally { await rm(temporary, { force: true }); }
    return readProof();
  }
  payload(day: string, install: string) {
    const listed = new Set(this.options.listed());
    const routes = [...this.days.get(day) ?? []].filter(([id]) => listed.has(id)).map(([id, counts]) => ({
      id, ok: counts.ok, failed: counts.failed, quota: counts.quota, auth: counts.auth,
      latency_ms: Math.round((counts.latencyMs ?? 0) / 100) * 100, signup_ok: counts.signupOk, signup_failed: counts.signupFailed,
      retired: this.options.retired(id)
    }));
    return routes.length ? { version: 1 as const, install, client: this.options.client ?? 'unknown', day, routes } : undefined;
  }
  private async request(path: string, init?: RequestInit) {
    for (const url of this.options.urls) {
      try {
        const response = await (this.options.fetcher ?? fetch)(`${url}/${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (response.ok) return response;
        await response.body?.cancel();
      } catch { /* Try the next registry endpoint. */ }
    }
  }
  // Send today's running totals and yesterday's final ones, then read the scores.
  async exchange() {
    const today = utcDay(this.now()), yesterday = utcDay(this.now() - DAY_MS);
    for (const day of this.days.keys()) if (day !== today && day !== yesterday) this.days.delete(day);
    try {
      const install = await this.installId();
      const proof = this.options.fleet ? await this.fleetProof().catch(() => '') : '';
      const fleetHeaders: Record<string,string> = /^[a-f0-9]{64}$/.test(proof) ? { 'X-Grunt-Fleet': proof } : {};
      let fleetToken: string | undefined;
      for (const day of [yesterday, today]) {
        const body = this.payload(day, install) ?? (day === today && fleetHeaders['X-Grunt-Fleet'] && !fleetToken
          ? { version: 1, install, client: this.options.client ?? 'unknown', day, routes: [] } : undefined);
        if (!body) continue;
        const sent = await this.request('feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...fleetHeaders }, body: JSON.stringify(body) });
        const issued = sent?.headers.get('X-Grunt-Fleet-Token');
        if (issued && /^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(issued)) fleetToken = issued;
        if (sent && day === yesterday) this.days.delete(day);
      }
      if (fleetToken) await this.options.fleet?.(fleetToken);
    } catch { /* Feedback is advisory; routing never waits on it. */ }
    try {
      const response = await this.request('scores');
      const scores = (await response?.json() as { scores?: Record<string, { score?: unknown }> } | undefined)?.scores;
      if (scores && typeof scores === 'object') {
        this.scores = new Map(Object.entries(scores).map(([id, value]) => [id,
          typeof value?.score === 'number' && Number.isFinite(value.score) ? Math.max(0, Math.min(100, value.score)) : null]));
      }
    } catch { /* Keep the last scores. */ }
  }
}
