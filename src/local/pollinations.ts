import { diagnosticFetch } from './diagnostics.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';
import { FreebuffTools } from './freebuff-tools.js';
import { readDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

export const POLLINATIONS_MODEL = 'community/morriszdweck/glm-5.3-flash-free';
// An explicit one-item candidate list replaces provider-configured fallbacks.
// The trailing separator is intentional: its empty second item is discarded.
export const POLLINATIONS_WIRE_MODEL = `${POLLINATIONS_MODEL},`;
export const POLLINATIONS_RETURNED_MODEL = 'poe/GLM-5.3-Flash-T';
export const POLLINATIONS_ORIGIN = 'https://gen.pollinations.ai';
export const POLLINATIONS_GRANT_ORIGIN = 'https://trusty-squire-api.fly.dev';
export const POLLINATIONS_RECEIPT_MAX_AGE_MS = 30 * 86400000;
const directory = () => configRoot();
export const pollinationsGrantPath = (location = directory()) => join(location, 'pollinations.json');
interface AccessGrant { base_url: string; token: string }
export interface PollinationsGrant extends AccessGrant {
  version: 1;
  upstream_origin: typeof POLLINATIONS_ORIGIN;
  model: typeof POLLINATIONS_MODEL;
  verified_at: string;
  free_account_verified: true;
  key_zero_budget_verified: true;
  quest_pollen_only: true;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rejected = () => new SourceError('logged_out', 'Pollinations private free-access verification is missing or expired; rerun usegrunt setup');
function accessGrant(value: unknown): AccessGrant {
  const grant = object(value);
  if (typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(grant.token)) throw rejected();
  let url: URL;
  try { url = new URL(grant.base_url); } catch { throw rejected(); }
  if (url.origin !== POLLINATIONS_GRANT_ORIGIN || url.username || url.password || url.search || url.hash || /[?#]/.test(grant.base_url)
    || !/^\/v1\/egress\/g_[A-Za-z0-9_-]{16,64}\/?$/.test(url.pathname)) throw rejected();
  return { base_url: url.href.replace(/\/$/, ''), token: grant.token };
}
function validateGrant(value: unknown): PollinationsGrant {
  const grant = object(value), access = accessGrant(value);
  const verified = typeof grant.verified_at === 'string' ? Date.parse(grant.verified_at) : NaN;
  if (grant.version !== 1 || grant.upstream_origin !== POLLINATIONS_ORIGIN || grant.model !== POLLINATIONS_MODEL
    || grant.free_account_verified !== true || grant.key_zero_budget_verified !== true || grant.quest_pollen_only !== true
    || !Number.isFinite(verified) || verified > Date.now() + 60000 || Date.now() - verified > POLLINATIONS_RECEIPT_MAX_AGE_MS) throw rejected();
  return { ...access, version: 1, upstream_origin: POLLINATIONS_ORIGIN, model: POLLINATIONS_MODEL, verified_at: grant.verified_at as string,
    free_account_verified: true, key_zero_budget_verified: true, quest_pollen_only: true };
}
export async function readPollinationsGrant(location = directory()): Promise<PollinationsGrant> {
  let file;
  try {
    file = await open(pollinationsGrantPath(location), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw rejected();
    return validateGrant(JSON.parse(await file.readFile('utf8')));
  } catch { throw rejected(); }
  finally { await file?.close(); }
}
// Setup supplies these facts only after ordinary browser verification and a
// successful read-only access check. No raw provider key is persisted by Grunt.
export async function writePollinationsGrant(grant: PollinationsGrant, location = directory()): Promise<void> {
  const value = validateGrant(grant), temporary = join(location, `.pollinations-${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, pollinationsGrantPath(location)); }
  finally { await rm(temporary, { force: true }); }
}
async function readJSON(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError('upstream', 'Pollinations returned an unsupported response');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        abort = () => { void reader.cancel().catch(() => {}); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await Promise.race([reader.read(), cancellation]); }
      finally { if (abort) signal.removeEventListener('abort', abort); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new SourceError('upstream', 'Pollinations response exceeded the supported size');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* An aborted reader may still be closing. */ }
  }
}
function status(response: Response) {
  if (response.ok) return;
  const raw = response.headers.get('retry-after');
  const seconds = raw === null ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  void response.body?.cancel().catch(() => {});
  throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
    `Pollinations returned HTTP ${response.status}`, Number.isFinite(seconds) ? Math.max(1, seconds) : undefined, undefined, { httpStatus: response.status, transport: 'http' });
}
// Nonbillable metadata only. The authoritative server's zero-budget rule
// rejects every non-free model even when account funds exist. Quest-only keys
// cannot consume purchased Pollen. Recheck before each actual inference.
export async function verifyPollinationsAccess(grant: AccessGrant, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<void> {
  const access = accessGrant(grant), deadline = AbortSignal.timeout(5000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  try {
    const get = async (path: string) => {
      combined.throwIfAborted();
      const response = await diagnosticFetch(options.fetcher ?? fetch, 'pollinations', path.startsWith('/v1/models/') ? 'models' : 'account')(`${access.base_url}${path}`, {
        headers: { Authorization: `Bearer ${access.token}` }, redirect: 'error', signal: combined
      });
      status(response);
      return object(await readJSON(response, combined, 131072));
    };
    const pending = [get('/account/key'), get('/account/balance'), get(`/v1/models/${POLLINATIONS_MODEL}`)];
    let key, balance, catalog;
    try { [key, balance, catalog] = await Promise.all(pending); }
    catch (error) { controller.abort(); await Promise.allSettled(pending); throw error; }
    combined.throwIfAborted();
    const permissions = object(key!.permissions), models = permissions.models, account = permissions.account;
    const expires = key!.expiresAt;
    if (key!.valid !== true || key!.type !== 'secret' || key!.pollenBudget !== 0 || key!.questPollenOnly !== true
      || !(models === null || (Array.isArray(models) && models.length === 1 && models[0] === POLLINATIONS_MODEL))
      || !Array.isArray(account) || account.length !== 1 || account[0] !== 'usage'
      || !(expires === null || (typeof expires === 'string' && Number.isFinite(Date.parse(expires)) && Date.parse(expires) > Date.now()))) {
      throw new SourceError('refused', 'Pollinations requires a valid zero-budget, Quest-only, minimally scoped free key');
    }
    const funds = object(balance!.accountBalance);
    if (balance!.balance !== 0 || funds.paid !== 0 || typeof funds.tier !== 'number' || !Number.isFinite(funds.tier) || funds.tier <= 0) {
      throw new SourceError('quota', 'Pollinations free Quest allowance is unavailable');
    }
    const pricing = object(catalog!.pricing);
    // This vetted registry exports currency alone for a zero-rate model. New
    // price or billing fields must be reviewed rather than assumed harmless.
    if (catalog!.id !== POLLINATIONS_MODEL || catalog!.object !== 'model' || catalog!.owned_by !== 'OSAII'
      || catalog!.category !== 'text' || catalog!.community !== true || catalog!.paid_only !== false
      || pricing.currency !== 'pollen' || Object.keys(pricing).length !== 1
      || ['billing', 'billing_rules', 'billingRules', 'costVariants', 'rates', 'rateSheets'].some(field => Object.hasOwn(catalog!, field))
      || !Array.isArray(catalog!.supported_endpoints) || !catalog!.supported_endpoints.includes('/v1/chat/completions')) {
      throw new SourceError('refused', 'Pollinations vetted community route is no longer verified as zero priced');
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (signal.aborted) throw new SourceError('timeout', 'Pollinations free-access check timed out');
    if (error instanceof SourceError) throw error;
    throw new SourceError('upstream', 'Pollinations free-access check failed');
  }
}
function requestBridge(request: ModelRequest): FreebuffTools {
  try {
    const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, validateFormats: true, addUsedSchema: false });
    for (const tool of request.tools) {
      if (tool.type !== 'function' || !object(tool.function).parameters) throw new Error('Unsupported tool');
      ajv.compile(object(tool.function).parameters as AnySchema);
    }
    // Responses represents simultaneous calls as adjacent assistant items.
    // Group those call-only items before enforcing complete result correlation.
    const messages: ModelRequest['messages'] = [];
    for (const message of request.messages) {
      const previous = messages.at(-1);
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length
        && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length) {
        previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      } else messages.push({ ...message });
    }
    return new FreebuffTools({ ...request, messages });
  } catch { throw new SourceError('refused', 'Pollinations rejected unsupported tool definitions or an invalid tool conversation'); }
}
export function stripPollinationsThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}
export class Pollinations implements Source {
  readonly id = 'pollinations';
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<PollinationsGrant> } = {}) {}
  private grant() { return (this.options.loadGrant?.() ?? readPollinationsGrant(this.options.directory)).then(validateGrant); }
  private async approved() { return (await readDataSharingConsent(this.options.directory ?? directory(), [this.id])).includes(this.id); }
  private async track<T>(task: Promise<T>): Promise<T> { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  async available() {
    return this.track((async () => {
      try {
        if (this.shutdown.signal.aborted || !await this.approved()) return false;
        await verifyPollinationsAccess(await this.grant(), { fetcher: this.options.fetcher ?? fetch, signal: this.shutdown.signal });
        return !this.shutdown.signal.aborted;
      } catch { return false; }
    })());
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    return this.track(this.completeOnce(request, caller));
  }
  private async completeOnce(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw new SourceError('refused', 'Pollinations supports text inputs through this route');
      const bridge = requestBridge(request);
      if (!await this.approved()) throw new SourceError('refused', 'Pollinations data sharing is not approved; rerun usegrunt setup');
      let inputTokens = 0, outputTokens = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const grant = await this.grant();
        await verifyPollinationsAccess(grant, { fetcher: this.options.fetcher ?? fetch, signal });
        const response = await diagnosticFetch(this.options.fetcher ?? fetch, 'pollinations', 'chat.completions')(`${grant.base_url}/v1/chat/completions`, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ model: POLLINATIONS_WIRE_MODEL, messages: [{ role: 'user', content: bridge.prompt(attempt > 0) }],
            tools: [], stream: false, max_tokens: Math.min(4096, Math.max(1, Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens!) : 4096)) })
        });
        status(response);
        if (response.headers.get('x-model-requested') !== POLLINATIONS_MODEL || response.headers.get('x-model-used') !== POLLINATIONS_MODEL) {
          void response.body?.cancel().catch(() => {});
          throw new SourceError('upstream', 'Pollinations did not acknowledge the pinned community route');
        }
        const body = object(await readJSON(response, signal, 2 * 1024 * 1024));
        signal.throwIfAborted();
        if (body.model !== POLLINATIONS_RETURNED_MODEL) throw new SourceError('upstream', 'Pollinations returned an unverified model identity');
        const choices = body.choices, message = object(Array.isArray(choices) && choices.length === 1 ? object(choices[0]).message : undefined);
        if (message.refusal) throw new SourceError('refused', 'Pollinations refused the request');
        if (message.function_call !== undefined || (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length))) {
          throw new SourceError('refused', 'Pollinations attempted unsupported native API tools');
        }
        const usage = object(body.usage);
        if (typeof message.content !== 'string' || !Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 0
          || !Number.isSafeInteger(usage.completion_tokens) || Number(usage.completion_tokens) < 0) {
          throw new SourceError('upstream', 'Pollinations returned an invalid completion or usage');
        }
        inputTokens += usage.prompt_tokens as number; outputTokens += usage.completion_tokens as number;
        if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) throw new SourceError('upstream', 'Pollinations returned invalid usage');
        try {
          const result = bridge.parse(stripPollinationsThinking(message.content));
          if (!result.text.trim() && !result.calls?.length) throw new Error('Empty answer');
          return { ...result, inputTokens, outputTokens };
        }
        catch { if (attempt === 1) throw new SourceError('upstream', 'Pollinations tool response failed validation after one repair attempt'); }
      }
      throw new SourceError('upstream', 'Pollinations tool protocol failed');
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Pollinations request cancelled during shutdown');
      if (signal.aborted) throw new SourceError('timeout', 'Pollinations request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Pollinations request failed');
    }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
