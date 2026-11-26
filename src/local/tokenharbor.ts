import { diagnosticFetch } from './diagnostics.js';
import { configRoot } from '../brand.js';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FreeApi, isDeepSeekV41Model, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import type { ModelRequest, QuotaWindow, Source } from './source.js';

export const TOKENHARBOR_STORE = { service: 'tokenharbor', label: 'grunt', api_hosts: ['tokenharbor.ai'], auth_shape: 'bearer' };
export const TOKENHARBOR_DEEPSEEK = 'deepseek-v4.1-flash:free';
const directory = () => configRoot();
const MAX_WINDOW_MS = 31 * 86400000;
const ALLOWANCE_CACHE_SECONDS = 15;
const instant = (value: unknown) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
interface Allowance {
  enabled: boolean;
  exhausted: boolean;
  window?: QuotaWindow;
}
function quotaWindow(data: { period_started_at?: unknown; reset_at?: unknown; period_ends_at?: unknown }, now: number): QuotaWindow | undefined {
  const startedAt = instant(data.period_started_at), reset = instant(data.reset_at);
  const resetAt = Number.isFinite(reset) ? reset : instant(data.period_ends_at);
  if (Number.isFinite(startedAt) && Number.isFinite(resetAt) && startedAt > 0 && startedAt <= now
    && resetAt > startedAt && resetAt >= now - ALLOWANCE_CACHE_SECONDS * 1000
    && resetAt - startedAt <= MAX_WINDOW_MS) return { startedAt, resetAt };
}
export async function writeTokenHarborGrant(grant: FreeApiGrant, location = directory()) {
  const url = new URL(grant.base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || typeof grant.token !== 'string' || !grant.token.trim()) throw new Error('Invalid Token Harbor grant');
  const temporary = join(location, `tokenharbor.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify({ base_url: grant.base_url.replace(/\/$/, ''), token: grant.token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, 'tokenharbor.json'));
  } finally { await rm(temporary, { force: true }); }
}
export class TokenHarbor implements Source {
  readonly inferenceOnly = true;
  readonly id = 'tokenharbor';
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  private location: string;
  private lastAllowance: { grant: FreeApiGrant; allowance: Allowance } | undefined;
  private check: { grant: FreeApiGrant; result: Promise<Allowance> } | undefined;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<FreeApiGrant>; now?: () => number } = {}) {
    this.location = options.directory ?? directory();
    this.source = new FreeApi('tokenharbor', { ...options, directory: this.location, loadGrant: () => this.grant(), fetcher: verifiedDeepSeekFetch(options.fetcher), verifyModel: isDeepSeekV41Model });
  }
  private async approved() { return (await readDataSharingConsent(this.location, ['tokenharbor'])).includes('tokenharbor'); }
  private grant() { return this.options.loadGrant?.() ?? readFreeApiGrant('tokenharbor', this.location); }
  private now() { return (this.options.now ?? Date.now)(); }
  private sameGrant(left: FreeApiGrant, right: FreeApiGrant) { return left.base_url === right.base_url && left.token === right.token; }
  quotaWindow() {
    const window = this.lastAllowance?.allowance.window;
    return window && window.resetAt > this.now() ? window : undefined;
  }
  private allowance(grant: FreeApiGrant) {
    if (this.check && this.sameGrant(this.check.grant, grant)) return this.check.result;
    if (this.lastAllowance && !this.sameGrant(this.lastAllowance.grant, grant)) this.lastAllowance = undefined;
    const result = this.readAllowance(grant).then(allowance => {
      if (this.check?.result === result) this.lastAllowance = { grant, allowance };
      return allowance;
    }).finally(() => {
      if (this.check?.result === result) this.check = undefined;
    });
    this.check = { grant, result };
    return result;
  }
  private async readAllowance(grant: FreeApiGrant): Promise<Allowance> {
    const response = await diagnosticFetch(this.options.fetcher ?? fetch, 'tokenharbor', 'account')(`${grant.base_url}/api/cli/free-tier`, {
      headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) { await response.body?.cancel(); return { enabled: false, exhausted: false }; }
    const value = await response.json() as Parameters<typeof quotaWindow>[0] & { models_enabled?: boolean; exhausted?: boolean };
    const window = quotaWindow(value, this.now());
    return { enabled: value.models_enabled === true, exhausted: value.exhausted === true, ...(window ? { window } : {}) };
  }
  private exhaustion(window?: QuotaWindow, original?: SourceError) {
    const remaining = window ? Math.ceil((window.resetAt - this.now()) / 1000) : undefined;
    // The entitlement endpoint can briefly return the old exhausted window after reset.
    const seconds = remaining !== undefined && remaining <= 0 ? ALLOWANCE_CACHE_SECONDS : remaining;
    return new SourceError('quota', 'Token Harbor reports that its free allowance is exhausted',
      seconds === undefined ? original?.retryAfter : Math.max(seconds, original?.retryAfter ?? 0), original?.output, original?.diagnostics);
  }
  async available() {
    if (!await this.approved()) { this.lastAllowance = undefined; this.check = undefined; return false; }
    try {
      const allowance = await this.allowance(await this.grant());
      if (allowance.enabled && allowance.exhausted) throw this.exhaustion(allowance.window);
      return allowance.enabled;
    } catch (error) {
      if (error instanceof SourceError && error.code === 'quota') throw error;
      return false;
    }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) {
      this.lastAllowance = undefined; this.check = undefined;
      throw new SourceError('refused', 'Token Harbor data sharing is not approved; rerun usegrunt setup');
    }
    const previous = this.lastAllowance;
    if (previous?.allowance.exhausted && previous.allowance.window && previous.allowance.window.resetAt > this.now()) {
      const current = await this.grant().catch(() => undefined);
      if (current && this.sameGrant(previous.grant, current)) throw this.exhaustion(previous.allowance.window);
    }
    try { return await this.source.complete({ ...request, model: this.id }, signal); }
    catch (error) {
      if (!(error instanceof SourceError) || error.code !== 'quota' || signal.aborted) throw error;
      // The short HTTP rate-limit delay and the weekly allowance are independent.
      const allowance = await this.grant().then(grant => this.allowance(grant)).catch(() => undefined);
      signal.throwIfAborted();
      if (allowance?.enabled && allowance.exhausted) throw this.exhaustion(allowance.window, error);
      throw error;
    }
  }
  async close() { await this.source.close(); }
}
