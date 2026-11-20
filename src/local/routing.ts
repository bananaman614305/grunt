import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { setImmediate as metadataTurn } from 'node:timers/promises';
import { userTurns } from './harness.js';
import { SourceError, answeredBy, needsFunctionTools, toolCapable, NO_TOOL_SOURCE } from './source.js';
import type { Completion, ErrorCode, ModelRequest, Source } from './source.js';
import type { Adapter, Registry } from '../registry.js';
import { disabledAdapters, knownAdapters } from '../registry.js';
import { SourceStatus } from './source-status.js';
import { SourceAvailability } from './source-availability.js';
import type { DiagnosticEvent } from './diagnostics.js';
import { routingWorkload, withRoutingWorkload } from './routing-history.js';

const exec = promisify(execFile);
const DEFAULT_FAILURE_COOLDOWN_SECONDS = 15 * 60;
const BAD_SAMPLE_COOLDOWN_SECONDS = 30;
const MAX_UPSTREAM_RETRY_SECONDS = 24 * 60 * 60;
export interface RoutingOptions { registry: () => Registry; localOptIns?: ReadonlySet<string>; random?: () => number; now?: () => number; pending?: ReadonlySet<string>; disabled?: ReadonlySet<string>; observation?: SourceStatus; attempt?: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>; observe?: (source: string, reason: NonNullable<DiagnosticEvent['reason']>, skipped?: boolean) => void }
interface Task { source?: string; original: string; output: string; checkpoint?: string; switched: boolean; busy: boolean }
export class StickyRouter {
  private tasks = new Map<string, Task>();
  private bars = new Map<string, number>();
  private barFailures = new Map<string, ErrorCode>();
  private barAt = new Map<string, number>();
  private observation: SourceStatus;
  private availability: SourceAvailability;
  private shutdown = new AbortController();
  constructor(private sources: Source[], private options: RoutingOptions) {
    this.observation = options.observation ?? new SourceStatus(sources.map(source => source.id), options.now);
    this.availability = new SourceAvailability(this.observation);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  needsHealthCheck(id: string) { return this.bars.get(id) === Infinity; }
  healthy(id: string) { if (this.bars.get(id) === Infinity) { this.bars.delete(id); this.barFailures.delete(id); } }
  verified(id: string) { this.bars.delete(id); this.barFailures.delete(id); this.barAt.delete(id); this.observation.clearRoutingBackoff(id); }
  cooldown(id: string) {
    let until = this.bars.get(id), code = this.barFailures.get(id);
    if (until !== undefined && Number.isFinite(until) && code !== 'quota' && (this.observation.routingRecoveryAt(id) ?? 0) > (this.barAt.get(id) ?? Infinity)) {
      this.bars.delete(id); this.barFailures.delete(id); this.barAt.delete(id); until = undefined; code = undefined;
    }
    const observedQuota = this.observation.quotaRetryAt(id);
    if (observedQuota !== undefined && (until === undefined || observedQuota >= until)) {
      return { until: observedQuota, code: 'quota' as const };
    }
    const persisted = this.observation.routingBackoff(id);
    if (persisted && (until === undefined || persisted.until >= until)) return { until: persisted.until, code: persisted.code };
    return until !== undefined ? { until, ...(code ? { code } : {}) } : undefined;
  }
  private registered(id: string) { return knownAdapters.has(id) || !!this.options.localOptIns?.has(id); }
  listed(id: string) { return this.registered(id) && this.options.registry().adapters.some(a => a.id === id); }
  supportsInput(id: string, imageInput = false) {
    return this.registered(id) && this.options.registry().adapters.some(adapter => adapter.id === id && adapter.modalities.includes('text') && (!imageInput || adapter.modalities.includes('image')));
  }
  private workerAdapter(adapter: Adapter) {
    return adapter.kind === 'model' && this.registered(adapter.id)
      && !disabledAdapters.has(adapter.id) && !this.options.disabled?.has(adapter.id);
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
  private exhausted(toolsRequired: boolean, retryTimes: number[]) {
    const now = this.now();
    const next = Math.min(...retryTimes);
    const seconds = Number.isFinite(next) && next > now ? Math.ceil((next - now) / 1000) : undefined;
    return new SourceError('quota', toolsRequired ? NO_TOOL_SOURCE : 'No eligible adapter is available; finish setup or retry after quota resets', seconds);
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    signal.throwIfAborted();
    await this.observation.refreshRoutingHistory();
    signal.throwIfAborted();
    const { worker, ...adapterRequest } = request;
    const workload = routingWorkload(request, !!worker);
    const cwd = worker ? request.cwd : await realpath(request.cwd);
    const key = worker ? `worker:${worker.id}` : createHash('sha256').update(JSON.stringify([cwd, userTurns(request), request.publicContext])).digest('hex');
    let task = this.tasks.get(key);
    if (!task) {
      // Reserve the task before asynchronous checkpoint creation to avoid two bindings.
      task = { original: '', output: '', switched: false, busy: true };
      this.tasks.set(key, task);
      if (!worker) Object.assign(task, await this.createTask({ ...adapterRequest, cwd }), { busy: true });
    } else {
      if (task.busy) throw new SourceError('upstream', 'A request for this task is already running; retry when it finishes');
      task.busy = true;
    }
    // A turn bound to a source without Pi tool support switches (with handoff)
    // when Pi attaches tools, unless the caller named that source explicitly.
    const toolsRequired = needsFunctionTools(request) && (!!worker || !this.sources.some(s => s.id === request.model));
    const attempted = new Set<string>();
    let yieldedMetadata = false;
    const observation = this.observation;
    const reportedSkips = worker ? new Set<string>() : undefined;
    const skip = (source: string, reason: NonNullable<DiagnosticEvent['reason']>) => {
      const key = `${source}:${reason}`;
      if (reportedSkips?.has(key)) return;
      reportedSkips?.add(key);
      this.options.observe?.(source, reason, true);
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        const adapters = this.options.registry().adapters.filter(a => this.registered(a.id) && a.modalities.includes('text') && (!request.imageInput || a.modalities.includes('image')));
        const eligible: { source: Source; weight: number }[] = [];
        const unknown: Source[] = [];
        const retryTimes: number[] = [];
        for (const source of this.sources) {
          signal.throwIfAborted();
          const adapter = adapters.find(a => a.id === source.id);
          if (!worker && !task.source && this.sources.some(s => s.id === request.model) && source.id !== request.model) continue;
          if (!adapter || this.options.disabled?.has(source.id) || worker && !this.workerAdapter(adapter)) {
            skip(source.id, 'not_listed');
            continue;
          }
          if (source.acceptsRequest && !source.acceptsRequest(request)) {
            if (!worker && source.id === request.model) throw new SourceError('refused', `${source.id} requires approved request context`);
            skip(source.id, 'context_not_approved');
            continue;
          }
          if (this.options.pending?.has(source.id)) { skip(source.id, 'pending_setup'); continue; }
          if (toolsRequired && !toolCapable(source)) { skip(source.id, 'tools_unsupported'); continue; }
          const until = this.cooldown(source.id)?.until;
          if (until !== undefined && until > this.now()) {
            if (Number.isFinite(until)) retryTimes.push(until);
            skip(source.id, 'cooldown');
            continue;
          }
          if (attempted.has(source.id)) {
            // This call cannot repeat this source. The next call can try it now.
            retryTimes.push(this.now());
            continue;
          }
          const available = this.availability.peek(source.id);
          if (source.id === task.source || available === true) eligible.push({ source, weight: adapter.weight * observation.routingWeight(source.id, !!worker, workload) });
          else if (available === undefined) unknown.push(source);
          else {
            // This live allowance check can discover a reset the router did not know at entry.
            const checkedUntil = this.cooldown(source.id)?.until;
            if (checkedUntil !== undefined && checkedUntil > this.now() && Number.isFinite(checkedUntil)) retryTimes.push(checkedUntil);
            skip(source.id, 'unavailable');
          }
        }
        signal.throwIfAborted();
        // At most four read-only admission checks run together. A ready source
        // can answer immediately while unrelated checks finish in the background.
        // Checks never replace the selected adapter's fresh dispatch guards.
        const startedChecks = this.availability.start(unknown);
        // Admit already-settled metadata before drawing (including a just-reset
        // quota), without waiting for network or a slow unrelated provider.
        if (eligible.length && startedChecks && !yieldedMetadata) {
          yieldedMetadata = true;
          await metadataTurn(undefined, { signal });
          continue;
        }
        if (!eligible.length) {
          if (this.availability.hasPending()) { await this.availability.changed(signal); continue; }
          throw this.exhausted(toolsRequired, retryTimes);
        }
        const idle = eligible.filter(candidate => !observation.isBusy(candidate.source.id));
        // Main requests may overlap a read-only/maintenance observation. They
        // prefer idle capacity but must not wait behind background work.
        const boundMain = !worker && eligible.some(candidate => candidate.source.id === task.source);
        const ready = boundMain ? eligible : worker || idle.length ? idle : eligible;
        if (worker && !ready.length) {
          try { worker?.onWait?.(); } catch { /* Status callbacks cannot change routing. */ }
          await observation.waitForIdle(eligible.map(candidate => candidate.source.id), signal);
          continue;
        }
        let selected = ready.find(candidate => candidate.source.id === task.source);
        const bound = !!selected;
        if (!selected) {
          let draw = (this.options.random ?? Math.random)() * ready.reduce((total, a) => total + a.weight, 0);
          selected = ready.find(a => (draw -= a.weight) < 0) ?? ready.at(-1)!;
        }
        const switched = task.switched || (!bound && task.source !== undefined);
        try {
          // A worker receives its entire scoped prompt at dispatch. Retrying it
          // does not need the working tree or output from the failed provider.
          // A provider with a request scope guard may only receive the client-approved
          // payload. Handoff would append an unchecked local diff and prior output.
          const input = switched && !worker && !selected.source.acceptsRequest ? await this.handoff({ ...adapterRequest, cwd }, task) : { ...adapterRequest, cwd };
          // Availability and handoff can yield while maintenance records a newer cooldown.
          if ((this.cooldown(selected.source.id)?.until ?? 0) > this.now()) {
            skip(selected.source.id, 'cooldown');
            continue;
          }
          signal.throwIfAborted();
          // Keep this check and attempt dispatch synchronous so workers cannot
          // race onto the same idle provider.
          const liveAdapter = this.options.registry().adapters.find(adapter => adapter.id === selected.source.id
            && this.registered(adapter.id) && adapter.modalities.includes('text') && (!request.imageInput || adapter.modalities.includes('image')));
          if (!liveAdapter || this.options.disabled?.has(selected.source.id) || this.options.pending?.has(selected.source.id)
            || worker && (observation.isBusy(selected.source.id) || !this.workerAdapter(liveAdapter))) continue;
          task.source = selected.source.id;
          task.switched = switched;
          attempted.add(selected.source.id);
          this.options.observe?.(selected.source.id, request.model === selected.source.id ? 'explicit' : task.switched ? 'fallback' : bound ? 'sticky' : 'weighted');
          try { worker?.onSource(selected.source.id); } catch { /* Status callbacks cannot change routing. */ }
          const result = await withRoutingWorkload(workload, () => this.options.attempt ? this.options.attempt(selected.source, input, signal) : observation.complete(selected.source, input, signal));
          task.output = Buffer.from(result.text).subarray(-4096).toString('utf8'); task.switched = false;
          answeredBy.set(result, selected.source.id);
          return result;
        } catch (error) {
          signal.throwIfAborted();
          const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          if (failure.output) task.output = failure.output;
          if (failure.code === 'cancelled') throw failure;
          let until: number;
          if (failure.code === 'quota') {
            const seconds = failure.retryAfter ?? 3600;
            until = (await observation.failureBackoff(selected.source.id, failure, seconds, false)).until;
          }
          else if (failure.code === 'logged_out' || failure.code === 'not_installed') until = Infinity;
          else {
            const status = failure.diagnostics?.httpStatus, retry = failure.retryAfter;
            const hasUpstreamHint = failure.code === 'upstream' && status !== undefined
              && Number.isInteger(status) && status >= 500 && status < 600
              && retry !== undefined && Number.isFinite(retry) && retry >= 0;
            // A reply that arrived but held an invalid function call is a bad
            // sample, not an outage; bench the source only briefly.
            const badSample = failure.code === 'upstream' && status === 200 && failure.diagnostics?.failureReason === 'response_tools';
            const seconds = hasUpstreamHint ? Math.min(MAX_UPSTREAM_RETRY_SECONDS, Math.max(1, retry))
              : badSample ? BAD_SAMPLE_COOLDOWN_SECONDS : DEFAULT_FAILURE_COOLDOWN_SECONDS;
            until = (await observation.failureBackoff(selected.source.id, failure, seconds, !hasUpstreamHint)).until;
          }
          this.barAt.set(selected.source.id, this.observation.routingBackoff(selected.source.id)?.at ?? this.now());
          this.bars.set(selected.source.id, until); this.barFailures.set(selected.source.id, failure.code); task.switched = true;
        }
      }
    } finally {
      task.busy = false;
      if (worker) this.tasks.delete(key);
      else if (this.tasks.size > 1024) for (const [oldKey, oldTask] of this.tasks) {
        if (oldKey !== key && !oldTask.busy) { this.tasks.delete(oldKey); break; }
      }
    }
  }
  async close() {
    this.shutdown.abort(new SourceError('cancelled', 'Routing stopped'));
    await this.availability.close();
  }
}
