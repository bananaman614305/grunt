import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { executable, Tmux } from './multiplexer.js';
import type { Multiplexer } from './multiplexer.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export function positive(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Pool size and timeout must be positive integers');
  return number;
}
interface Waiter { resolve(): void; reject(error: Error): void }
// A request starts a fresh process; slots bound parallel sessions for each canonical cwd.
class Pool {
  private active = 0;
  private queue: Waiter[] = [];
  constructor(private size: number) {}
  async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < this.size) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); }, reject };
      const abort = () => { this.queue = this.queue.filter(w => w !== waiter); reject(new SourceError('timeout', 'Freebuff request cancelled while queued')); };
      this.queue.push(waiter); signal.addEventListener('abort', abort, { once: true });
    });
  }
  release() { const waiter = this.queue.shift(); if (waiter) waiter.resolve(); else this.active--; }
}
interface ChatMessage { variant?: string; content?: string; isComplete?: boolean; blocks?: { type?: string; content?: string }[] }
export function parseChat(value: unknown, prompt: string): string | undefined {
  if (!Array.isArray(value) || value.some(m => !m || typeof m !== 'object' || typeof m.variant !== 'string')) throw new SourceError('upstream', 'Freebuff chat format changed: expected a message array');
  const messages = value as ChatMessage[];
  const userIndex = messages.findIndex(m => m.variant === 'user' && m.content === prompt);
  if (userIndex < 0) return;
  const replies = messages.slice(userIndex + 1).filter(m => m.variant === 'ai');
  const last = replies.at(-1);
  if (!last || last.isComplete !== true) return;
  if (!Array.isArray(last.blocks)) throw new SourceError('upstream', 'Freebuff chat format changed: missing reply blocks');
  const blocks = last.blocks.filter(b => b.type === 'text');
  if (!blocks.length || blocks.some(b => typeof b.content !== 'string')) throw new SourceError('upstream', 'Freebuff chat format changed: missing text blocks');
  return blocks.map(b => b.content).join('\n');
}
export class Freebuff implements Source {
  id = 'freebuff';
  private pools = new Map<string, Pool>();
  private sessions = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { mux?: Multiplexer; home?: string; pool?: number; timeout?: number; poll?: number; startup?: number } = {}) {}
  private get mux() { return this.options.mux ?? (this.options.mux = new Tmux()); }
  async available() { try { await executable('freebuff'); await executable('tmux'); return true; } catch { return false; } }
  async complete(request: ModelRequest, caller: AbortSignal) {
    const binary = await executable('freebuff'); await executable('tmux');
    const cwd = await realpath(request.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new SourceError('upstream', 'Freebuff cwd must be a directory');
    const timeout = this.options.timeout ?? positive(process.env.MILO_APP_TIMEOUT_MS, 600000);
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(timeout)]);
    let pool = this.pools.get(cwd);
    if (!pool) { pool = new Pool(this.options.pool ?? positive(process.env.MILO_APP_POOL, 2)); this.pools.set(cwd, pool); }
    let acquired = false;
    const id = `milo-${randomUUID()}`;
    const directory = join(this.options.home ?? homedir(), '.config/manicode/projects', basename(cwd), 'chats');
    const prompt = `[Milo request ${id}]\n\n` + request.messages.map(m => `[${m.role}]\n${m.content}${m.tool_calls ? '\n' + JSON.stringify(m.tool_calls) : ''}`).join('\n\n');
    try {
      await pool.acquire(signal); acquired = true;
      signal.throwIfAborted();
      const before = new Set(await this.chatFiles(directory));
      this.sessions.add(id);
      await this.mux.start(id, cwd, binary);
      await delay(this.options.startup ?? 2500, undefined, { signal });
      await this.mux.send(id, prompt);
      let malformedSince: number | undefined;
      while (true) {
        signal.throwIfAborted();
        for (const file of await this.chatFiles(directory)) {
          if (before.has(file)) continue;
          let raw: string;
          try { raw = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          let data: unknown;
          try { data = JSON.parse(raw); }
          catch {
            // Writes may briefly be partial; a persistently invalid file is an actionable format error.
            malformedSince ??= Date.now();
            if (Date.now() - malformedSince > 2000) throw new SourceError('upstream', 'Freebuff chat file is persistently invalid JSON');
            continue;
          }
          const text = parseChat(data, prompt);
          if (text !== undefined) return { text };
        }
        await delay(this.options.poll ?? 200, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw new SourceError('timeout', `Freebuff timed out or was cancelled after ${timeout}ms; check freebuff login and your free-hours balance`);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `Freebuff failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      await this.mux.stop(id); this.sessions.delete(id);
      if (acquired) pool.release();
    }
  }
  private async chatFiles(dir: string): Promise<string[]> {
    try { return (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(dir, d.name, 'chat-messages.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async close() { this.shutdown.abort(); await Promise.all([...this.sessions].map(id => this.mux.stop(id))); }
}
