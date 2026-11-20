import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { currentDiagnosticContext, diagnosticFetch } from './diagnostics.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import type { FreeApiGrant } from './free-api.js';
import { nousQuotaDelay, readQuotaError } from './quota-timing.js';
import { SourceError } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const PROMOTIONAL_PROVIDERS = {
  fikra: { host: 'api.fikraapi.co.ke', signup: 'https://fikraapi.co.ke/account/signup', model: 'deepseek-v4-1-flash-economy-free', expires: '2026-11-25T00:00:00Z' },
  openference: { host: 'api.openference.com', signup: 'https://openference.com/register', model: 'DeepSeek-V4.1-Flash-1017-Free', expires: '2027-01-01T00:00:00Z' }
} as const;
export type PromotionalProvider = keyof typeof PROMOTIONAL_PROVIDERS;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const zero = (value: unknown) => value === 0 || value === '0';
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;

// These offers are temporary, not recurring free tiers. Never change aliases or
// use a wallet when a promotion ends. They remain opt-in until live qualification.
export class PromotionalApi implements Source {
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  constructor(readonly id: PromotionalProvider, private options: {
    directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant>;
  } = {}) {}
  private get spec() { return PROMOTIONAL_PROVIDERS[this.id]; }
  private get now() { return (this.options.now ?? Date.now)(); }
  // Openference's unattended-use permission is unresolved. Exact-ID interactive
  // qualification is supported; neither automatic routing nor workers may use it.
  acceptsRequest(request: ModelRequest) { return this.id !== 'openference' || request.model === this.id && !request.worker && currentDiagnosticContext()?.kind !== 'maintenance'; }
  private async freeGrant(signal?: AbortSignal) {
    if (this.now >= Date.parse(this.spec.expires)) return;
    const directory = this.options.directory ?? configRoot();
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    // Proxy grants are service-scoped by Squire. Direct keys must stay on the
    // exact API origin, without an injected endpoint path or port.
    if (url.origin === 'https://trusty-squire-api.fly.dev') {
      if (!/^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname)) return;
    } else if (grant.base_url !== `https://${this.spec.host}`) return;
    const read = async (endpoint: string, publicGate = false) => {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, publicGate ? 'account' : 'models')(
        publicGate ? 'https://fikraapi.co.ke/free-deepseek-api/status.json' : `${grant.base_url}${endpoint}`, {
          redirect: 'error', headers: publicGate ? {} : { Authorization: `Bearer ${grant.token}` },
          signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
        });
      if (!response.ok) { await response.body?.cancel(); return {}; }
      return object(await response.json());
    };
    let expires = Date.parse(this.spec.expires);
    if (this.id === 'fikra') {
      const gate = await read('', true);
      if (gate.active !== true || gate.model_id !== this.spec.model || timestamp(gate.expires_at) <= this.now
        || !Number.isFinite(timestamp(gate.expires_at)) || !Number.isFinite(timestamp(gate.checked_at))
        || Math.abs(this.now - timestamp(gate.checked_at)) > 60000
        || typeof gate.used_usd !== 'number' || typeof gate.cap_usd !== 'number' || !Number.isFinite(gate.used_usd) || !Number.isFinite(gate.cap_usd) || gate.used_usd < 0 || !(gate.used_usd < gate.cap_usd)
        || count(gate.tokens_used) === undefined || count(gate.tokens_cap) === undefined || !(Number(gate.tokens_used) < Number(gate.tokens_cap))) return;
      expires = Math.min(expires, timestamp(gate.expires_at));
    }
    const catalog = await read('/v1/models');
    if (!Array.isArray(catalog.data)) return;
    const offers = catalog.data.map(object).filter(row => row.id === this.spec.model);
    if (offers.length !== 1) return;
    const offer = offers[0]!, pricing = object(offer.pricing);
    if (this.id === 'fikra') {
      if (pricing.unit !== 'USD_PER_1M_TOKENS' || pricing.input !== 0 || pricing.output !== 0 || pricing.input_cached !== undefined && pricing.input_cached !== 0
        || count(offer.context_window) === undefined || Number(offer.context_window) < 204096) return;
    } else {
      if (offer.is_free !== true || offer.free_until !== '2026-12-31' || offer.quota_multiplier !== 0
        || !zero(pricing.prompt) || !zero(pricing.completion) || !zero(pricing.cache_read)
        || object(offer.capabilities).tool_calling !== true || count(offer.context_length) === undefined || Number(offer.context_length) < 204096) return;
    }
    // Recheck after all preflight I/O; the earlier deadline always wins.
    if (this.now >= expires) return;
    return grant;
  }
  async available() { try { return !!await this.freeGrant(); } catch { return false; } }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    if (!this.acceptsRequest(request)) throw new SourceError('refused', 'Openference is limited to explicit interactive qualification');
    if (![this.id, 'grunt', 'milo'].includes(request.model) || request.tools.some(tool => tool.type !== 'function')) throw new SourceError('refused', 'Unsupported promotional request');
    const grant = await this.freeGrant(caller).catch(() => undefined);
    caller.throwIfAborted();
    if (!grant) throw new SourceError('refused', `${this.id} free offer could not be verified`);
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', 'User-Agent': this.id === 'openference' ? 'grunt/free-source-qualification' : 'grunt' },
        body: JSON.stringify({ model: this.spec.model, messages: request.messages, tools: request.tools.length ? request.tools : undefined,
          stream: this.id === 'openference', ...(this.id === 'openference' ? { stream_options: { include_usage: true } } : {}),
          max_tokens: Math.min(4096, Math.max(1, request.maxTokens ?? 4096)) })
      });
      if (!response.ok) {
        const retry = nousQuotaDelay(response.headers, await readQuotaError(response), this.now);
        throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
          `${this.id} returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions' });
      }
      if (this.id === 'openference') return await readPromotionalStream(response, this.spec.model, signal);
      const body = object(await response.json());
      if (body.model !== this.spec.model) throw new Error('Unexpected model');
      const message = object(object(Array.isArray(body.choices) ? body.choices[0] : null).message);
      if (message.refusal) throw new SourceError('refused', 'Promotional request refused');
      const calls = message.tool_calls;
      if (calls !== undefined && !validCalls(calls) || typeof message.content !== 'string' && !(validCalls(calls) && calls.length)) throw new Error('Invalid completion');
      return completion(typeof message.content === 'string' ? message.content : '', validCalls(calls) ? calls : [], object(body.usage));
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Promotional source closed');
      if (signal.aborted) throw new SourceError('timeout', `${this.id} response timed out`);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `${this.id} returned an invalid completion`);
    }
  }
  async close() { this.shutdown.abort(); }
}
function validCalls(value: unknown): value is ToolCall[] {
  return Array.isArray(value) && value.every(call => call && typeof call.id === 'string' && call.id.length > 0 && call.type === 'function'
    && typeof call.function?.name === 'string' && call.function.name.length > 0 && typeof call.function.arguments === 'string' && validArguments(call.function.arguments));
}
function validArguments(value: string): boolean {
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed); } catch { return false; }
}
function completion(text: string, calls: ToolCall[], usage: Record<string, unknown>): Completion {
  const inputTokens = count(usage.prompt_tokens), outputTokens = count(usage.completion_tokens);
  return { text, ...(calls.length ? { calls } : {}), ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

// SSE is transport even when the harness requests a non-streamed completion.
// Bound memory, assemble indexed function fragments, require an explicit finish,
// and reject errors/truncated streams instead of passing partial output as success.
export async function readPromotionalStream(response: Response, model: string, signal: AbortSignal): Promise<Completion> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Expected SSE');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', text = '', size = 0, finished = false, done = false, seenModel = false;
  let usage: Record<string, unknown> = {};
  let truncated = false;
  const calls = new Map<number, ToolCall>();
  const event = (raw: string) => {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    if (done) throw new Error('Event after DONE');
    const chunk = object(JSON.parse(data));
    if (chunk.error) throw new Error('Stream failed');
    if (chunk.model !== undefined) { if (chunk.model !== model) throw new Error('Unexpected model'); seenModel = true; }
    if (chunk.usage) usage = object(chunk.usage);
    if (!Array.isArray(chunk.choices)) throw new Error('Invalid stream choices');
    for (const value of chunk.choices) {
      const choice = object(value);
      if (choice.index !== 0) throw new Error('Unexpected stream choice');
      const delta = object(choice.delta);
      if (delta.refusal) throw new SourceError('refused', 'Promotional request refused');
      if (delta.content !== undefined && delta.content !== null) {
        if (finished || typeof delta.content !== 'string') throw new Error('Invalid stream content');
        text += delta.content;
      }
      if (delta.tool_calls !== undefined) {
        if (finished || !Array.isArray(delta.tool_calls)) throw new Error('Invalid tool fragments');
        for (const fragment of delta.tool_calls) {
          const part = object(fragment), fn = object(part.function), index = count(part.index);
          if (index === undefined || index > 127 || part.type !== undefined && part.type !== 'function') throw new Error('Invalid tool index/type');
          const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
          for (const field of ['id'] as const) if (part[field] !== undefined) { if (typeof part[field] !== 'string') throw new Error('Invalid tool id'); call[field] += part[field]; }
          for (const field of ['name', 'arguments'] as const) if (fn[field] !== undefined) { if (typeof fn[field] !== 'string') throw new Error('Invalid tool function'); call.function[field] += fn[field]; }
          calls.set(index, call);
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (!['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason))) throw new Error('Invalid stream finish');
        truncated = choice.finish_reason === 'length';
        finished = true;
      }
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4 * 1024 * 1024) throw new Error('Stream too large');
      pending += decoder.decode(chunk.value, { stream: true });
      // Normalize CRLF only after buffering, including split delimiters.
      pending = pending.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) !== -1) { event(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
    }
    const result = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (!done || !finished || !seenModel || truncated && result.length > 0 || !validCalls(result) || !text && !result.length) throw new Error('Incomplete stream');
    signal.throwIfAborted();
    return completion(text, result, usage);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
