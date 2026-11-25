import { configRoot } from '../brand.js';
import { createHash } from 'node:crypto';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch, diagnosticNetworks } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { FreebuffTools } from './freebuff-tools.js';
import { MetadataFlights } from './metadata-flight.js';
import { readPromotionalStream } from './promotional-api.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { quotaObject, quotaRetryAfter, quotaSeconds, readQuotaError } from './quota-timing.js';
import { lengthLimited, requestRefusal, SourceError, truncatedCompletion } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';
import { compileToolSchemas } from './tool-schema.js';

export const OPENROUTER_PARTICLE_ID = 'openrouter-particle';
export const OPENROUTER_PARTICLE_MODEL = 'particle-ai/particle-1:free';
export const OPENROUTER_PARTICLE_HOST = 'openrouter.ai';
// The free endpoint's own tag. The paid endpoints of the same model carry other tags and prices.
export const OPENROUTER_PARTICLE_ENDPOINT = 'particle-ai/us';
// Published context of the endpoint. OpenRouter lists no separate prompt cap. Largest tested input is in docs/reference.md.
export const OPENROUTER_PARTICLE_CONTEXT = 1048576;
export const OPENROUTER_PARTICLE_MAX_OUTPUT = 131072;
// A reasoning model on a shared free fleet: its first reasoning token can take a while, but a stalled stream must fail over.
export const OPENROUTER_PARTICLE_FIRST_OUTPUT_MS = 120000;
export const OPENROUTER_PARTICLE_IDLE_MS = 60000;
export const OPENROUTER_PARTICLE_TOTAL_MS = 300000;
// The entitlement check is reused this long; any failed completion discards it.
export const OPENROUTER_PARTICLE_PREFLIGHT_MS = 60000;
// OpenRouter counts failed requests against the small free daily allowance, so a capacity 429 never retries sooner than this.
export const OPENROUTER_PARTICLE_CAPACITY_COOLDOWN_SECONDS = 60;
const object = quotaObject;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const zero = (value: unknown) => value === 0 || typeof value === 'string' && /^0(?:\.0+)?$/.test(value.trim());
const costFields = ['cost', 'total_cost', 'credits_charged'];

async function json(response: Response, signal: AbortSignal, limit: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('Oversized response');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// OpenRouter's X-RateLimit-Reset is documented in milliseconds since the epoch.
function resetDelay(headers: Headers, now: number) {
  const raw = headers.get('x-ratelimit-reset');
  if (raw === null || !/^\d+$/.test(raw)) return;
  const at = Number(raw), epochMs = at > 1e12 ? at : at * 1000;
  return quotaSeconds(Math.max(0, epochMs - now) / 1000);
}

// A reply only counts when OpenRouter says it cost nothing: no priced field may be nonzero, and the cost must be reported.
function reportedFree(usage: Record<string, unknown>) {
  const details = object(usage.cost_details);
  return zero(usage.cost) && costFields.every(field => !(field in usage) || zero(usage[field]))
    && Object.entries(details).every(([, value]) => value === null || zero(value));
}

/**
 * OpenRouter's free `particle-ai/particle-1:free` alias only: separate from Kilo's anonymous Particle route, with
 * its own key, its own account allowance and its own data-sharing policy. It never selects a paid alias, never
 * lets OpenRouter pick another model or provider, and refuses any reply that reports a cost.
 */
export class OpenRouterParticle implements Source {
  readonly id = OPENROUTER_PARTICLE_ID;
  readonly supportsFunctionTools = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly firstOutputMs = OPENROUTER_PARTICLE_FIRST_OUTPUT_MS;
  readonly idleMs = OPENROUTER_PARTICLE_IDLE_MS;
  private readonly shutdown = new AbortController();
  private readonly metadata = new MetadataFlights(10000);
  private verified: { key: string; at: number } | undefined;
  private window: { startedAt: number; resetAt: number } | undefined;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {}
  private get now() { return (this.options.now ?? Date.now)(); }
  quotaWindow() { return this.window ? { ...this.window } : undefined; }

  private async checked(caller?: AbortSignal) {
    const signal = AbortSignal.any([this.shutdown.signal, ...(caller ? [caller] : [])]);
    signal.throwIfAborted();
    const directory = this.options.directory ?? configRoot();
    // Consent belongs to this source's own policy. Kilo's approval never counts here.
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    if (grant.base_url !== `https://${OPENROUTER_PARTICLE_HOST}` && !(url.origin === 'https://trusty-squire-api.fly.dev'
      && /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname))) return;
    const key = createHash('sha256').update(JSON.stringify([grant.base_url, grant.token])).digest('hex');
    if (this.verified?.key === key && this.now >= this.verified.at && this.now - this.verified.at < OPENROUTER_PARTICLE_PREFLIGHT_MS) return grant;
    this.verified = undefined;
    const result = await this.metadata.run(key, shared => this.preflight(grant, shared), signal);
    signal.throwIfAborted();
    if (result) this.verified = { key, at: this.now };
    return result;
  }

  private async fail(response: Response, endpoint: 'account' | 'models' | 'chat.completions'): Promise<never> {
    const body = await readQuotaError(response), error = object(body.error), metadata = object(error.metadata);
    const hints = [quotaRetryAfter(response.headers.get('retry-after'), this.now), quotaSeconds(metadata.retry_after_seconds_raw), quotaSeconds(metadata.retry_after_seconds),
      resetDelay(response.headers, this.now)].filter((value): value is number => value !== undefined);
    let retry = hints.length ? Math.max(...hints) : undefined;
    const capacity = response.status === 429 && (metadata.limit_source === 'upstream_provider_shared_pool' || metadata.provider_error_code === 'fleet_capacity_exhausted');
    // Capacity is Particle's shared pool, not this account's allowance. Wait it out without inventing a reset time.
    if (capacity) retry = Math.max(retry ?? 0, OPENROUTER_PARTICLE_CAPACITY_COOLDOWN_SECONDS);
    // A missing or negative credit balance can block even free models. This route never tops up.
    const code = response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota'
      : [403, 404].includes(response.status) ? 'refused' : 'upstream';
    throw new SourceError(code, `OpenRouter Particle returned HTTP ${response.status}`, retry, undefined,
      { httpStatus: response.status, transport: 'http', httpMethod: endpoint === 'chat.completions' ? 'POST' : 'GET', endpointLabel: endpoint });
  }

  // Entitlement: the exact free endpoint is zero-priced with tools and enough context, and the key is an ordinary
  // inference key with a free-model daily allowance left. Anything unverifiable blocks inference.
  private async preflight(grant: FreeApiGrant, signal: AbortSignal) {
    const fetcher = this.options.fetcher ?? fetch;
    const read = async (path: string, endpoint: 'account' | 'models') => {
      const response = await diagnosticFetch(fetcher, this.id, endpoint)(`${grant.base_url}/api/v1/${path}`, {
        redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` }
      });
      if (!response.ok) return this.fail(response, endpoint);
      return json(response, signal, 1024 * 1024);
    };
    const model = object((await read(`models/${OPENROUTER_PARTICLE_MODEL}/endpoints`, 'models')).data);
    const endpoints = Array.isArray(model.endpoints) ? model.endpoints.map(object) : [];
    const free = endpoints.filter(endpoint => endpoint.tag === OPENROUTER_PARTICLE_ENDPOINT);
    if (model.id !== OPENROUTER_PARTICLE_MODEL || free.length !== 1) return;
    const offer = free[0]!, pricing = object(offer.pricing), parameters = offer.supported_parameters;
    if (offer.model_id !== OPENROUTER_PARTICLE_MODEL || offer.status !== 0 || !count(offer.context_length) || offer.context_length < 200000
      || offer.max_prompt_tokens !== null && offer.max_prompt_tokens !== undefined && (!count(offer.max_prompt_tokens) || offer.max_prompt_tokens < 200000)
      || !Object.keys(pricing).length || !('prompt' in pricing) || !('completion' in pricing)
      || !Object.entries(pricing).every(([name, value]) => name === 'discount' ? value === 0 || value === undefined : zero(value))
      || !Array.isArray(parameters) || !['tools', 'tool_choice', 'max_tokens'].every(name => parameters.includes(name))) return;
    const key = object((await read('key', 'account')).data), quota = object(key.free_model_daily_requests);
    // A management key can mint other keys and spend. Only an ordinary inference key may serve this route.
    if (key.is_management_key !== false || key.is_provisioning_key === true || !count(quota.used) || !count(quota.limit) || !count(quota.remaining)
      || quota.limit < 1 || quota.used + quota.remaining > quota.limit) return;
    const day = new Date(this.now).setUTCHours(0, 0, 0, 0);
    this.window = { startedAt: day, resetAt: day + 86400000 };
    if (!quota.remaining) throw new SourceError('quota', 'OpenRouter free-model daily requests are exhausted', Math.max(1, Math.ceil((this.window.resetAt - this.now) / 1000)));
    return grant;
  }

  async available(caller?: AbortSignal) {
    try { return !!await this.checked(caller); }
    catch (error) { if (error instanceof SourceError && error.code === 'quota') throw error; return false; }
  }
  async healthCheck() { return this.available(); }

  async complete(request: ModelRequest, caller: AbortSignal, progress?: () => void): Promise<Completion> {
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenRouter Particle source closed');
    // Only this exact free source: no named paid or other model, no images, no hosted tools.
    if (![this.id, 'grunt', 'milo'].includes(request.model) || request.imageInput || request.tools.some(tool => tool.type !== 'function')) {
      throw new SourceError('refused', 'OpenRouter Particle serves only its exact free text route');
    }
    try { new FreebuffTools(request); } catch { throw requestRefusal('Invalid OpenRouter Particle function definitions or tool conversation'); }
    const validators = compileToolSchemas(request.tools, 'OpenRouter Particle rejected a function tool schema');
    let grant: FreeApiGrant | undefined;
    try { grant = await this.checked(caller); } catch (error) { caller.throwIfAborted(); if (error instanceof SourceError) throw error; }
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenRouter Particle source closed');
    if (!grant) throw new SourceError('refused', 'OpenRouter Particle free route could not be verified');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(OPENROUTER_PARTICLE_TOTAL_MS)]);
    // The caller's output budget, never above the endpoint's maximum; an unspecified one is left to the provider (docs/reference.md).
    const maxTokens = request.maxTokens === undefined ? undefined : Math.min(OPENROUTER_PARTICLE_MAX_OUTPUT, request.maxTokens);
    let streamFailure: SafeDiagnosticMetadata['failureReason'];
    try {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/api/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        // Streaming is for liveness only: the caller still gets one whole reply. `models` and `route` are never sent, so
        // OpenRouter cannot fall back to another model; `provider` pins the free endpoint and forbids any priced one.
        body: JSON.stringify({ model: OPENROUTER_PARTICLE_MODEL, messages: request.messages, ...(request.tools.length ? { tools: request.tools } : {}),
          stream: true, stream_options: { include_usage: true }, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          provider: { only: [OPENROUTER_PARTICLE_ENDPOINT], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } })
      });
      if (!response.ok) return await this.fail(response, 'chat.completions');
      // Whatever usage block arrives is held to zero reported cost; the stream's final chunk carries it.
      const usable = (usage: Record<string, unknown>) => {
        if (!count(usage.prompt_tokens) || !count(usage.completion_tokens) || !reportedFree(usage)) throw new Error('Unverified free usage');
      };
      let reply: Completion;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        reply = await readPromotionalStream(response, OPENROUTER_PARTICLE_MODEL, signal, { ...(progress ? { progress } : {}), failure: reason => { streamFailure ??= reason; }, cleanup: () => {}, result: usable });
      } else {
        const body = await json(response, signal, 4 * 1024 * 1024), usage = object(body.usage);
        if (body.model !== OPENROUTER_PARTICLE_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
        usable(usage);
        const choice = object(body.choices[0]), message = object(choice.message);
        if (message.refusal) throw new SourceError('refused', 'OpenRouter Particle refused the request');
        if (lengthLimited(choice.finish_reason)) return truncatedCompletion(message.content, usage);
        if (!['stop', 'tool_calls'].includes(String(choice.finish_reason)) || !(message.content === undefined || message.content === null || typeof message.content === 'string')) throw new Error('Invalid completion');
        let calls: ToolCall[] | undefined;
        if (message.tool_calls !== undefined) {
          if (!Array.isArray(message.tool_calls)) throw new Error('Invalid tools');
          calls = message.tool_calls.map(raw => {
            const call = object(raw), fn = object(call.function);
            if (typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Invalid tools');
            return { id: call.id, type: call.type as 'function', function: { name: fn.name, arguments: fn.arguments } };
          });
        }
        reply = { text: typeof message.content === 'string' ? message.content : '', ...(calls?.length ? { calls } : {}),
          inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number };
      }
      if (reply.finishReason === 'length') return reply;
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (reply.calls && reply.calls.length > 16) throw new Error('Invalid tools');
      for (const call of reply.calls ?? []) {
        const args: unknown = JSON.parse(call.function.arguments);
        if (call.type !== 'function' || !call.id || ids.has(call.id) || request.messages.some(message => message.tool_calls?.some(old => old.id === call.id))
          || !call.function.name || !validators.get(call.function.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tools');
        ids.add(call.id);
        calls.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } });
      }
      if (!reply.text && !calls.length) throw new Error('Empty answer');
      return { text: reply.text, ...(calls.length ? { calls } : {}), ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }),
        ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }) };
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenRouter Particle source closed');
      // Whatever failed, the next request checks the entitlement again.
      this.verified = undefined;
      if (signal.aborted) throw new SourceError('timeout', 'OpenRouter Particle response timed out');
      if (error instanceof SourceError) throw error;
      const cause = object(object(error).cause), code = object(error).code ?? cause.code;
      const networkCode = diagnosticNetworks.find(known => known === code);
      throw new SourceError('upstream', 'OpenRouter Particle returned an invalid completion', undefined, undefined, streamFailure || networkCode
        ? { transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions', ...(streamFailure ? { failureReason: streamFailure } : {}), ...(networkCode ? { networkCode } : {}) } : undefined);
    }
  }
  async close() { this.shutdown.abort(); this.metadata.close(); }
}
