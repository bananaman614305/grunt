import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { executable } from './multiplexer.js';
import { loopback } from './freellmapi.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export class OpenCode implements Source {
  readonly id = 'opencode';
  private child?: ChildProcess;
  private starting: Promise<string> | undefined;
  private sessions = new Map<string, string>();
  private busy = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { url?: string; fetcher?: typeof fetch; model?: string; timeout?: number } = {}) {
    if (options.url) loopback(options.url);
  }
  private get fetcher() { return this.options.fetcher ?? fetch; }
  async available() { if (this.options.url) return true; try { await executable('opencode'); return true; } catch { return false; } }
  private async server(): Promise<string> {
    if (this.options.url) return this.options.url.replace(/\/$/, '');
    if (this.starting) return this.starting;
    const binary = await executable('opencode');
    this.starting = new Promise<string>((resolve, reject) => {
      // Keep the normal OS home and the user's existing OpenCode login.
      const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child;
      const timer = setTimeout(() => { child.kill(); reject(new SourceError('timeout', 'OpenCode server startup timed out')); }, 30000);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) { clearTimeout(timer); resolve(address); }
      });
      const failed = () => { clearTimeout(timer); this.starting = undefined; this.sessions.clear(); reject(new SourceError('upstream', 'OpenCode server stopped; run opencode serve to check installation')); };
      child.once('error', failed); child.once('exit', failed);
    });
    return this.starting;
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const turns = userTurns(request), prompt = turns.at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const cwd = await realpath(request.cwd);
    const key = (history: string[]) => createHash('sha256').update(JSON.stringify([cwd, history])).digest('hex');
    const prior = turns.length > 1 ? this.sessions.get(key(turns.slice(0, -1))) : undefined;
    const continuation = prior && !this.busy.has(prior) ? prior : undefined;
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 90000)]);
    let session: string | undefined, base: string | undefined;
    const headers = { 'Content-Type': 'application/json', 'x-opencode-directory': cwd,
      ...(process.env.OPENCODE_SERVER_PASSWORD ? { Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } : {}) };
    const call = async (path: string, body: unknown) => {
      const res = await this.fetcher(`${base}${path}`, { method: 'POST', headers, redirect: 'error', signal, body: JSON.stringify(body) });
      if (!res.ok) throw new SourceError(res.status === 403 ? 'refused' : res.status === 401 ? 'logged_out' : res.status === 429 ? 'quota' : 'upstream', `OpenCode returned HTTP ${res.status}`);
      return await res.json();
    };
    try {
      base = await this.server(); signal.throwIfAborted();
      session = continuation ?? (await call('/session', { title: 'Milo' })).id;
      if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new SourceError('upstream', 'OpenCode returned an invalid session');
      this.busy.add(session);
      const reply = await call(`/session/${session}/message`, { model: { providerID: 'opencode', modelID: this.options.model ?? 'big-pickle' }, parts: [{ type: 'text', text: prompt }] });
      if (reply.info?.error) {
        const error = reply.info.error;
        if (error.name === 'ProviderAuthError' || error.data?.statusCode === 401) throw new SourceError('logged_out', 'OpenCode free model requires sign-in');
        throw new SourceError('refused', 'OpenCode provider refused the request');
      }
      const parts: { type: string; text?: string }[] = reply.parts ?? [];
      const text = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
      if (!text) throw new SourceError('upstream', 'OpenCode returned no assistant text');
      this.sessions.set(key(turns), session);
      return { text };
    } catch (error) {
      if (signal.aborted) {
        if (session && base) await this.fetcher(`${base}/session/${session}/abort`, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {});
        caller.throwIfAborted();
        if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'OpenCode request cancelled during shutdown');
        throw new SourceError('timeout', 'OpenCode request timed out');
      }
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'OpenCode request failed');
    } finally { if (session) this.busy.delete(session); }
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
