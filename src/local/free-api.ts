import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';

import { join } from 'node:path';
import { completionEnding, emitStreamText, endingOf, withEnding, lengthLimited, truncatedCompletion, SourceError } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';
import { classifyHttpFailure, observeAvailabilityFailure } from './provider-error.js';
import { readPromotionalStream } from './promotional-api.js';
import { nousQuotaDelay, quotaObject, quotaRetryAfter, readQuotaError } from './quota-timing.js';
import { observeAttemptDispatch, diagnosticFetch } from './diagnostics.js';
import { isVaultProvider, readVaultGrant } from './vault.js';

// Low-level pinned clients. Production wrappers add provider-specific access
// receipts, quota checks and data-sharing consent before enabling a route.
export const FREE_API_PROVIDERS = {
  zro: { model: 'deepseek-v4.1-flash', prefix: '/v1' },
  amd: { model: 'DeepSeek-V4.1-Flash', prefix: '/radeon/api/v1' },
  tokenharbor: { model: 'deepseek-v4.1-flash:free', prefix: '/v1' },
  runcrate: { model: 'deepseek-ai/DeepSeek-V4.1-Flash', prefix: '/v1' },
  livekit: { model: 'deepseek-ai/deepseek-v4.1-flash', prefix: '/v1' },
  nous: { model: 'qwen/qwen4-max:free', prefix: '/v1' },
  crowllm: { model: 'glm-5.3-flash:free', prefix: '/v1' },
  goedel: { model: 'deepseek/deepseek-v4.1-flash', prefix: '/v1' },
  numes: { model: 'z-ai/glm-5.3-flash:free', prefix: '/api/v1' }
} as const;
export type FreeApiProvider = keyof typeof FREE_API_PROVIDERS;
export interface FreeApiGrant { base_url: string; token: string }
// Official API metadata maps deepseek-flash to DeepSeek-V4.1-Flash:
// https://api-docs.deepseek.com/api/list-models/ . Other aliases below are the
// explicit V4.1 IDs used by these providers, not loose family-name matches.
const deepSeekV41Aliases = new Set(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
  'deepseek-v4.1-flash-free', 'deepseek-v4.1-flash:free', 'free/deepseek-v4.1-flash']);
export function isDeepSeekV41Model(value: unknown): boolean {
  return typeof value === 'string' && deepSeekV41Aliases.has(value.toLowerCase().replace(/^deepseek(?:-ai)?\//, ''));
}
const directory = () => configRoot();
function providerName(value: string): FreeApiProvider {
  if (!Object.hasOwn(FREE_API_PROVIDERS, value)) throw new Error('Unsupported free API provider');
  return value as FreeApiProvider;
}
function validateGrant(value: unknown): FreeApiGrant {
  const grant = value as Partial<FreeApiGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()) throw new Error('Invalid free API grant');
  let url: URL;
  try { url = new URL(grant.base_url); } catch { throw new Error('Invalid free API grant endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid free API grant endpoint');
  return { base_url: grant.base_url.replace(/\/$/, ''), token: grant.token };
}
export async function readFreeApiGrant(
  provider: FreeApiProvider,
  location = directory(),
  env: NodeJS.ProcessEnv = process.env
): Promise<FreeApiGrant> {
  const name = providerName(provider);
  if (isVaultProvider(name)) {
    const vaulted = await readVaultGrant(name, location, env);
    if (vaulted) return validateGrant({ base_url: vaulted.base_url, token: vaulted.token });
  }
  const file = await openPrivateFile(join(location, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) throw new Error('Unsafe free API grant file');
    return validateGrant(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finishReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'] as const satisfies readonly Completion['finishReason'][];
const validCalls = (value: unknown): value is ToolCall[] => Array.isArray(value) && value.every(call => call && typeof call.id === 'string'
  && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string');

export class FreeApi implements Source {
  readonly inferenceOnly = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly id: FreeApiProvider;
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  constructor(provider: FreeApiProvider, private options: {
    directory?: string; fetcher?: typeof fetch; timeout?: number; expectedModel?: string;
    verifyModel?: (model: unknown, response: Response) => boolean;
    verifyUsage?: (usage: Record<string, unknown>) => boolean;
    allowStream?: boolean; emitClientStream?: boolean; loadGrant?: () => Promise<FreeApiGrant>;
  } = {}) {
    this.id = providerName(provider);
  }
  private get spec() { return FREE_API_PROVIDERS[this.id]; }
  private grant() { return (this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.options.directory)).then(validateGrant); }
  // Availability here means private access is configured. Only the live probe
  // establishes whether the provider will serve the requested free model.
  async available() { try { await this.grant(); return true; } catch { observeAvailabilityFailure(new SourceError('not_installed', `${this.id} access is not configured`)); return false; } }
  complete(request: ModelRequest, caller: AbortSignal, output?: () => void) {
    return this.completeWithGrant(request, caller, undefined, output);
  }
  async completeWithGrant(request: ModelRequest, caller: AbortSignal, verifiedGrant?: FreeApiGrant, output?: () => void) {
    caller.throwIfAborted();
    if (![this.id, 'grunt'].includes(request.model)) throw new SourceError('upstream', 'Free API probe requires an explicit provider');
    if (request.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'Free API probe requires function tools');
    let grant: FreeApiGrant;
    try { grant = verifiedGrant ?? await this.grant(); }
    catch { throw new SourceError('logged_out', `${this.id} access is not configured`); }
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    const wantStream = this.options.allowStream !== false;
    let response: Response;
    try {
      observeAttemptDispatch({ model: this.spec.model, account: 'configured', maxOutputTokens: request.maxTokens });
      response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}${this.spec.prefix}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ model: this.spec.model, messages: request.messages,
          tools: request.tools.length ? request.tools : undefined, stream: wantStream,
          ...(wantStream ? { stream_options: { include_usage: true } } : {}),
          max_tokens: request.maxTokens })
      });
    } catch {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Free API probe closed');
      throw new SourceError(signal.aborted ? 'timeout' : 'upstream', `${this.id} endpoint is unavailable`);
    }
    if (!response.ok) {
      let retry = quotaRetryAfter(response.headers.get('Retry-After'));
      if (response.status === 429 && (this.id === 'nous' || this.id === 'numes' && retry === undefined)) {
        const body = await readQuotaError(response);
        if (this.id === 'nous') retry = nousQuotaDelay(response.headers, body);
        // Numes documents a provider-side rate limit without Retry-After.
        // Use a brief local backoff and keep trying other free routes.
        else {
          const code = quotaObject(quotaObject(body.error).metadata).error_type;
          if (code === 'rate_limited' || code === 'provider_overloaded') retry = 60;
        }
      } else await response.body?.cancel();
      throw classifyHttpFailure({
        source: this.id,
        status: response.status,
        ...(retry === undefined ? {} : { retryAfter: retry }),
        httpMethod: 'POST',
        endpointLabel: 'chat.completions'
      });
    }
    const verifyModel = this.options.verifyModel;
    const verifyUsage = this.options.verifyUsage;
    const checkUsage = (usage: unknown) => {
      if (verifyUsage && !verifyUsage(quotaObject(usage))) {
        throw new SourceError('upstream', `${this.id} returned unverified usage`, undefined, undefined, {
          failureReason: 'completion_billing', transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions'
        });
      }
    };
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const reply = await readPromotionalStream(response, this.options.expectedModel, signal, {
          ...(verifyModel ? { verifyModel: model => verifyModel(model, response) } : {}),
          ...(verifyUsage ? {
            event: chunk => { if (chunk.usage != null) checkUsage(chunk.usage); },
            result: checkUsage
          } : {}),
          strictToolArgs: false,
          allowAnyFinishReason: true,
          ...(output ? { progress: output } : {}),
          ...(request.stream && this.options.emitClientStream !== false ? { text: delta => emitStreamText(delta) } : {}),
          failure: () => {},
          cleanup: () => {}
        });
        signal.throwIfAborted();
        if (reply.finishReason === 'length') return reply;
        if (reply.calls !== undefined && !validCalls(reply.calls)) throw new SourceError('upstream', `${this.id} returned an invalid completion`);
        const ended = endingOf(reply);
        const finishReason = this.id === 'zro' ? finishReasons.find(reason => reason === ended?.providerFinish || reason === ended?.finish) : undefined;
        const result: Completion = {
          text: reply.text,
          ...(reply.calls?.length ? { calls: reply.calls } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }),
          ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens })
        };
        return ended ? withEnding(result, ended) : result;
      }
      const body = await response.json() as { model?: unknown; choices?: { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown; refusal?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      signal.throwIfAborted();
      if (this.options.expectedModel !== undefined && body.model !== this.options.expectedModel) {
        throw new SourceError('upstream', `${this.id} returned a different model`);
      }
      if (verifyModel && !verifyModel(body.model, response)) {
        throw new SourceError('upstream', `${this.id} returned a different model`);
      }
      checkUsage(body.usage);
      const choice = body.choices?.[0], message = choice?.message;
      const finishReason = this.id === 'zro' ? finishReasons.find(reason => reason === choice?.finish_reason) : undefined;
      if (message?.refusal) throw new SourceError('refused', `${this.id} refused the request`);
      if (lengthLimited(choice?.finish_reason)) return truncatedCompletion(message?.content, body.usage, choice?.finish_reason);
      const calls = message?.tool_calls;
      if (!message || (typeof message.content !== 'string' && !(validCalls(calls) && calls.length)) || (calls !== undefined && !validCalls(calls))) throw new SourceError('upstream', `${this.id} returned an invalid completion`);
      const inputTokens = tokens(body.usage?.prompt_tokens), outputTokens = tokens(body.usage?.completion_tokens);
      return withEnding({ text: typeof message.content === 'string' ? message.content : '', ...(validCalls(calls) && calls.length ? { calls } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) },
      completionEnding(choice?.finish_reason, body.usage, validCalls(calls) && calls.length > 0));
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Free API probe closed');
      if (signal.aborted) throw new SourceError('timeout', `${this.id} endpoint is unavailable`);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `${this.id} returned an invalid completion`);
    }
  }
  async close() { this.shutdown.abort(); }
}
