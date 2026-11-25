import { spawn } from 'node:child_process';
import { diagnosticFetch } from './diagnostics.js';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { executable } from './multiplexer.js';
import { loopback } from './freellmapi.js';
import { ManagedOpenCodeProcess } from './managed-opencode-process.js';
import { lengthLimited, preventReplay, replayTimeout, SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

export const DEFAULT_OPENCODE_MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle'] as const;
const MODEL_QUOTA_COOLDOWN_MS = 60000;
const MANAGED_IDLE_MS = 5 * 60000;
const REQUEST_TIMEOUT_MS = 180000;
class UnavailableModel extends SourceError {
  constructor() { super('upstream', 'OpenCode free model is unavailable'); }
}
// OpenCode's free limit is per IP and shared by every free model, and OpenCode
// itself retries it until the reset. Fail fast and cool down the whole pool.
class FreeLimit extends SourceError {
  constructor(retryAfter: number | undefined) { super('quota', 'OpenCode free usage limit reached', retryAfter); }
}
interface PromptAttempt { session?: string; messageID?: string; partID?: string; retryable: boolean }
interface StoredMessage { info: { id: string; role: string }; parts: { id: string; type: string; text?: string }[] }
interface TokenCounts { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
interface ReplyPart { type: string; reason?: string; text?: string; tokens?: TokenCounts }

async function waitForPreparation<T>(work: Promise<T>, signal: AbortSignal) {
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    return await Promise.race([work, cancelled]);
  } finally { signal.removeEventListener('abort', cancel); }
}

function sumTokens(counts: readonly unknown[]): number | undefined {
  let total = 0;
  for (const count of counts) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    total += count;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function replyUsage(parts: readonly ReplyPart[], messageTokens?: TokenCounts): Pick<Completion, 'inputTokens' | 'outputTokens'> {
  const steps = parts.filter(part => part.type === 'step-finish');
  // OpenCode's message summary can repeat just the final step's usage.
  const reports = steps.length ? steps.map(step => step.tokens) : [messageTokens];
  // OpenCode fills missing usage with zeros and omits the total in that case.
  const measured = reports.map(tokens => {
    if (tokens?.total === undefined && tokens?.input === 0 && tokens.output === 0 &&
        tokens.reasoning === 0 && tokens.cache?.read === 0 && tokens.cache.write === 0) return undefined;
    return tokens;
  });
  const inputTokens = sumTokens(measured.map(tokens => sumTokens([tokens?.input, tokens?.cache?.read ?? 0, tokens?.cache?.write ?? 0])));
  const outputTokens = sumTokens(measured.map(tokens => sumTokens([tokens?.output, tokens?.reasoning ?? 0])));
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

export class OpenCode implements Source {
  readonly id = 'opencode';
  // OpenCode runs its own coding tools and never returns the client's tool calls.
  readonly supportsFunctionTools = false;
  private child: ChildProcess | undefined;
  private managed: ManagedOpenCodeProcess | undefined;
  private activeRequests = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private recycling: Promise<void> | undefined;
  private idleRetiring = new WeakSet<ChildProcess>();
  private starting: Promise<string> | undefined;
  private sessions = new Map<string, string>();
  private sessionModels = new Map<string, string>();
  private sessionParents = new Map<string, string>();
  private modelCooldowns = new Map<string, number>();
  private nextModel = 0;
  private prepared = new Map<string, Promise<void>>();
  private busy = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { url?: string; fetcher?: typeof fetch; model?: string | (() => string); models?: readonly string[] | (() => readonly string[]); timeout?: number; configFile?: string; idleTimeoutMs?: number } = {}) {
    if (options.url) loopback(options.url);
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0)) throw new Error('Invalid managed OpenCode idle timeout');
  }
  private get fetcher() { return diagnosticFetch(this.options.fetcher ?? fetch, 'opencode', 'local.opencode'); }
  async available() { if (this.options.url) return true; try { await executable('opencode'); return true; } catch { return false; } }
  async healthCheck(caller?: AbortSignal) {
    // Executable discovery cannot prove that the upstream login has recovered.
    try {
      const deadline = AbortSignal.timeout(30000);
      const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
      const result = await this.complete({ model: this.id, messages: [{ role: 'user', content: 'Reply OK. Do not use tools or edit files.' }], tools: [], cwd: tmpdir(), stream: false }, signal);
      return Boolean(result.text);
    } catch { return false; }
  }
  private async server(): Promise<string> {
    if (this.options.url) return this.options.url.replace(/\/$/, '');
    if (this.recycling) await this.recycling;
    this.shutdown.signal.throwIfAborted();
    if (this.starting) return this.starting;
    const starting = (async () => {
      const binary = await executable('opencode');
      // Keep the normal OS home and the user's existing OpenCode login.
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
      const permission = typeof config.permission === 'string' ? { '*': config.permission } : config.permission;
      const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config, permission: { ...permission, external_directory: 'deny' }
      }) };
      if (this.options.configFile) {
        try {
          const stat = await lstat(this.options.configFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error('Invalid private config');
          // Signup may create this private grant after the daemon was started.
          // Let the CLI read it; provider values never enter this process.
          env.OPENCODE_CONFIG = this.options.configFile;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('logged_out', 'OpenCode private configuration is unavailable; rerun usegrunt setup');
        }
      }
      this.shutdown.signal.throwIfAborted();
      return new Promise<string>((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'], env, detached: grouped });
        this.child = child;
        const managed = new ManagedOpenCodeProcess(child, grouped);
        this.managed = managed;
        const timer = setTimeout(() => { this.retire(managed); reject(replayTimeout('OpenCode server startup timed out', true)); }, 30000);
        timer.unref();
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192);
          const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (address) { clearTimeout(timer); resolve(address); }
        });
        const failed = () => {
          clearTimeout(timer);
          if (this.child === child) {
            this.child = undefined; this.managed = undefined;
            if (this.starting === starting) this.starting = undefined;
            this.prepared.clear();
            // Deliberate idle cleanup preserves native, disk-backed session
            // identifiers and all model cooldowns for the next turn.
            if (!this.idleRetiring.has(child)) { this.sessions.clear(); this.sessionModels.clear(); this.sessionParents.clear(); }
          }
          reject(new SourceError('upstream', 'OpenCode server stopped; run opencode serve to check installation'));
        };
        child.once('error', failed); child.once('exit', failed);
      });
    })();
    this.starting = starting;
    void starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    this.activeRequests++;
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    try { return await this.completeOnce(request, caller); }
    finally { this.activeRequests--; this.scheduleIdle(); }
  }
  private retire(managed: ManagedOpenCodeProcess) {
    const recycling = managed.stop();
    this.recycling = recycling;
    // A failed cleanup must not admit another managed server beside a process
    // whose termination could not be confirmed, including startup timeouts.
    void recycling.then(() => { if (this.recycling === recycling) this.recycling = undefined; }, () => {});
  }
  private scheduleIdle() {
    if (this.options.url || this.shutdown.signal.aborted || this.activeRequests || !this.child || !this.managed) return;
    clearTimeout(this.idleTimer);
    const child = this.child, managed = this.managed;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeRequests || this.shutdown.signal.aborted || this.child !== child) return;
      this.idleRetiring.add(child);
      this.retire(managed);
    }, this.options.idleTimeoutMs ?? MANAGED_IDLE_MS);
    this.idleTimer.unref();
  }
  private async completeOnce(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? REQUEST_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const scalar = typeof this.options.model === 'function' ? this.options.model() : this.options.model;
    const configured = typeof this.options.models === 'function' ? this.options.models() : this.options.models;
    const models = [...new Set(scalar === undefined ? configured ?? DEFAULT_OPENCODE_MODELS : [scalar])];
    if (!models.length || models.some(model => typeof model !== 'string' || !model.trim())) throw new SourceError('upstream', 'OpenCode model pool is empty or invalid');
    const turns = userTurns(request), cwd = await realpath(request.cwd);
    const key = (history: string[]) => createHash('sha256').update(JSON.stringify([cwd, history])).digest('hex');
    const prior = this.sessions.get(key(turns)) ?? (turns.length > 1 ? this.sessions.get(key(turns.slice(0, -1))) : undefined);
    const sticky = prior && !this.busy.has(prior) ? this.sessionModels.get(prior) : undefined;
    const start = sticky && models.includes(sticky) ? models.indexOf(sticky) : this.nextModel % models.length;
    const candidates = [...models.slice(start), ...models.slice(0, start)];
    const attempt: PromptAttempt = { retryable: false };
    let last: SourceError | undefined;
    try {
      for (const model of candidates) {
        if ((this.modelCooldowns.get(model) ?? 0) > Date.now()) continue;
        signal.throwIfAborted();
        if (model !== sticky) this.nextModel = (models.indexOf(model) + 1) % models.length;
        try { return await this.completeModel(request, caller, model, signal, attempt); }
        catch (error) {
          if (signal.aborted || !(error instanceof SourceError) || (error.code !== 'quota' && !(error instanceof UnavailableModel))) throw error;
          if (error instanceof FreeLimit) {
            const until = Date.now() + (error.retryAfter ?? MODEL_QUOTA_COOLDOWN_MS / 1000) * 1000;
            for (const each of models) this.modelCooldowns.set(each, until);
            throw error;
          }
          last = error;
          this.modelCooldowns.set(model, Date.now() + (error.retryAfter === undefined ? MODEL_QUOTA_COOLDOWN_MS : error.retryAfter * 1000));
          if (!attempt.retryable || error.replay === 'unsafe') throw error;
        }
      }
      const retryAfter = Math.max(1, Math.ceil((Math.min(...models.map(model => this.modelCooldowns.get(model) ?? Date.now())) - Date.now()) / 1000));
      throw new SourceError('quota', 'OpenCode free models are temporarily exhausted or unavailable', retryAfter, last?.output, last?.diagnostics);
    } finally { if (attempt.session) this.busy.delete(attempt.session); }
  }
  private async completeModel(request: ModelRequest, caller: AbortSignal, modelID: string, signal: AbortSignal, attempt: PromptAttempt) {
    const turns = userTurns(request), prompt = request.handoffPrompt ?? turns.at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const cwd = await realpath(request.cwd);
    const key = (history: string[]) => createHash('sha256').update(JSON.stringify([cwd, history])).digest('hex');
    const prior = this.sessions.get(key(turns)) ?? (turns.length > 1 ? this.sessions.get(key(turns.slice(0, -1))) : undefined);
    const continuation = attempt.session ?? (prior && !this.busy.has(prior) ? prior : undefined);
    attempt.retryable = false;
    // Reserve a continuation before any asynchronous server work, and keep the
    // reservation across quota retries of this same user turn.
    if (continuation) { attempt.session = continuation; this.busy.add(continuation); }
    let session: string | undefined, base: string | undefined;
    const events = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let watching: Promise<never> | undefined;
    let guardFailed = false, dispatched = false, effectFreeReply = false, reportedProviderFailure = false, replyUsedTools = false;
    const turnSignal = AbortSignal.any([signal, events.signal]);
    const headers = { 'Content-Type': 'application/json', 'x-opencode-directory': cwd,
      ...(process.env.OPENCODE_SERVER_PASSWORD ? { Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } : {}) };
    const check = (res: Response) => {
      if (!res.ok) {
        const header = res.headers.get('Retry-After');
        const seconds = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
        throw new SourceError(res.status === 403 ? 'refused' : res.status === 401 ? 'logged_out' : res.status === 429 ? 'quota' : 'upstream', `OpenCode returned HTTP ${res.status}`, Number.isFinite(seconds) ? Math.max(1, seconds) : undefined, undefined,
          { httpStatus: res.status, transport: 'http', endpointLabel: 'local.opencode' });
      }
    };
    const call = async (path: string, body: unknown) => {
      const res = await this.fetcher(`${base}${path}`, { method: 'POST', headers, redirect: 'error', signal: turnSignal, body: JSON.stringify(body) });
      check(res);
      return await res.json();
    };
    try {
      base = await waitForPreparation(this.server(), signal);
      signal.throwIfAborted();
      if (!this.options.url) {
        // Personal MCP catalogs can fill the model context before a task starts.
        // Disconnect them only in our own worker instance, once per directory.
        // OpenCode's coding tools, saved login and config files stay available.
        let prepared = this.prepared.get(cwd);
        if (!prepared) {
          prepared = (async () => {
            const preparationSignal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30000)]);
            const prepare = async (path: string, method = 'GET') => {
              const response = await this.fetcher(`${base}${path}`, { method, headers, redirect: 'error', signal: preparationSignal });
              check(response);
              return await response.json();
            };
            const peers = await prepare('/mcp') as Record<string, { status?: string }>;
            if (!peers || typeof peers !== 'object' || Array.isArray(peers)) throw new SourceError('upstream', 'OpenCode returned invalid MCP status');
            await Promise.all(Object.entries(peers).filter(([, peer]) => peer?.status === 'connected').map(async ([name]) => {
              if (await prepare(`/mcp/${encodeURIComponent(name)}/disconnect`, 'POST') !== true) throw new SourceError('upstream', 'OpenCode could not prepare its worker tools');
            }));
          })();
          this.prepared.set(cwd, prepared);
          const pending = prepared;
          void pending.catch(() => { if (this.prepared.get(cwd) === pending) this.prepared.delete(cwd); });
        }
        await waitForPreparation(prepared, turnSignal);
      }
      session = continuation ?? (await call('/session', { title: 'grunt' })).id;
      if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new SourceError('upstream', 'OpenCode returned an invalid session');
      attempt.session = session;
      this.busy.add(session);
      // OpenCode 1.18.31: subscribe before sending the message so a fast
      // permission request cannot be missed, including on an existing server.
      const stream = await this.fetcher(`${base}/event`, { headers, redirect: 'error', signal: turnSignal });
      check(stream);
      if (!stream.headers.get('content-type')?.includes('text/event-stream') || !stream.body) {
        throw new SourceError('upstream', 'OpenCode permission event stream unavailable');
      }
      reader = stream.body.getReader();
      watching = (async (): Promise<never> => {
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader!.read();
          if (chunk.done) throw new SourceError('upstream', 'OpenCode permission event stream closed');
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event = JSON.parse(data);
            const status = event.type === 'session.status' ? event.properties : undefined;
            if (status?.sessionID === session && status.status?.type === 'retry' && status.status.action?.reason === 'free_tier_limit') {
              const next = status.status.next;
              throw new FreeLimit(typeof next === 'number' && Number.isFinite(next) ? Math.max(1, Math.ceil((next - Date.now()) / 1000)) : undefined);
            }
            if (event.type !== 'permission.asked') continue;
            const permission = event.properties;
            if (typeof permission?.sessionID !== 'string') throw new SourceError('upstream', 'OpenCode returned an invalid permission request');
            if (permission.sessionID !== session) continue;
            if (typeof permission.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(permission.id)) {
              throw new SourceError('upstream', 'OpenCode returned an invalid permission request');
            }
            await call(`/permission/${permission.id}/reply`, { reply: 'reject' });
          }
        }
      })().catch(error => { guardFailed = true; throw error; });
      turnSignal.throwIfAborted();
      dispatched = true;
      const reply = await Promise.race([watching, call(`/session/${session}/message`, {
        ...(attempt.messageID ? { messageID: attempt.messageID } : {}),
        model: { providerID: 'opencode', modelID }, parts: [{ ...(attempt.partID ? { id: attempt.partID } : {}), type: 'text', text: prompt }]
      })]);
      const parts: ReplyPart[] = reply.parts ?? [];
      const text = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
      if (reply.info?.error) {
        reportedProviderFailure = true;
        // A settled reply can be handed off only when its parts rule out native tools.
        effectFreeReply = Array.isArray(reply.parts) && parts.every(part => ['text', 'reasoning', 'step-start', 'step-finish'].includes(part.type));
        replyUsedTools = parts.some(part => !['text', 'reasoning', 'step-start', 'step-finish'].includes(part.type));
        const error = reply.info.error;
        if (error.name === 'ProviderAuthError' || error.data?.statusCode === 401) throw new SourceError('logged_out', 'OpenCode free model requires sign-in');
        if (error.data?.statusCode === 429) throw new SourceError('quota', 'OpenCode free model quota exhausted', undefined, text);
        if (error.data?.statusCode === 404 || error.data?.code === 'model_not_found' || ['ModelNotFoundError', 'ProviderModelNotFoundError'].includes(error.name)) throw new UnavailableModel();
        throw new SourceError('refused', 'OpenCode provider refused the request');
      }
      const finish = reply.info?.finish ?? parts.findLast(part => part.type === 'step-finish')?.reason;
      const truncated = lengthLimited(finish);
      if (!text && !truncated) throw new SourceError('upstream', 'OpenCode returned no assistant text');
      this.sessions.set(key(turns), session);
      this.sessionModels.set(session, modelID);
      if (typeof reply.info?.parentID === 'string') this.sessionParents.set(session, reply.info.parentID);
      return { text, ...(truncated ? { finishReason: 'length' as const } : {}), ...replyUsage(parts, reply.info?.tokens) };
    } catch (error) {
      if ((signal.aborted || guardFailed) && session && base) await this.fetcher(`${base}/session/${session}/abort`, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {});
      if (signal.aborted) {
        caller.throwIfAborted();
        if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenCode request cancelled during shutdown');
        throw replayTimeout('OpenCode request timed out', !dispatched);
      }
      // A free limit is never retried here, and the pending prompt is still sleeping.
      const rejection = error instanceof SourceError && [401, 403, 429].includes(error.diagnostics?.httpStatus ?? 0) && !guardFailed;
      if (error instanceof SourceError && !(error instanceof FreeLimit) && (error.code === 'quota' || error instanceof UnavailableModel) && session && base && (!dispatched || reportedProviderFailure || rejection)) {
        // A provider error can arrive after OpenCode has persisted the user
        // prompt. Reuse that prompt's IDs rather than appending it again. Never
        // replay a turn that already ran native tools, or whose state is unclear.
        try {
          const response = await this.fetcher(`${base}/session/${session}/message`, { headers, redirect: 'error', signal: turnSignal });
          check(response);
          const messages = await response.json() as StoredMessage[];
          if (Array.isArray(messages)) {
            const userIndex = messages.findLastIndex(message => message.info?.role === 'user');
            const user = messages[userIndex];
            const usedTools = replyUsedTools || messages.slice(Math.max(0, userIndex)).some(message => message.parts?.some(part => part.type === 'tool'));
            if (!usedTools && (messages.length === 0 || user?.info.id === this.sessionParents.get(session))) {
              attempt.session = session; delete attempt.messageID; delete attempt.partID; attempt.retryable = true;
            } else if (!usedTools && user?.parts?.length === 1 && user.parts[0]?.type === 'text' && user.parts[0].text === prompt
              && /^msg[a-zA-Z0-9_-]+$/.test(user.info.id) && /^prt[a-zA-Z0-9_-]+$/.test(user.parts[0].id)) {
              attempt.session = session; attempt.messageID = user.info.id; attempt.partID = user.parts[0].id; attempt.retryable = true;
            }
          }
        } catch { /* Unknown persisted state is not safe to replay automatically. */ }
      }
      if (dispatched && !effectFreeReply && !rejection && !attempt.retryable) throw preventReplay(error, 'OpenCode request failed after sending the prompt');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'OpenCode request failed');
    } finally {
      events.abort();
      await reader?.cancel().catch(() => {});
      await watching?.catch(() => {});
    }
  }
  async close() {
    this.shutdown.abort();
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    await this.managed?.stop();
    await this.recycling;
  }
}
