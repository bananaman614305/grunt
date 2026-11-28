import { compileToolSchemas } from './tool-schema.js';
import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { observeAttemptDispatch, diagnosticFetch, diagnosticNetworks } from './diagnostics.js';
import { classifyHttpFailure, observeAvailabilityFailure } from './provider-error.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { JsonToolBridge } from './json-tool-bridge.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { readPromotionalStream } from './promotional-api.js';
import { completionEnding, emitStreamText, endingOf, withEnding, lengthLimited, truncatedCompletion, SourceError, requestRefusal } from './source.js';
import type { Completion, ModelRequest, SlowUpstreamPolicy, Source, ToolCall } from './source.js';

export const MILLIONSEEK_MODEL = 'deepseek-v4.1-flash-free';
export const MILLIONSEEK_HOST = '100milionseek.top';
export const MILLIONSEEK_SERVICE = '100milionseek';
export const MILLIONSEEK_INPUT_LIMIT = 198000;
// The provider is often congested: time to first token p50 ~11 s, p95 ~48 s, ~28 tokens/s, and its edge cuts a
// silent non-streaming call at ~125 s. A streamed call proves liveness, so a stalled call fails over early while
// a healthy-but-slow one is left alone. First output must arrive within 90 s (well past p95, before the edge
// cutoff); once output starts, 45 s of silence is a stall. The overall bound covers a 4096-token reply at 28 tok/s.
export const MILLIONSEEK_FIRST_OUTPUT_MS = 90000;
export const MILLIONSEEK_IDLE_MS = 45000;
export const MILLIONSEEK_TOTAL_MS = 300000;
// A congested provider needs longer than the default 15 minutes to recover. Slow failures (502/503/504/524, resets,
// cut streams, output deadlines) bench it 30 minutes, doubling per consecutive one up to the 2 hour back-off cap.
export const MILLIONSEEK_SLOW_UPSTREAM: SlowUpstreamPolicy = { baseSeconds: 30 * 60, maxSeconds: 2 * 60 * 60 };
// The /api/status and /v1/models entitlement check is reused for this long; a failed completion discards it.
export const MILLIONSEEK_PREFLIGHT_MS = 60000;
const day = 86400000;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

async function json(response: Response, signal: AbortSignal, limit = 1024 * 1024) {
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > limit) throw new Error('Oversized response'); chunks.push(part.value);
    }
    signal.throwIfAborted(); return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One free-only provider and alias. No wallet, account switching or paid route. */
export class MillionSeek implements Source {
  readonly inferenceOnly = true;
  readonly id = 'millionseek';
  readonly supportsFunctionTools = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly firstOutputMs = MILLIONSEEK_FIRST_OUTPUT_MS;
  readonly idleMs = MILLIONSEEK_IDLE_MS;
  readonly slowUpstream = MILLIONSEEK_SLOW_UPSTREAM;
  private verified: { key: string; at: number } | undefined;
  private shutdown = new AbortController();
  private window: { startedAt: number; resetAt: number } | undefined;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {}
  private get now() { return (this.options.now ?? Date.now)(); }
  quotaWindow() { return this.window && { ...this.window }; }
  private quota(headers: Headers) {
    const numbers = ['x-quota-limit', 'x-quota-used', 'x-quota-remaining'].map(k => {
      const v = headers.get(k); return v !== null && /^\d+$/.test(v) ? Number(v) : NaN;
    });
    const [limit, used, remaining] = numbers;
    const resetAt = Date.parse(headers.get('x-quota-reset') ?? '');
    const nextReset = new Date(this.now).setUTCHours(24, 0, 0, 0);
    if (!numbers.every(integer) || limit! < 100000000 || used! > limit! || remaining !== limit! - used! || resetAt !== nextReset) throw new Error('Unverified free quota');
    this.window = { startedAt: resetAt - day, resetAt };
    return remaining!;
  }
  private async checked(caller?: AbortSignal) {
    const directory = this.options.directory ?? configRoot();
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    if (grant.base_url !== `https://${MILLIONSEEK_HOST}` && !(url.origin === 'https://trusty-squire-api.fly.dev' && /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname))) return;
    const key = `${grant.base_url}\n${grant.token}`;
    if (this.verified?.key === key && this.now >= this.verified.at && this.now - this.verified.at < MILLIONSEEK_PREFLIGHT_MS) return grant;
    this.verified = undefined;
    const checked = await this.preflight(grant, caller);
    if (checked) this.verified = { key, at: this.now };
    return checked;
  }
  private async preflight(grant: FreeApiGrant, caller?: AbortSignal) {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000), ...(caller ? [caller] : [])]);
    const fetcher = this.options.fetcher ?? fetch;
    const status = await diagnosticFetch(fetcher, this.id, 'account')(`${grant.base_url}/api/status`, { redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` } });
    if (!status.ok) { await status.body?.cancel(); return; }
    const state = await json(status, signal), model = object(state.model), allowance = object(state.allowance);
    const at = Date.parse(String(state.updated_at));
    // The permanent 100M entitlement is checked independently of temporary bonuses.
    if (!Number.isFinite(at) || Math.abs(this.now - at) > 60000 || state.base_daily_tokens !== 100000000
      || model.id !== MILLIONSEEK_MODEL || model.context_length !== MILLIONSEEK_INPUT_LIMIT || model.max_output_tokens !== 65536 || model.tools !== true
      || allowance.reset !== '00:00 UTC' || allowance.session_limit !== 5 || !integer(allowance.daily_tokens) || allowance.daily_tokens < 100000000) return;
    const catalog = await diagnosticFetch(fetcher, this.id, 'models')(`${grant.base_url}/v1/models`, { redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` } });
    if (!catalog.ok) { await catalog.body?.cancel(); return; }
    const remaining = this.quota(catalog.headers), body = await json(catalog, signal);
    const offers = Array.isArray(body.data) ? body.data.map(object).filter(row => row.id === MILLIONSEEK_MODEL) : [];
    if (offers.length !== 1 || offers[0]!.owned_by !== '100milionseek' || offers[0]!.context_length !== MILLIONSEEK_INPUT_LIMIT
      || offers[0]!.max_output_tokens !== 65536 || offers[0]!.quota_multiplier !== 1) return;
    if (!remaining) throw new SourceError('quota', '100milionseek daily free allowance exhausted', Math.max(1, Math.ceil((this.window!.resetAt - this.now) / 1000)));
    return grant;
  }
  async available() { try { return !!await this.checked(); } catch (e) { if (e instanceof SourceError && e.code === 'quota') throw e; observeAvailabilityFailure(e); return false; } }
  async complete(request: ModelRequest, caller: AbortSignal, progress?: () => void): Promise<Completion> {
    caller.throwIfAborted();
    if (!['millionseek', 'grunt'].includes(request.model) || request.imageInput || request.tools.some(t => t.type !== 'function')) throw new SourceError('refused', '100milionseek requires its exact free text route');
    try { new JsonToolBridge(request); } catch { throw requestRefusal('Invalid 100milionseek function definitions or tool conversation'); }
    const validators = compileToolSchemas(request.tools, 'Invalid 100milionseek function schema');
    let grant: FreeApiGrant | undefined;
    try { grant = await this.checked(caller); } catch (e) { caller.throwIfAborted(); if (e instanceof SourceError) throw e; }
    caller.throwIfAborted();
    if (!grant) throw new SourceError('refused', '100milionseek free entitlement could not be verified');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(MILLIONSEEK_TOTAL_MS)]);
    const maxTokens = request.maxTokens;
    // Streaming is for liveness only: Grunt still hands the client one whole reply.
    const payload = JSON.stringify({ model: MILLIONSEEK_MODEL, messages: request.messages, ...(request.tools.length ? { tools: request.tools } : {}), stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens });
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new SourceError('refused', '100milionseek request exceeds its documented body limit');
    let streamFailure: SafeDiagnosticMetadata['failureReason'];
    try {
      observeAttemptDispatch({ model: MILLIONSEEK_MODEL, account: 'vaulted', maxOutputTokens: maxTokens });
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }, body: payload });
      if (!response.ok) {
        let retry: number | undefined;
        const raw = await json(response, signal).catch(() => ({} as Record<string, unknown>)), error = object(raw.error);
        if (response.status === 429 && error.code === 'daily_quota_exceeded') retry = Math.max(1, Math.ceil((new Date(this.now).setUTCHours(24, 0, 0, 0) - this.now) / 1000));
        else { const after = response.headers.get('retry-after'); if (after && /^\d+$/.test(after)) retry = Math.max(1, Number(after)); }
        throw classifyHttpFailure({
          source: '100milionseek',
          status: response.status,
          ...(retry === undefined ? {} : { retryAfter: retry }),
          endpointLabel: 'chat.completions'
        });
      }
      this.quota(response.headers);
      // A usage block, when the provider sends one, is held to the same checks as a whole reply's.
      const usable = (usage: Record<string, unknown>) => {
        if (!integer(usage.prompt_tokens) || usage.prompt_tokens < 1 || !integer(usage.completion_tokens) || maxTokens !== undefined && usage.completion_tokens > maxTokens
          || ['cost', 'total_cost', 'credits_charged'].some(k => k in usage && usage[k] !== 0)) throw new Error('Invalid completion');
      };
      let reply: Completion;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        reply = await readPromotionalStream(response, MILLIONSEEK_MODEL, signal, { ...(progress ? { progress } : {}), ...(request.stream ? { text: delta => emitStreamText(delta) } : {}), failure: reason => { streamFailure ??= reason; }, cleanup: () => {},
          // A stream without usage (the provider ignoring include_usage) is still a valid reply; its token counts are unknown.
          result: usage => { if (Object.keys(usage).length) usable(usage); } });
      } else {
        // A provider that ignores `stream` answers with one JSON body.
        const body = await json(response, signal, 4 * 1024 * 1024), usage = object(body.usage);
        if (body.model !== MILLIONSEEK_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
        const choice = object(body.choices[0]), message = object(choice.message);
        if (message.refusal) throw new SourceError('refused', '100milionseek refused the request');
        usable(usage);
        if (lengthLimited(choice.finish_reason)) return truncatedCompletion(message.content, usage, choice.finish_reason);
        if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))
          || !(message.content === undefined || message.content === null || typeof message.content === 'string')) throw new Error('Invalid completion');
        let calls: ToolCall[] | undefined;
        if (message.tool_calls !== undefined) {
          if (!Array.isArray(message.tool_calls)) throw new Error('Invalid tools');
          calls = message.tool_calls.map(raw => {
            const call = object(raw), fn = object(call.function);
            if (typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Invalid tools');
            return { id: call.id, type: call.type as 'function', function: { name: fn.name, arguments: fn.arguments } };
          });
        }
        reply = withEnding({ text: typeof message.content === 'string' ? message.content : '', ...(calls?.length ? { calls } : {}), inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number },
          completionEnding(choice.finish_reason, usage, !!calls?.length));
      }
      if (reply.finishReason === 'length') return reply;
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (reply.calls && reply.calls.length > 16) throw new Error('Invalid tools');
      for (const call of reply.calls ?? []) {
        const args: unknown = JSON.parse(call.function.arguments);
        if (call.type !== 'function' || !call.id || ids.has(call.id) || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id))
          || !call.function.name || !validators.get(call.function.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tools');
        ids.add(call.id); calls.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } });
      }
      if (!reply.text && !calls.length) throw new Error('Empty answer');
      const ended = endingOf(reply), final = { text: reply.text, ...(calls.length ? { calls } : {}), ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }), ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }) };
      return ended ? withEnding(final, { ...ended, toolCalls: calls.length > 0 }) : final;
    } catch (e) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', '100milionseek source closed');
      // Whatever failed, the next request re-checks the entitlement.
      this.verified = undefined;
      if (signal.aborted) throw new SourceError('timeout', '100milionseek response timed out');
      if (e instanceof SourceError) throw e;
      const cause = object(object(e).cause), code = object(e).code ?? cause.code;
      const networkCode = diagnosticNetworks.find(known => known === code);
      throw new SourceError('upstream', '100milionseek returned an invalid completion', undefined, undefined, streamFailure || networkCode
        ? { transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions', ...(streamFailure ? { failureReason: streamFailure } : {}), ...(networkCode ? { networkCode } : {}) } : undefined);
    }
  }
  async close() { this.shutdown.abort(); }
}
