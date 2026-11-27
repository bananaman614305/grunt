import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { setImmediate as metadataTurn } from 'node:timers/promises';
import { taskTurns } from './harness.js';
import { Sources, RequestError, SourceError, answeredBy, bridgedTools, canReplay, hasImageInput, needsFunctionTools, toolCapable, withAttemptStream, NO_TOOL_SOURCE } from './source.js';
import type { Completion, ErrorCode, ModelRequest, SlowUpstreamPolicy, Source } from './source.js';
import type { Adapter, Registry } from '../registry.js';
import { knownAdapters, TIER_TOTALS } from '../registry.js';
import { SourceStatus } from './source-status.js';
import { SourceAvailability } from './source-availability.js';
import { currentDiagnosticContext, observeRequestPhase, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticEvent } from './diagnostics.js';
import type { RoutingWorkload } from './routing-history.js';
import { RETIRE_AFTER_FAILURES, activeRoutingWorkload, toolHold, generalHold, recoveryDeadline, localRequestRefusal, currentRoutingWorkload, slowUpstreamFailure, upstreamRetryHint, withRoutingWorkload } from './routing-history.js';

const exec = promisify(execFile);
const DEFAULT_FAILURE_COOLDOWN_SECONDS = 15 * 60;
const DEFAULT_SLOW_UPSTREAM = { baseSeconds: 300, maxSeconds: 7200 };
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

// A request with function tools draws from sources that call tools through the provider's own interface before it
// draws from JSON-bridged ones (Source.jsonToolBridge), whose model is only asked, in prose, to answer with a tool
// envelope and may decline. Only the draw set narrows: weights, consent, quota and cooldowns are untouched, and a
// bridged source still serves when no native tool source is eligible. See docs/router.md.
export const NATIVE_TOOL_SOURCES_FIRST = true;
// A first draw whose ready sources are all busy waits at most this long for the admission checks of sources that
// may be idle (a fallback waits for them as long as they run). Probes take 0.1 to 2.5 s; each is bounded at 5 s.
export const FIRST_DRAW_IDLE_WAIT_MS = 3000;
// An image-capable source benched for longer than this no longer keeps the image in the conversation (see imageUsable).
export const IMAGE_WAIT_SECONDS = 300;

export const HEDGE_AFTER_MS = 8000;
const backupUnavailable = Symbol('backup eligibility changed');
const attemptProgress = new AsyncLocalStorage<{ commit: () => boolean; progress: () => void }>();
export const acceptRoutingCompletion = () => attemptProgress.getStore()?.commit() ?? true;
export const routingOutputProgress = () => attemptProgress.getStore()?.progress;

export interface RoutingOptions { hedgeAfterMs?: number; scheduleRecovery?: (id: string, at: number) => void; registry: () => Registry; localOptIns?: ReadonlySet<string>; unrouted?: ReadonlySet<string>; random?: () => number; now?: () => number; pending?: ReadonlySet<string>; disabled?: ReadonlySet<string>; observation?: SourceStatus; attempt?: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>; observe?: (source: string, reason: NonNullable<DiagnosticEvent['reason']>, skipped?: boolean) => void; observeEligible?: (source: string, at: number) => void; dropped?: (source: string) => void }
interface Task {
  source?: string; original: string; output: string; checkpoint?: string; switched: boolean; busy: boolean;
  reassessment?: { from: string; source: string; samples: number; at: number };
  lastPerformanceSwitchAt?: number;
}
interface Candidate { source: Source; adapter: Adapter; weight: number }
export class StickyRouter {
  private tasks = new Map<string, Task>();
  private barFailures = new Map<string, ErrorCode>();
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
  // Sources a task has drawn and not yet finished with. A draw claims its source in the same tick, before
  // any await (handoff) and for the whole attempt, so concurrent new tasks see it as busy and spread out.
  private reservations = new Map<string, number>();
  // True while a request is active on the source or another selection holds it. `own` discounts the
  // caller's own reservation.
  busy(id: string, own = 0) { return this.observation.isBusy(id) || (this.reservations.get(id) ?? 0) > own; }
  private reserve(id: string): () => void {
    this.reservations.set(id, (this.reservations.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.reservations.get(id) ?? 1) - 1;
      if (left > 0) this.reservations.set(id, left); else this.reservations.delete(id);
    };
  }
  // Retired and not yet due for a trial. A retired route reopens after a bounded wait (15 min, doubling to
  // 4 h per failed trial) for a single real request; success clears it, failure extends the wait.
  private applicableTool(id: string) {
    return activeRoutingWorkload()?.endsWith('-text') ? undefined : toolHold(this.observation.routingBackoff(id));
  }
  retired(id: string) {
    const general = generalHold(this.observation.routingBackoff(id)), tool = this.applicableTool(id);
    return [general, tool].some(hold => hold && hold.streak >= RETIRE_AFTER_FAILURES && hold.until > this.now());
  }
  // A due retired route whose single trial is already in flight.
  trialBusy(id: string) { return this.dueTrial(id) && (this.trials.has(id) || this.observation.isBusy(id)); }
  // Synchronously claims the single trial of a due retired route; call it right after the retired() check
  // and before dispatch. Returns a release to call when the attempt has settled, or a no-op otherwise.
  claimTrial(id: string): () => void {
    if (!this.dueTrial(id) || this.trials.has(id)) return () => {};
    this.trials.add(id);
    return () => { this.trials.delete(id); };
  }
  private dueTrial(id: string) {
    const general = generalHold(this.observation.routingBackoff(id)), tool = this.applicableTool(id);
    return Math.max(general?.streak ?? 0, tool?.streak ?? 0) >= RETIRE_AFTER_FAILURES;
  }
  private awaitingProbe(id: string) {
    return this.dueTrial(id) || this.observation.schedulesRecovery && !!(generalHold(this.observation.routingBackoff(id)) || this.applicableTool(id));
  }
  needsHealthCheck(id: string) { return this.barFailures.has(id); }
  healthy(id: string) { this.barFailures.delete(id); }
  nextRecoveryAt(id: string) {
    const hold = this.observation.routingBackoff(id);
    return hold && recoveryDeadline(hold, this.observation.quotaRetryAt(id));
  }
  private scheduleRecovery(id: string) {
    const next = this.nextRecoveryAt(id);
    if (next !== undefined) this.options.scheduleRecovery?.(id, next);
  }
  needsToolProbe(id: string) {
    const tool = toolHold(this.observation.routingBackoff(id));
    return tool !== undefined && tool.until <= this.now();
  }
  verified(id: string, provedTools = false) {
    this.barFailures.delete(id);
    this.observation.clearRoutingBackoff(id, provedTools);
    this.scheduleRecovery(id);
  }
  cooldown(id: string, _clearRecovered = true) {
    const bar = this.barFailures.get(id);
    if (bar) return { until: Infinity, code: bar };
    const general = generalHold(this.observation.routingBackoff(id));
    const tool = this.applicableTool(id);
    const until = Math.max(general?.until ?? 0, tool?.until ?? 0);
    const quota = this.observation.quotaRetryAt(id);
    if (quota !== undefined && quota >= until) return { until: quota, code: 'quota' as const };
    if (general && general.until >= (tool?.until ?? 0)) return { until: general.until, code: general.code };
    if (tool) return { until: tool.until, code: 'upstream' as const };
  }
  private benched(id: string) { return this.retired(id) || (this.cooldown(id)?.until ?? 0) > this.now(); }
  // Consecutive slow upstream failures per source (SlowUpstreamPolicy). A success since the last one resets the
  // count; a failure inside the cooldown it earned (a parallel straggler) is the same episode and does not escalate.
  private slow = new Map<string, { count: number; at: number; until: number }>();
  private slowUpstreamSeconds(id: string, policy: SlowUpstreamPolicy) {
    const at = this.now(), previous = this.slow.get(id);
    const fresh = !previous || (this.observation.routingRecoveryAt(id) ?? 0) > previous.at;
    if (previous && !fresh && at < previous.until) return Math.max(1, Math.ceil((previous.until - at) / 1000));
    const count = fresh ? 1 : previous.count + 1;
    const seconds = Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** Math.min(count - 1, 20));
    this.slow.set(id, { count, at, until: at + seconds * 1000 });
    return seconds;
  }
  async recordFailure(id: string, failure: SourceError, toolProbe = false) {
    if (!this.registered(id) || failure.code === 'cancelled') return;
    // Our own bug or the request's shape, never provider health: no retirement count, no cooldown.
    if (localRequestRefusal(failure)) return;
    const wasBenched = this.benched(id);
    if (failure.code === 'quota') {
      const seconds = failure.retryAfter ?? 3600;
      await this.observation.failureBackoff(id, failure, seconds, false, toolProbe);
    }
    else if (failure.code === 'logged_out' || failure.code === 'not_installed') {
      this.barFailures.set(id, failure.code);
      const tool = toolHold(this.observation.routingBackoff(id));
      if (toolProbe && tool && tool.streak >= RETIRE_AFTER_FAILURES && tool.until <= this.now()) {
        await this.observation.failureBackoff(id, failure, 0, false, true);
      }
    }
    else {
      const status = failure.diagnostics?.httpStatus, retry = failure.retryAfter;
      const hasUpstreamHint = upstreamRetryHint(failure);
      // A reply that arrived but held an invalid function call is a bad
      // sample, not an outage; bench the source only briefly.
      const badSample = failure.code === 'upstream' && status === 200 && failure.diagnostics?.failureReason === 'response_tools';
      const policy = hasUpstreamHint || badSample || !slowUpstreamFailure(failure) ? undefined : this.sources.find(source => source.id === id)?.slowUpstream ?? DEFAULT_SLOW_UPSTREAM;
      const seconds = hasUpstreamHint ? Math.min(MAX_UPSTREAM_RETRY_SECONDS, Math.max(1, retry ?? 1))
        : badSample ? BAD_SAMPLE_COOLDOWN_SECONDS : policy ? this.slowUpstreamSeconds(id, policy) : DEFAULT_FAILURE_COOLDOWN_SECONDS;
      // The policy already scales its own delay across consecutive slow failures of any kind.
      await this.observation.failureBackoff(id, failure, seconds, !hasUpstreamHint && !policy, toolProbe);
    }
    this.scheduleRecovery(id);
    if (!wasBenched && this.benched(id)) try { this.options.dropped?.(id); } catch { /* Signup triggers cannot change routing. */ }
  }

  auditAdapters() {
    return this.options.registry().adapters.map(({ id, tier, status, expires }) => ({ id, tier, status, expires }));
  }
  registered(id: string) {
    if (knownAdapters.has(id) || this.options.localOptIns?.has(id)) return true;
    const adapter = this.options.registry().adapters.find(item => item.id === id);
    return adapter?.install === 'declarative:openai' && adapter.declarative !== undefined;
  }
  listed(id: string) { return this.registered(id) && this.options.registry().adapters.some(a => a.id === id && !scoutRetired(a, this.now())); }
  supportsInput(id: string, imageInput = false) {
    return this.registered(id) && this.options.registry().adapters.some(adapter => adapter.id === id && adapter.modalities.includes('text') && (!imageInput || adapter.modalities.includes('image')));
  }
  // An adapter that lists image input in the current registry, whatever its state right now.
  private imageListed(id: string) {
    return this.registered(id) && this.options.registry().adapters.some(adapter => adapter.id === id && adapter.modalities.includes('text') && adapter.modalities.includes('image') && !scoutRetired(adapter, this.now()));
  }
  // An image-capable source that can serve soon: listed, set up, not retired, and not benched longer than
  // IMAGE_WAIT_SECONDS. The caller keeps the image for it (a short wait or a true 429 retry is honest); beyond that
  // the conversation is better served as text now than held for a source that is gone for hours.
  imageUsable(id: string) {
    if (!this.imageListed(id) || this.options.disabled?.has(id) || this.options.pending?.has(id) || this.retired(id)) return false;
    const until = this.cooldown(id)?.until;
    return until === undefined || until <= this.now() + IMAGE_WAIT_SECONDS * 1000;
  }
  private async git(cwd: string, args: string[], signal: AbortSignal) {
    return (await exec('git', ['-C', cwd, ...args], { signal, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  private async createTask(request: ModelRequest, signal: AbortSignal): Promise<Task> {
    const task: Task = { original: taskTurns(request).at(-1) ?? '', output: '', switched: false, busy: false };
    try { task.checkpoint = await this.git(request.cwd, ['stash', 'create'], signal) || await this.git(request.cwd, ['rev-parse', 'HEAD'], signal); }
    catch { /* Non-git and unborn directories use prompt/output handoff only. */ }
    return task;
  }
  private async handoff(request: ModelRequest, task: Task, signal: AbortSignal) {
    let work = '';
    if (task.checkpoint) {
      try {
        const status = await this.git(request.cwd, ['status', '--short'], signal);
        const diff = await this.git(request.cwd, ['diff', task.checkpoint, '--'], signal);
        work = `\nWorking tree status:\n${status}\nChanges since task start:\n${diff}\n`;
      } catch { work = '\nWorking tree snapshot unavailable. Inspect the current files before continuing.\n'; }
    }
    const prompt = `Original task:\n${task.original}\n${work}\nPrevious adapter output (last 4 KB):\n${Buffer.from(task.output).subarray(-4096).toString('utf8')}\nContinue this task from the current state. Do not restart.`;
    return { ...request, messages: [...request.messages, { role: 'user', content: prompt }], handoffPrompt: prompt };
  }
  private exhausted(toolsRequired: boolean, retryTimes: number[], refused = 0, transient = true) {
    const now = this.now();
    const next = Math.min(...retryTimes);
    const seconds = Number.isFinite(next) && next > now ? Math.ceil((next - now) / 1000) : undefined;
    // Sources that refused the request's own shape never contacted a provider and are not rate limited. Say
    // so, and when nothing is merely waiting (cooling, limited, busy, pending, failed this call), answer as an
    // invalid request rather than a quota wait. Any transient source keeps the retryable error.
    if (refused) {
      const detail = `${refused} adapter${refused === 1 ? '' : 's'} refused this conversation's tool definitions or tool history locally, before any provider was contacted`;
      return !transient
        ? new RequestError(`${detail}, and no other tool-capable adapter is available; this request cannot be served as sent`)
        : new SourceError('quota', `${detail}; the other tool-capable adapters are cooling down or limited; retry after the reset`, seconds);
    }
    return new SourceError('quota', toolsRequired ? NO_TOOL_SOURCE : 'No eligible adapter is available; finish setup or retry after quota resets', seconds);
  }
  private fasterContinuation(task: Task, request: ModelRequest, candidates: Candidate[], adapters: Adapter[], workload: RoutingWorkload) {
    const reset = () => { delete task.reassessment; return undefined; };
    // Native agents retain private tool/session state. Only function-tool routes carry
    // the complete continuation transcript across this safe request boundary.
    if (!needsFunctionTools(request) || this.sources.some(source => source.id === request.model)
      || task.lastPerformanceSwitchAt !== undefined && this.now() - task.lastPerformanceSwitchAt < 5 * 60 * 1000) return reset();
    const current = candidates.find(candidate => candidate.source.id === task.source);
    if (!current || !toolCapable(current.source) || this.busy(current.source.id)) return reset();
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
      if (candidate === current || !toolCapable(candidate.source) || this.busy(candidate.source.id)
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
  private raceAttempts(primary: Source, signal: AbortSignal, backup: () => Source | undefined,
    run: (source: Source, signal: AbortSignal) => Promise<Completion>, bind: (source: Source) => void,
    releasePrimary: () => void, fail: (source: Source, failure: SourceError) => Promise<void>, hedge: boolean) {
    if (!hedge) return run(primary, signal).catch(async error => {
      signal.throwIfAborted();
      const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
      await fail(primary, failure);
      throw failure;
    });
    return new Promise<Completion>((resolve, reject) => {
      const active = new Map<Source, { controller: AbortController; release: () => void }>();
      let winner: Source | undefined;
      let replayBarrier: SourceError | undefined;
      let done = false;
      const stop = (source: Source) => {
        const attempt = active.get(source);
        active.delete(source);
        attempt?.controller.abort(signal.aborted ? signal.reason : new SourceError('cancelled', 'Another route answered'));
        attempt?.release();
      };
      const finish = () => {
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        for (const source of active.keys()) stop(source);
      };
      const abort = () => { finish(); reject(signal.reason); };
      const launch = async (source: Source, release: () => void) => {
        const controller = new AbortController();
        active.set(source, { controller, release });
        const commit = () => {
          if (done || controller.signal.aborted || !active.has(source)) return false;
          if (!winner) {
            winner = source;
            clearTimeout(timer);
            bind(source);
            for (const other of active.keys()) if (other !== source) stop(other);
          }
          return winner === source;
        };
        try {
          const result = await attemptProgress.run({ commit, progress: () => clearTimeout(timer) }, () => Sources.withStreamTextGate(commit, () => run(source, controller.signal)));
          if (commit()) { active.delete(source); resolve(result); finish(); }
        } catch (error) {
          if (done || controller.signal.aborted) return;
          const failure = error === backupUnavailable ? new SourceError('cancelled', 'Backup eligibility changed') : error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          clearTimeout(timer);
          active.delete(source);
          release();
          // An already dispatched sibling can finish. Keep an unsafe error to
          // prevent a new dispatch if both attempts ultimately fail.
          if (error !== backupUnavailable && !canReplay(failure)) replayBarrier ??= failure;
          const terminal = !!winner || !active.size;
          if (terminal) finish();
          try { await fail(source, failure); }
          catch (storageError) { finish(); reject(storageError); return; }
          if (terminal) reject(replayBarrier ?? failure);
        } finally { release(); }
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        try {
          const source = backup();
          if (source) void launch(source, this.reserve(source.id));
        } catch { /* An unavailable backup leaves the primary running. */ }
      }, this.options.hedgeAfterMs ?? HEDGE_AFTER_MS);
      void launch(primary, releasePrimary);
    });
  }
  async complete(request: ModelRequest, signal: AbortSignal, fallback?: (reason: SourceError, signal: AbortSignal) => Promise<Completion>, skipped = new Map<string, string>()): Promise<Completion> {
    return withRoutingWorkload(currentRoutingWorkload(request), () => this.route(request, signal, fallback, skipped));
  }
  private async route(request: ModelRequest, signal: AbortSignal, fallback: ((reason: SourceError, signal: AbortSignal) => Promise<Completion>) | undefined, skipped: Map<string, string>): Promise<Completion> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    signal.throwIfAborted();
    await this.observation.refreshRoutingHistory();
    signal.throwIfAborted();
    const workload = currentRoutingWorkload(request);
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
      Object.assign(task, await this.createTask({ ...request, cwd }, signal), { busy: true });
    } else {
      if (task.busy) throw new SourceError('upstream', 'A request for this task is already running; retry when it finishes');
      task.busy = true;
    }
    // A turn bound to a source without function-tool support switches (with handoff)
    // when the client attaches tools, unless the caller named that source explicitly.
    const toolsRequired = needsFunctionTools(request) && !explicit;
    const imageRequest = hasImageInput(request);
    const attempted = new Set<string>(), refused = new Set<string>();
    let imageRefusal: SourceError | undefined;
    const observedEligible = new Set<string>();
    const checking = new Map<string, Source>();
    const context = currentDiagnosticContext(), observeEligible = this.options.observeEligible;
    const reportEligible = (id: string, at: number) => {
      if (!context?.sink || !observeEligible || observedEligible.has(id)) return;
      observedEligible.add(id);
      withDiagnosticContext(context, () => observeEligible(id, at));
    };
    let hedged = false;
    let yieldedMetadata = false, idleWaitEnds: number | undefined;
    const observation = this.observation;
    const skip = (source: string, reason: NonNullable<DiagnosticEvent['reason']>) => {
      this.options.observe?.(source, reason, true);
      const code = reason === 'cooldown' || reason === 'retired' ? this.cooldown(source)?.code : undefined;
      const detail = observation.routeSkip(source, reason, code);
      if (detail) skipped.set(source, detail);
    };
    const dispatchBlockReason = (id: string): DiagnosticEvent['reason'] => {
      const adapter = this.options.registry().adapters.find(a => a.id === id
        && this.registered(a.id));
      if (!adapter) return 'not_listed';
      if (!adapter.modalities.includes('text') || imageRequest && !adapter.modalities.includes('image')) return 'input_unsupported';
      if (scoutRetired(adapter, this.now()) || this.retired(id)) return 'retired';
      if (this.trialBusy(id)) return 'trial_in_progress';
      if (this.options.disabled?.has(id)) return 'disabled';
      if (this.options.pending?.has(id)) return 'pending_setup';
    };
    // Subscribe per request so a shared availability probe can identify
    // eligible backups while the current attempt is still running.
    const stopObserving = context?.sink && observeEligible ? observation.observePositiveAvailability((id, at) => {
      const source = checking.get(id);
      if (!source || signal.aborted || attempted.has(id) || dispatchBlockReason(id)
        || (this.cooldown(id)?.until ?? 0) > at || source.acceptsRequest && !source.acceptsRequest(request)) return;
      reportEligible(id, at);
    }) : undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        const registered = this.options.registry().adapters.filter(a => this.registered(a.id));
        const adapters = registered.filter(a => a.modalities.includes('text') && (!imageRequest || a.modalities.includes('image')));
        let eligible: Candidate[] = [];
        const unknown: Source[] = [];
        const retryTimes: number[] = [];
        let transient = false;
        for (const source of this.sources) {
          signal.throwIfAborted();
          // Sources outside the registry are never drawn or reported as skipped;
          // Sources.complete() offers them only as a last resort.
          if (this.options.unrouted?.has(source.id)) continue;
          const adapter = adapters.find(a => a.id === source.id);
          if (explicit && source.id !== request.model) continue;
          if (!adapter || this.options.disabled?.has(source.id) || scoutRetired(adapter, this.now())) {
            skip(source.id, this.options.disabled?.has(source.id) ? 'disabled'
              : adapter ? 'retired' : registered.some(a => a.id === source.id) ? 'input_unsupported' : 'not_listed');
            continue;
          }
          if (source.acceptsRequest && !source.acceptsRequest(request)) {
            skip(source.id, 'context_not_approved');
            if (source.id === request.model) throw new SourceError('refused', `${source.id} requires approved request context`);
            continue;
          }
          if (this.options.pending?.has(source.id)) { transient = true; skip(source.id, 'pending_setup'); continue; }
          if (toolsRequired && !toolCapable(source)) { skip(source.id, 'tools_unsupported'); continue; }
          if (this.retired(source.id)) { skip(source.id, 'retired'); continue; }
          if (this.trialBusy(source.id)) { transient = true; skip(source.id, 'trial_in_progress'); continue; }
          const until = this.cooldown(source.id)?.until;
          if (until !== undefined && until > this.now()) {
            if (Number.isFinite(until)) { retryTimes.push(until); transient = true; }
            skip(source.id, 'cooldown');
            continue;
          }
          if (attempted.has(source.id)) {
            // This call cannot repeat this source. The next call can try it now, unless it refused the request itself.
            if (!refused.has(source.id)) { retryTimes.push(this.now()); transient = true; }
            skip(source.id, refused.has(source.id) ? 'request_refused' : 'already_attempted');
            continue;
          }
          const available = this.availability.peek(source.id);
          if (source.id === task.source || available === true) {
            eligible.push({ source, adapter, weight: adapter.weight * observation.routingWeight(source.id, false, workload) * registryScoreFactor(this.registryScore?.(source.id)) });
            if (available === true) reportEligible(source.id, this.now());
          }
          else if (available === undefined) unknown.push(source);
          else {
            // This live allowance check can discover a reset the router did not know at entry.
            const checkedUntil = this.cooldown(source.id)?.until;
            if (checkedUntil !== undefined && checkedUntil > this.now() && Number.isFinite(checkedUntil)) retryTimes.push(checkedUntil);
            // Unavailable without a known reset (limited, still checking) may recover; only a permanent bar cannot.
            if (checkedUntil !== Infinity) transient = true;
            skip(source.id, 'unavailable');
          }
        }
        signal.throwIfAborted();
        // At most four read-only admission checks run together. A ready source
        // can answer immediately while unrelated checks finish in the background.
        // Checks never replace the selected adapter's fresh dispatch guards.
        if (stopObserving) {
          checking.clear();
          for (const source of unknown) checking.set(source.id, source);
        }
        const startedChecks = this.availability.start(unknown);
        // Admit already-settled metadata before drawing (including a just-reset
        // quota), without waiting for network or a slow unrelated provider.
        if (eligible.length && startedChecks && !yieldedMetadata) {
          yieldedMetadata = true;
          observeRequestPhase('checking_routes');
          await metadataTurn(undefined, { signal });
          continue;
        }
        if (!eligible.length) {
          if (unknown.length && this.availability.hasPending()) { observeRequestPhase('checking_routes'); await this.availability.changed(signal); continue; }
          // No source lists image input at all: that is the request's shape, not quota, so say so as an invalid request.
          const imageRefused = imageRequest && !this.sources.some(source => (!explicit || source.id === request.model) && !this.options.unrouted?.has(source.id) && this.imageListed(source.id));
          const failure = imageRefused ? new RequestError('This conversation contains an image, but no source on this route accepts image input; remove the image or continue in text')
            : imageRefusal && !transient ? new SourceError('refused', imageRefusal.message, undefined, undefined, imageRefusal.diagnostics)
            : this.exhausted(toolsRequired, retryTimes, refused.size, transient);
          // Keep the task reserved until its fallback has settled.
          if (!explicit && fallback) return await fallback(failure, signal);
          throw failure;
        }
        const open = eligible.filter(({ source }) => !this.awaitingProbe(source.id));
        if (open.length) eligible = open;
        else if (unknown.length && this.availability.hasPending()) {
          await this.availability.changed(signal);
          continue;
        }
        const boundMain = eligible.some(candidate => candidate.source.id === task.source);
        // A task that is not bound yet (a first draw or a fallback) takes a native tool source when one is eligible, so
        // a model that must be asked in prose to call tools is not drawn while a provider-native one could answer. A
        // bound task keeps its source: it is mid-session, and leaving costs a handoff for no known failure.
        const native = NATIVE_TOOL_SOURCES_FIRST && toolsRequired && !boundMain && eligible.some(candidate => !bridgedTools(candidate.source));
        const draw = native ? eligible.filter(candidate => !bridgedTools(candidate.source)) : eligible;
        if (native) for (const candidate of eligible) if (bridgedTools(candidate.source)) skip(candidate.source.id, 'native_tools_preferred');
        // Only bridged sources are ready, but a native one is still being checked: wait for that check (deadline
        // bounded) instead of drawing a bridged source on a cold cache.
        if (NATIVE_TOOL_SOURCES_FIRST && toolsRequired && !boundMain && !native && unknown.some(source => toolCapable(source) && !bridgedTools(source)) && this.availability.hasPending()) {
          observeRequestPhase('checking_routes'); await this.availability.changed(signal); continue;
        }
        const idle = draw.filter(candidate => !this.busy(candidate.source.id));
        // Main requests may overlap a read-only/maintenance observation. They
        // prefer idle capacity but must not wait behind background work.
        // A first draw and a fallback (the bound source failed or is benched) prefer idle capacity. Sources whose
        // admission metadata is still being fetched may be idle, so wait for those checks (each is deadline bounded;
        // a first draw's total wait is FIRST_DRAW_IDLE_WAIT_MS) before sharing a source that is busy with another
        // task. A healthy bound source never waits.
        // A first draw waits too, but only a bounded time, and only for sources that would join the draw (a native tool
        // source is not worth waiting for on behalf of a bridged one, nor the reverse).
        const joining = native ? unknown.filter(source => !bridgedTools(source)) : unknown;
        if (!boundMain && !idle.length && joining.length && this.availability.hasPending()) {
          idleWaitEnds ??= Date.now() + (task.source === undefined ? FIRST_DRAW_IDLE_WAIT_MS : Infinity);
          const left = idleWaitEnds - Date.now();
          if (left > 0) { observeRequestPhase('checking_routes'); await this.availability.changed(signal, Number.isFinite(left) ? left : undefined); continue; }
        }
        const ready = boundMain || !idle.length ? draw : idle;
        if (ready === idle) for (const candidate of draw) if (!idle.includes(candidate)) skip(candidate.source.id, 'idle_route_preferred');
        let selected = ready.find(candidate => candidate.source.id === task.source);
        let performanceSwitch = false;
        if (selected && !attempted.size) {
          const faster = this.fasterContinuation(task, request, ready, adapters, workload);
          if (faster) { selected = faster; performanceSwitch = true; }
        }
        // A first request has no bound source; its draw is weighted, not sticky.
        const bound = selected !== undefined && selected.source.id === task.source;
        if (!selected) {
          if (toolsRequired) {
            // Redistribute each tier's base share across the eligible tool routes.
            // Performance and registry scores still scale each route's resulting share.
            const totals = { stable: 0, experimental: 0 };
            for (const { adapter } of ready) totals[adapter.tier] += adapter.weight;
            for (const candidate of ready) {
              const tier = candidate.adapter.tier;
              candidate.weight *= TIER_TOTALS[tier] / totals[tier];
            }
          }
          let draw = (this.options.random ?? Math.random)() * ready.reduce((total, a) => total + a.weight, 0);
          selected = ready.find(a => (draw -= a.weight) < 0) ?? ready.at(-1)!;
        }
        for (const candidate of ready) if (candidate !== selected) skip(candidate.source.id, bound ? 'sticky_binding' : 'weighted_draw');
        // Claim the source now, in the same tick as the draw: handoff below awaits, and concurrent tasks must
        // not draw the same idle source meanwhile. Released when this attempt ends or the selection is dropped.
        const unreserve = this.reserve(selected.source.id);
        const switched = task.switched || (!bound && task.source !== undefined);
        let release = () => {};
        try {
          // A provider with a request scope guard may only receive the client-approved
          // payload. Handoff would append an unchecked local diff and prior output.
          const handoff = switched && !explicit && !selected.source.acceptsRequest;
          if (handoff) observeRequestPhase('preparing_handoff', selected.source.id);
          const input = handoff ? await this.handoff({ ...request, cwd }, task, signal) : { ...request, cwd };
          // Availability and handoff can yield while maintenance records a newer cooldown.
          if ((this.cooldown(selected.source.id)?.until ?? 0) > this.now()) {
            skip(selected.source.id, 'cooldown');
            continue;
          }
          signal.throwIfAborted();
          // Keep this check and attempt dispatch synchronous.
          const blocked = dispatchBlockReason(selected.source.id) ?? (performanceSwitch && this.busy(selected.source.id, 1) ? 'idle_route_preferred' : undefined);
          if (blocked) { skip(selected.source.id, blocked); continue; }
          release = this.claimTrial(selected.source.id);
          task.source = selected.source.id;
          task.switched = switched;
          if (performanceSwitch) { task.lastPerformanceSwitchAt = this.now(); delete task.reassessment; }
          attempted.add(selected.source.id);
          this.options.observe?.(selected.source.id, request.model === selected.source.id ? 'explicit' : task.switched ? 'fallback' : bound ? 'sticky' : 'weighted');
          const primary = selected.source;
          const safeToRace = (source: Source) => source.inferenceOnly || adapters.some(a => a.id === source.id && a.kind === 'model');
          const backupEligible = (source: Source) => safeToRace(source) && !this.options.unrouted?.has(source.id)
            && !dispatchBlockReason(source.id) && !this.awaitingProbe(source.id) && (this.cooldown(source.id)?.until ?? 0) <= this.now()
            && this.availability.peek(source.id) === true && (!source.acceptsRequest || source.acceptsRequest(request))
            && (!toolsRequired || toolCapable(source) && (!NATIVE_TOOL_SOURCES_FIRST || bridgedTools(source) === bridgedTools(primary)));
          const backup = () => {
            const source = this.sources.find(source => !attempted.has(source.id) && !this.busy(source.id) && backupEligible(source));
            if (source) { attempted.add(source.id); hedged = true; }
            return source;
          };
          const run = async (source: Source, child: AbortSignal) => {
            let payload = input;
            if (source !== primary) {
              if (source.acceptsRequest) payload = { ...request, cwd };
              else if (!handoff && (switched || bound)) payload = await this.handoff({ ...request, cwd }, task, child);
              child.throwIfAborted();
              if (!backupEligible(source) || this.busy(source.id, 1)) throw backupUnavailable;
              this.options.observe?.(source.id, 'fallback');
            }
            return this.options.attempt ? this.options.attempt(source, payload, child)
              : withAttemptStream(source.id, () => observation.complete(source, payload, child));
          };
          const fail = async (source: Source, failure: SourceError) => {
            if (failure.code === 'cancelled') return;
            if (localRequestRefusal(failure)) {
              refused.add(source.id);
              if (imageRequest && failure.diagnostics?.failureReason === 'request_body') {
                imageRefusal ??= failure;
                skipped.set(source.id, 'no free vision model is currently available');
              } else {
                skipped.set(source.id, 'rejected the tool definitions or tool history');
              }
            } else skipped.set(source.id, observation.routeFailure(source.id, failure.code) ?? 'request failed');
            await this.recordFailure(source.id, failure);
          };
          const result = await this.raceAttempts(primary, signal, backup, run, source => { task.source = source.id; },
            unreserve, fail, !explicit && !hedged && safeToRace(primary));
          signal.throwIfAborted();
          task.output = Buffer.from(result.text).subarray(-4096).toString('utf8'); task.switched = false;
          answeredBy.set(result, task.source!);
          return result;
        } catch (error) {
          const failure = error instanceof SourceError ? error : new SourceError('upstream', 'Adapter request failed');
          if (failure.output) task.output = failure.output;
          signal.throwIfAborted();
          if (!canReplay(failure)) throw failure;
          task.switched = true;
        } finally { release(); unreserve(); }
      }
    } finally {
      stopObserving?.();
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
