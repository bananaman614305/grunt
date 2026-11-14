import { SourceError } from './source.js';
import type { ModelRequest, Source, ToolCall } from './source.js';

// Numeric loopback addresses avoid DNS rebinding and accidental remote routing.
export function loopback(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('A numeric HTTP loopback URL is required');
  return url;
}
export const KILO_URL = 'https://ai-gateway.kilo.ai/api/v1';
export const FREEBUFF_URL = 'http://127.0.0.1:8789/v1';
export function freeConfig() {
  return {
    customProviders: [
      { baseUrl: KILO_URL, apiKey: 'no-key', label: 'Kilo Free', models: [{ model: 'kilo-auto/free', supportsTools: true }] },
      { baseUrl: FREEBUFF_URL, apiKey: 'no-key', label: 'Freebuff', models: [{ model: 'freebuff', supportsTools: false }] }
    ],
    // Existing keyed provider rows retain their catalog priorities. Never enable
    // OpenRouter or unvetted aggregators by provisioning keys for them here.
    fallback: [
      { platform: 'custom', modelId: 'kilo-auto/free', endpoint: KILO_URL, priority: 999999 },
      { platform: 'custom', modelId: 'freebuff', endpoint: FREEBUFF_URL, priority: 1000000 }
    ],
    routing: { strategy: 'priority' as const }
  };
}
export class FreeLLMAPI implements Source {
  readonly id: string;
  readonly supportsFunctionTools = true;
  private url: string;
  private fetcher: typeof fetch;
  constructor(private options: { url?: string; key?: string; loadKey?: () => Promise<string>; fetcher?: typeof fetch; model?: string; id?: string } = {}) {
    this.url = loopback(options.url ?? 'http://127.0.0.1:3001/v1').href.replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.id = options.id ?? 'freellmapi';
  }
  async available() {
    try {
      const key = this.options.key || await this.options.loadKey?.();
      if (!key) return false;
      return (await this.fetcher(`${this.url}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(2000) })).ok;
    } catch { return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const key = this.options.key || await this.options.loadKey?.();
    caller.throwIfAborted();
    if (!key) throw new SourceError('logged_out', 'FreeLLMAPI login unavailable; check the local router and saved login');
    if (request.tools.some(t => t.type !== 'function')) throw new SourceError('upstream', 'FreeLLMAPI Chat Completions requires function tools');
    const signal = AbortSignal.any([caller, AbortSignal.timeout(600000)]);
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.options.model ?? 'auto', messages: request.messages, tools: request.tools.length ? request.tools : undefined, stream: false, max_tokens: Math.min(4096, Math.max(1, request.maxTokens ?? 4096)) })
      });
    } catch { throw new SourceError(signal.aborted ? 'timeout' : 'upstream', 'Local FreeLLMAPI is unavailable'); }
    if (!response.ok) throw new SourceError(response.status === 403 ? 'refused' : response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `FreeLLMAPI returned HTTP ${response.status}`);
    // FreeLLMAPI treats a pinned model as a preference and can fall back to
    // another provider. Never attribute that provider's answer to Kilo.
    if (this.id === 'kilo' && response.headers.get('x-routed-via') !== `custom/${this.options.model}`) {
      await response.body?.cancel();
      throw new SourceError('upstream', 'Kilo did not answer; the local backend selected another route');
    }
    const result = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; refusal?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = result.choices?.[0]?.message;
    if (message?.refusal) throw new SourceError('refused', 'FreeLLMAPI provider refused the request');
    if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'FreeLLMAPI returned an invalid completion');
    return { text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}), inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 };
  }
}
