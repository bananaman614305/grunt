import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { setImmediate as metadataTurn } from 'node:timers/promises';
import { taskTurns } from './harness.js';
import { SourceError, answeredBy, needsFunctionTools, toolCapable, NO_TOOL_SOURCE } from './source.js';
import type { Completion, ErrorCode, ModelRequest, Source } from './source.js';
import type { Adapter, Registry } from '../registry.js';
import { knownAdapters } from '../registry.js';
import { SourceStatus } from './source-status.js';
import { SourceAvailability } from './source-availability.js';
import type { DiagnosticEvent } from './diagnostics.js';
import type { RoutingWorkload } from './routing-history.js';
import { RETIRE_AFTER_FAILURES, localRequestRefusal, routingWorkload, upstreamRetryHint, withRoutingWorkload } from './routing-history.js';

const exec = promisify(execFile);
const DEFAULT_FAILURE_COOLDOWN_SECONDS = 15 * 60;
const BAD_SAMPLE_COOLDOWN_SECONDS = 30;
const MAX_UPSTREAM_RETRY_SECONDS = 24 * 60 * 60;
// The 5th consecutive identical failure, each within the routing-history window
// of the last, retires a route (docs/router.md). Quota is availability, not failure.
export { RETIRE_AFTER_FAILURES } from './routing-history.js';
// The scout marks an offering expiring or inactive, or its expiry day has passed.
export function scoutRetired(adapter: Adapter, now = Date.now()) {
  return adapter.status === 'expiring' || adapter.status === 'inactive'
    || adapter.expires !== undefined && now >= Date.parse(adapter.expires) + 24 * 60 * 60 * 1000;
}
// Routes worth opening, best first: great before possible, then by weight.
export function recommendedAdapters(registry: Registry, now = Date.now()) {
  const rank = (adapter: Adapter) => adapter.fit === 'great' ? 0 : 1;
  return registry.adapters.filter(adapter => adapter.fit !== 'poor' && !scoutRetired(adapter, now))
    .sort((a, b) => rank(a) - rank(b) || b.weight - a.weight);
}

// Registry feedback scales a route's draw from 0.5x (score 0) to 1.5x (score
// 100); a route without a score keeps its weight.
export function registryScoreFactor(score: number | null | undefined) {
  return typeof score === 'number' && Number.isFinite(score) ? 0.5 + Math.max(0, Math.min(100, score)) / 100 : 1;
}

export interface RoutingOptions { registry: () => Registry; localOptIns?: ReadonlySet<string>; unrouted?: ReadonlySet<string>; random?: () => number; now?: () => number; pending?: ReadonlySet<string>; disabled?: ReadonlySet<string>; observation?: SourceStatus; attempt?: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>; observe?: (source: string, reason: NonNullable<DiagnosticEvent['reason']>, skipped?: boolean) => void; dropped?: (source: string) => void }
interface Task {
  source?: string; original: string; output: string; checkpoint?: string; switched: boolean; busy: boolean;
  reassessment?: { from: string; source: string; samples: number; at: number };
  lastPerformanceSwitchAt?: number;
}
interface Candidate { source: Source; weight: number }
export class StickyRouter {
  private tasks = new Map<string, Task>();
  private bars = new Map<string, number>();
  private barFailures = new Map<string, ErrorCode>();
  private barAt = new Map<string, number>();
  private observation: SourceStatus;
  private availability: SourceAvailability;
  private shutdown = new AbortController();
  private registryScore: ((id: string) => number | null | undefined) | undefined;
  constructor(private sources: Source[], private options: RoutingOptions) {
    this.observation = options.observation ?? new SourceStatus(sources.map(source => source.id), options.now);
    this.availability = new SourceAvailability(this.observation);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  useRegistryScores(score: (id: string) => number | null | undefined) { this.registryScore = score; }
  // Routes allowed their one half-open trial request right now (see claimTrial).
  private trials = new Set<string>();
  // Retired and not yet due for a trial. A retired route reopens after a bounded wait (15 min, doubling to
  // 4 h per failed trial) for a single real request; success clears it, failure extends the wait.
  retired(id: string) {
    const backoff = this.observation.routingBackoff(id);
    if (!backoff || backoff.streak < RETIRE_AFTER_FAILURES) return false;
    return this.now() < backoff.until;
  }
  // A due retired route whose single trial is already in flight.
  trialBusy(id: string) { return this.trials.has(id) && (this.observation.routingBackoff(id)?.streak ?? 0) >= RETIRE_AFTER_FAILURES; }
  // Synchronously claims the single trial of a due retired route; call it right after the retired() check
  // and before dispatch. Returns a release to call when the attempt has settled, or a no-op otherwise.
  claimTrial(id: string): () => void {
    const backoff = this.observation.routingBackoff(id);
    if (!backoff || backoff.streak < RETIRE_AFTER_FAILURES || this.trials.has(id)) return () => {};
    this.trials.add(id);
    return () => { this.trials.delete(id); };
  }
  needsHealthCheck(id: string) { return this.bars.get(id) === Infinity; }
  healthy(id: string) { if (this.bars.get(id) === Infinity) { this.bars.delete(id); this.barFailures.delete(id); } }
  verified(id: string) { this.bars.delete(id); this.barFailures.delete(id); this.barAt.delete(id); this.observation.clearRoutingBackoff(id); }
  cooldown(id: string) {
    let until = this.bars.get(id), code = this.barFailures.get(id);
    if (until !== undefined && Number.isFinite(until) && (this.observation.routingRecoveryAt(id) ?? 0) > (this.barAt.get(id) ?? Infinity)) {
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
  private benched(id: string) { return this.retired(id) || (this.cooldown(id)?.until ?? 0) > this.now(); }
  async recordFailure(id: string, failure: SourceError) {
    if (!this.registered(id) || failure.code === 'cancelled') return;
    // Our own bug or the request's shape, never provider health: no retirement count, no cooldown.
    if (localRequestRefusal(failure)) return;
    const wasBenched = this.benched(id);
    let until: number;
    if (failure.code === 'quota') {
      const seconds = failure.retryAfter ?? 3600;
      until = (await this.observation.failureBackoff(id, failure, seconds, false)).until;
    }
    else if (failure.code === 'logged_out' || failure.code === 'not_installed') until = Infinity;
    else {
      const status = failure.diagnostics?.httpStatus, retry = failure.retryAfter;
      const hasUpstreamHint = upstreamRetryHint(failure);
      // A reply that arrived but held an invalid function call is a bad
      // sample, not an outage; bench the source only briefly.
      const badSample = failure.code === 'upstream' && status === 200 && failure.diagnostics?.failureReason === 'response_tools';
      const seconds = hasUpstreamHint ? Math.min(MAX_UPSTREAM_RETRY_SECONDS, Math.max(1, retry ?? 1))
        : badSample ? BAD_SAMPLE_COOLDOWN_SECONDS : DEFAULT_FAILURE_COOLDOWN_SECONDS;
      until = (await this.observation.failureBackoff(id, failure, seconds, !hasUpstreamHint)).until;
    }
    this.barAt.set(id, this.observation.routingBackoff(id)?.at ?? this.now());
    this.bars.set(id, until); this.barFailures.set(id, this.observation.routingBackoff(id)?.code ?? failure.code);
    if (!wasBenched && this.benched(id)) try { this.options.dropped?.(id); } catch { /* Signup triggers cannot change routing. */ }
  }

  private registered(id: string) { return knownAdapters.has(id) || !!this.options.localOptIns?.has(id); }
  listed(id: string) { return this.registered(id) && this.options.registry().adapters.some(a => a.id === id && !scoutRetired(a, this.now())); }
  supportsInput(id: string, imageInput = false) {
    return this.registered(id) && this.options.registry().adapters.some(adapter => adapter.id === id && adapter.modalities.includes('text') && (!imageInput || adapter.modalities.includes('image')));
  }
  private async git(cwd: string, args: string[]) {
    return (await exec('git', ['-C', cwd, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  private async createTask(request: ModelRequest): Promise<Task> {
    const task: Task = { original: taskTurns(request).at(-1) ?? '', output: '', switched: false, busy: false };
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
  private fasterContinuation(task: Task, request: ModelRequest, candidates: Candidate[], adapters: Adapter[], workload: RoutingWorkload) {
    const reset = () => { delete task.reassessment; return undefined; };
    // Native agents retain private tool/session state. Only Pi tool routes carry
    // the complete continuation transcript across this safe request boundary.
    if (!needsFunctionTools(request) || this.sources.some(source => source.id === request.model)
      || task.lastPerformanceSwitchAt !== undefined && this.now() - task.lastPerformanceSwitchAt < 5 * 60 * 1000) return reset();
    const current = candidates.find(candidate => candidate.source.id === task.source);
    if (!current || !toolCapable(current.source) || this.observation.isBusy(current.source.id)) return reset();
    const currentAdapter = adapters.find(adapter => adapter.id === current.source.id);
    const estimate = this.observation.routingContinuationEstimate(current.source.id, workload);
    if (!estimate || currentAdapter?.kind !== 'model') return reset();
    // Budget twenty seconds for handoff/setup, plus one second per 4 KiB of
    // retransmitted context/cache loss. Require a 2x win even after this cost.
    const contextBytes = Buffer.byteLength(JSON.stringify([request.messages, request.tools]));
    const switchingMs = 20000 + Math.ceil(contextBytes / 4096) * 1000;
    let best: Candidate | undefined, bestMs = estimate.expectedMs / 2;
    for (const candidate of candidates) {
      const adapter = adapters.find(adapter => adapter.id === candidate.source.id);
      if (candidate === current || !toolCapable(candidate.source) || this.observation.isBusy(candidate.source.id)
        || adapter?.kind !== 'model' || adapter.fit === 'poor' || currentAdapter.fit === 'great' && adapter.fit !== 'great') continue;
      const alternate = this.observation.routingContinuationEstimate(candidate.source.id, workload);
      if (!alternate || alternate.reliability < .95 || alternate.reliability < estimate.reliability) continue;
      const expectedMs = alternate.expectedMs + switchingMs;
      if (expectedMs < bestMs) { best = candidate; bestMs = expectedMs; }
    }
    if (!best) return reset();
    const previous = task.reassessment;
    task.reassessment = { from: current.source.id, source: best.source.id, samples: estimate.samples, at: estimate.at };
    // Two separate successful-turn boundaries must support the same candidate.
    // Repeated routing-loop passes over unchanged observations are not evidence.
    if (!previous || previous.from !== current.source.id || previous.source !== best.source.id || estimate.samples < previous.samples || estimate.at <= previous.at) return;
    return best;
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    signal.throwIfAborted();
    await this.observation.refreshRoutingHistory();
    signal.throwIfAborted();
    const workload = routingWorkload(request);
    const cwd = await realpath(request.cwd);
    // An explicit source selection cannot inherit an automatic binding with the
    // same user turns (or another explicitly selected source's continuation).
    const explicit = this.sources.some(source => source.id === request.model);
    const key = createHash('sha256').update(JSON.stringify([cwd, taskTurns(request), request.publicContext, explicit ? request.model : null])).digest('hex');
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
    const attempted = new Set<string>();
    let yieldedMetadata = false;
    const observation = this.observation;
    const skip = (source: string, reason: NonNullable<DiagnosticEvent['reason']>) => this.options.observe?.(source, reason, true);
    try {
      for (;;) {
        signal.throwIfAborted();
        const adapters = this.options.registry().adapters.filter(a => this.registered(a.id) && a.modalities.includes('text') && (!request.imageInput || a.modalities.includes('image')));
        const eligible: Candidate[] = [];
        const unknown: Source[] = [];
        const retryTimes: number[] = [];
        for (const source of this.sources) {
          signal.throwIfAborted();
          // Sources outside the registry are never drawn or reported as skipped;
          // Sources.complete() offers them only as a last resort.
          if (this.options.unrouted?.has(source.id)) continue;
          const adapter = adapters.find(a => a.id === source.id);
          if (!task.source && this.sources.some(s => s.id === request.model) && source.id !== request.model) continue;
          if (!adapter || this.options.disabled?.has(source.id) || scoutRetired(adapter, this.now())) {
            skip(source.id, 'not_listed');
            continue;
          }
          if (source.acceptsRequest && !source.acceptsRequest(request)) {
            if (source.id === request.model) throw new SourceError('refused', `${source.id} requires approved request context`);
            skip(source.id, 'context_not_approved');
            continue;
          }
          if (this.options.pending?.has(source.id)) { skip(source.id, 'pending_setup'); continue; }
          if (toolsRequired && !toolCapable(source)) { skip(source.id, 'tools_unsupported'); continue; }
          if (this.retired(source.id) || this.trialBusy(source.id)) { skip(source.id, 'cooldown'); continue; }
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
          if (source.id === task.source || available === true) eligible.push({ source, weight: adapter.weight * observation.routingWeight(source.id, false, workload) * registryScoreFactor(this.registryScore?.(source.id)) });
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
        const boundMain = eligible.some(candidate => candidate.source.id === task.source);
        // A fallback (the bound source failed or is benched) prefers idle capacity like a first draw. Sources whose
        // admission metadata is still being fetched may be idle, so wait briefly for those checks (each is deadline
        // bounded) before sharing a source that is busy with another task. A healthy bound source never waits.
        if (!boundMain && task.source !== undefined && !idle.length && this.availability.hasPending()) { await this.availability.changed(signal); continue; }
        const ready = boundMain || !idle.length ? eligible : idle;
        let selected = ready.find(candidate => candidate.source.id === task.source);
        let performanceSwitch = false;
        if (selected && !attempted.size) {
          const faster = this.fasterContinuation(task, request, ready, adapters, workload);
          if (faster) { selected = faster; performanceSwitch = true; }
        }
        // A first request has no bound source; its draw is weighted, not sticky.
        const bound = selected !== undefined && selected.source.id === task.source;
        if (!selected) {
          let draw = (this.options.random ?? Math.random)() * ready.reduce((total, a) => total + a.weight, 0);
          selected = ready.find(a => (draw -= a.weight) < 0) ?? ready.at(-1)!;
        }
        const switched = task.switched || (!bound && task.source !== undefined);
        let release = () => {};
        try {
          // A provider with a request scope guard may only receive the client-approved
          // payload. Handoff would append an unchecked local diff and prior output.
          const input = switched && !selected.source.acceptsRequest ? await this.handoff({ ...request, cwd }, task) : { ...request, cwd };
          // Availability and handoff can yield while maintenance records a newer cooldown.
          if ((this.cooldown(selected.source.id)?.until ?? 0) > this.now()) {
            skip(selected.source.id, 'cooldown');
            continue;
          }
          signal.throwIfAborted();
          // Keep this check and attempt dispatch synchronous.
          const liveAdapter = this.options.registry().adapters.find(adapter => adapter.id === selected.source.id
            && this.registered(adapter.id) && adapter.modalities.includes('text') && (!request.imageInput || adapter.modalities.includes('image')));
          if (!liveAdapter || scoutRetired(liveAdapter, this.now()) || this.retired(selected.source.id) || this.trialBusy(selected.source.id) || this.options.disabled?.has(selected.source.id) || this.options.pending?.has(selected.source.id)
            || performanceSwitch && observation.isBusy(selected.source.id)) continue;
          release = this.claimTrial(selected.source.id);
          task.source = selected.source.id;
          task.switched = switched;
          if (performanceSwitch) { task.lastPerformanceSwitchAt = this.now(); delete task.reassessment; }
          attempted.add(selected.source.id);
          this.options.observe?.(selected.source.id, request.model === selected.source.id ? 'explicit' : task.switched ? 'fallback' : bound ? 'sticky' : 'weighted');
          const result = await withRoutingWorkload(workload, () => this.options.attempt ? this.options.attempt(selected.source, input, signal) : observation.complete(selected.source, input, signal));
          task.output = Buffer.from(result.text).subarray(-4096).toString('utf8'); task.switched = false;
          answeredBy.set(result, selected.source.id);
          return result;
        } catch (error) {
          signal.throwIfAborted();
          const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          if (failure.output) task.output = failure.output;
          if (failure.code === 'cancelled') throw failure;
          await this.recordFailure(selected.source.id, failure); task.switched = true;
        } finally { release(); }
      }
    } finally {
      task.busy = false;
      if (this.tasks.size > 1024) for (const [oldKey, oldTask] of this.tasks) {
        if (oldKey !== key && !oldTask.busy) { this.tasks.delete(oldKey); break; }
      }
    }
  }
  async close() {
    this.shutdown.abort(new SourceError('cancelled', 'Routing stopped'));
    await this.availability.close();
  }
}
