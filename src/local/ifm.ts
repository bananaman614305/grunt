import { createHash } from 'node:crypto';
import { compileToolSchemas } from './tool-schema.js';
import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch, diagnosticNetworks, observeAttemptDispatch, observeAttemptQueue } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import { readPromotionalStream } from './promotional-api.js';
import type { FreeApiGrant } from './free-api.js';
import { JsonToolBridge } from './json-tool-bridge.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { quotaRetryAfter, quotaSeconds } from './quota-timing.js';
import { completionEnding, endingOf, withEnding, lengthLimited, truncatedCompletion, SourceError, requestRefusal } from './source.js';
import type { Completion, Message, ModelRequest, Source, ToolCall } from './source.js';

export const IFM_MODEL = 'IFM/K2-Horizon-375B-A23B';
export const IFM_HOST = 'api.ifm.ai';
export const IFM_SERVICE = 'ifm';
/** The context window IFM documents and lists in its catalog. It is not a usable-input claim. */
export const IFM_DOCUMENTED_CONTEXT = 524288;
/** The largest prompt grunt has sent to this route (a needle retrieved at 205,019 prompt tokens, Cerebras-routed). Other hosts behind IFM were not tested at this size. */
export const IFM_MEASURED_INPUT = 205019;
/** The documented daily token allowance of one key, prompt and completion tokens together. */
export const IFM_DAILY_TOKENS = 10000000;
// The catalog check is reused for this long; any failed completion discards it.
export const IFM_PREFLIGHT_MS = 60000;
// A reply streams for liveness. The first delta (usually reasoning) must arrive within 120 s, which covers the 2 to 6 s
// seen on 50K-token prompts with a wide margin, and 60 s of silence after output starts is a stall. The overall bound
// covers a 32K-token reply at the ~125 tokens a second measured, with margin.
export const IFM_FIRST_OUTPUT_MS = 120000;
export const IFM_IDLE_MS = 60000;
export const IFM_TOTAL_MS = 600000;
// Each streamed token is one ~240-byte event, so a 32K-token reply is ~8 MB; allow far more than the shared 4 MiB.
export const IFM_STREAM_BYTES = 64 * 1024 * 1024;
export const IFM_REASONING_CHARS = 2 * 1024 * 1024;
export const IFM_GUARD_BACKOFF_SECONDS = 30;
// Every live response carried a request guard of 2 with a 1 s reset. Starts are spaced to stay inside it.
export const IFM_GUARD_REQUESTS = 2;
export const IFM_GUARD_WINDOW_MS = 1000;
const MEMORY_LIMIT = 512;
const day = 86400000;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

async function json(response: Response, signal: AbortSignal, limit = 4 * 1024 * 1024) {
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

// IFM sends Go-style durations in its reset headers: "1s", "250ms", "1m30s", "24h0m0s".
export function ifmDuration(value: string | null): number | undefined {
  if (value === null || !/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(value)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) seconds += Number(amount) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : unit === 's' ? 1 : 0.001);
  return quotaSeconds(seconds);
}

// How long to wait after an HTTP 429. Only signals IFM documents or actually sends count: Retry-After, a
// dimension whose own remaining counter is zero, and the daily cap resetting at 00:00 UTC. A bare 429 has no
// inferred reset.
export function ifmRetryAfter(headers: Headers, now: number): number | undefined {
  const midnight = Math.max(1, Math.ceil((new Date(now).setUTCHours(24, 0, 0, 0) - now) / 1000));
  const delays = [quotaRetryAfter(headers.get('retry-after'), now)];
  // Only the daily counter IFM documents counts. Live Cerebras-routed replies also carried -day, -hour and -minute
  // counters (34.56B tokens a day, 14.4M requests a day) that never appeared on the Nebius or AWS routes; they
  // describe a third-party host's own account, not this key's allowance, so they are ignored.
  if (headers.get('x-ratelimit-remaining-tokens-daily') === '0') delays.push(midnight);
  for (const [remaining, reset] of [['x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'], ['x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']] as const) {
    if (headers.get(remaining) === '0') delays.push(ifmDuration(headers.get(reset)));
  }
  const known = delays.filter((delay): delay is number => delay !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * IFM's chat template rejects, with HTTP 400, a tool schema whose "required" list is not backed by "properties": a
 * non-empty list with no properties outside a oneOf/anyOf variant, or a name that "properties" does not define.
 * Harness tools do carry such schemas (an MCP tool that lists required inputs without declaring them). The model
 * is sent the schema minus the unbacked names; Grunt still validates the model's call against the original.
 */
export function ifmSchema(spec: unknown, inVariant = false): unknown {
  if (!isObject(spec)) return spec;
  const out: Json = { ...spec };
  const properties = isObject(spec.properties) && Object.keys(spec.properties).length ? spec.properties : undefined;
  if ('required' in out) {
    if (!Array.isArray(out.required)) delete out.required;
    else if (!out.required.length) { /* An empty list is accepted as it is. */ }
    else if (properties) out.required = out.required.filter(name => typeof name === 'string' && Object.hasOwn(properties, name));
    else if (!inVariant || out.required.some(name => typeof name !== 'string')) delete out.required;
  }
  if (isObject(out.properties)) out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, child]) => [key, ifmSchema(child)]));
  if ('items' in out) out.items = ifmSchema(out.items);
  for (const key of ['oneOf', 'anyOf'] as const) if (Array.isArray(out[key])) out[key] = out[key].map(variant => ifmSchema(variant, true));
  if (isObject(out.additionalProperties)) out.additionalProperties = ifmSchema(out.additionalProperties);
  if (isObject(out.patternProperties)) out.patternProperties = Object.fromEntries(Object.entries(out.patternProperties).map(([key, child]) => [key, ifmSchema(child)]));
  return out;
}
const ifmTool = (tool: ModelRequest['tools'][number]) => {
  const fn = (tool as { function?: unknown }).function;
  return isObject(fn) && isObject(fn.parameters) ? { ...tool, function: { ...fn, parameters: ifmSchema(fn.parameters) } } : tool;
};

const callKey = (calls: readonly ToolCall[]) => createHash('sha256').update(JSON.stringify(calls.map(call => [call.id, call.function.name, call.function.arguments]))).digest('hex');
const textKey = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * K2 Horizon returns its reasoning beside the answer and asks for it back, verbatim, on the next turn.
 * Harnesses keep only the visible text and tool calls, so the adapter remembers each reply's reasoning
 * for the process lifetime, keyed by the exact tool calls (or answer text), and puts it back on the
 * matching assistant turn. Without a match the turn carries an empty thinking field: IFM answers HTTP 422 to an
 * assistant turn that has text and no thinking field at all.
 */
class ReasoningMemory {
  private entries = new Map<string, string>();
  remember(reply: { text: string; calls?: ToolCall[] }, reasoning: string) {
    const key = reply.calls?.length ? `c:${callKey(reply.calls)}` : `t:${textKey(reply.text)}`;
    this.entries.delete(key); this.entries.set(key, reasoning);
    while (this.entries.size > MEMORY_LIMIT) this.entries.delete(this.entries.keys().next().value!);
  }
  recall(message: Message) {
    return this.entries.get(message.tool_calls?.length ? `c:${callKey(message.tool_calls)}` : `t:${textKey(message.content)}`);
  }
}

/**
 * IFM K2 Horizon, optional and experimental. Grunt cannot establish this route's price, terms, retention or
 * training from IFM's published documents, so it never turns it on by itself: it needs the explicit data-sharing
 * receipt and a vaulted key the person supplied. No wallet, account switching or paid route.
 */
export class Ifm implements Source {
  readonly id = 'ifm';
  readonly supportsFunctionTools = true;
  readonly inferenceOnly = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly firstOutputMs = IFM_FIRST_OUTPUT_MS;
  readonly idleMs = IFM_IDLE_MS;
  private verified: { key: string; at: number } | undefined;
  private shutdown = new AbortController();
  private memory = new ReasoningMemory();
  private window: { startedAt: number; resetAt: number } | undefined;
  private starts: number[] = [];
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {}
  private get now() { return (this.options.now ?? Date.now)(); }
  quotaWindow() { return this.window && { ...this.window }; }
  private markExhausted() {
    const resetAt = new Date(this.now).setUTCHours(24, 0, 0, 0);
    this.window = { startedAt: resetAt - day, resetAt };
  }
  private async checked(caller?: AbortSignal) {
    const directory = this.options.directory ?? configRoot();
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    if (grant.base_url !== `https://${IFM_HOST}` && !(url.origin === 'https://trusty-squire-api.fly.dev' && /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname))) return;
    const key = `${grant.base_url}\n${grant.token}`;
    if (this.verified?.key === key && this.now >= this.verified.at && this.now - this.verified.at < IFM_PREFLIGHT_MS) return grant;
    this.verified = undefined;
    // IFM publishes no price or entitlement endpoint, so there is nothing here to prove the route is free. The
    // catalog check only confirms the exact model and its documented context before a request is sent.
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000), ...(caller ? [caller] : [])]);
    const catalog = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models')(`${grant.base_url}/v1/models`, { redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` } });
    if (!catalog.ok) { await catalog.body?.cancel(); return; }
    const body = await json(catalog, signal, 1024 * 1024);
    const offers = Array.isArray(body.data) ? body.data.map(object).filter(row => row.id === IFM_MODEL) : [];
    if (offers.length !== 1 || offers[0]!.context_length !== IFM_DOCUMENTED_CONTEXT || offers[0]!.owned_by !== 'MBZUAI') return;
    this.verified = { key, at: this.now };
    return grant;
  }
  // At most IFM_GUARD_REQUESTS request starts per IFM_GUARD_WINDOW_MS, so a burst from parallel subagents queues
  // for a moment here instead of drawing a 429 from the guard. In-flight requests are not limited.
  private async admit(signal: AbortSignal) {
    let queued = false;
    for (;;) {
      signal.throwIfAborted();
      const now = Date.now();
      this.starts = this.starts.filter(at => now - at < IFM_GUARD_WINDOW_MS);
      if (this.starts.length < IFM_GUARD_REQUESTS) { this.starts.push(now); return; }
      // This time-based gate has no FIFO order to report.
      if (!queued) { observeAttemptQueue(() => null); queued = true; }
      const wait = IFM_GUARD_WINDOW_MS - (now - this.starts[0]!) + 5;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, wait);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  async available() { try { return !!await this.checked(); } catch { return false; } }
  async complete(request: ModelRequest, caller: AbortSignal, progress?: () => void): Promise<Completion> {
    caller.throwIfAborted();
    if (!['ifm', 'grunt'].includes(request.model) || request.imageInput || request.tools.some(t => t.type !== 'function')) throw new SourceError('refused', 'IFM requires its exact K2 Horizon text route');
    try { new JsonToolBridge(request); } catch { throw requestRefusal('Invalid IFM function definitions or tool conversation'); }
    const validators = compileToolSchemas(request.tools, 'Invalid IFM function schema');
    let grant: FreeApiGrant | undefined;
    try { grant = await this.checked(caller); } catch (e) { caller.throwIfAborted(); if (e instanceof SourceError) throw e; }
    caller.throwIfAborted();
    if (!grant) throw new SourceError('refused', 'IFM route could not be verified; it needs current data-sharing approval and its vaulted key');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(IFM_TOTAL_MS)]);
    // The caller's output budget is passed through unchanged. Without one IFM's own default (the remaining context) applies.
    // Only the OpenAI chat fields are sent. IFM's gateway answers HTTP 422 to any assistant turn that carries text and
    // no thinking field, so every assistant turn gets one: the remembered reasoning when this process produced the
    // reply, otherwise the empty string, which IFM documents as valid (history that came from another source).
    const messages = request.messages.map(message => {
      const role = message.role === 'developer' ? 'system' : message.role;
      return { role, content: typeof message.content === 'string' ? message.content : '',
        ...(role === 'assistant' ? { reasoning_content: this.memory.recall(message) ?? '' } : {}),
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}), ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}) };
    });
    // IFM recommends temperature 1.0 and top_p 0.95; reasoning effort "high" is the only level and the default.
    const payload = JSON.stringify({ model: IFM_MODEL, messages, stream: true, stream_options: { include_usage: true }, ...(request.tools.length ? { tools: request.tools.map(ifmTool) } : {}), temperature: 1.0, top_p: 0.95, ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}) });
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new SourceError('refused', 'IFM request is larger than grunt will send');
    let streamFailure: SafeDiagnosticMetadata['failureReason'];
    const maxTokens = request.maxTokens;
    // Token counts must be whole numbers within the caller's budget, and a reported charge refuses the route.
    const usable = (usage: Record<string, unknown>) => {
      if (['cost', 'total_cost', 'credits_charged'].some(k => k in usage && usage[k] !== 0)) throw new SourceError('refused', 'IFM reported a charge; grunt will not continue');
      return integer(usage.prompt_tokens) && integer(usage.completion_tokens) && (maxTokens === undefined || usage.completion_tokens <= maxTokens);
    };
    try {
      await this.admit(signal);
      observeAttemptDispatch({ model: IFM_MODEL, account: 'vaulted', maxOutputTokens: request.maxTokens });
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: payload });
      if (!response.ok) {
        await response.body?.cancel();
        // Payment or billing is never acceptable on a free-only route.
        if (response.status === 402) throw new SourceError('refused', 'IFM reported a payment or billing requirement; grunt will not continue', undefined, undefined, { httpStatus: 402, transport: 'http', endpointLabel: 'chat.completions' });
        // A 429 with no usable signal (an unpublished per-second or per-minute guard) is a short local back-off, not
        // a claim about when IFM resets, so a request-guard hit does not bench the source for the default hour.
        // A request IFM refuses for its shape (400, 413, 422) is not provider health: no cooldown, no retirement, and the
        // router moves this task to another source. The error body is never read or kept.
        if ([400, 413, 422].includes(response.status)) throw new SourceError('refused', `IFM rejected the request shape (HTTP ${response.status})`, undefined, undefined,
          { httpStatus: response.status, transport: 'http', endpointLabel: 'chat.completions', failureReason: response.status === 413 ? 'request_size' : 'request_body' });
        const retry = response.status === 429 ? ifmRetryAfter(response.headers, this.now) ?? IFM_GUARD_BACKOFF_SECONDS : quotaRetryAfter(response.headers.get('retry-after'), this.now);
        if (response.status === 429 && response.headers.get('x-ratelimit-remaining-tokens-daily') === '0') this.markExhausted();
        throw new SourceError(response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
          `IFM returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', endpointLabel: 'chat.completions' });
      }
      const served = response.headers.get('ifm-served-model');
      if (served !== null && served !== IFM_MODEL) throw new Error('Unexpected model');
      let reply: Completion, reasoning: string | undefined;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        // Streaming is for liveness only: a long reasoning reply can take minutes, and each delta, reasoning included,
        // keeps the first-output and idle deadlines satisfied. Grunt still hands the client one whole reply.
        let thinking = '';
        reply = await readPromotionalStream(response, IFM_MODEL, signal, { ...(progress ? { progress } : {}), failure: reason => { streamFailure ??= reason; }, cleanup: () => {},
          maxBytes: IFM_STREAM_BYTES, reasoning: delta => { if (thinking.length < IFM_REASONING_CHARS) thinking += delta; },
          // A stream without usage is not accepted: the token counts and the zero-charge check need it.
          result: usage => { if (!usable(usage)) throw new Error('Invalid completion'); } });
        reasoning = thinking;
      } else {
        // A host that ignores `stream` answers with one JSON body.
        const body = await json(response, signal), usage = object(body.usage);
        if (body.model !== IFM_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
        if (!usable(usage)) throw new Error('Invalid completion');
        const choice = object(body.choices[0]), message = object(choice.message);
        if (message.refusal) throw new SourceError('refused', 'IFM refused the request');
        // IFM's documents call the field reasoning_content; live responses named it reasoning. Keep whichever arrives.
        reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : undefined;
        if (lengthLimited(choice.finish_reason)) reply = truncatedCompletion(message.content, usage, choice.finish_reason);
        else {
          if (!['stop', 'tool_calls'].includes(String(choice.finish_reason)) || !(message.content === undefined || message.content === null || typeof message.content === 'string')) throw new Error('Invalid completion');
          if (message.tool_calls !== undefined && message.tool_calls !== null && !Array.isArray(message.tool_calls)) throw new Error('Invalid tools');
          const raw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          const calls = raw.map((value): ToolCall => {
            const call = object(value), fn = object(call.function);
            if (typeof call.id !== 'string' || call.type !== 'function' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Invalid tools');
            return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
          });
          reply = withEnding({ text: typeof message.content === 'string' ? message.content : '', ...(calls.length ? { calls } : {}), inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number },
            completionEnding(choice.finish_reason, usage, calls.length > 0));
        }
      }
      // A reply cut off by its token budget keeps its visible text; an unfinished tool call is dropped. The template's
      // newline before the answer is not part of it.
      if (reply.finishReason === 'length') return { ...reply, text: reply.text.replace(/^\n+/, '') };
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (reply.calls && reply.calls.length > 16) throw new Error('Invalid tools');
      for (const call of reply.calls ?? []) {
        const args: unknown = JSON.parse(call.function.arguments);
        if (!call.id || ids.has(call.id) || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id))
          || !validators.get(call.function.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tools');
        ids.add(call.id); calls.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } });
      }
      const text = reply.text.replace(/^\n+/, '');
      // Nothing but reasoning is an empty answer; the router treats it as a bad sample, not a reply.
      if (!text && !calls.length) throw new Error('Empty answer');
      const answer = { text, ...(calls.length ? { calls } : {}) };
      if (reasoning !== undefined) this.memory.remember(answer, reasoning);
      const ended = endingOf(reply), final = { ...answer, ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }), ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }) };
      return ended ? withEnding(final, { ...ended, toolCalls: calls.length > 0 }) : final;
    } catch (e) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'IFM source closed');
      // Whatever failed, the next request re-checks the catalog.
      this.verified = undefined;
      if (signal.aborted) throw new SourceError('timeout', 'IFM response timed out');
      if (e instanceof SourceError) throw e;
      const cause = object(object(e).cause), code = object(e).code ?? cause.code;
      const networkCode = diagnosticNetworks.find(known => known === code);
      throw new SourceError('upstream', 'IFM returned an invalid completion', undefined, undefined, streamFailure || networkCode
        ? { transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions', ...(streamFailure ? { failureReason: streamFailure } : {}), ...(networkCode ? { networkCode } : {}) } : undefined);
    }
  }
  async close() { this.shutdown.abort(); }
}
