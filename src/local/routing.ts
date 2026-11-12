import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { SourceError, answeredBy } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import type { Registry } from '../registry.js';
import { knownAdapters } from '../registry.js';

const exec = promisify(execFile);
export interface RoutingOptions { registry: () => Registry; random?: () => number; now?: () => number }
interface Task { source?: string; failures: number; original: string; output: string; checkpoint?: string; switched: boolean; busy: boolean }
export class StickyRouter {
  private tasks = new Map<string, Task>();
  private bars = new Map<string, number>();
  constructor(private sources: Source[], private options: RoutingOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  needsHealthCheck(id: string) { return this.bars.get(id) === Infinity; }
  healthy(id: string) { if (this.bars.get(id) === Infinity) this.bars.delete(id); }
  listed(id: string) { return knownAdapters.has(id) && this.options.registry().adapters.some(a => a.id === id); }
  private async git(cwd: string, args: string[]) {
    return (await exec('git', ['-C', cwd, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  private async createTask(request: ModelRequest): Promise<Task> {
    const task: Task = { failures: 0, original: userTurns(request).at(-1) ?? '', output: '', switched: false, busy: false };
    try { task.checkpoint = await this.git(request.cwd, ['stash', 'create']) || await this.git(request.cwd, ['rev-parse', 'HEAD']); }
    catch { /* Non-git and unborn directories use prompt/output handoff only. */ }
    return task;
  }
  private async handoff(request: ModelRequest, task: Task) {
    let work = '';
    if (task.checkpoint) {
      try {
        const status = await this.git(request.cwd, ['status', '--short']);
        const diff = await this.git(request.cwd, ['diff', task.checkpoint, '--']);
        work = `\nWorking tree status:\n${status}\nChanges since task start:\n${diff}\n`;
      } catch { work = '\nWorking tree snapshot unavailable. Inspect the current files before continuing.\n'; }
    }
    const prompt = `Original task:\n${task.original}\n${work}\nPrevious adapter output (last 4 KB):\n${Buffer.from(task.output).subarray(-4096).toString('utf8')}\nContinue this task from the current state. Do not restart.`;
    return { ...request, messages: [...request.messages, { role: 'user', content: prompt }], handoffPrompt: prompt };
  }
  private exhausted() {
    const times = [...this.bars.values()].filter(Number.isFinite);
    const seconds = times.length ? Math.max(1, Math.ceil((Math.min(...times) - this.now()) / 1000)) : undefined;
    return new SourceError('quota', 'No eligible adapter is available; finish setup or retry after quota resets', seconds);
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal.throwIfAborted();
    const cwd = await realpath(request.cwd);
    const key = createHash('sha256').update(JSON.stringify([cwd, userTurns(request)])).digest('hex');
    let task = this.tasks.get(key);
    if (!task) {
      // Reserve the task before asynchronous checkpoint creation to avoid two bindings.
      task = { failures: 0, original: '', output: '', switched: false, busy: true };
      this.tasks.set(key, task);
      Object.assign(task, await this.createTask({ ...request, cwd }), { busy: true });
    } else {
      if (task.busy) throw new SourceError('upstream', 'A request for this task is already running; retry when it finishes');
      task.busy = true;
    }
    try {
      for (;;) {
        signal.throwIfAborted();
        const adapters = this.options.registry().adapters.filter(a => knownAdapters.has(a.id) && a.modalities.includes('text') && (!request.imageInput || a.modalities.includes('image')));
        const eligible: { source: Source; weight: number }[] = [];
        for (const source of this.sources) {
          const adapter = adapters.find(a => a.id === source.id);
          if (!task.source && this.sources.some(s => s.id === request.model) && source.id !== request.model) continue;
          if (!adapter || (this.bars.get(source.id) ?? 0) > this.now()) continue;
          if (source.id === task.source || await source.available().catch(() => false)) eligible.push({ source, weight: adapter.weight });
        }
        signal.throwIfAborted();
        let selected = eligible.find(candidate => candidate.source.id === task.source);
        if (!selected) {
          if (!eligible.length) throw this.exhausted();
          let draw = (this.options.random ?? Math.random)() * eligible.reduce((total, a) => total + a.weight, 0);
          selected = eligible.find(a => (draw -= a.weight) < 0) ?? eligible.at(-1)!;
          if (task.source) task.switched = true;
          task.source = selected.source.id; task.failures = 0;
        }
        try {
          const input = task.switched ? await this.handoff({ ...request, cwd }, task) : { ...request, cwd };
          const result = await selected.source.complete(input, signal);
          task.failures = 0; task.output = Buffer.from(result.text).subarray(-4096).toString('utf8'); task.switched = false;
          answeredBy.set(result, selected.source.id);
          return result;
        } catch (error) {
          signal.throwIfAborted();
          const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          if (failure.output) task.output = failure.output;
          if (failure.code === 'cancelled' || failure.code === 'refused') throw failure;
          let until: number;
          if (failure.code === 'quota') until = this.now() + (failure.retryAfter ?? 3600) * 1000;
          else if (failure.code === 'logged_out' || failure.code === 'not_installed') until = Infinity;
          else { task.failures++; if (task.failures < 3) throw failure; until = this.now() + 15 * 60 * 1000; }
          this.bars.set(selected.source.id, until); task.switched = true;
        }
      }
    } finally {
      task.busy = false;
      if (this.tasks.size > 1024) for (const [oldKey, oldTask] of this.tasks) {
        if (oldKey !== key && !oldTask.busy) { this.tasks.delete(oldKey); break; }
      }
    }
  }
}
