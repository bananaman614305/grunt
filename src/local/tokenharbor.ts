import { diagnosticFetch } from './diagnostics.js';
import { configRoot } from '../brand.js';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FreeApi, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const TOKENHARBOR_DEEPSEEK = 'deepseek-v4.1-flash:free';
const directory = () => configRoot();
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
  readonly id = 'tokenharbor';
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  private location: string;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.location = options.directory ?? directory();
    this.source = new FreeApi('tokenharbor', { ...options, directory: this.location, fetcher: verifiedDeepSeekFetch(options.fetcher) });
  }
  private async approved() { return (await readDataSharingConsent(this.location, ['tokenharbor'])).includes('tokenharbor'); }
  private grant() { return this.options.loadGrant?.() ?? readFreeApiGrant('tokenharbor', this.location); }
  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, 'tokenharbor', 'account')(`${grant.base_url}/api/cli/free-tier`, {
        headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const result = await response.json() as { models_enabled?: boolean; exhausted?: boolean };
      return result.models_enabled === true && result.exhausted !== true;
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    if (!await this.approved()) throw new SourceError('refused', 'Token Harbor data sharing is not approved; rerun usegrunt setup');
    return this.source.complete({ ...request, model: this.id }, signal);
  }
  async close() { await this.source.close(); }
}
