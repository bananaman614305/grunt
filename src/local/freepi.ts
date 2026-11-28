import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { compileToolSchemas } from './tool-schema.js';
import type { ValidateFunction } from 'ajv';
import { JsonToolBridge } from './json-tool-bridge.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { acquireFreePiAccountLease } from './freepi-lock.js';
import { quotaRetryAfter } from './quota-timing.js';
import { observeAttemptDispatch, diagnosticFetch } from './diagnostics.js';
import { lengthLimited, truncatedCompletion, withObservedEnding, SourceError, requestRefusal } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const FREEPI_ID = 'freepi';
export const FREEPI_BASE = 'https://api.freepi.ai';
export const FREEPI_MODEL = 'deepseek-v4.1-flash';
export const FREEPI_CLIENT_VERSION = '0.6.25';
export const FREEPI_CONSENT_VERSION = '4';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const requiredWallets = ['credit_usd', 'credit_credits', 'bonus_credits', 'bonus_wallet_credits', 'premium_credits', 'premium_bought_credits', 'premium_gifted_credits'];
const wallets = [...requiredWallets, 'premium_expiring_credits', 'regular_wallet_credits'];
const metadata = ['credit_tiers', 'premium_get_line', 'premium_expires_at', 'use_bonus', 'allowance_credits', 'remaining_credits_today'];

// Match the authenticated 0.6.25 contract, including earned/gifted wallets.
// New spending controls fail closed until reviewed; optional is not assumed zero.
export function assertFreePiAccount(account: Record<string, unknown>, now = Date.now(), allowExhausted = false) {
  if (requiredWallets.some(key => !Object.hasOwn(account, key)) || wallets.some(key => Object.hasOwn(account, key) && account[key] !== 0)
    || Object.keys(account).some(key => /wallet|credit|payment|billing|charge|subscription|postpaid/i.test(key) && !wallets.includes(key) && !metadata.includes(key))) {
    throw new SourceError('refused', 'Free-Pi requires verified zero balances for every spendable wallet');
  }
  const reset = typeof account.refill_at === 'string' ? Date.parse(account.refill_at) : NaN;
  if (account.guest === true || account.lane !== 'standard' || !Number.isFinite(reset) || reset <= now || reset > now + 86400000
    || !count(account.remaining_credits_today) || typeof account.remaining_usd_today !== 'number' || !Number.isFinite(account.remaining_usd_today)) {
    throw new SourceError('refused', 'Free-Pi account allowance could not be verified');
  }
  if (!allowExhausted && (account.remaining_usd_today <= 0 || account.remaining_credits_today <= 0)) throw new SourceError('quota', 'Free-Pi daily allowance exhausted', Math.max(1, (reset - now) / 1000));
}

export async function readFreePiToken(directory: string): Promise<string> {
  const file = await openPrivateFile(join(directory, 'freepi', 'credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600) || stat.size > 4096) throw new Error('Unsafe Free-Pi credential');
    const credential = object(JSON.parse(await file.readFile('utf8')));
    if (credential.issuer !== FREEPI_BASE || typeof credential.token !== 'string' || !credential.token) throw new Error('Invalid Free-Pi credential');
    return credential.token;
  } finally { await file.close(); }
}

export async function readFreePiJson(response: Response, signal: AbortSignal, limit = 4 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Free-Pi response');
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > limit) throw new Error('Oversized Free-Pi response');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class FreePi implements Source {
  readonly inferenceOnly = true;
  readonly metadataOnlyMaintenance = true;
  readonly id = FREEPI_ID;
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();
  private readonly session = randomUUID();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; now?: () => number; loadToken?: () => Promise<string>; lockDirectory?: string } = {}) {}
  acceptsRequest(request: ModelRequest) { return request.publicContext === true && !request.handoffPrompt && !request.imageInput; }
  private get directory() { return this.options.directory ?? configRoot(); }
  private async token() {
    if (!(await readDataSharingConsent(this.directory, [this.id])).includes(this.id)) throw new SourceError('refused', 'Free-Pi requires explicit current trace-sale consent');
    try { return await (this.options.loadToken?.() ?? readFreePiToken(this.directory)); }
    catch { throw new SourceError('logged_out', 'Free-Pi native login is required'); }
  }
  private async read(path: string, signal: AbortSignal, token?: string, body?: unknown) {
    const response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, path === '/me/stats' ? 'account' : path === '/client-version' ? 'models' : 'chat.completions')(`${FREEPI_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'grunt', 'x-client-version': FREEPI_CLIENT_VERSION, 'x-session-id': this.session, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream', `Free-Pi returned HTTP ${response.status}`, quotaRetryAfter(response.headers.get('Retry-After')), undefined, { httpStatus: response.status, transport: 'http', endpointLabel: path === '/me/stats' ? 'account' : 'chat.completions' });
    }
    return readFreePiJson(response, signal, path === '/me/stats' ? 65536 : undefined);
  }
  private async guard(token: string, signal: AbortSignal) {
    const catalog = await this.read('/client-version', signal);
    if (catalog.latest !== FREEPI_CLIENT_VERSION || typeof catalog.min !== 'string' || catalog.min !== '0.6.21') throw new SourceError('refused', 'Free-Pi client contract changed; review required');
    const models = Array.isArray(catalog.models) ? catalog.models.map(object).filter(model => model.id === FREEPI_MODEL) : [];
    if (models.length !== 1 || models[0]!.free !== true || models[0]!.stats_id !== 'deepseek/deepseek-v4.1-flash-1017') throw new SourceError('refused', 'Free-Pi exact free model offer is unavailable');
    const account = await this.read('/me/stats', signal, token);
    assertFreePiAccount(account, (this.options.now ?? Date.now)());
  }
  async available() {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000)]);
    try { const token = await this.token(); await this.guard(token, signal); return true; }
    catch (error) { if (error instanceof SourceError && error.code === 'quota') throw error; return false; }
  }
  // Maintenance verifies native access/free rights without selling another trace.
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    if (!this.acceptsRequest(request) || ![this.id, 'grunt'].includes(request.model) || request.tools.some(tool => tool.type !== 'function')) throw new SourceError('refused', 'Free-Pi requires a reviewed public-only request');
    if (Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), 'utf8') > 1024 * 1024) throw new SourceError('refused', 'Free-Pi request exceeds the verified context envelope');
    const prepared = prepareTools(request);
    const token = await this.token();
    // JWT sub is used only to derive a local account mutex, never as an auth assertion.
    let subject: unknown;
    try { subject = object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())).sub; } catch { /* Fail closed below. */ }
    if (typeof subject !== 'string' || !subject) throw new SourceError('logged_out', 'Free-Pi account token is invalid');
    const lockRoot = this.options.lockDirectory ?? join(homedir(), '.cache', 'usegrunt-freepi-locks');
    const release = await acquireFreePiAccountLease(subject, lockRoot);
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      await this.guard(token, signal);
      observeAttemptDispatch({ model: FREEPI_MODEL, account: 'local_session', maxOutputTokens: request.maxTokens });
      const body = await this.read('/v1/chat/completions', signal, token, { model: FREEPI_MODEL, messages: prepared.messages,
        ...(request.tools.length ? { tools: request.tools } : {}), stream: false, max_tokens: request.maxTokens });
      // Preserve provider-sponsored text exactly; never hide or rewrite ads.
      assertFreePiAccount(await this.read('/me/stats', signal, token), (this.options.now ?? Date.now)(), true);
      if (body.model !== 'deepseek-ai/deepseek-v41-flash-1017' || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Unexpected Free-Pi model');
      const choice = object(body.choices[0]), message = object(choice.message), usage = object(body.usage), calls = message.tool_calls;
      if (message.refusal) throw new SourceError('refused', 'Free-Pi refused this request');
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw new Error('Invalid Free-Pi content');
      if (lengthLimited(choice.finish_reason)) return truncatedCompletion(message?.content, usage, choice.finish_reason);
      const checkedCalls = calls == null ? [] : validatedCalls(calls, prepared.validators, request);
      if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))
        || choice.finish_reason === 'tool_calls' && !checkedCalls.length || typeof message.content !== 'string' && !checkedCalls.length || !message.content && !checkedCalls.length) throw new Error('Invalid Free-Pi completion');
      return withObservedEnding({ text: typeof message.content === 'string' ? message.content : '', ...(checkedCalls.length ? { calls: checkedCalls } : {}),
        ...(count(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}), ...(count(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}) },
        choice.finish_reason, usage, checkedCalls.length > 0);
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Free-Pi source closed');
      if (signal.aborted) throw new SourceError('timeout', 'Free-Pi response timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Free-Pi response or free-account guard could not be verified');
    } finally { await release(); }
  }
  async close() { this.shutdown.abort(); }
}
function prepareTools(request: ModelRequest) {
  const messages: ModelRequest['messages'] = [];
  try {
    for (const message of request.messages) {
      const previous = messages.at(-1);
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length && !message.tool_call_id
        && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length && !previous.tool_call_id) previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      else messages.push({ ...message });
    }
    // Validation only: never render a bridge prompt or execute a tool.
    new JsonToolBridge({ ...request, messages });
  } catch { throw requestRefusal('Free-Pi rejected invalid tools or an uncorrelated conversation'); }
  return { messages, validators: compileToolSchemas(request.tools, 'Free-Pi rejected a function tool schema') };
}
function validatedCalls(value: unknown, validators: Map<string, ValidateFunction>, request: ModelRequest): ToolCall[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid Free-Pi tools');
  const ids = new Set<string>();
  return value.map(item => {
    const call = object(item), fn = object(call.function);
    if (typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id) || call.type !== 'function' || typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string'
      || request.messages.some(message => message.tool_calls?.some(old => old.id === call.id))) throw new Error('Invalid Free-Pi tool call');
    const args: unknown = JSON.parse(fn.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args) || !validators.get(fn.name)?.(args)) throw new Error('Invalid Free-Pi tool arguments');
    ids.add(call.id);
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });
}
