import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { executable } from './multiplexer.js';
import { loopback } from './freellmapi.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const DEFAULT_OPENCODE_MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle'] as const;
const MODEL_QUOTA_COOLDOWN_MS = 60000;
class UnavailableModel extends SourceError {
  constructor() { super('upstream', 'OpenCode free model is unavailable'); }
}
interface PromptAttempt { session?: string; messageID?: string; partID?: string; retryable: boolean }
interface StoredMessage { info: { id: string; role: string }; parts: { id: string; type: string; text?: string }[] }

export class OpenCode implements Source {
  readonly id = 'opencode';
  private child?: ChildProcess;
  private starting: Promise<string> | undefined;
  private sessions = new Map<string, string>();
  private sessionModels = new Map<string, string>();
  private sessionParents = new Map<string, string>();
  private modelCooldowns = new Map<string, number>();
  private nextModel = 0;
  private prepared = new Map<string, Promise<void>>();
  private busy = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { url?: string; fetcher?: typeof fetch; model?: string | (() => string); models?: readonly string[] | (() => readonly string[]); timeout?: number; configFile?: string } = {}) {
    if (options.url) loopback(options.url);
  }
  private get fetcher() { return this.options.fetcher ?? fetch; }
  async available() { if (this.options.url) return true; try { await executable('opencode'); return true; } catch { return false; } }
  async healthCheck() {
    // Executable discovery cannot prove that the upstream login has recovered.
    try {
      const result = await this.complete({ model: this.id, messages: [{ role: 'user', content: 'Reply OK. Do not use tools or edit files.' }], tools: [], cwd: tmpdir(), stream: false }, AbortSignal.timeout(30000));
      return Boolean(result.text);
    } catch { return false; }
  }
  private async server(): Promise<string> {
    if (this.options.url) return this.options.url.replace(/\/$/, '');
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
        const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'], env });
        this.child = child;
        const timer = setTimeout(() => { child.kill(); reject(new SourceError('timeout', 'OpenCode server startup timed out')); }, 30000);
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192);
          const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (address) { clearTimeout(timer); resolve(address); }
        });
        const failed = () => { clearTimeout(timer); this.starting = undefined; this.sessions.clear(); this.sessionModels.clear(); this.sessionParents.clear(); this.prepared.clear(); reject(new SourceError('upstream', 'OpenCode server stopped; run opencode serve to check installation')); };
        child.once('error', failed); child.once('exit', failed);
      });
    })();
    this.starting = starting;
    void starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, ...(this.options.timeout ? [AbortSignal.timeout(this.options.timeout)] : [])]);
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
          last = error;
          this.modelCooldowns.set(model, Date.now() + (error.retryAfter === undefined ? MODEL_QUOTA_COOLDOWN_MS : error.retryAfter * 1000));
          if (!attempt.retryable) throw error;
        }
      }
      const retryAfter = Math.max(1, Math.ceil((Math.min(...models.map(model => this.modelCooldowns.get(model) ?? Date.now())) - Date.now()) / 1000));
      throw new SourceError('quota', 'OpenCode free models are temporarily exhausted or unavailable', retryAfter, last?.output);
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
    let guardFailed = false;
    const turnSignal = AbortSignal.any([signal, events.signal]);
    const headers = { 'Content-Type': 'application/json', 'x-opencode-directory': cwd,
      ...(process.env.OPENCODE_SERVER_PASSWORD ? { Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } : {}) };
    const check = (res: Response) => {
      if (!res.ok) {
        const header = res.headers.get('Retry-After');
        const seconds = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
        throw new SourceError(res.status === 403 ? 'refused' : res.status === 401 ? 'logged_out' : res.status === 429 ? 'quota' : 'upstream', `OpenCode returned HTTP ${res.status}`, Number.isFinite(seconds) ? Math.max(1, seconds) : undefined);
      }
    };
    const call = async (path: string, body: unknown) => {
      const res = await this.fetcher(`${base}${path}`, { method: 'POST', headers, redirect: 'error', signal: turnSignal, body: JSON.stringify(body) });
      check(res);
      return await res.json();
    };
    try {
      base = await this.server(); signal.throwIfAborted();
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
        let cancel!: () => void;
        const cancellation = new Promise<never>((_, reject) => { cancel = () => reject(turnSignal.reason); });
        turnSignal.addEventListener('abort', cancel, { once: true });
        try { turnSignal.throwIfAborted(); await Promise.race([prepared, cancellation]); }
        finally { turnSignal.removeEventListener('abort', cancel); }
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
      const reply = await Promise.race([watching, call(`/session/${session}/message`, {
        ...(attempt.messageID ? { messageID: attempt.messageID } : {}),
        model: { providerID: 'opencode', modelID }, parts: [{ ...(attempt.partID ? { id: attempt.partID } : {}), type: 'text', text: prompt }]
      })]);
      const parts: { type: string; text?: string }[] = reply.parts ?? [];
      const text = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
      if (reply.info?.error) {
        const error = reply.info.error;
        if (error.name === 'ProviderAuthError' || error.data?.statusCode === 401) throw new SourceError('logged_out', 'OpenCode free model requires sign-in');
        if (error.data?.statusCode === 429) throw new SourceError('quota', 'OpenCode free model quota exhausted', undefined, text);
        if (error.data?.statusCode === 404 || error.data?.code === 'model_not_found' || ['ModelNotFoundError', 'ProviderModelNotFoundError'].includes(error.name)) throw new UnavailableModel();
        throw new SourceError('refused', 'OpenCode provider refused the request');
      }
      if (!text) throw new SourceError('upstream', 'OpenCode returned no assistant text');
      this.sessions.set(key(turns), session);
      this.sessionModels.set(session, modelID);
      if (typeof reply.info?.parentID === 'string') this.sessionParents.set(session, reply.info.parentID);
      return { text };
    } catch (error) {
      if ((signal.aborted || guardFailed) && session && base) await this.fetcher(`${base}/session/${session}/abort`, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {});
      if (signal.aborted) {
        caller.throwIfAborted();
        if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenCode request cancelled during shutdown');
        throw new SourceError('timeout', 'OpenCode request timed out');
      }
      if (error instanceof SourceError && (error.code === 'quota' || error instanceof UnavailableModel) && session && base) {
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
            const usedTools = messages.slice(Math.max(0, userIndex)).some(message => message.parts?.some(part => part.type === 'tool'));
            if (!usedTools && (messages.length === 0 || user?.info.id === this.sessionParents.get(session))) {
              attempt.session = session; delete attempt.messageID; delete attempt.partID; attempt.retryable = true;
            } else if (!usedTools && user?.parts?.length === 1 && user.parts[0]?.type === 'text' && user.parts[0].text === prompt
              && /^msg[a-zA-Z0-9_-]+$/.test(user.info.id) && /^prt[a-zA-Z0-9_-]+$/.test(user.parts[0].id)) {
              attempt.session = session; attempt.messageID = user.info.id; attempt.partID = user.parts[0].id; attempt.retryable = true;
            }
          }
        } catch { /* Unknown persisted state is not safe to replay automatically. */ }
      }
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
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      // Some CLI versions keep their idle server alive after SIGTERM. Setup
      // must release its probe process before it can exit or try sign-in again.
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
}
