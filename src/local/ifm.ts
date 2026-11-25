import { createHash } from 'node:crypto';
import { compileToolSchemas } from './tool-schema.js';
import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch, diagnosticNetworks } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { FreebuffTools } from './freebuff-tools.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { quotaRetryAfter, quotaSeconds } from './quota-timing.js';
import { lengthLimited, truncatedCompletion, SourceError, requestRefusal } from './source.js';
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
export const IFM_TOTAL_MS = 300000;
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

const callKey = (calls: readonly ToolCall[]) => createHash('sha256').update(JSON.stringify(calls.map(call => [call.id, call.function.name, call.function.arguments]))).digest('hex');
const textKey = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * K2 Horizon returns its reasoning beside the answer and asks for it back, verbatim, on the next turn.
 * Harnesses keep only the visible text and tool calls, so the adapter remembers each reply's reasoning
 * for the process lifetime, keyed by the exact tool calls (or answer text), and puts it back on the
 * matching assistant turn. Without a match the turn is sent as the harness has it, which IFM accepts.
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
    for (;;) {
      signal.throwIfAborted();
      const now = Date.now();
      this.starts = this.starts.filter(at => now - at < IFM_GUARD_WINDOW_MS);
      if (this.starts.length < IFM_GUARD_REQUESTS) { this.starts.push(now); return; }
      const wait = IFM_GUARD_WINDOW_MS - (now - this.starts[0]!) + 5;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, wait);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  async available() { try { return !!await this.checked(); } catch { return false; } }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    if (!['ifm', 'grunt', 'milo'].includes(request.model) || request.imageInput || request.tools.some(t => t.type !== 'function')) throw new SourceError('refused', 'IFM requires its exact K2 Horizon text route');
    try { new FreebuffTools(request); } catch { throw requestRefusal('Invalid IFM function definitions or tool conversation'); }
    const validators = compileToolSchemas(request.tools, 'Invalid IFM function schema');
    let grant: FreeApiGrant | undefined;
    try { grant = await this.checked(caller); } catch (e) { caller.throwIfAborted(); if (e instanceof SourceError) throw e; }
    caller.throwIfAborted();
    if (!grant) throw new SourceError('refused', 'IFM route could not be verified; it needs current data-sharing approval and its vaulted key');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(IFM_TOTAL_MS)]);
    // The caller's output budget is passed through unchanged. Without one IFM's own default (the remaining context) applies.
    const messages = request.messages.map(message => {
      const role = message.role === 'developer' ? 'system' : message.role;
      const reasoning = role === 'assistant' ? this.memory.recall(message) : undefined;
      return reasoning === undefined ? { ...message, role } : { ...message, role, reasoning_content: reasoning };
    });
    // IFM recommends temperature 1.0 and top_p 0.95; reasoning effort "high" is the only level and the default.
    const payload = JSON.stringify({ model: IFM_MODEL, messages, ...(request.tools.length ? { tools: request.tools } : {}), temperature: 1.0, top_p: 0.95, ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}) });
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new SourceError('refused', 'IFM request is larger than grunt will send');
    try {
      await this.admit(signal);
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: payload });
      if (!response.ok) {
        await response.body?.cancel();
        // Payment or billing is never acceptable on a free-only route.
        if (response.status === 402) throw new SourceError('refused', 'IFM reported a payment or billing requirement; grunt will not continue', undefined, undefined, { httpStatus: 402, transport: 'http', endpointLabel: 'chat.completions' });
        // A 429 with no usable signal (an unpublished per-second or per-minute guard) is a short local back-off, not
        // a claim about when IFM resets, so a request-guard hit does not bench the source for the default hour.
        const retry = response.status === 429 ? ifmRetryAfter(response.headers, this.now) ?? IFM_GUARD_BACKOFF_SECONDS : quotaRetryAfter(response.headers.get('retry-after'), this.now);
        if (response.status === 429 && response.headers.get('x-ratelimit-remaining-tokens-daily') === '0') this.markExhausted();
        throw new SourceError(response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
          `IFM returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', endpointLabel: 'chat.completions' });
      }
      const served = response.headers.get('ifm-served-model');
      if (served !== null && served !== IFM_MODEL) throw new Error('Unexpected model');
      const body = await json(response, signal), usage = object(body.usage);
      if (body.model !== IFM_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
      if (['cost', 'total_cost', 'credits_charged'].some(k => k in usage && usage[k] !== 0)) throw new SourceError('refused', 'IFM reported a charge; grunt will not continue');
      const choice = object(body.choices[0]), message = object(choice.message);
      if (message.refusal) throw new SourceError('refused', 'IFM refused the request');
      // IFM's documents call the field reasoning_content; live responses named it reasoning. Keep whichever arrives.
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : undefined;
      const prompt = usage.prompt_tokens, completion = usage.completion_tokens;
      if (!integer(prompt) || !integer(completion) || request.maxTokens !== undefined && completion > request.maxTokens) throw new Error('Invalid completion');
      if (lengthLimited(choice.finish_reason)) {
        // A reply cut off by its token budget keeps its visible text; an unfinished tool call is dropped.
        return truncatedCompletion(typeof message.content === 'string' ? message.content.replace(/^\n+/, '') : '', usage);
      }
      if (!['stop', 'tool_calls'].includes(String(choice.finish_reason)) || !(message.content === undefined || message.content === null || typeof message.content === 'string')) throw new Error('Invalid completion');
      let calls: ToolCall[] = [];
      if (message.tool_calls !== undefined && message.tool_calls !== null) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw new Error('Invalid tools');
        const ids = new Set<string>();
        calls = message.tool_calls.map(raw => {
          const call = object(raw), fn = object(call.function);
          if (typeof call.id !== 'string' || call.type !== 'function' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Invalid tools');
          const args: unknown = JSON.parse(fn.arguments);
          if (!call.id || ids.has(call.id) || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id))
            || !validators.get(fn.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tools');
          ids.add(call.id);
          return { id: call.id, type: 'function' as const, function: { name: fn.name, arguments: fn.arguments } };
        });
      }
      // The chat template puts a newline before the answer; it is not part of it.
      const text = typeof message.content === 'string' ? message.content.replace(/^\n+/, '') : '';
      if (!text && !calls.length) throw new Error('Empty answer');
      const reply = { text, ...(calls.length ? { calls } : {}) };
      if (reasoning !== undefined) this.memory.remember(reply, reasoning);
      return { ...reply, inputTokens: prompt, outputTokens: completion };
    } catch (e) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'IFM source closed');
      // Whatever failed, the next request re-checks the catalog.
      this.verified = undefined;
      if (signal.aborted) throw new SourceError('timeout', 'IFM response timed out');
      if (e instanceof SourceError) throw e;
      const cause = object(object(e).cause), code = object(e).code ?? cause.code;
      const networkCode = diagnosticNetworks.find(known => known === code);
      throw new SourceError('upstream', 'IFM returned an invalid completion', undefined, undefined, networkCode ? { transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions', networkCode } : undefined);
    }
  }
  async close() { this.shutdown.abort(); }
}
