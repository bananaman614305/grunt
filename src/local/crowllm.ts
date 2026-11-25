import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FreeApi, FREE_API_PROVIDERS, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { validateProviderGrant } from './provider-grant.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

const { model } = FREE_API_PROVIDERS.crowllm;
interface Offer {
  model_name?: unknown; quota_type?: unknown; model_ratio?: unknown; model_price?: unknown;
  completion_ratio?: unknown; enable_groups?: unknown; supported_endpoint_types?: unknown;
}

export class CrowLLM implements Source {
  readonly inferenceOnly = true;
  readonly id = 'crowllm';
  readonly supportsFunctionTools = true;
  private readonly directory: string;
  private readonly client: FreeApi;

  constructor(private options: { directory?: string; fetcher?: typeof fetch; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.directory = options.directory ?? configRoot();
    this.client = new FreeApi(this.id, { expectedModel: model, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  }

  private async freeGrant(signal?: AbortSignal) {
    if (!(await readDataSharingConsent(this.directory, [this.id])).includes(this.id)) return undefined;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.directory)));
    const origin = new URL(grant.base_url).origin;
    if (grant.base_url !== 'https://crowllm.com' && origin !== 'https://trusty-squire-api.fly.dev') return undefined;
    const checked = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'account')(`${grant.base_url}/api/usage/token/`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!checked.ok) { await checked.body?.cancel(); return undefined; }
    const key = await checked.json() as { code?: unknown; data?: { object?: unknown; expires_at?: unknown } };
    if (key.code !== true || key.data?.object !== 'token_usage' || typeof key.data.expires_at !== 'number'
      || !Number.isFinite(key.data.expires_at) || key.data.expires_at !== 0 && key.data.expires_at <= Date.now() / 1000) return undefined;
    const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models')(`${grant.base_url}/api/pricing`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const catalog = await response.json() as { success?: unknown; data?: Offer[] };
    if (catalog.success !== true || !Array.isArray(catalog.data)) return undefined;
    const matches = catalog.data.filter(offer => offer?.model_name === model);
    const offer = matches.length === 1 ? matches[0] : undefined;
    return offer?.quota_type === 0 && offer.model_ratio === 0 && offer.model_price === 0
      && typeof offer.completion_ratio === 'number' && Number.isFinite(offer.completion_ratio) && offer.completion_ratio >= 0
      && Array.isArray(offer.enable_groups) && offer.enable_groups.includes('free')
      && Array.isArray(offer.supported_endpoint_types) && offer.supported_endpoint_types.includes('openai') ? grant : undefined;
  }

  async available() {
    try { return !!await this.freeGrant(); } catch { return false; }
  }

  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const grant = await this.freeGrant(signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!grant) throw new SourceError('refused', 'CrowLLM could not verify the approved zero-price GLM route');
    return this.client.completeWithGrant({ ...request, model: this.id }, signal, grant);
  }

  async close() { await this.client.close(); }
}
