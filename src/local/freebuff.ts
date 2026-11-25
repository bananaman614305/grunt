import { gruntEnv } from '../brand.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { executable, Tmux } from './multiplexer.js';
import type { Multiplexer } from './multiplexer.js';
import { userTurns } from './harness.js';
import { preventReplay, replayTimeout, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { FreebuffTools } from './freebuff-tools.js';

export function positive(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Pool size and timeout must be positive integers');
  return number;
}
const exec = promisify(execFile);
// freebuff doctor can take several seconds on a healthy machine (8 s measured).
export const DOCTOR_TIMEOUT_MS = 30000;
function logError(log: string): SourceError | undefined {
  const line = log.split('\n').find(line => /prompt_policy_refused|logged.?out|unauthorized|login required|not signed in|"code"\s*:\s*"quota"|quota[ _-](?:exceeded|exhausted|reached)|free[ _-]?hours.*(?:exhaust|exceed|empty)|(?:out of|no) free hours/i.test(line));
  if (!line) return;
  if (/prompt_policy_refused/.test(line)) return new SourceError('refused', 'Freebuff refused this request under its usage policy');
  if (/quota|hours/i.test(line)) return new SourceError('quota', 'Freebuff free-hours allowance is exhausted');
  return new SourceError('logged_out', 'Freebuff login is unavailable; rerun setup');
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
interface ChatMessage { variant?: string; content?: string; textAttachments?: { content?: string }[]; isComplete?: boolean; blocks?: { type?: string; textType?: string; name?: string; content?: string }[] }
function matchesUser(m: ChatMessage, prompt: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n').trim();
  return m.variant === 'user' && normalize(m.content || m.textAttachments?.map(a => a.content ?? '').join('\n') || '') === normalize(prompt);
}
export function parseChat(value: unknown, prompt: string, forbidNative = false): string | undefined {
  if (!Array.isArray(value) || value.some(m => !m || typeof m !== 'object' || typeof m.variant !== 'string')) throw new SourceError('upstream', 'Freebuff chat format changed: expected a message array');
  const messages = value as ChatMessage[];
  const userIndex = messages.findLastIndex(m => matchesUser(m, prompt));
  if (userIndex < 0) return;
  const replies = messages.slice(userIndex + 1).filter(m => m.variant === 'ai');
  if (forbidNative && replies.some(m => m.blocks?.some(b => b.type !== 'text'))) throw new SourceError('refused', 'Freebuff used native tools during a JSON bridge request');
  const last = replies.at(-1);
  if (!last || last.isComplete !== true) return;
  if (!Array.isArray(last.blocks)) throw new SourceError('upstream', 'Freebuff chat format changed: missing reply blocks');
  let end = last.blocks.length;
  while (end > 0 && last.blocks[end - 1]!.type === 'tool' && last.blocks[end - 1]!.name === 'suggest_followups') end--;
  const answer = last.blocks.slice(0, end);
  const blocks = answer.slice(answer.findLastIndex(b => b.type !== 'text') + 1).filter(b => b.textType !== 'reasoning');
  if (!blocks.length) return;
  if (blocks.some(b => typeof b.content !== 'string')) throw new SourceError('upstream', 'Freebuff chat format changed: missing text blocks');
  return blocks.map(b => b.content).join('\n');
}
export class Freebuff implements Source {
  id = 'freebuff';
  private pools = new Map<string, Pool>();
  private sessions = new Set<string>();
  private conversations = new Map<string, string>();
  private busy = new Set<string>();
  private creationLocks = new Map<string, Pool>();
  private shutdown = new AbortController();
  private doctorRun: Promise<void> | undefined;
  readonly reportsOutput = true;
  constructor(private options: { mux?: Multiplexer; home?: string; pool?: number; timeout?: number; poll?: number; startup?: number; toolBridge?: boolean; doctor?: (signal: AbortSignal) => Promise<string> } = {}) {}
  get supportsFunctionTools() { return this.options.toolBridge === true; }
  get jsonToolBridge() { return this.options.toolBridge === true; }
  private get mux() { return this.options.mux ?? (this.options.mux = new Tmux()); }
  async available() {
    try {
      const binary = await executable('freebuff'); await executable('tmux');
      const { stdout } = await exec(binary, ['doctor'], { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 65536 });
      return /Freebuff doctor/i.test(stdout) && logError(stdout)?.code !== 'logged_out';
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  // After a failure, run freebuff doctor once in the background and log what it
  // says. Only one run at a time; a failure while it runs does not queue another.
  failed() {
    if (this.doctorRun || this.shutdown.signal.aborted) return;
    const signal = this.shutdown.signal;
    const run = this.options.doctor ?? (async (signal: AbortSignal) => {
      const { stdout, stderr } = await exec(await executable('freebuff'), ['doctor'], { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 65536, signal });
      return `${stdout}${stderr}`;
    });
    this.doctorRun = Promise.resolve().then(() => run(signal)).then(
      output => { console.error(`freebuff doctor after failure:\n${output.trim().slice(-4096) || '(no output)'}`); },
      error => { console.error(`freebuff doctor after failure did not finish: ${error instanceof Error ? error.message : 'unknown error'}`); }
    ).finally(() => { this.doctorRun = undefined; });
  }
  async complete(request: ModelRequest, caller: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    if (!this.options.toolBridge) return this.completeText(request, caller, false, output, beforeNativeWork);
    caller.throwIfAborted();
    const bridge = new FreebuffTools(request);
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.options.timeout ?? positive(gruntEnv('APP_TIMEOUT_MS'), 600000))]);
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const result = await this.completeText({ ...request, handoffPrompt: bridge.prompt(attempt > 0) }, signal, true, output, beforeNativeWork);
      signal.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Freebuff request cancelled during shutdown');
      try { return bridge.parse(result.text); }
      catch { if (attempt === 1) throw new SourceError('upstream', 'Freebuff JSON bridge failed validation after one repair attempt'); }
    }
    throw new SourceError('upstream', 'Freebuff JSON bridge failed');
  }
  private async completeText(request: ModelRequest, caller: AbortSignal, isolated = false, output?: () => void, beforeNativeWork?: () => void) {
    const binary = await executable('freebuff'); await executable('tmux');
    let diagnostics: string;
    try { diagnostics = (await exec(binary, ['doctor'], { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 65536, signal: caller })).stdout; }
    catch { throw new SourceError('upstream', 'Freebuff startup check failed; run freebuff doctor'); }
    const diagnosticError = logError(diagnostics);
    if (diagnosticError) throw diagnosticError;
    const cwd = await realpath(request.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new SourceError('upstream', 'Freebuff cwd must be a directory');
    const timeout = this.options.timeout ?? positive(gruntEnv('APP_TIMEOUT_MS'), 600000);
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(timeout)]);
    let pool = this.pools.get(cwd);
    if (!pool) { pool = new Pool(this.options.pool ?? positive(gruntEnv('APP_POOL'), 2)); this.pools.set(cwd, pool); }
    let acquired = false;
    const id = `grunt-${randomUUID()}`;
    const directory = join(this.options.home ?? homedir(), '.config/manicode/projects', basename(cwd), 'chats');
    const turns = userTurns(request);
    const prompt = request.handoffPrompt ?? turns.at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const key = cwd + ':' + createHash('sha256').update(turns[0]!).digest('hex');
    // Simultaneous requests must never send into the same pane/chat.
    let continuation = isolated || this.busy.has(key) ? undefined : this.conversations.get(key);
    const ownsConversation = !isolated && !this.busy.has(key);
    if (ownsConversation) this.busy.add(key);
    let creation: Pool | undefined;
    let creating = false;
    let partial = '';
    let dispatched = false;
    const releaseCreation = () => { if (creating) { creation!.release(); creating = false; } };
    try {
      await pool.acquire(signal); acquired = true;
      let previousMessages = 0;
      if (continuation) {
        try { previousMessages = (JSON.parse(await readFile(continuation, 'utf8')) as unknown[]).length; }
        catch { this.conversations.delete(key); continuation = undefined; }
      }
      if (!continuation) {
        // Freebuff groups different working folders with the same basename together.
        // Start only one unassociated process per on-disk directory at a time.
        creation = this.creationLocks.get(directory);
        if (!creation) { creation = new Pool(1); this.creationLocks.set(directory, creation); }
        await creation.acquire(signal); creating = true;
      }
      signal.throwIfAborted();
      const before = new Set(await this.chatFiles(directory));
      const logOffsets = new Map<string, number>();
      if (continuation) {
        try { logOffsets.set(continuation, (await readFile(join(dirname(continuation), 'log.jsonl'), 'utf8')).length); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      this.sessions.add(id);
      await this.mux.start(id, cwd, binary, continuation ? basename(dirname(continuation)) : undefined);
      await delay(this.options.startup ?? 2500, undefined, { signal });
      // Persisted files can identify this process before send finishes returning.
      // Observe them concurrently, while still holding the creation lock.
      let sendComplete = false;
      let sendFailure: unknown;
      signal.throwIfAborted();
      beforeNativeWork?.();
      dispatched = true;
      void this.mux.send(id, prompt).then(() => { sendComplete = true; }, error => { sendFailure = error; sendComplete = true; });
      let malformedSince: number | undefined;
      let selected = continuation;
      let sawUser = false;
      const sentAt = Date.now();
      while (true) {
        signal.throwIfAborted();
        if (sendFailure) throw sendFailure;
        for (const file of await this.chatFiles(directory)) {
          if (selected ? file !== selected : before.has(file)) continue;
          let log = '';
          try { log = await readFile(join(dirname(file), 'log.jsonl'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          const startupError = logError(log.slice(logOffsets.get(file) ?? 0));
          let raw: string;
          try { raw = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (startupError) throw startupError; continue; } throw error; }
          let data: unknown;
          try { data = JSON.parse(raw); }
          catch {
            // Writes may briefly be partial; a persistently invalid file is an actionable format error.
            malformedSince ??= Date.now();
            if (Date.now() - malformedSince > 2000) throw new SourceError('upstream', 'Freebuff chat file is persistently invalid JSON');
            continue;
          }
          if (Array.isArray(data)) {
            const latest = data.filter(m => m?.variant === 'ai').at(-1);
            if (Array.isArray(latest?.blocks)) partial = latest.blocks.filter((b: { type?: string; textType?: string; content?: string }) => b.type === 'text' && b.textType !== 'reasoning' && typeof b.content === 'string').map((b: { content: string }) => b.content).join('\n').slice(-4096);
          }
          if (startupError) {
            selected = file;
            releaseCreation();
            throw startupError;
          }
          if (continuation && Array.isArray(data)) data = data.slice(previousMessages);
          const matched = Array.isArray(data) && data.some(m => matchesUser(m, prompt));
          if (!matched) continue;
          // No other new process sharing this storage directory started between
          // our snapshot and this association. Later polling reads only this chat.
          selected = file;
          releaseCreation();
          sawUser = true;
          // First output: any reply after this turn, including tool or reasoning blocks.
          if (output && (data as ChatMessage[]).slice((data as ChatMessage[]).findLastIndex(m => matchesUser(m, prompt)) + 1).some(m => m?.variant === 'ai')) output();
          const text = parseChat(data, prompt, isolated);
          if (text !== undefined && sendComplete) { if (ownsConversation) this.conversations.set(key, file); return { text }; }
        }
        if (!sawUser && Date.now() - sentAt > 10000) throw new SourceError('upstream', 'Freebuff did not persist a user turn within 10 seconds; run freebuff doctor and check login or startup prompts');
        await delay(this.options.poll ?? 200, undefined, { signal });
      }
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Freebuff request cancelled during shutdown');
      if (signal.aborted) throw replayTimeout(`Freebuff timed out after ${timeout}ms; check freebuff login and your free-hours balance`, !dispatched);
      if (error instanceof SourceError && partial && !isolated) error.output = partial;
      if (dispatched) throw preventReplay(error, 'Freebuff failed after sending the prompt');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `Freebuff failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      try { await this.mux.stop(id); }
      finally {
        // An unassociated process must be stopped before another one can start.
        releaseCreation(); this.sessions.delete(id);
        if (acquired) pool.release();
        if (ownsConversation) this.busy.delete(key);
      }
    }
  }
  private async chatFiles(dir: string): Promise<string[]> {
    try { return (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(dir, d.name, 'chat-messages.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async close() { this.shutdown.abort(); await Promise.all([...this.sessions].map(id => this.mux.stop(id))); await this.mux.close?.(); }
}
