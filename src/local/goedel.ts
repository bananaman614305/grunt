import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FreeApi, FREE_API_PROVIDERS, readFreeApiGrant } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { validateProviderGrant } from './provider-grant.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

const { model } = FREE_API_PROVIDERS.goedel;
const api = 'https://api.goedelmachines.com';
const squire = 'https://trusty-squire-api.fly.dev';

export class Goedel implements Source {
  readonly id = 'goedel';
  readonly supportsFunctionTools = true;
  private readonly directory: string;
  private readonly client: FreeApi;

  constructor(private options: { directory?: string; fetcher?: typeof fetch; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.directory = options.directory ?? configRoot();
    this.client = new FreeApi(this.id, {
      expectedModel: model,
      ...(options.fetcher ? { fetcher: options.fetcher } : {})
    });
  }

  acceptsRequest(request: ModelRequest) {
    return request.publicContext === true && !request.handoffPrompt && !request.imageInput;
  }

  private async freeGrant(signal?: AbortSignal) {
    if (!(await readDataSharingConsent(this.directory, [this.id])).includes(this.id)) return undefined;
    const load = this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.directory);
    const grant = validateProviderGrant(await load);
    const origin = new URL(grant.base_url).origin;
    if (origin === api ? grant.base_url !== api || !/^sk-gm-free-[A-Za-z0-9_-]+$/.test(grant.token)
      : origin !== squire) return undefined;
    const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'account')(`${grant.base_url}/v1/key`, {
      redirect: 'error', headers: { Authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const { data } = await response.json() as { data?: { tier?: string } };
    return data?.tier === 'free' && response.headers.get('X-Data-Policy') === 'retained'
      && !response.headers.has('X-Goedel-Credit-Remaining') ? grant : undefined;
  }

  async available() {
    try { return !!await this.freeGrant(); } catch { return false; }
  }

  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.acceptsRequest(request)) throw new SourceError('refused', 'Gödel requires approved public request context');
    const grant = await this.freeGrant(signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!grant) throw new SourceError('logged_out', 'Gödel could not verify an approved Free Key');
    return this.client.completeWithGrant({ ...request, model: this.id }, signal, grant);
  }

  async close() { await this.client.close(); }
}
