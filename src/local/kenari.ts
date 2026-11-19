import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { validateProviderGrant } from './provider-grant.js';
import { Gateway, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const KENARI_FREE_MODEL = 'ernie-5-5-flash-preview:free';
interface CatalogEntry {
  id?: string;
  context_length?: number;
  pricing?: { free?: boolean };
  tool_call?: boolean;
}

async function readGrant(directory: string) {
  const file = await open(join(directory, 'kenari.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe Kenari grant file');
    return validateProviderGrant(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}

export class Kenari implements Source {
  readonly id = 'kenari';
  readonly supportsFunctionTools = true;
  private directory: string;
  private fetcher: typeof fetch;
  private shutdown = new AbortController();

  constructor(private options: { directory?: string; fetcher?: typeof fetch; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.directory = options.directory ?? configRoot();
    this.fetcher = options.fetcher ?? fetch;
  }

  private approved() { return readDataSharingConsent(this.directory, [this.id]).then(ids => ids.includes(this.id)); }
  private grant() { return (this.options.loadGrant?.() ?? readGrant(this.directory)).then(validateProviderGrant); }

  private async hasFreeRoute(grant: FreeApiGrant, signal: AbortSignal = this.shutdown.signal) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${grant.base_url}/v1/models`, {
      headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), signal])
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const { data } = await response.json() as { data?: CatalogEntry[] };
    return Array.isArray(data) && data.some(entry => entry?.id === KENARI_FREE_MODEL && entry.pricing?.free === true
      && Number(entry.context_length) >= 200_000 && entry.tool_call === true);
  }

  async available() {
    if (!await this.approved()) return false;
    try { return await this.hasFreeRoute(await this.grant()); } catch { return false; }
  }

  async complete(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(120000)]);
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Kenari data sharing needs approval before routing');
    let grant: FreeApiGrant;
    try { grant = await this.grant(); }
    catch { throw new SourceError('logged_out', 'Kenari access is not configured'); }
    const free = await this.hasFreeRoute(grant, signal).catch(() => false);
    signal.throwIfAborted();
    if (!free) throw new SourceError('refused', 'Kenari is missing the advertised free ERNIE route');

    let retryAfter: number | undefined;
    const send = diagnosticFetch(this.fetcher, this.id, 'chat.completions');
    const client = new Gateway(`${grant.base_url}/v1`, grant.token, async (url, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = await send(url, { ...init, body: JSON.stringify({ ...requestBody, model: KENARI_FREE_MODEL }) });
      if (!response.ok) {
        const delay = response.headers.get('retry-after');
        if (delay && /^\d+$/.test(delay)) retryAfter = Math.max(1, Number(delay));
        await response.body?.cancel();
        return new Response(null, { status: response.status });
      }
      const body = await response.clone().json() as { model?: string };
      if (body.model === KENARI_FREE_MODEL) return response;
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    });
    try {
      return await client.complete({ ...request, maxTokens: Math.min(4096, Math.max(1, request.maxTokens ?? 4096)) }, signal);
    } catch (error) {
      if (error instanceof SourceError && error.code === 'quota') {
        throw new SourceError('quota', 'Kenari free quota is temporarily unavailable', retryAfter);
      }
      throw error;
    }
  }

  async close() { this.shutdown.abort(); }
}
