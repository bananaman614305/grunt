import { diagnosticFetch } from './diagnostics.js';
import { isDeepSeekV41Model } from './free-api.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { object as record, selectedReply, selectedStatus } from './selected-chat.js';

const seller = 'e4c4129c86752a2a8d092ddb0eb1c27cc4933c7b';
const model = 'deepseek/deepseek-v4.1-flash-free';
export class AntseedVikey implements Source {
  readonly id = 'antseed-vikey';
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();
  private readonly url: string;
  constructor(private options: { port?: string; fetcher?: typeof fetch } = {}) {
    const port = options.port ?? '8381';
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid Vikey buyer port');
    this.url = `http://127.0.0.1:${Number(port)}/v1`;
  }
  private async freeOffer(signal: AbortSignal) {
    const res = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models')(`${this.url}/models`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' });
    if (!res.ok) { await res.body?.cancel(); return false; }
    const data = record(await res.json()).data;
    if (!Array.isArray(data)) return false;
    const entry = record(data.find(row => record(row).id === model));
    return Array.isArray(entry.peers) && entry.peers.map(record).some(peer => peer.peerId === seller && peer.serviceId === model && peer.type === 'text'
      && peer.inputUsdPerMillion === 0 && peer.cachedInputUsdPerMillion === 0 && peer.outputUsdPerMillion === 0);
  }
  async available() {
    try { return await this.freeOffer(this.shutdown.signal); } catch { return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      signal.throwIfAborted();
      if (request.imageInput || request.tools.some(tool => tool.type !== 'function')) throw new SourceError('refused', 'Antseed Vikey requires text and function tools');
      if (!await this.freeOffer(signal)) throw new SourceError('not_installed', 'The pinned Antseed Vikey free offer is unavailable');
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${this.url}/chat/completions`, {
        method: 'POST', signal, redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `${seller}@${model}`, messages: request.messages, tools: request.tools.length ? request.tools : undefined,
          stream: false, max_tokens: Math.min(4096, Math.max(1, request.maxTokens ?? 4096)) }),
      });
      await selectedStatus(this.id, response);
      const prices = ['input', 'cached-input', 'output'].map(kind => response.headers.get(`x-antseed-${kind}-usd-per-million`));
      if (response.headers.get('x-antseed-peer-id') !== seller || response.headers.get('x-antseed-unit-priced') !== '0'
        || prices.some(price => price === null || !/^0(?:\.0+)?$/.test(price))) {
        await response.body?.cancel();
        throw new SourceError('refused', 'Antseed Vikey did not attest the pinned $0 offer');
      }
      return selectedReply(this.id, await response.json(), request, isDeepSeekV41Model);
    } catch (error) {
      if (caller.aborted || this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Antseed Vikey request cancelled');
      if (signal.aborted || error instanceof DOMException && error.name === 'TimeoutError') throw new SourceError('timeout', 'Antseed Vikey request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Antseed Vikey request failed');
    }
  }
  async close() { this.shutdown.abort(); }
}
