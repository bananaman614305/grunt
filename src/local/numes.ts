import { configRoot } from '../brand.js';
import { createHash } from 'node:crypto';
import { NUMES_AMAZEE_MODELS_CONSENT, NUMES_DEEPSEEK_FLASH_CONSENT, readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FreeApi, FREE_API_PROVIDERS, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { MetadataFlights } from './metadata-flight.js';

const { model, prefix } = FREE_API_PROVIDERS.numes;
export const NUMES_DEEPSEEK_FLASH_MODEL = 'deepseek/deepseek-v4.1-flash:free';
export const NUMES_KIMI_MODEL = 'moonshotai/kimi-k3.1-pro:free';
export const NUMES_GLM_MODEL = 'z-ai/glm-5.3:free';
// Every free route below, and the GLM 5.3 Flash default, resolves to the same
// Amazee.ai endpoint under one Numes account. Numes publishes no per-model
// allowance, so rotating models adds quality options, not capacity. The order
// is the preference: the verified Flash route, then Kimi, then full GLM 5.3.
export const NUMES_STRICT_ROUTES: readonly { model: string; consent: string }[] = [
  { model: NUMES_DEEPSEEK_FLASH_MODEL, consent: NUMES_DEEPSEEK_FLASH_CONSENT },
  { model: NUMES_KIMI_MODEL, consent: NUMES_AMAZEE_MODELS_CONSENT },
  { model: NUMES_GLM_MODEL, consent: NUMES_AMAZEE_MODELS_CONSENT }
];
const strictRoute = (name: string | undefined) => NUMES_STRICT_ROUTES.find(route => route.model === name);
const zeroPrice = { prompt: 0, completion: 0 };
const preferredFreeEndpoint = 'amazee-ai-5149fc8341b341f3a6ebe026ae44f7c7/token-factory-df2d2988c4514d66a143237f387d4e64';
const chatEndpoint = `${prefix}/chat/completions`;
const ROUTE_BACKOFF_MS = 15 * 60_000;
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
const strictKey = (key: Key) => key.billing_currency === 'USD' && key.limit_reset === null;
const freeOffer = (entry: Offer) => Number(entry.context_length) >= 200_000
  && entry.pricing?.prompt === '0' && entry.pricing.completion === '0'
  && Object.values(entry.pricing).every(rate => rate === '0')
  && Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes('tools');

interface NumesOptions {
  directory?: string;
  fetcher?: typeof fetch;
  loadGrant?: () => Promise<FreeApiGrant>;
  // Qualification only: pin one strict route and never use the default.
  pinned?: string | undefined;
}

export class Numes implements Source {
  readonly id = 'numes';
  readonly supportsFunctionTools = true;
  private directory: string;
  private client: FreeApi;
  private fetcher: typeof fetch;
  private retryAt = new Map<string, number>();
  private metadata = new MetadataFlights();

  constructor(private options: NumesOptions = {}) {
    this.directory = options.directory ?? configRoot();
    this.fetcher = options.fetcher ?? fetch;
    this.client = new FreeApi(this.id, {
      loadGrant: () => this.grant(),
      fetcher: (input, init) => this.checkedCompletion(input, init)
    });
  }

  private approved() {
    const policy = strictRoute(this.options.pinned)?.consent ?? this.id;
    return readDataSharingConsent(this.directory, [policy]).then(ids => ids.includes(policy));
  }
  private grant() { return this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.directory); }
  private metadataKey(base: string, headers: Headers, path: string) {
    return createHash('sha256').update(JSON.stringify([base, headers.get('Authorization'), path])).digest('hex');
  }

  // First approved strict route that is not backed off and has a fresh exact free endpoint.
  private async strictAvailable(base: string, headers: Headers, signal?: AbortSignal | null) {
    const approved = await readDataSharingConsent(this.directory, NUMES_STRICT_ROUTES.map(route => route.consent));
    for (const route of NUMES_STRICT_ROUTES) {
      if (Date.now() < (this.retryAt.get(route.model) ?? 0) || !approved.includes(route.consent)) continue;
      signal?.throwIfAborted();
      if (await this.hasOffer(route.model, base, headers, signal).catch(() => false)) return route.model;
    }
    return undefined;
  }

  private usableKey(base: string, headers: Headers, caller?: AbortSignal | null) {
    return this.metadata.run(this.metadataKey(base, headers, 'key'), signal => this.readUsableKey(base, headers, signal), caller);
  }
  private async readUsableKey(base: string, headers: Headers, signal: AbortSignal) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'account')(`${base}${prefix}/key`, {
      headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const { data } = await response.json() as { data?: Key };
    // Owner, 22 Nov: an uncapped key is fine. Every request still pins zero
    // prices and is rejected unless Numes reports a zero cost.
    if (data?.disabled === false && data.is_management_key === false
      && ((data.limit === 0 && data.limit_remaining === 0) || (data.limit === null && data.limit_remaining === null))) return data;
    return undefined;
  }

  private hasOffer(name: string, base: string, headers: Headers, caller?: AbortSignal | null) {
    return this.metadata.run(this.metadataKey(base, headers, name), signal => this.readOffer(name, base, headers, signal), caller);
  }
  private async readOffer(name: string, base: string, headers: Headers, signal: AbortSignal) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${base}${prefix}/models/${name}/endpoints`, {
      headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    const captured = Date.parse(response.headers.get('X-Catalogue-Supply-Captured-At') ?? '');
    const age = Date.now() - captured;
    if (!response.ok || response.headers.get('X-Catalogue-Stale') === 'true' || !Number.isFinite(age) || age < -5000 || age > 60000) {
      await response.body?.cancel();
      return false;
    }
    const { data } = await response.json() as { data?: { id?: string; endpoints?: Endpoint[] } };
    return data?.id === name && Array.isArray(data.endpoints) && data.endpoints.some(endpoint =>
      endpoint.tag === preferredFreeEndpoint && endpoint.billing_currency === 'USD' && Number(endpoint.max_prompt_tokens) >= 200_000
      && freeOffer(endpoint) && Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes('max_tokens'));
  }

  private offers(base: string, headers: Headers, caller?: AbortSignal) {
    return this.metadata.run(this.metadataKey(base, headers, 'models'), async signal => {
      const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${base}${prefix}/models`, {
        headers, redirect: 'error', signal
      });
      if (!response.ok) { await response.body?.cancel(); return undefined; }
      const { data } = await response.json() as { data?: Offer[] };
      return Array.isArray(data) ? data : [];
    }, caller);
  }

  async available(signal?: AbortSignal) {
    if (signal?.aborted) return false;
    if (!await this.approved()) return false;
    try {
      signal?.throwIfAborted();
      const grant = await this.grant();
      const base = grant.base_url;
      const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
      const key = await this.usableKey(base, headers, signal);
      if (!key) return false;
      if (this.options.pinned) return strictKey(key) && await this.hasOffer(this.options.pinned, base, headers, signal);
      const data = await this.offers(base, headers, signal);
      if (!data) return false;
      return data.some(entry => entry.id === model && freeOffer(entry))
        || (strictKey(key) && await this.strictAvailable(base, headers, signal) !== undefined);
    } catch { return false; }
  }

  private async checkedCompletion(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    if (!url.endsWith(chatEndpoint) || typeof init?.body !== 'string') return new Response(null, { status: 403 });
    const base = url.slice(0, -chatEndpoint.length);
    const headers = new Headers(init.headers);
    const key = await this.usableKey(base, headers, init.signal);
    if (!key || (this.options.pinned && !strictKey(key))) return new Response(null, { status: 403 });
    const strict = !strictKey(key) ? undefined : this.options.pinned
      ? (await this.hasOffer(this.options.pinned, base, headers, init.signal) ? this.options.pinned : undefined)
      : await this.strictAvailable(base, headers, init.signal);
    if (this.options.pinned && !strict) return new Response(null, { status: 503 });
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const selectedModel = strict ?? model;
    const routing = strict ? { only: [preferredFreeEndpoint], allow_fallbacks: false } : { order: [preferredFreeEndpoint] };
    const response = await this.fetcher(url, {
      ...init,
      body: JSON.stringify({ ...body, model: selectedModel, provider: { max_price: zeroPrice, require_parameters: true, ...routing } })
    });
    if (!response.ok) {
      if (strict && !this.options.pinned) this.retryAt.set(strict, Date.now() + ROUTE_BACKOFF_MS);
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

  async close() { this.metadata.close(); await this.client.close(); }
}
