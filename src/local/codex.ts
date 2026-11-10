import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { executable } from './multiplexer.js';
import { SourceError } from './source.js';
import type { ModelRequest } from './source.js';

function failure(output: string) {
  const code = /usage.limit|quota|rate.limit|limit.reached|too many requests|credits.*exhausted/i.test(output) ? 'quota'
    : /not logged in|logged out|sign.in|log.in|authentication|unauthorized|token.*expired/i.test(output) ? 'logged_out' : 'upstream';
  return new SourceError(code, `Codex request failed (${code})`);
}
export class Codex {
  readonly id = 'codex';
  private sessions = new Map<string, string>();
  private busy = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { model?: string; timeout?: number } = {}) {}
  private async run(args: string[], cwd: string | undefined, signal: AbortSignal, input?: string) {
    signal.throwIfAborted();
    const binary = await executable('codex');
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', oversized = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 1000); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 8 * 1024 * 1024) { oversized = true; stdout = ''; child.kill('SIGKILL'); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.once('error', () => {});
      child.once('close', code => {
        signal.removeEventListener('abort', abort); if (force) clearTimeout(force);
        if (signal.aborted) reject(new SourceError('timeout', 'Codex request timed out or was cancelled'));
        else if (code !== 0 || oversized) reject(failure(stdout + stderr));
        else resolve(stdout + (args[0] === 'login' ? stderr : ''));
      });
    });
  }
  async available() {
    try { return /Logged in using ChatGPT/i.test(await this.run(['login', 'status'], undefined, AbortSignal.timeout(10000))); }
    catch { return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 600000)]);
    const login = await this.run(['login', 'status'], undefined, signal);
    if (!/Logged in using ChatGPT/i.test(login)) throw new SourceError('logged_out', 'Codex requires an existing ChatGPT login');
    const turns = userTurns(request), prompt = turns.at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const cwd = await realpath(request.cwd);
    const key = (history: string[]) => createHash('sha256').update(JSON.stringify([cwd, history])).digest('hex');
    const prior = turns.length > 1 ? this.sessions.get(key(turns.slice(0, -1))) : undefined;
    const session = prior && !this.busy.has(prior) ? prior : undefined;
    if (session) this.busy.add(session);
    try {
      // Exec options precede resume so workspace-write applies to both commands.
      const args = ['exec', '--json', '--sandbox', 'workspace-write', ...(this.options.model ? ['-m', this.options.model] : []), ...(session ? ['resume', session] : []), '-'];
      const output = await this.run(args, cwd, signal, prompt);
      let thread: string | undefined, text = '';
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started') thread = event.thread_id;
        if (event.type === 'error' || event.type === 'turn.failed') throw failure(JSON.stringify(event));
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
      }
      if (!text) throw new SourceError('upstream', 'Codex returned no assistant text');
      if (thread || session) this.sessions.set(key(turns), thread ?? session!);
      console.error('Milo source: codex');
      return { text };
    } finally { if (session) this.busy.delete(session); }
  }
  async close() { this.shutdown.abort(); }
}
