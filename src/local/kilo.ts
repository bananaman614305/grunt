import { Ajv } from 'ajv';
import type { AnySchema, ValidateFunction } from 'ajv';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory } from './provider-grant.js';
import { FreebuffTools } from './freebuff-tools.js';
import { SourceError } from './source.js';
import { diagnosticFetch } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const KILO_PARTICLE = 'particle-ai/particle-1:free';
export const KILO_ORIGIN = 'https://ai-gateway.kilo.ai/api/v1';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
function responseFailure(response: Response, endpointLabel: 'models' | 'chat.completions', code: 'upstream' | 'refused',
  message: string, failureReason: NonNullable<SafeDiagnosticMetadata['failureReason']>) {
  return new SourceError(code, message, undefined, undefined, { transport: 'http', endpointLabel, httpStatus: response.status, failureReason });
}
async function json(response: Response, signal: AbortSignal, limit: number, endpointLabel: 'models' | 'chat.completions') {
  const oversized = () => responseFailure(response, endpointLabel, 'upstream', 'Kilo response exceeded the supported size', 'response_body');
  if (!response.body || Number(response.headers.get('content-length')) > limit) { void response.body?.cancel().catch(() => {}); throw oversized(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  const readFailure = endpointLabel === 'models' ? 'Kilo free model metadata is unavailable' : 'Kilo request failed';
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal); signal.throwIfAborted(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > limit) throw oversized(); chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof SourceError || signal.aborted) throw error;
    throw responseFailure(response, endpointLabel, 'upstream', readFailure, 'response_body');
  } finally { void reader.cancel().catch(() => {}); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw responseFailure(response, endpointLabel, 'upstream', readFailure, 'response_json'); }
}
function status(response: Response) {
  if (response.ok) return;
  const raw = response.headers.get('retry-after'), seconds = raw === null ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  void response.body?.cancel().catch(() => {});
  throw new SourceError(response.status === 429 ? 'quota' : [401, 402, 403].includes(response.status) ? 'refused' : 'upstream',
    `Kilo returned HTTP ${response.status}`, response.status === 429 ? Math.max(1, Number.isFinite(seconds) ? Math.ceil(seconds) : 60) : undefined, undefined,
    { httpStatus: response.status, transport: 'http' });
}
/** Nonbillable public metadata only. No account, API key, or paid fallback is used. */
export async function verifyKiloAccess(options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<void> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    const response = await abortable(diagnosticFetch(options.fetcher ?? fetch, 'kilo', 'models')(`${KILO_ORIGIN}/models`, { redirect: 'error', signal }), signal); status(response);
    const body = await json(response, signal, 4 * 1024 * 1024, 'models'), rows = Array.isArray(body.data) ? body.data.filter(row => object(row).id === KILO_PARTICLE) : [];
    const model = object(rows.length === 1 ? rows[0] : undefined), pricing = object(model.pricing), parameters = model.supported_parameters;
    const zero = (key: string) => (typeof pricing[key] === 'string' || typeof pricing[key] === 'number') && String(pricing[key]).trim() !== '' && Number(pricing[key]) === 0;
    const costs = ['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write'];
    if (model.isFree !== true || !zero('prompt') || !zero('completion') || costs.some(key => key in pricing && !zero(key))
      || !Number.isSafeInteger(model.context_length) || Number(model.context_length) < 200000
      || !Array.isArray(parameters) || !['tools', 'max_tokens'].every(key => parameters.includes(key))) {
      throw new SourceError('refused', 'Kilo Particle is not currently a verified free model with at least 200K context');
    }
  } catch (error) {
    if (options.signal?.aborted) throw new SourceError('cancelled', 'Kilo access check cancelled');
    if (signal.aborted) throw new SourceError('timeout', 'Kilo access check timed out');
    if (error instanceof SourceError) throw error;
    throw new SourceError('upstream', 'Kilo free model metadata is unavailable');
  }
}
function conversation(request: ModelRequest) {
  try {
    const messages: ModelRequest['messages'] = [];
    for (const message of request.messages) {
      const previous = messages.at(-1);
      // Responses expresses parallel calls as separate assistant items.
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length && !message.tool_call_id
        && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length && !previous.tool_call_id) {
        previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      } else messages.push({ ...message });
    }
    new FreebuffTools({ ...request, messages }); // Validate roles and actual correlated results; no JSON bridge or tool execution.
    const validators = new Map<string, ValidateFunction>(), ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, addUsedSchema: false });
    for (const tool of request.tools) { const fn = object(tool.function); validators.set(fn.name as string, ajv.compile(fn.parameters as AnySchema)); }
    return { messages, validators };
  } catch { throw new SourceError('refused', 'Kilo rejected invalid function tools or an uncorrelated tool conversation'); }
}
export class Kilo implements Source {
  readonly id = 'kilo'; readonly supportsFunctionTools = true;
  private shutdown = new AbortController(); private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number } = {}) {}
  private async approved() { return (await readDataSharingConsent(this.options.directory ?? providerGrantDirectory(), [this.id])).includes(this.id); }
  private async track<T>(task: Promise<T>) { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  async available() {
    return this.track((async () => { try {
      if (this.shutdown.signal.aborted || !await this.approved()) return false;
      await verifyKiloAccess({ ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal: this.shutdown.signal });
      return !this.shutdown.signal.aborted;
    } catch { return false; } })());
  }
  async healthCheck() { return this.available(); }
  complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> { return this.track(this.once(request, caller)); }
  private async once(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const timeout = this.options.timeout, signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(180000, Math.ceil(timeout)) : 180000)]);
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw new SourceError('refused', 'Kilo Particle supports text inputs through this route');
      if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw new SourceError('refused', 'Kilo requires a positive integer output-token budget');
      const limit = Math.min(4096, request.maxTokens ?? 4096), { messages, validators } = conversation(request);
      if (!await this.approved()) throw new SourceError('refused', 'Kilo data sharing is not approved; rerun usegrunt setup');
      signal.throwIfAborted();
      const body = JSON.stringify({ model: KILO_PARTICLE, messages, ...(request.tools.length ? { tools: request.tools } : {}), stream: false, max_tokens: limit });
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new SourceError('refused', 'Kilo prompt exceeds the supported input size');
      await verifyKiloAccess({ ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal });
      signal.throwIfAborted();
      const response = await abortable(diagnosticFetch(this.options.fetcher ?? fetch, 'kilo', 'chat.completions')(`${KILO_ORIGIN}/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' }, body }), signal); status(response);
      const fail = (code: 'upstream' | 'refused', message: string, reason: NonNullable<SafeDiagnosticMetadata['failureReason']>) =>
        responseFailure(response, 'chat.completions', code, message, reason);
      const result = await json(response, signal, 2 * 1024 * 1024, 'chat.completions'), usage = object(result.usage), details = object(usage.cost_details);
      if (result.model !== KILO_PARTICLE) throw fail('refused', 'Kilo returned an unverified Particle model', 'completion_model');
      const unverifiedUsage = 'Kilo returned unverified free usage or exceeded the output budget';
      if (usage.cost !== 0 || ['total_cost', 'credits_charged'].some(key => key in usage && usage[key] !== 0)
        || ['upstream_inference_cost', 'upstream_inference_prompt_cost', 'upstream_inference_completions_cost'].some(key => details[key] !== 0)
        || ['cost', 'total_cost', 'credits_charged'].some(key => key in result && result[key] !== 0)) {
        throw fail('refused', unverifiedUsage, 'completion_billing');
      }
      if (!Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 1 || !Number.isSafeInteger(usage.completion_tokens)
        || Number(usage.completion_tokens) < 1 || Number(usage.completion_tokens) > limit) throw fail('refused', unverifiedUsage, 'completion_usage');
      if (!Array.isArray(result.choices) || result.choices.length !== 1) throw fail('upstream', 'Kilo returned an empty completion', 'response_choices');
      const choice = object(result.choices[0]), message = object(choice.message);
      if (message.refusal) throw fail('refused', 'Kilo refused the request', 'refusal');
      if (!(message.content === undefined || message.content === null || typeof message.content === 'string')) throw fail('upstream', 'Kilo returned invalid completion content', 'response_content');
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw fail('upstream', 'Kilo returned invalid function calls', 'response_tools');
        for (const value of message.tool_calls) {
          const call = object(value), fn = object(call.function); let args: unknown;
          try { args = JSON.parse(String(fn.arguments)); } catch { throw fail('upstream', 'Kilo returned invalid function arguments', 'response_tools'); }
          if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id)
            || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id)) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string'
            || !args || typeof args !== 'object' || Array.isArray(args) || !validators.get(fn.name)?.(args)) throw fail('upstream', 'Kilo returned invalid function calls', 'response_tools');
          ids.add(call.id); calls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
        }
      }
      if (!message.content && !calls.length) throw fail('upstream', 'Kilo returned an empty completion', 'response_content');
      return { text: typeof message.content === 'string' ? message.content : '', ...(calls.length ? { calls } : {}), inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number };
    } catch (error) {
      if (caller.aborted || this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Kilo request cancelled');
      if (signal.aborted) throw new SourceError('timeout', 'Kilo request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Kilo request failed');
    }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
