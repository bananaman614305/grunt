import { Ajv } from 'ajv';
import type { AnySchema, ValidateFunction } from 'ajv';
import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { FreebuffTools } from './freebuff-tools.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { SourceError, requestRefusal } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const MILLIONSEEK_MODEL = 'deepseek-v4.1-flash-free';
export const MILLIONSEEK_HOST = '100milionseek.top';
export const MILLIONSEEK_SERVICE = '100milionseek';
export const MILLIONSEEK_INPUT_LIMIT = 198000;
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
  readonly id = 'millionseek';
  readonly supportsFunctionTools = true;
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
  async available() { try { return !!await this.checked(); } catch (e) { if (e instanceof SourceError && e.code === 'quota') throw e; return false; } }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    if (!['millionseek', 'grunt', 'milo'].includes(request.model) || request.imageInput || request.tools.some(t => t.type !== 'function')) throw new SourceError('refused', '100milionseek requires its exact free text route');
    const validators = new Map<string, ValidateFunction>();
    try {
      new FreebuffTools(request);
      const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, addUsedSchema: false });
      for (const tool of request.tools) { const fn = object(tool.function); validators.set(fn.name as string, ajv.compile(fn.parameters as AnySchema)); }
    } catch { throw requestRefusal('Invalid 100milionseek function definitions or tool conversation'); }
    let grant: FreeApiGrant | undefined;
    try { grant = await this.checked(caller); } catch (e) { caller.throwIfAborted(); if (e instanceof SourceError) throw e; }
    caller.throwIfAborted();
    if (!grant) throw new SourceError('refused', '100milionseek free entitlement could not be verified');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    const maxTokens = Math.min(4096, Math.max(1, Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens!) : 4096));
    const payload = JSON.stringify({ model: MILLIONSEEK_MODEL, messages: request.messages, ...(request.tools.length ? { tools: request.tools } : {}), stream: false, max_tokens: maxTokens });
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new SourceError('refused', '100milionseek request exceeds its documented body limit');
    try {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: payload });
      if (!response.ok) {
        let retry: number | undefined;
        const raw = await json(response, signal).catch(() => ({} as Record<string, unknown>)), error = object(raw.error);
        if (response.status === 429 && error.code === 'daily_quota_exceeded') retry = Math.max(1, Math.ceil((new Date(this.now).setUTCHours(24, 0, 0, 0) - this.now) / 1000));
        else { const after = response.headers.get('retry-after'); if (after && /^\d+$/.test(after)) retry = Math.max(1, Number(after)); }
        throw new SourceError(response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
          `100milionseek returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', endpointLabel: 'chat.completions' });
      }
      this.quota(response.headers);
      const body = await json(response, signal, 4 * 1024 * 1024), usage = object(body.usage);
      if (body.model !== MILLIONSEEK_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
      const choice = object(body.choices[0]), message = object(choice.message);
      if (message.refusal) throw new SourceError('refused', '100milionseek refused the request');
      if (!integer(usage.prompt_tokens) || usage.prompt_tokens < 1 || !integer(usage.completion_tokens) || usage.completion_tokens > maxTokens
        || ['cost', 'total_cost', 'credits_charged'].some(k => k in usage && usage[k] !== 0)
        || !['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason))
        || !(message.content === undefined || message.content === null || typeof message.content === 'string')) throw new Error('Invalid completion');
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16 || choice.finish_reason === 'length') throw new Error('Invalid tools');
        for (const raw of message.tool_calls) {
          const call = object(raw), fn = object(call.function); const args: unknown = JSON.parse(String(fn.arguments));
          if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || request.messages.some(m => m.tool_calls?.some(old => old.id === call.id))
            || typeof fn.name !== 'string' || typeof fn.arguments !== 'string' || !validators.get(fn.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tools');
          ids.add(call.id); calls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
        }
      }
      if (!message.content && !calls.length) throw new Error('Empty answer');
      return { text: typeof message.content === 'string' ? message.content : '', ...(calls.length ? { calls } : {}), inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
    } catch (e) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', '100milionseek source closed');
      if (signal.aborted) throw new SourceError('timeout', '100milionseek response timed out');
      if (e instanceof SourceError) throw e;
      throw new SourceError('upstream', '100milionseek returned an invalid completion');
    }
  }
  async close() { this.shutdown.abort(); }
}
