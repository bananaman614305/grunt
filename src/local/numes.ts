import { configRoot } from '../brand.js';
import { NUMES_DEEPSEEK_FLASH_CONSENT, readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FreeApi, FREE_API_PROVIDERS, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

const { model, prefix } = FREE_API_PROVIDERS.numes;
export const NUMES_DEEPSEEK_FLASH_MODEL = 'deepseek/deepseek-v4.1-flash:free';
const zeroPrice = { prompt: 0, completion: 0 };
const preferredFreeEndpoint = 'amazee-ai-5149fc8341b341f3a6ebe026ae44f7c7/token-factory-df2d2988c4514d66a143237f387d4e64';
const chatEndpoint = `${prefix}/chat/completions`;
const DEEPSEEK_BACKOFF_MS = 15 * 60_000;
interface Offer {
  id?: string; context_length?: number; pricing?: Record<string, unknown>; supported_parameters?: unknown;
}
interface Endpoint extends Offer {
  tag?: string; billing_currency?: string; max_prompt_tokens?: number;
}
interface Key {
  disabled?: boolean; is_management_key?: boolean; limit?: number; limit_remaining?: number;
  billing_currency?: string; limit_reset?: string | null;
}
const deepSeekKey = (key: Key) => key.billing_currency === 'USD' && key.limit_reset === null;
const freeOffer = (entry: Offer) => Number(entry.context_length) >= 200_000
  && entry.pricing?.prompt === '0' && entry.pricing.completion === '0'
  && Object.values(entry.pricing).every(rate => rate === '0')
  && Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes('tools');

interface NumesOptions {
  directory?: string;
  fetcher?: typeof fetch;
  loadGrant?: () => Promise<FreeApiGrant>;
  deepSeekFlash?: boolean;
}

export class Numes implements Source {
  readonly id = 'numes';
  readonly supportsFunctionTools = true;
  private directory: string;
  private client: FreeApi;
  private fetcher: typeof fetch;
  private deepSeekRetryAt = 0;

  constructor(private options: NumesOptions = {}) {
    this.directory = options.directory ?? configRoot();
    this.fetcher = options.fetcher ?? fetch;
    this.client = new FreeApi(this.id, {
      loadGrant: () => this.grant(),
      fetcher: (input, init) => this.checkedCompletion(input, init)
    });
  }

  private approved() {
    const policy = this.options.deepSeekFlash ? NUMES_DEEPSEEK_FLASH_CONSENT : this.id;
    return readDataSharingConsent(this.directory, [policy]).then(ids => ids.includes(policy));
  }
  private grant() { return this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.directory); }

  private async deepSeekAvailable(base: string, headers: Headers, signal?: AbortSignal | null) {
    if (Date.now() < this.deepSeekRetryAt
      || !(await readDataSharingConsent(this.directory, [NUMES_DEEPSEEK_FLASH_CONSENT])).includes(NUMES_DEEPSEEK_FLASH_CONSENT)) return false;
    return this.hasDeepSeekOffer(base, headers, signal).catch(() => false);
  }

  private async zeroSpendKey(base: string, headers: Headers, signal?: AbortSignal | null) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'account')(`${base}${prefix}/key`, {
      headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const { data } = await response.json() as { data?: Key };
    if (data?.disabled === false && data.is_management_key === false && data.limit === 0 && data.limit_remaining === 0) return data;
    return undefined;
  }

  private async hasDeepSeekOffer(base: string, headers: Headers, signal?: AbortSignal | null) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${base}${prefix}/models/${NUMES_DEEPSEEK_FLASH_MODEL}/endpoints`, {
      headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    const captured = Date.parse(response.headers.get('X-Catalogue-Supply-Captured-At') ?? '');
    const age = Date.now() - captured;
    if (!response.ok || response.headers.get('X-Catalogue-Stale') === 'true' || !Number.isFinite(age) || age < -5000 || age > 60000) {
      await response.body?.cancel();
      return false;
    }
    const { data } = await response.json() as { data?: { id?: string; endpoints?: Endpoint[] } };
    return data?.id === NUMES_DEEPSEEK_FLASH_MODEL && Array.isArray(data.endpoints) && data.endpoints.some(endpoint =>
      endpoint.tag === preferredFreeEndpoint && endpoint.billing_currency === 'USD' && Number(endpoint.max_prompt_tokens) >= 200_000
      && freeOffer(endpoint) && Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes('max_tokens'));
  }

  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      const base = grant.base_url;
      const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
      const key = await this.zeroSpendKey(base, headers);
      if (!key) return false;
      if (this.options.deepSeekFlash) return deepSeekKey(key) && await this.hasDeepSeekOffer(base, headers);
      const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${base}${prefix}/models`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const { data } = await response.json() as { data?: Offer[] };
      return (Array.isArray(data) && data.some(entry => entry.id === model && freeOffer(entry)))
        || (deepSeekKey(key) && await this.deepSeekAvailable(base, headers));
    } catch { return false; }
  }

  private async checkedCompletion(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    if (!url.endsWith(chatEndpoint) || typeof init?.body !== 'string') return new Response(null, { status: 403 });
    const base = url.slice(0, -chatEndpoint.length);
    const headers = new Headers(init.headers);
    const key = await this.zeroSpendKey(base, headers, init.signal);
    if (!key || (this.options.deepSeekFlash && !deepSeekKey(key))) return new Response(null, { status: 403 });
    const deepSeekFlash = deepSeekKey(key) && (this.options.deepSeekFlash
      ? await this.hasDeepSeekOffer(base, headers, init.signal)
      : await this.deepSeekAvailable(base, headers, init.signal));
    if (this.options.deepSeekFlash && !deepSeekFlash) return new Response(null, { status: 503 });
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const selectedModel = deepSeekFlash ? NUMES_DEEPSEEK_FLASH_MODEL : model;
    const routing = deepSeekFlash ? { only: [preferredFreeEndpoint], allow_fallbacks: false } : { order: [preferredFreeEndpoint] };
    const response = await this.fetcher(url, {
      ...init,
      body: JSON.stringify({ ...body, model: selectedModel, provider: { max_price: zeroPrice, require_parameters: true, ...routing } })
    });
    if (!response.ok) {
      if (deepSeekFlash && !this.options.deepSeekFlash) this.deepSeekRetryAt = Date.now() + DEEPSEEK_BACKOFF_MS;
      return response;
    }
    const result = await response.clone().json() as { model?: string; usage?: { cost?: number } };
    if ((result.model !== selectedModel && result.model !== selectedModel.slice(0, -':free'.length)) || result.usage?.cost !== 0) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return response;
  }

  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Numes data sharing needs approval before routing');
    return this.client.complete({ ...request, model: this.id }, signal);
  }

  async close() { await this.client.close(); }
}
