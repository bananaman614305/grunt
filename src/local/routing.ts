import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { userTurns } from './harness.js';
import { SourceError, answeredBy, needsFunctionTools, toolCapable, NO_TOOL_SOURCE } from './source.js';
import type { Completion, ErrorCode, ModelRequest, Source } from './source.js';
import type { Registry } from '../registry.js';
import { knownAdapters } from '../registry.js';
import type { SourceStatus } from './source-status.js';
import type { DiagnosticEvent } from './diagnostics.js';

const exec = promisify(execFile);
export interface RoutingOptions { registry: () => Registry; random?: () => number; now?: () => number; pending?: ReadonlySet<string>; observation?: SourceStatus; attempt?: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>; observe?: (source: string, reason: NonNullable<DiagnosticEvent['reason']>, skipped?: boolean) => void }
interface Task { source?: string; original: string; output: string; checkpoint?: string; switched: boolean; busy: boolean }
export class StickyRouter {
  private tasks = new Map<string, Task>();
  private bars = new Map<string, number>();
  private barFailures = new Map<string, ErrorCode>();
  constructor(private sources: Source[], private options: RoutingOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  needsHealthCheck(id: string) { return this.bars.get(id) === Infinity; }
  healthy(id: string) { if (this.bars.get(id) === Infinity) { this.bars.delete(id); this.barFailures.delete(id); } }
  verified(id: string) { this.bars.delete(id); this.barFailures.delete(id); }
  cooldown(id: string) {
    const until = this.bars.get(id), code = this.barFailures.get(id);
    return until !== undefined ? { until, ...(code ? { code } : {}) } : undefined;
  }
  listed(id: string) { return knownAdapters.has(id) && this.options.registry().adapters.some(a => a.id === id); }
  supportsInput(id: string, imageInput = false) {
    return knownAdapters.has(id) && this.options.registry().adapters.some(adapter => adapter.id === id && adapter.modalities.includes('text') && (!imageInput || adapter.modalities.includes('image')));
  }
  private async git(cwd: string, args: string[]) {
    return (await exec('git', ['-C', cwd, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  private async createTask(request: ModelRequest): Promise<Task> {
    const task: Task = { original: userTurns(request).at(-1) ?? '', output: '', switched: false, busy: false };
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
  private exhausted(toolsRequired = false) {
    const times = [...this.bars.entries()].filter(([id, until]) => Number.isFinite(until)
      && (!toolsRequired || this.sources.some(source => source.id === id && toolCapable(source)))).map(([, until]) => until);
    const seconds = times.length ? Math.max(1, Math.ceil((Math.min(...times) - this.now()) / 1000)) : undefined;
    return new SourceError('quota', toolsRequired ? NO_TOOL_SOURCE : 'No eligible adapter is available; finish setup or retry after quota resets', seconds);
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal.throwIfAborted();
    const cwd = await realpath(request.cwd);
    const key = createHash('sha256').update(JSON.stringify([cwd, userTurns(request)])).digest('hex');
    let task = this.tasks.get(key);
    if (!task) {
      // Reserve the task before asynchronous checkpoint creation to avoid two bindings.
      task = { original: '', output: '', switched: false, busy: true };
      this.tasks.set(key, task);
      Object.assign(task, await this.createTask({ ...request, cwd }), { busy: true });
    } else {
      if (task.busy) throw new SourceError('upstream', 'A request for this task is already running; retry when it finishes');
      task.busy = true;
    }
    // A turn bound to a source without Pi tool support switches (with handoff)
    // when Pi attaches tools, unless the caller named that source explicitly.
    const toolsRequired = needsFunctionTools(request) && !this.sources.some(s => s.id === request.model);
    try {
      for (;;) {
        signal.throwIfAborted();
        const adapters = this.options.registry().adapters.filter(a => knownAdapters.has(a.id) && a.modalities.includes('text') && (!request.imageInput || a.modalities.includes('image')));
        const eligible: { source: Source; weight: number }[] = [];
        for (const source of this.sources) {
          const adapter = adapters.find(a => a.id === source.id);
          if (!task.source && this.sources.some(s => s.id === request.model) && source.id !== request.model) continue;
          if (!adapter) { this.options.observe?.(source.id, 'not_listed', true); continue; }
          if (this.options.pending?.has(source.id)) { this.options.observe?.(source.id, 'pending_setup', true); continue; }
          if ((this.bars.get(source.id) ?? 0) > this.now()) { this.options.observe?.(source.id, 'cooldown', true); continue; }
          if (toolsRequired && !toolCapable(source)) { this.options.observe?.(source.id, 'tools_unsupported', true); continue; }
          if (source.id === task.source || await (this.options.observation ? this.options.observation.available(source) : source.available()).catch(() => false)) eligible.push({ source, weight: adapter.weight });
          else this.options.observe?.(source.id, 'unavailable', true);
        }
        signal.throwIfAborted();
        let selected = eligible.find(candidate => candidate.source.id === task.source);
        const bound = !!selected;
        if (!selected) {
          if (!eligible.length) throw this.exhausted(toolsRequired);
          let draw = (this.options.random ?? Math.random)() * eligible.reduce((total, a) => total + a.weight, 0);
          selected = eligible.find(a => (draw -= a.weight) < 0) ?? eligible.at(-1)!;
          if (task.source) task.switched = true;
          task.source = selected.source.id;
        }
        try {
          this.options.observe?.(selected.source.id, request.model === selected.source.id ? 'explicit' : task.switched ? 'fallback' : bound ? 'sticky' : 'weighted');
          const input = task.switched ? await this.handoff({ ...request, cwd }, task) : { ...request, cwd };
          const result = await (this.options.attempt ? this.options.attempt(selected.source, input, signal) : this.options.observation ? this.options.observation.complete(selected.source, input, signal) : selected.source.complete(input, signal));
          task.output = Buffer.from(result.text).subarray(-4096).toString('utf8'); task.switched = false;
          answeredBy.set(result, selected.source.id);
          return result;
        } catch (error) {
          signal.throwIfAborted();
          const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          if (failure.output) task.output = failure.output;
          if (failure.code === 'cancelled') throw failure;
          let until: number;
          if (failure.code === 'quota') until = this.now() + (failure.retryAfter ?? 3600) * 1000;
          else if (failure.code === 'logged_out' || failure.code === 'not_installed') until = Infinity;
          // Any other failure moves this task to the next source now, so the request still gets an answer.
          else until = this.now() + 15 * 60 * 1000;
          this.bars.set(selected.source.id, until); this.barFailures.set(selected.source.id, failure.code); task.switched = true;
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
