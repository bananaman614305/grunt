import { configRoot } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { readPromotionalStream } from './promotional-api.js';
import { readPrivateProviderGrant, validateProviderGrant } from './provider-grant.js';
import { nousQuotaDelay, readQuotaError } from './quota-timing.js';
import { SourceError } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const DARUS_MODEL = 'darus/deepseek-v4.1-flash-1017-FREE';
export const DARUS_HOST = 'gateway.darusalfatah.id';
const dayMs = 86400000;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function json(response: Response, signal: AbortSignal, limit = 1024 * 1024): Promise<Record<string, unknown>> {
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

// The daily free token pool is distinct from wallet credit. Both the exact
// -FREE alias and the server-side protectBalance switch are mandatory.
export class Darus implements Source {
  readonly id = 'darus';
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();
  private window: { startedAt: number; resetAt: number } | undefined;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {}
  private get now() { return (this.options.now ?? Date.now)(); }
  quotaWindow() { return this.window ? { ...this.window } : undefined; }

  private async freeGrant(caller?: AbortSignal) {
    const directory = this.options.directory ?? configRoot();
    if (!(await readDataSharingConsent(directory, [this.id])).includes(this.id)) return;
    const grant = validateProviderGrant(await (this.options.loadGrant?.() ?? readPrivateProviderGrant(this.id, directory)));
    const url = new URL(grant.base_url);
    if (grant.base_url !== `https://${DARUS_HOST}` && !(url.origin === 'https://trusty-squire-api.fly.dev'
      && /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname))) return;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000), ...(caller ? [caller] : [])]);
    const catalog = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models')(`${grant.base_url}/v1/models`, {
      redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` }
    });
    if (!catalog.ok) { await catalog.body?.cancel(); return; }
    const models = (await json(catalog, signal)).data;
    if (!Array.isArray(models)) return;
    const offers = models.map(object).filter(row => row.id === DARUS_MODEL);
    if (offers.length !== 1 || offers[0]!.free !== true || offers[0]!.owned_by !== 'Darus Gateway') return;
    const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'account')(`${grant.base_url}/v1/tpd`, {
      redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.token}` }
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const status = object((await json(response, signal)).status), tier = object(status.tier);
    const now = this.now, day = new Date(now).toISOString().slice(0, 10), startedAt = Date.parse(`${day}T00:00:00Z`);
    if (status.eligible !== true || status.protectBalance !== true || status.day !== day
      || tier.key !== 'FREE' || tier.minBalance !== 0 || tier.tpd !== 10000000
      || status.allowance !== 10000000 || status.multiplier !== 1 || !count(status.balance)
      || !count(status.used) || !count(status.remaining) || status.used > status.allowance
      || status.remaining !== status.allowance - status.used) return;
    this.window = { startedAt, resetAt: startedAt + dayMs };
    if (!status.remaining) throw new SourceError('quota', 'Darus daily free allowance exhausted', Math.ceil((startedAt + dayMs - now) / 1000));
    return { grant, day, remaining: status.remaining };
  }

  async available() {
    try { return !!await this.freeGrant(); }
    catch (error) { if (error instanceof SourceError && error.code === 'quota') throw error; return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Darus source closed');
    if (!['darus', 'grunt', 'milo'].includes(request.model) || request.tools.some(tool => tool.type !== 'function')) throw new SourceError('refused', 'Unsupported Darus request');
    let checked: Awaited<ReturnType<Darus['freeGrant']>>;
    try { checked = await this.freeGrant(caller); } catch (error) { caller.throwIfAborted(); if (error instanceof SourceError) throw error; }
    caller.throwIfAborted();
    if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Darus source closed');
    if (!checked || checked.day !== new Date(this.now).toISOString().slice(0, 10)) throw new SourceError('refused', 'Darus protected daily free allowance could not be verified');
    const maxTokens = Math.min(4096, Math.max(1, request.maxTokens ?? 4096));
    // UTF-8 bytes plus framing are a conservative input-token bound, not a
    // tokenizer estimate. Protect Balance remains the authoritative hard stop.
    const budget = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), 'utf8') + 4096 + maxTokens;
    if (checked.remaining < budget) throw new SourceError('quota', 'Darus free allowance is insufficient for this bounded request',
      Math.max(1, Math.ceil(((this.window?.resetAt ?? this.now + dayMs) - this.now) / 1000)));
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${checked.grant.base_url}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${checked.grant.token}`, 'Content-Type': 'application/json', 'User-Agent': 'grunt' },
        body: JSON.stringify({ model: DARUS_MODEL, messages: request.messages,
          tools: request.tools.length ? request.tools : undefined, stream: true, stream_options: { include_usage: true },
          max_tokens: maxTokens })
      });
      if (!response.ok) {
        const retry = nousQuotaDelay(response.headers, await readQuotaError(response), this.now);
        throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
          `Darus returned HTTP ${response.status}`, retry, undefined, { httpStatus: response.status, transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions' });
      }
      if (response.headers.has('x-darus-model-failover')) {
        await response.body?.cancel();
        throw new SourceError('refused', 'Darus reported a model failover');
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) return await readPromotionalStream(response, DARUS_MODEL, signal);
      const body = await json(response, signal, 4 * 1024 * 1024);
      if (body.model !== DARUS_MODEL || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected completion');
      const choice = object(body.choices[0]), message = object(choice.message), usage = object(body.usage);
      if (message.refusal) throw new SourceError('refused', 'Darus request refused');
      const calls = message.tool_calls;
      if (!['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason)) || choice.finish_reason === 'length' && Array.isArray(calls) && calls.length
        || calls !== undefined && !validCalls(calls) || typeof message.content !== 'string' && !(validCalls(calls) && calls.length)
        || !message.content && !(validCalls(calls) && calls.length)) throw new Error('Invalid completion');
      return { text: typeof message.content === 'string' ? message.content : '', ...(validCalls(calls) && calls.length ? { calls } : {}),
        ...(count(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}), ...(count(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}) };
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Darus source closed');
      if (signal.aborted) throw new SourceError('timeout', 'Darus response timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Darus returned an invalid completion');
    }
  }
  async close() { this.shutdown.abort(); }
}

function validCalls(value: unknown): value is ToolCall[] {
  return Array.isArray(value) && value.every(item => {
    const call = object(item), fn = object(call.function);
    if (typeof call.id !== 'string' || !call.id || call.type !== 'function' || typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string') return false;
    try { const args: unknown = JSON.parse(fn.arguments); return args !== null && typeof args === 'object' && !Array.isArray(args); } catch { return false; }
  });
}
