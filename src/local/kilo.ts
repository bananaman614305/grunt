import { compileToolSchemas } from './tool-schema.js';
import type { ValidateFunction } from 'ajv';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory, readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { FreebuffTools } from './freebuff-tools.js';
import { completionEnding, withEnding, lengthLimited, truncatedCompletion, needsFunctionTools, SourceError } from './source.js';
import { diagnosticFetch, recordAttemptFailure } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const KILO_PARTICLE = 'particle-ai/particle-1:free';
export const KILO_BEAM = 'reflection/beam-free';
// Free models left out of the rotation for requests that carry function tools, for lack of credibility as a coding
// agent. Each needs evidence, not a hunch; everything else stays. Checked against Kilo's public catalog and the
// vendors' own cards on 2026-11-25.
// - liquid/lfm-3-1.7b: 1.73B parameters, 8192-token output cap in the catalog, and its model card says it is not
//   recommended for agentic coding or complex multi-step reasoning due to its small size.
// Text-only requests still use the whole rotation, and so does a tools request if this would leave nothing.
export const KILO_NOT_FOR_TOOL_WORK: ReadonlySet<string> = new Set(['liquid/lfm-3-1.7b:free']);
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
function requestFailure(message: string, failureReason: 'request_body' | 'request_tools' | 'request_tool_schema' | 'request_size') {
  // No transport or HTTP status: these checks reject locally before dispatch.
  return new SourceError('refused', message, undefined, undefined, { failureReason });
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
/** Nonbillable public metadata only. No account, API key, or paid fallback is used.
 * Returns the verified free models this route may use, in try order. Kilo rotates
 * across verified exact `:free` models and Reflection Beam: Particle first,
 * then Reflection Beam, then the rest in catalog order.
 * Reflection Beam's own route keeps its single model.
 * Router aliases such as kilo-auto/free are never used because their completions
 * cannot be verified as one exact model. */
export async function verifyKiloAccess(options: { fetcher?: typeof fetch; signal?: AbortSignal; reflectionBeam?: boolean } = {}): Promise<string[]> {
  const name = options.reflectionBeam ? 'reflection-beam' : 'kilo';
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    const response = await abortable(diagnosticFetch(options.fetcher ?? fetch, name, 'models')(`${KILO_ORIGIN}/models`, { redirect: 'error', signal }), signal); status(response);
    const body = await json(response, signal, 4 * 1024 * 1024, 'models'), rows = Array.isArray(body.data) ? body.data.map(object) : [];
    const zero = (pricing: Record<string, unknown>, key: string) => (typeof pricing[key] === 'string' || typeof pricing[key] === 'number') && String(pricing[key]).trim() !== '' && Number(pricing[key]) === 0;
    const costs = ['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write'];
    const verified = (model: Record<string, unknown>) => {
      const pricing = object(model.pricing), parameters = model.supported_parameters;
      return model.isFree === true && zero(pricing, 'prompt') && zero(pricing, 'completion') && !costs.some(key => key in pricing && !zero(pricing, key))
        && Number.isSafeInteger(model.context_length) && Number(model.context_length) >= 200000
        && Array.isArray(parameters) && ['tools', 'max_tokens'].every(key => parameters.includes(key));
    };
    const eligible = (id: unknown): id is string => typeof id === 'string' && (options.reflectionBeam ? id === KILO_BEAM : id === KILO_BEAM || id.endsWith(':free'));
    const ids = rows.map(row => row.id).filter(eligible), unique = ids.filter(id => ids.indexOf(id) === ids.lastIndexOf(id));
    const models = unique.filter(id => verified(rows.find(row => row.id === id)!));
    const order = (id: string) => id === KILO_PARTICLE ? 0 : id === KILO_BEAM ? 1 : 2;
    if (!models.length) throw new SourceError('refused', options.reflectionBeam ? `${KILO_BEAM} is not currently a verified free model with at least 200K context`
      : 'No Kilo :free model is currently verified free with at least 200K context');
    return models.sort((a, b) => order(a) - order(b));
  } catch (error) {
    if (options.signal?.aborted) throw new SourceError('cancelled', 'Kilo access check cancelled');
    if (signal.aborted) throw new SourceError('timeout', 'Kilo access check timed out');
    if (error instanceof SourceError) throw error;
    throw new SourceError('upstream', 'Kilo free model metadata is unavailable');
  }
}
function conversation(request: ModelRequest) {
  const messages: ModelRequest['messages'] = [];
  try {
    for (const message of request.messages) {
      const previous = messages.at(-1);
      // Responses expresses parallel calls as separate assistant items.
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length && !message.tool_call_id
        && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length && !previous.tool_call_id) {
        previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      } else messages.push({ ...message });
    }
    // Some upstream sources reuse call IDs across completed turns. Preserve each
    // exact pair on this request's native wire without accepting ambiguous IDs.
    const reserved = new Set(messages.flatMap(message => [...(message.tool_calls?.map(call => call.id) ?? []), ...(message.tool_call_id ? [message.tool_call_id] : [])]));
    const seen = new Set<string>(), pending = new Map<string, string>(); let serial = 0;
    for (const message of messages) {
      if (message.role === 'tool') {
        const original = message.tool_call_id;
        if (original && pending.has(original)) { message.tool_call_id = pending.get(original)!; pending.delete(original); }
      } else if (message.tool_calls?.length) {
        message.tool_calls = message.tool_calls.map(call => {
          const original = call.id;
          if (pending.has(original)) throw new Error('Ambiguous pending tool call ID');
          let id = original;
          if (seen.has(original)) { do { id = `grunt_call_${++serial}`; } while (reserved.has(id)); reserved.add(id); }
          seen.add(original); pending.set(original, id);
          return { ...call, id };
        });
      }
    }
    new FreebuffTools({ ...request, messages }); // Validate roles and actual correlated results; no JSON bridge or tool execution.
  } catch { throw requestFailure('Kilo rejected invalid function tools or an uncorrelated tool conversation', 'request_tools'); }
  return { messages, validators: compileToolSchemas(request.tools, 'Kilo rejected a function tool schema') };
}
export class Kilo implements Source {
  readonly inferenceOnly = true;
  readonly id: 'kilo' | 'reflection-beam'; readonly supportsFunctionTools = true;
  // The model that answered last is tried first; a quota reply moves on to the next.
  private preferred: string | undefined;
  private shutdown = new AbortController(); private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; anonymous?: () => boolean; reflectionBeam?: boolean } = {}) {
    this.id = options.reflectionBeam ? 'reflection-beam' : 'kilo';
  }
  private verify(signal: AbortSignal) {
    return verifyKiloAccess({ ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), reflectionBeam: this.id === 'reflection-beam', signal });
  }
  private async approved() { return (await readDataSharingConsent(this.options.directory ?? providerGrantDirectory(), [this.id])).includes(this.id); }
  private async grant() {
    try { return validateProviderGrant(await readPrivateProviderGrant('kilo', this.options.directory ?? providerGrantDirectory())); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('refused', 'Kilo vault grant is invalid'); }
  }
  private async track<T>(task: Promise<T>) { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  async available() {
    return this.track((async () => { try {
      if (this.shutdown.signal.aborted || !await this.approved()) return false;
      await this.verify(this.shutdown.signal);
      return !this.shutdown.signal.aborted;
    } catch { return false; } })());
  }
  async healthCheck() { return this.available(); }
  complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> { return this.track(this.retryBadCalls(request, caller)); }
  // Particle sometimes samples one function call that fails the tool schema.
  // Ask once more before reporting the failure, so one bad sample does not
  // end a coding-tool turn.
  private async retryBadCalls(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    try { return await this.once(request, caller); }
    catch (error) {
      if (!(error instanceof SourceError) || error.diagnostics?.failureReason !== 'response_tools' || caller.aborted || this.shutdown.signal.aborted) throw error;
      return this.once(request, caller);
    }
  }
  private async once(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const timeout = this.options.timeout, signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(180000, Math.ceil(timeout)) : 180000)]);
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw requestFailure('This Kilo route supports text inputs', 'request_body');
      if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw requestFailure('Kilo requires a positive integer output-token budget', 'request_body');
      const limit = request.maxTokens, { messages, validators } = conversation(request);
      if (!await this.approved()) throw new SourceError('refused', 'Kilo data sharing is not approved; rerun usegrunt setup');
      signal.throwIfAborted();
      const wire = (model: string) => {
        const body = JSON.stringify({ model, messages, ...(request.tools.length ? { tools: request.tools } : {}), stream: false, max_tokens: limit });
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw requestFailure('Kilo prompt exceeds the supported input size', 'request_size');
        return body;
      };
      wire(''); // Refuse an oversized prompt before any network call.
      const models = await this.verify(signal);
      signal.throwIfAborted();
      const grant = this.id === 'reflection-beam' || this.options.anonymous?.() ? undefined : await this.grant();
      const origin = grant ? `${grant.base_url}/api/gateway` : KILO_ORIGIN;
      const agentic = needsFunctionTools(request) ? models.filter(id => !KILO_NOT_FOR_TOOL_WORK.has(id)) : models;
      const rotation = agentic.length ? agentic : models;
      const order = this.preferred && rotation.includes(this.preferred) ? [this.preferred, ...rotation.filter(id => id !== this.preferred)] : rotation;
      let quota: SourceError | undefined, last: SourceError | undefined;
      for (const model of order) {
        try {
          const completion = await this.ask(model, wire(model), origin, grant, request, messages, validators, limit, signal);
          this.preferred = model; return completion;
        } catch (error) {
          // Move on when this model reports quota (429), a server error (5xx) or
          // answers as another model. A timeout or any other failure ends the turn.
          const reported = error instanceof SourceError && (error.code === 'quota' || error.diagnostics?.failureReason === 'completion_model'
            || error.code === 'upstream' && (error.diagnostics?.httpStatus ?? 0) >= 500);
          if (!reported || signal.aborted) throw error;
          if (error.code !== 'quota') last = error;
          else if (!quota || (error.retryAfter ?? Infinity) < (quota.retryAfter ?? Infinity)) quota = error;
        }
      }
      throw last ?? quota!;
    } catch (error) {
      if (caller.aborted || this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Kilo request cancelled');
      if (signal.aborted) throw new SourceError('timeout', 'Kilo request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Kilo request failed');
    }
  }
  private async ask(model: string, body: string, origin: string, grant: { token: string } | undefined, request: ModelRequest, messages: ModelRequest['messages'],
    validators: Map<string, ValidateFunction>, limit: number | undefined, signal: AbortSignal): Promise<Completion> {
    const response = await abortable(diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${origin}/chat/completions`, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(grant ? { Authorization: `Bearer ${grant.token}` } : {}) }, body }), signal); status(response);
    const fail = (code: 'upstream' | 'refused', message: string, reason: NonNullable<SafeDiagnosticMetadata['failureReason']>) =>
      responseFailure(response, 'chat.completions', code, message, reason);
    const unusable = (message: string, reason: 'response_content' | 'response_empty' | 'length') => {
      // Keep the existing attempt code for older collectors. The opt-in trace
      // detail can distinguish an empty reply from an invalid content field.
      const failure = fail('upstream', message, reason === 'response_empty' ? 'response_content' : reason);
      recordAttemptFailure(this.id, { ...failure.diagnostics, failureReason: reason }, true);
      return failure;
    };
    const result = await json(response, signal, 2 * 1024 * 1024, 'chat.completions'), usage = object(result.usage), details = object(usage.cost_details);
    if (result.model !== model) throw fail('refused', 'Kilo returned an unverified model', 'completion_model');
    const unverifiedUsage = 'Kilo returned unverified free usage or exceeded the output budget';
    if (usage.cost !== 0 || ['total_cost', 'credits_charged'].some(key => key in usage && usage[key] !== 0)
      || ['upstream_inference_cost', 'upstream_inference_prompt_cost', 'upstream_inference_completions_cost'].some(key => details[key] !== 0)
      || ['cost', 'total_cost', 'credits_charged'].some(key => key in result && result[key] !== 0)) {
      throw fail('refused', unverifiedUsage, 'completion_billing');
    }
    if (!Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 1 || !Number.isSafeInteger(usage.completion_tokens)
      || Number(usage.completion_tokens) < 1 || limit !== undefined && Number(usage.completion_tokens) > limit) throw fail('refused', unverifiedUsage, 'completion_usage');
    if (!Array.isArray(result.choices) || result.choices.length !== 1) throw fail('upstream', 'Kilo returned an empty completion', 'response_choices');
    const choice = object(result.choices[0]), message = object(choice.message);
    if (message.refusal) throw fail('refused', 'Kilo refused the request', 'refusal');
    if (!(message.content === undefined || message.content === null || typeof message.content === 'string')) throw unusable('Kilo returned invalid completion content', 'response_content');
    const text = typeof message.content === 'string' ? message.content : '';
    if (lengthLimited(choice.finish_reason)) {
      if (request.model !== this.id && !text.trim()) throw unusable('Kilo stopped at the output limit without usable output', 'length');
      return { ...truncatedCompletion(text, usage), servedModel: model, free: true };
    }
    const calls: ToolCall[] = [], ids = new Set<string>();
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw fail('upstream', 'Kilo returned invalid function calls', 'response_tools');
      for (const value of message.tool_calls) {
        const call = object(value), fn = object(call.function); let args: unknown;
        try { args = JSON.parse(String(fn.arguments)); } catch { throw fail('upstream', 'Kilo returned invalid function arguments', 'response_tools'); }
        if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id)
          || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id)) || messages.some(m => m.tool_calls?.some(old => old.id === call.id)) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string'
          || !args || typeof args !== 'object' || Array.isArray(args) || !validators.get(fn.name)?.(args)) throw fail('upstream', 'Kilo returned invalid function calls', 'response_tools');
        ids.add(call.id); calls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
      }
    }
    // A reply that ends in a tool call (or carries a legacy function_call) but has no parsed call is an invalid sample,
    // not a finished text answer. The text is not parsed or changed.
    if (!calls.length && (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call' || message.function_call !== undefined && message.function_call !== null)) {
      throw fail('upstream', 'Kilo ended in a tool call but returned none', 'response_tools');
    }
    if (!text.trim() && !calls.length) throw unusable('Kilo returned an empty completion', 'response_empty');
    return withEnding({ servedModel: model, free: true, text, ...(calls.length ? { calls } : {}), inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number },
      completionEnding(choice.finish_reason, usage, calls.length > 0));
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
