import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { observeAttemptDispatch, diagnosticFetch } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { readPromotionalStream } from './promotional-api.js';
import { calendarQuotaDelay } from './quota-policy.js';
import { nousQuotaDelay, readQuotaError } from './quota-timing.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { emitStreamText, lengthLimited, truncatedCompletion, withObservedEnding, SourceError } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const APERTURE_ID = 'aperture-ai';
export const APERTURE_HOST = 'www.aperture-ai.run';
export const APERTURE_MODEL = 'baidu/ernie-5.5-flash-preview:free';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const zero = (value: unknown) => value === 0 || typeof value === 'string' && /^0(?:\.0+)?$/.test(value);

async function json(response: Response, signal: AbortSignal, limit: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error('Oversized response');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// The exact :free route is zero-priced independently of credit balances. Require
// a Free account and fresh zero-price model metadata before every dispatch.
export class Aperture implements Source {
  readonly inferenceOnly = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly id = APERTURE_ID;
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {}
  private get now() { return (this.options.now ?? Date.now)(); }
  private async responseFailure(response: Response, endpoint: 'account' | 'models' | 'chat.completions'): Promise<never> {
    const body = await readQuotaError(response), error = object(body.error);
    let retry = nousQuotaDelay(response.headers, body, this.now);
    // A generic/upstream 429 is not evidence of daily allowance exhaustion.
    // Prefer explicit reset signals; otherwise use the documented UTC cadence
    // only for the exact named daily quota error.
    if (response.status === 429 && (body.code === 'daily_quota_exceeded' || error.code === 'daily_quota_exceeded')) {
      retry ??= calendarQuotaDelay(this.id, this.now);
    }
    throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
      `Aperture returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', httpMethod: endpoint === 'chat.completions' ? 'POST' : 'GET', endpointLabel: endpoint });
  }
  private async freeGrant(caller?: AbortSignal) {
    const directory = this.options.directory ?? configRoot();
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    if (![`https://${APERTURE_HOST}`, 'https://aperture-ai.run'].includes(grant.base_url) && !(url.origin === 'https://trusty-squire-api.fly.dev'
      && /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname))) return;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000), ...(caller ? [caller] : [])]);
    const read = async (path: string, endpoint: 'account' | 'models', limit: number) => {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, endpoint)(`${grant.base_url}${path}`, {
        redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` }
      });
      if (!response.ok) return this.responseFailure(response, endpoint);
      return json(response, signal, limit);
    };
    const account = await read('/auth/me', 'account', 8192);
    if (account.valid !== true || account.plan !== 'free') return;
    const models = (await read('/api/v1/models', 'models', 1024 * 1024)).data;
    if (!Array.isArray(models)) return;
    const offers = models.map(object).filter(row => row.id === APERTURE_MODEL);
    if (offers.length !== 1) return;
    const model = offers[0]!, pricing = object(model.pricing);
    if (model.expiration_date !== null || !zero(pricing.prompt) || !zero(pricing.completion)
      || !Object.values(pricing).every(zero) || !count(model.context_length) || model.context_length < 204096
      || !Array.isArray(model.supported_parameters) || !model.supported_parameters.includes('tools')
      || model.endpoints !== undefined && (!Array.isArray(model.endpoints) || !model.endpoints.includes('/api/v1/chat/completions'))) return;
    signal.throwIfAborted();
    return grant;
  }
  async available() {
    try { return !!await this.freeGrant(); }
    catch (error) { if (error instanceof SourceError && error.code === 'quota') throw error; return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal, output?: () => void): Promise<Completion> {
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Aperture source closed');
    if (![this.id, 'grunt'].includes(request.model) || request.tools.some(tool => tool.type !== 'function')) throw new SourceError('refused', 'Unsupported Aperture request');
    let grant: FreeApiGrant | undefined;
    try { grant = await this.freeGrant(caller); } catch (error) { caller.throwIfAborted(); if (error instanceof SourceError) throw error; }
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Aperture source closed');
    if (!grant) throw new SourceError('refused', 'Aperture Free account and exact zero-price route could not be verified');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      observeAttemptDispatch({ model: APERTURE_MODEL, account: 'vaulted', maxOutputTokens: request.maxTokens });
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/api/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', 'User-Agent': 'grunt' },
        body: JSON.stringify({ model: APERTURE_MODEL, messages: request.messages, tools: request.tools.length ? request.tools : undefined,
          stream: true, stream_options: { include_usage: true }, max_tokens: request.maxTokens })
      });
      if (!response.ok) return await this.responseFailure(response, 'chat.completions');
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const reply = await readPromotionalStream(response, APERTURE_MODEL, signal, {
          ...(output ? { progress: output } : {}),
          ...(request.stream ? { text: emitStreamText } : {}),
          strictToolArgs: false,
          failure: () => {},
          cleanup: () => {}
        });
        if (reply.calls && !validCalls(reply.calls)) throw new Error('Invalid completion');
        return reply;
      }
      const body = await json(response, signal, 4 * 1024 * 1024);
      if (body.model !== APERTURE_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
      const choice = object(body.choices[0]), message = object(choice.message), usage = object(body.usage);
      if (message.refusal) throw new SourceError('refused', 'Aperture request refused');
      if (lengthLimited(choice.finish_reason)) return truncatedCompletion(message?.content, usage, choice.finish_reason);
      const calls = message.tool_calls;
      if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))
        || calls !== undefined && !validCalls(calls) || typeof message.content !== 'string' && !(validCalls(calls) && calls.length)
        || !message.content && !(validCalls(calls) && calls.length)) throw new Error('Invalid completion');
      return withObservedEnding({ text: typeof message.content === 'string' ? message.content : '', ...(validCalls(calls) && calls.length ? { calls } : {}),
        ...(count(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}), ...(count(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}) },
        choice.finish_reason, usage, validCalls(calls) && calls.length > 0);
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Aperture source closed');
      if (signal.aborted) throw new SourceError('timeout', 'Aperture response timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Aperture returned an invalid completion');
    }
  }
  async close() { this.shutdown.abort(); }
}
function validCalls(value: unknown): value is ToolCall[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  const ids = new Set<string>();
  return value.every(item => {
    const call = object(item), fn = object(call.function);
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string') return false;
    ids.add(call.id);
    try { const args: unknown = JSON.parse(fn.arguments); return args !== null && typeof args === 'object' && !Array.isArray(args); } catch { return false; }
  });
}
