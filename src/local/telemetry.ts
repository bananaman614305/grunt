import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ErrorCode } from './source.js';
import { POSTHOG_KEY } from './telemetry-key.js';

// Anonymous usage telemetry sent to US PostHog (docs/router.md#4-usage-telemetry).
// Using Grunt requires it whenever the build embeds a project key. Events carry
// only the counts listed below. Never sent: prompts, responses, keys, provider
// error text, model names, paths or hosts.
export const POSTHOG_HOST = 'https://us.i.posthog.com';
export const HEARTBEAT_KEYS = ['version', 'os', 'arch', 'open_routes', 'enabled_sources'] as const;
export const ROUTE_SUMMARY_KEYS = ['version', 'route', 'ok', 'failed', 'quota', 'auth', 'latency_ms', 'signup_ok', 'signup_failed', 'retired'] as const;
export const SETUP_KEYS = ['version', 'os', 'arch', 'sources_configured'] as const;
// PostHog control properties: deduplication, no person profiles, no GeoIP lookup.
export const SYSTEM_KEYS = ['$insert_id', '$process_person_profile', '$geoip_disable'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;

type Env = Record<string, string | undefined>;
type Properties = Record<string, string | number | boolean>;
export interface TelemetryEvent { event: string; distinct_id: string; uuid: string; timestamp: string; properties: Properties }
interface Counts { ok: number; failed: number; quota: number; auth: number; latencyMs?: number; signupOk: number; signupFailed: number }

export const embeddedPostHogKey = () => typeof GRUNT_POSTHOG_KEY === 'string' ? GRUNT_POSTHOG_KEY : POSTHOG_KEY;
// A release build's embedded key and US PostHog host cannot be changed. Only a
// keyless build reads a test key and host from the environment.
export function postHogKey(env: Env = process.env, embedded = embeddedPostHogKey()) {
  return embedded || env.GRUNT_POSTHOG_KEY || '';
}
export function postHogHost(env: Env = process.env, embedded = embeddedPostHogKey()) {
  return embedded ? POSTHOG_HOST : (env.GRUNT_POSTHOG_HOST || POSTHOG_HOST).replace(/\/+$/, '');
}
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

// The random install id in the daemon config directory, hashed so PostHog never
// stores the file's value.
export async function anonymousId(directory: string) {
  const path = join(directory, 'registry-install');
  let install = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{32}$/.test(install)) {
    install = randomBytes(16).toString('hex');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, install, { mode: 0o600 });
  }
  return createHash('sha256').update('grunt-posthog-v1:' + install).digest('hex');
}

// PostHog merges events that share uuid, timestamp, event and distinct_id, so a
// day's later totals replace its earlier ones.
function event(name: string, distinctId: string, insertId: string, day: string, properties: Properties): TelemetryEvent {
  const hex = createHash('sha256').update(insertId).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | parseInt(hex[16]!, 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { event: name, distinct_id: distinctId, uuid, timestamp: `${day}T00:00:00.000Z`,
    properties: { ...properties, $insert_id: insertId, $process_person_profile: false, $geoip_disable: true } };
}

interface SendOptions { env?: Env; fetcher?: typeof fetch }
// One batch request. Resolves false on any failure and never throws.
export async function sendBatch(batch: TelemetryEvent[], options: SendOptions = {}) {
  const key = postHogKey(options.env);
  if (!key || !batch.length) return false;
  try {
    const response = await (options.fetcher ?? fetch)(`${postHogHost(options.env)}/batch/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ api_key: key, batch })
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch { return false; }
}

export interface TelemetryOptions {
  directory: string;
  // Routes the current registry lists; counts for other ids are never sent.
  listed: () => readonly string[];
  retired: (id: string) => boolean;
  stats?: () => { openRoutes: number; enabledSources: number };
  version?: string;
  env?: Env;
  fetcher?: typeof fetch;
  now?: () => number;
}
export class PostHogTelemetry {
  private days = new Map<string, Map<string, Counts>>();
  constructor(private options: TelemetryOptions) {}
  get enabled() { return Boolean(postHogKey(this.options.env)); }
  private now() { return (this.options.now ?? Date.now)(); }
  private get version() { return this.options.version ?? 'unknown'; }
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
  heartbeat(distinctId: string, day = utcDay(this.now())) {
    const stats = this.options.stats?.() ?? { openRoutes: 0, enabledSources: 0 };
    return event('daemon_heartbeat', distinctId, `hb:${distinctId}:${day}`, day,
      { version: this.version, os: process.platform, arch: process.arch, open_routes: stats.openRoutes, enabled_sources: stats.enabledSources });
  }
  summaries(distinctId: string, day: string) {
    const listed = new Set(this.options.listed());
    return [...this.days.get(day) ?? []].filter(([route]) => listed.has(route)).map(([route, counts]) =>
      event('route_daily_summary', distinctId, `route:${distinctId}:${day}:${route}`, day, {
        version: this.version, route, ok: counts.ok, failed: counts.failed, quota: counts.quota, auth: counts.auth,
        latency_ms: Math.round((counts.latencyMs ?? 0) / 100) * 100, signup_ok: counts.signupOk, signup_failed: counts.signupFailed,
        retired: this.options.retired(route)
      }));
  }
  // Today's heartbeat and running totals, plus yesterday's final totals, which
  // are dropped once PostHog accepts them. Never throws; routing never waits on it.
  async exchange() {
    const today = utcDay(this.now()), yesterday = utcDay(this.now() - DAY_MS);
    for (const day of this.days.keys()) if (day !== today && day !== yesterday) this.days.delete(day);
    if (!this.enabled) return;
    try {
      const distinctId = await anonymousId(this.options.directory);
      const setup = await queuedSetup(this.options.directory, distinctId);
      const batch = [this.heartbeat(distinctId, today), ...setup ? [setup.event] : [], ...this.summaries(distinctId, yesterday), ...this.summaries(distinctId, today)];
      if (await sendBatch(batch, { ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}) })) {
        this.days.delete(yesterday);
        // Remove only the queued event that was sent; a newer setup may have replaced it.
        if (setup) await rm(setup.path).catch(() => {});
      }
    } catch { /* Telemetry is best effort. */ }
  }
}

const SETUP_FILE = 'telemetry-setup.json';
export interface SetupCompletedOptions { directory: string; sourcesConfigured: number; version?: string; env?: Env; now?: () => number }
// Setup queues setup_completed in a private file and makes no network request,
// so it never holds the CLI open. The daemon sends it on its next exchange.
export async function queueSetupCompleted(options: SetupCompletedOptions) {
  if (!postHogKey(options.env)) return false;
  try {
    const path = join(options.directory, SETUP_FILE), temporary = `${path}.${randomBytes(8).toString('hex')}`;
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ day: utcDay((options.now ?? Date.now)()), version: options.version ?? 'unknown', sources_configured: options.sourcesConfigured }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path).catch(async error => { await rm(temporary, { force: true }); throw error; });
    return true;
  } catch { return false; }
}
async function queuedSetup(directory: string, distinctId: string) {
  const path = join(directory, SETUP_FILE), sending = `${path}.sending`;
  // Claim the queued file so a setup that finishes during the send is kept.
  await rename(path, sending).catch(() => {});
  let saved: unknown;
  try { saved = JSON.parse(await readFile(sending, 'utf8')); } catch { return undefined; }
  const { day, version, sources_configured: count } = (saved ?? {}) as Record<string, unknown>;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)
    || !Number.isSafeInteger(count) || (count as number) < 0) { await rm(sending, { force: true }); return undefined; }
  return { path: sending, event: event('setup_completed', distinctId, `setup:${distinctId}:${day}`, day,
    { version, os: process.platform, arch: process.arch, sources_configured: count as number }) };
}
