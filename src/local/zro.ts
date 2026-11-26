import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FreeApi } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { readVaultGrant } from './vault.js';

export const ZRO_STORE = { service: 'zro', label: 'grunt', api_hosts: ['zro.moonmath.ai'], auth_shape: 'bearer' };
export const ZRO_DEEPSEEK = 'deepseek-v4.1-flash';
export interface ZroGrant extends FreeApiGrant { free_account_verified: true; verified_at: string }
const directory = () => configRoot();
function validate(value: unknown): ZroGrant {
  const grant = value as Partial<ZroGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()
    || grant.free_account_verified !== true || typeof grant.verified_at !== 'string' || !Number.isFinite(Date.parse(grant.verified_at))) throw new Error('Zro free account verification is missing');
  const url = new URL(grant.base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Zro grant endpoint');
  return { base_url: grant.base_url.replace(/\/$/, ''), token: grant.token, free_account_verified: true, verified_at: grant.verified_at };
}
export async function readZroGrant(location = directory(), env: NodeJS.ProcessEnv = process.env): Promise<ZroGrant> {
  const file = await open(join(location, 'zro.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe Zro grant file');
    const saved = validate(JSON.parse(await file.readFile('utf8')));
    const vaulted = await readVaultGrant('zro', location, env);
    return vaulted ? validate({ ...saved, base_url: vaulted.base_url, token: vaulted.token }) : saved;
  } finally { await file.close(); }
}
// Called after Squire has confirmed Free plan, no purchased balance and no payment method.
// This is a setup receipt, not a guarantee that an externally upgraded account stays free.
export async function writeZroGrant(grant: FreeApiGrant, location = directory()) {
  const value = validate({ ...grant, free_account_verified: true, verified_at: new Date().toISOString() });
  const temporary = join(location, `zro.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, 'zro.json'));
  } finally { await rm(temporary, { force: true }); }
}
export class Zro implements Source {
  readonly inferenceOnly = true;
  readonly id = 'zro';
  readonly availabilityTimeoutMs = 30000;
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<ZroGrant> } = {}) {
    this.source = new FreeApi('zro', { ...options, fetcher: verifiedDeepSeekFetch(options.fetcher), loadGrant: () => this.grant() });
  }
  private grant() { return (this.options.loadGrant?.() ?? readZroGrant(this.options.directory)).then(validate); }
  // Readiness is a real chat request: Zro still lists models for a paused key.
  async available(signal?: AbortSignal) {
    try {
      await this.source.complete({ model: this.id, cwd: this.options.directory ?? directory(), messages: [{ role: 'user', content: 'Reply with one word: ready' }],
        tools: [], stream: false, maxTokens: 16 }, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.availabilityTimeoutMs)]));
      signal?.throwIfAborted();
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SourceError && error.code === 'quota') throw error;
      return false;
    }
  }
  async healthCheck() { return this.available(); }
  complete(request: ModelRequest, signal: AbortSignal) {
    // Router aliases select this source; they never select another upstream model.
    return this.source.complete({ ...request, model: this.id }, signal);
  }
  async close() { await this.source.close(); }
}
