import { configRoot } from '../brand.js';
import {
  ID_PATTERN,
  disabledAdapters,
  isDeclarativeAdapter,
  knownAdapters,
  safeApiPath,
  safePublicHttpsOrigin
} from '../registry.js';
import type { Adapter, DeclarativeAdapter, Registry } from '../registry.js';
import { declarativeDataSharingPolicy, readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch, observeAttemptDispatch, recordTransport } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { readPromotionalStream } from './promotional-api.js';
import {
  declarativeGrantAllowed,
  firstWorkingGrant,
  readDeclarativeProviderGrant,
  validateProviderGrant,
  writeDeclarativeProviderGrant
} from './provider-grant.js';
import { nousQuotaDelay, readQuotaError } from './quota-timing.js';
import type { BrowserSquire, SetupSquire } from './setup.js';
import { SetupRefusal } from './setup-failure.js';
import {
  SourceError,
  completionEnding,
  lengthLimited,
  requestRefusal,
  truncatedCompletion,
  withEnding
} from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const DECLARATIVE_STORE_LABEL = 'Grunt Free';
const DAY_MS = 24 * 60 * 60 * 1000;
const MODELS_MAX_BYTES = 2 * 1024 * 1024;
const COMPLETION_MAX_BYTES = 4 * 1024 * 1024;
const COST_KEY_PATTERN = /(?:^|_)(?:cost|price|charge|charged|usd|cents|billed)(?:$|_)/i;
const PRICING_METADATA_KEYS = new Set(['unit', 'currency']);
const PRICING_PRIMARY_KEYS = new Set(['prompt', 'completion', 'input', 'output', 'request', 'token', 'input_token', 'output_token']);

type FailureReason = NonNullable<SafeDiagnosticMetadata['failureReason']>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isZeroPriceValue(value: unknown): boolean {
  return value === 0 || typeof value === 'string' && /^0(?:\.0+)?$/.test(value.trim());
}

export function declarativeRetired(adapter: Pick<Adapter, 'status' | 'expires'>, now = Date.now()): boolean {
  return adapter.status === 'inactive' || adapter.status === 'expiring'
    || adapter.expires !== undefined && now >= Date.parse(adapter.expires) + DAY_MS;
}

// Refuse any response usage/body payload that reports a non-zero monetary cost.
export function isUsageZeroCost(record: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (COST_KEY_PATTERN.test(key)) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        if (!isUsageZeroCost(value as Record<string, unknown>)) return false;
      } else if (!isZeroPriceValue(value)) {
        return false;
      }
    }
  }
  return true;
}

// Verify a single /models catalog entry carries positive zero-price proof and no paid pricing fields.
export function isCatalogOfferZeroPrice(offer: Record<string, unknown>, minContextLength?: number, now = Date.now()): boolean {
  if (offer.is_free !== undefined && offer.is_free !== true) return false;
  if (offer.free !== undefined && offer.free !== true) return false;
  if (offer.quota_multiplier !== undefined && !isZeroPriceValue(offer.quota_multiplier)) return false;
  if (offer.model_price !== undefined && !isZeroPriceValue(offer.model_price)) return false;
  if (offer.price !== undefined && !isZeroPriceValue(offer.price)) return false;
  if (offer.cost !== undefined && !isZeroPriceValue(offer.cost)) return false;
  if (typeof offer.expiration_date === 'string') {
    const parsed = Date.parse(offer.expiration_date);
    if (!Number.isFinite(parsed) || now >= parsed) return false;
  }
  const capabilities = object(offer.capabilities);
  if (capabilities.tool_calling === false) return false;
  if (minContextLength !== undefined) {
    const context = offer.context_length ?? offer.context_window;
    if (!count(context) || context < minContextLength) return false;
  }

  let positiveProof = offer.is_free === true || offer.free === true
    || (offer.price !== undefined && isZeroPriceValue(offer.price))
    || (offer.cost !== undefined && isZeroPriceValue(offer.cost))
    || (offer.model_price !== undefined && isZeroPriceValue(offer.model_price));

  if (offer.pricing !== undefined) {
    if (offer.pricing === null || typeof offer.pricing !== 'object' || Array.isArray(offer.pricing)) return false;
    const pricing = offer.pricing as Record<string, unknown>;
    let seenZeroPriceField = false;
    for (const [key, value] of Object.entries(pricing)) {
      if (value === undefined) continue;
      if (PRICING_METADATA_KEYS.has(key) && typeof value === 'string') continue;
      if (!isZeroPriceValue(value)) return false;
      if (PRICING_PRIMARY_KEYS.has(key) || COST_KEY_PATTERN.test(key) || typeof value === 'number' || typeof value === 'string') {
        seenZeroPriceField = true;
      }
    }
    if (seenZeroPriceField) positiveProof = true;
  }
  return positiveProof;
}

export function declarativeSquireStore(adapter: DeclarativeAdapter) {
  const origin = safePublicHttpsOrigin(adapter.declarative.baseUrl);
  if (!origin) return undefined;
  return {
    service: adapter.id,
    label: DECLARATIVE_STORE_LABEL,
    api_hosts: [new URL(origin).hostname],
    auth_shape: 'bearer' as const
  };
}

async function readBoundedJson(response: Response, signal: AbortSignal, limit: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validCalls(value: unknown): value is ToolCall[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  const ids = new Set<string>();
  return value.every(item => {
    const call = object(item), fn = object(call.function);
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function'
      || typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string') return false;
    ids.add(call.id);
    try {
      const parsed: unknown = JSON.parse(fn.arguments);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch { return false; }
  });
}

function buildCompletion(text: string, calls: ToolCall[], usage: Record<string, unknown>, model: string, finish?: unknown): Completion {
  const inputTokens = count(usage.prompt_tokens) ? usage.prompt_tokens : undefined;
  const outputTokens = count(usage.completion_tokens) ? usage.completion_tokens : undefined;
  return withEnding({
    servedModel: model,
    free: true,
    text,
    ...(calls.length ? { calls } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens })
  }, completionEnding(finish, usage, calls.length > 0));
}

export interface DeclarativeApiOptions {
  directory?: string;
  registry?: () => Registry;
  adapter?: () => DeclarativeAdapter | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
  loadGrant?: () => Promise<FreeApiGrant>;
  timeout?: number;
}

// Generic OpenAI-compatible free-API source driven solely by validated registry
// data. Enforces HTTPS origin pinning, Squire grant host checks, data-sharing
// receipts, optional live /models zero-price verification, exact pinned model
// attestation, zero-cost usage checks, native function tools, and expiry cutoff.
export class DeclarativeApi implements Source {
  readonly inferenceOnly = true;
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();

  constructor(readonly id: string, private options: DeclarativeApiOptions = {}) {
    if (!ID_PATTERN.test(id) || knownAdapters.has(id) || disabledAdapters.has(id)) {
      throw new Error(`Invalid declarative adapter id: ${id}`);
    }
  }

  get reportsProgress(): boolean {
    return this.entry()?.declarative.stream === true;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private entry(): DeclarativeAdapter | undefined {
    const candidate = this.options.adapter?.() ?? this.options.registry?.().adapters.find(adapter => adapter.id === this.id);
    if (!isDeclarativeAdapter(candidate) || candidate.id !== this.id) return undefined;
    if (!safePublicHttpsOrigin(candidate.declarative.baseUrl) || !safeApiPath(candidate.declarative.apiPath)) return undefined;
    if (candidate.declarative.zeroPriceCheck === 'models_catalog' && !safeApiPath(candidate.declarative.modelsEndpoint)) return undefined;
    return candidate;
  }

  private async responseFailure(response: Response, endpoint: 'models' | 'chat.completions'): Promise<never> {
    const body = await readQuotaError(response);
    const retry = nousQuotaDelay(response.headers, body, this.now);
    throw new SourceError(
      response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
      `${this.id} returned HTTP ${response.status}`,
      retry,
      undefined,
      { httpStatus: response.status, transport: 'http', httpMethod: endpoint === 'chat.completions' ? 'POST' : 'GET', endpointLabel: endpoint }
    );
  }

  private async verifiedAccess(caller?: AbortSignal): Promise<{ adapter: DeclarativeAdapter; grant: FreeApiGrant } | undefined> {
    const adapter = this.entry();
    if (!adapter || declarativeRetired(adapter, this.now)) return undefined;
    const directory = this.options.directory ?? configRoot();
    const policy = declarativeDataSharingPolicy(adapter);
    if (!(await readDataSharingConsent(directory, [this.id], [policy])).includes(this.id)) return undefined;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readDeclarativeProviderGrant(this.id, directory)));
    if (!declarativeGrantAllowed(grant, adapter.declarative.baseUrl)) return undefined;

    if (adapter.declarative.zeroPriceCheck === 'models_catalog') {
      const modelsPath = adapter.declarative.modelsEndpoint;
      if (!safeApiPath(modelsPath)) return undefined;
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000), ...(caller ? [caller] : [])]);
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models')(`${grant.base_url}${modelsPath}`, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'User-Agent': 'grunt' }
      });
      if (!response.ok) return await this.responseFailure(response, 'models');
      const catalog = await readBoundedJson(response, signal, MODELS_MAX_BYTES);
      if (!Array.isArray(catalog.data)) return undefined;
      const offers = catalog.data.map(object).filter(row => row.id === adapter.model);
      if (offers.length !== 1) return undefined;
      if (!isCatalogOfferZeroPrice(offers[0]!, adapter.declarative.minContextLength, this.now)) return undefined;
    }

    // Recheck expiry/retirement after preflight I/O so an expired offer never dispatches.
    const latest = this.entry();
    if (!latest || declarativeRetired(latest, this.now)) return undefined;
    return { adapter: latest, grant };
  }

  async available(signal?: AbortSignal): Promise<boolean> {
    try { return !!(await this.verifiedAccess(signal)); }
    catch (error) {
      if (error instanceof SourceError && error.code === 'quota') throw error;
      return false;
    }
  }

  async complete(request: ModelRequest, caller: AbortSignal, progress?: () => void): Promise<Completion> {
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', `${this.id} source closed`);
    if (![this.id, 'grunt', 'milo'].includes(request.model)) {
      throw new SourceError('refused', `Unsupported declarative model request for ${this.id}`);
    }
    if (request.tools.some(tool => tool.type !== 'function')) {
      throw requestRefusal(`${this.id} supports function tools only`, 'request_tools');
    }

    const adapter = this.entry();
    if (!adapter) throw new SourceError('refused', `${this.id} is not in the current adapter registry`);
    if (declarativeRetired(adapter, this.now)) {
      throw new SourceError('refused', `${this.id} declarative free offer expired or retired; select another free route`);
    }
    const directory = this.options.directory ?? configRoot();
    const policy = declarativeDataSharingPolicy(adapter);
    if (!(await readDataSharingConsent(directory, [this.id], [policy])).includes(this.id)) {
      throw new SourceError('refused', `${this.id} data sharing is not approved; rerun usegrunt setup`);
    }

    let verified: { adapter: DeclarativeAdapter; grant: FreeApiGrant } | undefined;
    try {
      verified = await this.verifiedAccess(caller);
    } catch (error) {
      caller.throwIfAborted();
      if (error instanceof SourceError) throw error;
    }
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', `${this.id} source closed`);
    if (declarativeRetired(adapter, this.now)) {
      throw new SourceError('refused', `${this.id} declarative free offer expired or retired; select another free route`);
    }
    if (!verified) {
      throw new SourceError('refused', `${this.id} declarative free offer could not be verified`);
    }

    const { adapter: current, grant } = verified;
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    let completionFailure: FailureReason | undefined;
    try {
      observeAttemptDispatch({ model: current.model, account: 'vaulted', maxOutputTokens: request.maxTokens });
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}${current.declarative.apiPath}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${grant.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'grunt'
        },
        body: JSON.stringify({
          model: current.model,
          messages: request.messages,
          tools: request.tools.length ? request.tools : undefined,
          stream: Boolean(current.declarative.stream),
          ...(current.declarative.stream ? { stream_options: { include_usage: true } } : {}),
          max_tokens: request.maxTokens
        })
      });
      if (!response.ok) return await this.responseFailure(response, 'chat.completions');

      if (current.declarative.stream) {
        const result = await readPromotionalStream(response, current.model, signal, {
          ...(progress ? { progress } : {}),
          failure: reason => { completionFailure = reason; },
          cleanup: () => {
            recordTransport({
              source: this.id, outcome: 'failed', transport: 'http', httpMethod: 'POST',
              endpointLabel: 'chat.completions', httpStatus: response.status, failureReason: 'stream_cleanup'
            });
          },
          result: usage => {
            if (!isUsageZeroCost(usage)) {
              throw new SourceError('refused', `${this.id} reported a non-zero usage cost`);
            }
          }
        });
        result.servedModel = current.model;
        result.free = true;
        return result;
      }

      const body = await readBoundedJson(response, signal, COMPLETION_MAX_BYTES);
      if (body.model !== current.model) {
        throw new SourceError('upstream', `${this.id} returned unexpected model`);
      }
      const usage = object(body.usage);
      if (!isUsageZeroCost(body) || !isUsageZeroCost(usage)) {
        throw new SourceError('refused', `${this.id} reported a non-zero usage cost`);
      }
      if (!Array.isArray(body.choices) || !body.choices.length) throw new Error('Missing choices');
      const choice = object(body.choices[0]), message = object(choice.message);
      if (message.refusal) throw new SourceError('refused', `${this.id} refused the request`);
      if (lengthLimited(choice.finish_reason)) {
        return truncatedCompletion(message.content, usage, choice.finish_reason, { servedModel: current.model, free: true });
      }
      const calls = message.tool_calls;
      if (calls !== undefined && !validCalls(calls) || typeof message.content !== 'string' && !(validCalls(calls) && calls.length)) {
        throw new Error('Invalid completion');
      }
      if (!message.content && !(validCalls(calls) && calls.length)) {
        throw new Error('Empty completion');
      }
      return buildCompletion(typeof message.content === 'string' ? message.content : '', validCalls(calls) ? calls : [], usage, current.model, choice.finish_reason);
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', `${this.id} source closed`);
      if (signal.aborted) throw new SourceError('timeout', `${this.id} response timed out`);
      if (error instanceof SourceError) throw error;
      const reason = completionFailure;
      throw new SourceError('upstream', `${this.id} returned an invalid completion`, undefined, undefined, reason ? {
        failureReason: reason,
        transport: 'http',
        httpMethod: 'POST',
        endpointLabel: 'chat.completions'
      } : undefined);
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
  }
}

type DeclarativeSetupSquire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;

export async function setupDeclarativeApi(adapter: DeclarativeAdapter, options: {
  directory: string;
  squire: DeclarativeSetupSquire;
  notify(line: string): void;
  connect?: () => Promise<void>;
  signal?: AbortSignal;
  background: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const { directory, squire, notify, signal } = options;
  const now = (options.now ?? Date.now)();
  if (declarativeRetired(adapter, now)) {
    throw new SetupRefusal('free promotion expired', `${adapter.id}'s free promotion has expired or been retired; use another free route`);
  }
  const policy = declarativeDataSharingPolicy(adapter);
  if (!(await readDataSharingConsent(directory, [adapter.id], [policy])).includes(adapter.id)) {
    throw new Error(`${adapter.id} requires current data-sharing approval`);
  }
  const store = declarativeSquireStore(adapter);
  if (!store) throw new Error(`${adapter.id} has an invalid API endpoint`);
  const apiHost = store.api_hosts[0]!;
  const signupHost = new URL(adapter.signup).hostname;
  const allowedHost = (host: string) => host === apiHost || host === signupHost || host === `*.${signupHost}`;
  const probeSource = (loadGrant?: () => Promise<FreeApiGrant>) => new DeclarativeApi(adapter.id, {
    directory,
    adapter: () => adapter,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(loadGrant ? { loadGrant } : {})
  });

  signal?.throwIfAborted();
  if (await probeSource().available(signal)) {
    notify(`${adapter.id}: declarative free route reused`);
    return;
  }

  await options.connect?.();
  const select = async () => {
    if (!squire.call) {
      const list = await squire.credentials.list();
      return list.filter(item => item.service?.trim().toLowerCase() === adapter.id
        && item.auth_strategy !== 'username_password'
        && item.field_names.some(field => /^(?:value|api_?key|token|key)$/i.test(field)));
    }
    const result = await squire.call('list_credentials', { service: adapter.id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error(`${adapter.id} vault lookup incomplete`);
    return (result.credentials as { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }[])
      .filter(item => item?.service === adapter.id
        && item.label === store.label
        && item.reference?.startsWith('vault://')
        && item.allowed_hosts?.includes(apiHost)
        && item.allowed_hosts.every(allowedHost)
        && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
        && item.field_names?.length === 1
        && /^(?:value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };

  let matches = await select();
  if (!matches.length) {
    if (options.background) throw new Error(`${adapter.id} has no saved free API key`);
    if (!squire.signup) throw new Error(`${adapter.id} requires browser-capable Trusty Squire`);
    signal?.throwIfAborted();
    await squire.signup(
      adapter.id,
      adapter.signup,
      `Reuse this user's account and connected identity. If no account exists, create one ordinary personal free account. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed. Pause for the user only if Squire cannot finish a required verification step. Never skip or forge verification. Do not add a card, pay, top up, activate a paid plan, or create a second account. Reuse or create one key named ${store.label} and capture directly into Squire service ${adapter.id}, label ${store.label}, auth_shape bearer, api_hosts ["${apiHost}"]. Never show its value. Use only ${adapter.model}. If key model restrictions are offered, allow only this exact free model.`
    );
    matches = await select();
  }
  if (!matches.length) throw new Error(`${adapter.id} requires one unambiguous ${store.label} API key`);
  signal?.throwIfAborted();

  const grant = await firstWorkingGrant(
    matches.map(item => item.reference!),
    reference => squire.credentials.grant(reference),
    candidate => probeSource(async () => candidate).available(signal),
    signal
  );
  if (!grant) throw new Error(`${adapter.id} free catalog/grant verification failed`);
  signal?.throwIfAborted();
  await writeDeclarativeProviderGrant(adapter.id, grant, directory);
  notify(`${adapter.id}: declarative free route connected`);
}
