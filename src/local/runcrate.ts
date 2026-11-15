import { FreeApi } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory, readPrivateProviderGrant, validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const RUNCRATE_DEEPSEEK = 'deepseek-ai/DeepSeek-V4.1-Flash';
export interface RuncrateGrant extends FreeApiGrant { free_account_verified: true; key_topups_disabled: true; verified_at: string }
function validate(value: unknown): RuncrateGrant {
  const grant = value as Partial<RuncrateGrant> | null;
  const access = validateProviderGrant(value);
  if (grant?.free_account_verified !== true || grant.key_topups_disabled !== true || typeof grant.verified_at !== 'string'
    || !Number.isFinite(Date.parse(grant.verified_at))) throw new Error('Runcrate free account verification is missing');
  return { ...access, free_account_verified: true, key_topups_disabled: true, verified_at: grant.verified_at };
}
export async function readRuncrateGrant(location = providerGrantDirectory()): Promise<RuncrateGrant> {
  return validate(await readPrivateProviderGrant('runcrate', location));
}
// Setup calls this only after confirming free access and disabling key top-ups.
// Like Zro's setup receipt, this does not freeze future account changes at Runcrate.
export async function writeRuncrateGrant(grant: FreeApiGrant, location = providerGrantDirectory()) {
  const value = validate({ ...grant, free_account_verified: true, key_topups_disabled: true, verified_at: new Date().toISOString() });
  await writePrivateProviderGrant('runcrate', value, location);
}
export class Runcrate implements Source {
  readonly id = 'runcrate';
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  private location: string;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<RuncrateGrant> } = {}) {
    this.location = options.directory ?? providerGrantDirectory();
    this.source = new FreeApi('runcrate', { ...options, fetcher: verifiedDeepSeekFetch(options.fetcher), loadGrant: () => this.grant() });
  }
  private approved = async () => (await readDataSharingConsent(this.location, [this.id])).includes(this.id);
  private grant() { return (this.options.loadGrant?.() ?? readRuncrateGrant(this.location)).then(validate); }
  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      const response = await (this.options.fetcher ?? fetch)(`${grant.base_url}/v1/models`, {
        headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const result = await response.json() as { data?: { id?: string }[] };
      return result.data?.some(model => model.id === RUNCRATE_DEEPSEEK) ?? false;
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Runcrate data sharing is not approved; rerun usegrunt setup');
    return this.source.complete({ ...request, model: this.id }, signal);
  }
  async close() { await this.source.close(); }
}
