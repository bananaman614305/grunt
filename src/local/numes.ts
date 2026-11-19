import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FreeApi, FREE_API_PROVIDERS, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

const { model, prefix } = FREE_API_PROVIDERS.numes;
const zeroPrice = { prompt: 0, completion: 0 };
const preferredFreeEndpoint = 'amazee-ai-5149fc8341b341f3a6ebe026ae44f7c7/token-factory-df2d2988c4514d66a143237f387d4e64';
const chatEndpoint = `${prefix}/chat/completions`;
const freeOffer = (entry: {
  id?: string; context_length?: number; pricing?: Record<string, unknown>; supported_parameters?: unknown;
}) => entry.id === model && Number(entry.context_length) >= 200_000
  && entry.pricing?.prompt === '0' && entry.pricing.completion === '0'
  && Object.values(entry.pricing).every(rate => rate === '0')
  && Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes('tools');

interface NumesOptions {
  directory?: string;
  fetcher?: typeof fetch;
  loadGrant?: () => Promise<FreeApiGrant>;
}

export class Numes implements Source {
  readonly id = 'numes';
  readonly supportsFunctionTools = true;
  private directory: string;
  private client: FreeApi;
  private fetcher: typeof fetch;

  constructor(private options: NumesOptions = {}) {
    this.directory = options.directory ?? configRoot();
    this.fetcher = options.fetcher ?? fetch;
    this.client = new FreeApi(this.id, {
      loadGrant: () => this.grant(),
      fetcher: (input, init) => this.checkedCompletion(input, init)
    });
  }

  private approved() { return readDataSharingConsent(this.directory, [this.id]).then(ids => ids.includes(this.id)); }
  private grant() { return this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.directory); }

  private async hasZeroSpendCap(base: string, headers: Headers, signal?: AbortSignal | null) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'account')(`${base}${prefix}/key`, {
      headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const { data } = await response.json() as {
      data?: { disabled?: boolean; is_management_key?: boolean; limit?: number; limit_remaining?: number };
    };
    return data?.disabled === false && data.is_management_key === false && data.limit === 0 && data.limit_remaining === 0;
  }

  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      const base = grant.base_url;
      const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
      if (!await this.hasZeroSpendCap(base, headers)) return false;
      const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${base}${prefix}/models`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const { data } = await response.json() as { data?: Parameters<typeof freeOffer>[0][] };
      return Array.isArray(data) && data.some(freeOffer);
    } catch { return false; }
  }

  private async checkedCompletion(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    if (!url.endsWith(chatEndpoint) || typeof init?.body !== 'string') return new Response(null, { status: 403 });
    const base = url.slice(0, -chatEndpoint.length);
    if (!await this.hasZeroSpendCap(base, new Headers(init.headers), init.signal)) {
      return new Response(null, { status: 403 });
    }
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const response = await this.fetcher(url, {
      ...init,
      body: JSON.stringify({ ...body, model, provider: { max_price: zeroPrice, require_parameters: true, order: [preferredFreeEndpoint] } })
    });
    if (!response.ok) return response;
    const result = await response.clone().json() as { model?: string; usage?: { cost?: number } };
    if ((result.model !== model && result.model !== model.slice(0, -':free'.length)) || result.usage?.cost !== 0) {
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
