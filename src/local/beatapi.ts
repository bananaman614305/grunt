import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { AnySchema, ValidateFunction } from 'ajv';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory } from './provider-grant.js';
import { FreebuffTools } from './freebuff-tools.js';
import { SourceError } from './source.js';
import type { Completion, ModelRequest, Source, ToolCall } from './source.js';

export const BEATAPI_MODEL = 'deepseek-v4.1-flash-free';
export const BEATAPI_ORIGIN = 'https://api.beatapi.io';
export const BEATAPI_RECEIPT_MAX_AGE_MS = 30 * 86400000;
export interface BeatAPIAccess { base_url: string; token: string }
export interface BeatAPIGrant extends BeatAPIAccess {
  version: 1; upstream_origin: typeof BEATAPI_ORIGIN; model: typeof BEATAPI_MODEL; verified_at: string;
  free_account_verified: true; lifetime_paid: 0; payment_method_present: false; auto_recharge: false;
  credit_provenance: 'signup' | 'zero'; baseline_balance: number;
}
export const beatapiGrantPath = (directory = providerGrantDirectory()) => join(directory, 'beatapi.json');
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rejected = () => new SourceError('logged_out', 'BeatAPI private free-account verification is missing or expired; rerun usegrunt setup');
function access(value: unknown): BeatAPIAccess {
  const grant = obj(value);
  if (typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(grant.token)) throw rejected();
  let url: URL;
  try { url = new URL(grant.base_url); } catch { throw rejected(); }
  if (url.origin !== 'https://trusty-squire-api.fly.dev' || url.username || url.password || url.search || url.hash
    || !/^\/v1\/egress\/g_[A-Za-z0-9_-]{16,64}\/?$/.test(url.pathname)) throw rejected();
  return { base_url: url.href.replace(/\/$/, ''), token: grant.token };
}
function validate(value: unknown): BeatAPIGrant {
  const grant = obj(value), auth = access(value), checked = typeof grant.verified_at === 'string' ? Date.parse(grant.verified_at) : NaN;
  if (grant.version !== 1 || grant.upstream_origin !== BEATAPI_ORIGIN || grant.model !== BEATAPI_MODEL || grant.free_account_verified !== true
    || grant.lifetime_paid !== 0 || grant.payment_method_present !== false || grant.auto_recharge !== false
    || !Number.isFinite(checked) || checked > Date.now() + 60000 || Date.now() - checked > BEATAPI_RECEIPT_MAX_AGE_MS
    || typeof grant.baseline_balance !== 'number' || !Number.isFinite(grant.baseline_balance) || grant.baseline_balance < 0 || grant.baseline_balance > 2
    || (grant.credit_provenance !== 'zero' && grant.credit_provenance !== 'signup')
    || (grant.credit_provenance === 'zero' ? grant.baseline_balance !== 0 : grant.baseline_balance <= 0)) throw rejected();
  return { ...auth, version: 1, upstream_origin: BEATAPI_ORIGIN, model: BEATAPI_MODEL, verified_at: grant.verified_at as string,
    free_account_verified: true, lifetime_paid: 0, payment_method_present: false, auto_recharge: false,
    credit_provenance: grant.credit_provenance, baseline_balance: grant.baseline_balance };
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw rejected();
}
export async function readBeatAPIGrant(directory = providerGrantDirectory()): Promise<BeatAPIGrant> {
  let file;
  try {
    await privateDirectory(directory);
    file = await open(beatapiGrantPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw rejected();
    return validate(JSON.parse(await file.readFile('utf8')));
  } catch { throw rejected(); }
  finally { await file?.close(); }
}
export async function writeBeatAPIGrant(grant: BeatAPIGrant, directory = providerGrantDirectory()) {
  const value = validate(grant); await privateDirectory(directory, true);
  const temporary = join(directory, `.beatapi-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, beatapiGrantPath(directory)); }
  finally { await rm(temporary, { force: true }); }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function json(response: Response, signal: AbortSignal, limit: number): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) { void response.body?.cancel().catch(() => {}); throw new SourceError('upstream', 'BeatAPI response exceeded the supported size'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal); signal.throwIfAborted(); if (part.done) break;
      size += part.value.byteLength; if (size > limit) throw new SourceError('upstream', 'BeatAPI response exceeded the supported size'); chunks.push(part.value);
    }
    return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { void reader.cancel().catch(() => {}); }
}
function status(response: Response): void {
  if (response.ok) return;
  const raw = response.headers.get('retry-after'), retry = raw === null ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  void response.body?.cancel().catch(() => {});
  throw new SourceError(response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : [402, 403].includes(response.status) ? 'refused' : 'upstream',
    `BeatAPI returned HTTP ${response.status}`, response.status === 429 ? Math.max(1, Number.isFinite(retry) ? Math.ceil(retry) : 60) : undefined);
}
export interface BeatAPIUsage { credit_balance: number; credits_settled: 0 }
// Public nonbillable API metadata. The published -free contract sets the price
// to zero even at zero balance; browser cookies are never needed at runtime.
export async function verifyBeatAPIAccess(grant: BeatAPIAccess, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<BeatAPIUsage> {
  const auth = access(grant), signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(5000)]);
  try {
    const response = await abortable((options.fetcher ?? fetch)(`${auth.base_url}/v1/usage`, { headers: { Authorization: `Bearer ${auth.token}` }, redirect: 'error', signal }), signal); status(response);
    const usage = obj((await json(response, signal, 131072)).data);
    if (usage.object !== 'usage' || typeof usage.credit_balance !== 'number' || !Number.isFinite(usage.credit_balance) || usage.credit_balance < 0 || usage.credit_balance > 2
      || usage.credits_settled !== 0 || ('lifetime_paid' in usage && usage.lifetime_paid !== 0)
      || ('payment_method_present' in usage && usage.payment_method_present !== false) || ('auto_recharge' in usage && usage.auto_recharge !== false)) {
      throw new SourceError('refused', 'BeatAPI requires an unspent zero-balance or ordinary signup-credit account');
    }
    return { credit_balance: usage.credit_balance, credits_settled: 0 };
  } catch (error) {
    if (options.signal?.aborted) throw new SourceError('cancelled', 'BeatAPI account check cancelled'); if (signal.aborted) throw new SourceError('timeout', 'BeatAPI account check timed out');
    if (error instanceof SourceError) throw error; throw new SourceError('upstream', 'BeatAPI account check failed');
  }
}
function tools(request: ModelRequest) {
  const validators = new Map<string, ValidateFunction>();
  try {
    // Responses encodes parallel function calls as adjacent assistant items.
    // Reassemble their single native assistant turn before correlation checks
    // and forwarding, preserving every call ID, argument and result.
    const messages: ModelRequest['messages'] = [];
    for (const message of request.messages) {
      const previous = messages.at(-1);
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length && !message.tool_call_id
        && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length && !previous.tool_call_id) {
        previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      } else messages.push({ ...message });
    }
    // Validation only; this does not prompt a bridge or execute a function.
    new FreebuffTools({ ...request, messages });
    const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, addUsedSchema: false });
    for (const tool of request.tools) { const fn = obj(tool.function); validators.set(fn.name as string, ajv.compile(fn.parameters as AnySchema)); }
    return { validators, messages };
  } catch { throw new SourceError('refused', 'BeatAPI rejected invalid function tools or an uncorrelated tool conversation'); }
}
export class BeatAPI implements Source {
  readonly id = 'beatapi'; readonly supportsFunctionTools = true;
  private shutdown = new AbortController(); private pending = new Set<Promise<unknown>>(); private next = 0; private busy = false;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<BeatAPIGrant>; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private grant() { return (this.options.loadGrant?.() ?? readBeatAPIGrant(this.options.directory)).then(validate); }
  private async approved() { return (await readDataSharingConsent(this.options.directory ?? providerGrantDirectory(), [this.id])).includes(this.id); }
  private async track<T>(task: Promise<T>) { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  async available() {
    return this.track((async () => { try {
      if (this.shutdown.signal.aborted || this.busy || this.now() < this.next || !await this.approved()) return false;
      const grant = await this.grant(), usage = await verifyBeatAPIAccess(grant, { ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal: this.shutdown.signal });
      return !this.shutdown.signal.aborted && usage.credit_balance === grant.baseline_balance;
    } catch { return false; } })());
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    if (caller.aborted) throw new SourceError('cancelled', 'BeatAPI request cancelled'); if (this.busy || this.now() < this.next) throw new SourceError('quota', 'BeatAPI free requests are limited to one successful request per minute', Math.max(1, Math.ceil((this.next - this.now()) / 1000)));
    this.busy = true; try { return await this.track(this.once(request, caller)); } finally { this.busy = false; }
  }
  private async once(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    try {
      signal.throwIfAborted(); if (![this.id, 'milo'].includes(request.model) || request.imageInput) throw new SourceError('refused', 'BeatAPI requires its pinned text-only free route');
      const { validators, messages } = tools(request); if (!await this.approved()) throw new SourceError('refused', 'BeatAPI data sharing is not approved; rerun usegrunt setup');
      const grant = await this.grant(), guards = { ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal };
      const before = await verifyBeatAPIAccess(grant, guards); if (before.credit_balance !== grant.baseline_balance) throw new SourceError('refused', 'BeatAPI account balance changed; rerun usegrunt setup');
      const response = await abortable((this.options.fetcher ?? fetch)(`${grant.base_url}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ model: BEATAPI_MODEL, messages,
          ...(request.tools.length ? { tools: request.tools } : {}), stream: false, max_tokens: Math.min(4096, Math.max(1, Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens!) : 4096)) }) }), signal);
      status(response); this.next = this.now() + 60000;
      const body = await json(response, signal, 2 * 1024 * 1024), after = await verifyBeatAPIAccess(grant, guards);
      if (after.credit_balance !== before.credit_balance) throw new SourceError('refused', 'BeatAPI free request changed the account balance; routing stopped');
      if (body.model !== BEATAPI_MODEL) throw new SourceError('upstream', 'BeatAPI returned an unverified free model identity');
      const choice = obj(Array.isArray(body.choices) && body.choices.length === 1 ? body.choices[0] : undefined), message = obj(choice.message), usage = obj(body.usage);
      if (message.refusal) throw new SourceError('refused', 'BeatAPI refused the request');
      if (!(message.content === undefined || message.content === null || typeof message.content === 'string') || !Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 0
        || !Number.isSafeInteger(usage.completion_tokens) || Number(usage.completion_tokens) < 0 || ['cost', 'total_cost', 'credits_charged'].some(key => key in usage && usage[key] !== 0)) throw new SourceError('upstream', 'BeatAPI returned an invalid completion or usage');
      const calls: ToolCall[] = [], ids = new Set<string>();
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw new SourceError('upstream', 'BeatAPI returned invalid function calls');
        for (const raw of message.tool_calls) {
          const c = obj(raw), fn = obj(c.function); let args: unknown; try { args = JSON.parse(String(fn.arguments)); } catch { throw new SourceError('upstream', 'BeatAPI returned invalid function arguments'); }
          if (c.type !== 'function' || typeof c.id !== 'string' || !c.id || ids.has(c.id) || request.messages.some(m => m.tool_calls?.some(old => old.id === c.id))
            || typeof fn.name !== 'string' || typeof fn.arguments !== 'string' || !validators.get(fn.name)?.(args) || !args || typeof args !== 'object' || Array.isArray(args)) throw new SourceError('upstream', 'BeatAPI returned invalid function calls');
          ids.add(c.id); calls.push({ id: c.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
        }
      }
      if (!message.content && !calls.length) throw new SourceError('upstream', 'BeatAPI returned an empty completion');
      this.next = this.now() + 60000;
      return { text: typeof message.content === 'string' ? message.content : '', ...(calls.length ? { calls } : {}), inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number };
    } catch (error) {
      if (caller.aborted) throw new SourceError('cancelled', 'BeatAPI request cancelled'); if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'BeatAPI request cancelled during shutdown');
      if (signal.aborted) throw new SourceError('timeout', 'BeatAPI request timed out');
      if (error instanceof SourceError) { if (error.code === 'quota') this.next = this.now() + (error.retryAfter ?? 60) * 1000; throw error; }
      throw new SourceError('upstream', 'BeatAPI request failed');
    }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
