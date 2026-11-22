import { performance } from 'node:perf_hooks';
import { SourceError, Sources } from './source.js';
import type { Completion, ErrorCode, ModelRequest, Source } from './source.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';

/** Timing/category fixtures only. These never load credentials, accounts or provider transports. */
export interface ReplayAttempt {
  durationMs: number;
  outcome: 'passed' | 'failed';
  errorCode?: ErrorCode;
  failureReason?: SafeDiagnosticMetadata['failureReason'];
  progress?: readonly { atMs: number; kind: 'meaningful' | 'heartbeat' }[];
  completion?: Completion;
  retryAfterSeconds?: number;
}
export interface ReplayAttemptObservation {
  index: number;
  outcome: 'passed' | 'failed' | 'cancelled';
  durationMs: number;
  errorCode?: ErrorCode;
  advertisedRetryAfterSeconds?: number;
}
export interface ReplayObservation {
  attemptsStarted: number;
  attemptsFinished: number;
  activeAttempts: number;
  activeTimers: number;
  meaningfulProgressEvents: number;
  heartbeatEvents: number;
  attempts: ReplayAttemptObservation[];
}
type ReplayError = new (code: ErrorCode, message: string, retryAfter?: number, output?: string, diagnostics?: SafeDiagnosticMetadata) => Error;
export interface ReplayRuntime {
  Sources: new (sources: Source[], routing?: undefined, disabled?: ReadonlySet<string>, firstOutputMs?: number) => {
    complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
    close(): Promise<void>;
  };
  SourceError: ReplayError;
}
const codes: readonly ErrorCode[] = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'];
const bounded = (value: number, max: number) => Number.isFinite(value) && value >= 0 && value <= max;

export function createReplaySource(id: string, attempts: readonly ReplayAttempt[], options: { reportsProgress?: boolean; SourceError?: ReplayError } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !attempts.length || attempts.length > 100) throw new Error('Invalid replay source or attempt count.');
  for (const attempt of attempts) {
    if (!bounded(attempt.durationMs, 300000) || !['passed', 'failed'].includes(attempt.outcome)
      || attempt.errorCode !== undefined && !codes.includes(attempt.errorCode)
      || attempt.retryAfterSeconds !== undefined && !bounded(attempt.retryAfterSeconds, 31 * 86400)
      || (attempt.progress?.length ?? 0) > 1000
      || attempt.progress?.some(event => !bounded(event.atMs, attempt.durationMs) || !['meaningful', 'heartbeat'].includes(event.kind))
      || attempt.outcome === 'passed' && (!attempt.completion || typeof attempt.completion.text !== 'string')) throw new Error('Invalid replay attempt.');
  }
  // Pin fixtures before dispatch. A benchmark must not mutate the scenario mid-run.
  const fixtures = structuredClone(attempts), ErrorType = options.SourceError ?? SourceError;
  const observation: ReplayObservation = { attemptsStarted: 0, attemptsFinished: 0, activeAttempts: 0, activeTimers: 0,
    meaningfulProgressEvents: 0, heartbeatEvents: 0, attempts: [] };
  const shutdown = new AbortController(), pending = new Set<Promise<Completion>>();
  const source: Source = {
    id, supportsFunctionTools: true,
    ...(options.reportsProgress ? { reportsOutput: true, reportsProgress: true } : {}),
    available: async () => !shutdown.signal.aborted,
    complete: (_request, caller, output) => {
      caller.throwIfAborted(); shutdown.signal.throwIfAborted();
      const index = observation.attemptsStarted++, fixture = fixtures[index];
      if (!fixture) {
        observation.attemptsFinished++;
        observation.attempts.push({ index, outcome: 'failed', errorCode: 'upstream', durationMs: 0 });
        return Promise.reject(new ErrorType('upstream', 'Replay attempts exhausted.'));
      }
      const started = performance.now(), signal = AbortSignal.any([caller, shutdown.signal]);
      observation.activeAttempts++;
      const task = new Promise<Completion>((resolve, reject) => {
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let done = false;
        const schedule = (delay: number, action: () => void) => {
          observation.activeTimers++;
          const timer = setTimeout(() => {
            timers.delete(timer); observation.activeTimers--;
            if (!done) action();
          }, delay);
          timers.add(timer);
        };
        const finish = (outcome: ReplayAttemptObservation['outcome'], value: Completion | unknown, errorCode?: ErrorCode) => {
          if (done) return;
          done = true;
          for (const timer of timers) { clearTimeout(timer); observation.activeTimers--; }
          timers.clear(); signal.removeEventListener('abort', abort);
          observation.activeAttempts--; observation.attemptsFinished++;
          observation.attempts.push({ index, outcome, durationMs: Math.max(0, performance.now() - started),
            ...(errorCode ? { errorCode } : {}),
            ...(fixture.retryAfterSeconds === undefined ? {} : { advertisedRetryAfterSeconds: fixture.retryAfterSeconds }) });
          if (outcome === 'passed') resolve(value as Completion); else reject(value);
        };
        const abort = () => {
          const code: unknown = signal.reason instanceof Error ? (signal.reason as Error & { code?: unknown }).code : undefined;
          finish('cancelled', signal.reason, codes.includes(code as ErrorCode) ? code as ErrorCode : 'cancelled');
        };
        signal.addEventListener('abort', abort, { once: true });
        for (const event of fixture.progress ?? []) schedule(event.atMs, () => {
          if (event.kind === 'meaningful') { observation.meaningfulProgressEvents++; output?.(); }
          // A heartbeat is observable transport activity, never useful model progress.
          else observation.heartbeatEvents++;
        });
        schedule(fixture.durationMs, () => {
          if (fixture.outcome === 'passed') finish('passed', structuredClone(fixture.completion!));
          else {
            const code = fixture.errorCode ?? 'upstream';
            finish('failed', new ErrorType(code, 'Synthetic replay failure.', fixture.retryAfterSeconds, undefined,
              fixture.failureReason ? { failureReason: fixture.failureReason } : undefined), code);
          }
        });
        if (signal.aborted) abort();
      });
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    close: async () => {
      shutdown.abort(new ErrorType('cancelled', 'Replay source closed.'));
      await Promise.allSettled([...pending]);
    }
  };
  return { source, observation };
}

export interface FallbackReplayScenario {
  id: string;
  sources: readonly { id: string; attempts: readonly ReplayAttempt[]; reportsProgress?: boolean }[];
  expectedText: string;
  deadlineMs: number;
  firstOutputMs: number;
}
export interface FallbackReplayTask {
  id: string;
  outcome: 'passed' | 'failed' | 'timed_out' | 'incorrect';
  elapsedMs: number;
  attempts: number;
  failedAttemptMs: number;
  quotaAttempts: number;
  advertisedQuotaWaitSeconds: number;
  cleanupComplete: boolean;
}

/** Failures and timeouts stay in the denominator; no success-only speed score. */
export async function runFallbackReplay(runtime: ReplayRuntime, scenarios: readonly FallbackReplayScenario[]) {
  if (!scenarios.length || scenarios.length > 100 || scenarios.some(scenario => !/^[a-z][a-z0-9-]{0,63}$/.test(scenario.id)
    || !scenario.sources.length || scenario.sources.length > 16 || typeof scenario.expectedText !== 'string'
    || !bounded(scenario.deadlineMs, 10000) || scenario.deadlineMs < 1 || !bounded(scenario.firstOutputMs, 10000) || scenario.firstOutputMs < 1)) throw new Error('Invalid replay scenario.');
  const tasks: FallbackReplayTask[] = [], batchStarted = performance.now();
  for (const scenario of scenarios) {
    const sources = scenario.sources.map(config => createReplaySource(config.id, config.attempts,
      { ...(config.reportsProgress ? { reportsProgress: true } : {}), SourceError: runtime.SourceError }));
    const pool = new runtime.Sources(sources.map(item => item.source), undefined, new Set(), scenario.firstOutputMs);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Replay task deadline exceeded.')), scenario.deadlineMs);
    const started = performance.now();
    let outcome: FallbackReplayTask['outcome'] = 'failed';
    try {
      const result = await pool.complete({ model: 'grunt', cwd: '/tmp', stream: false, tools: [],
        messages: [{ role: 'user', content: 'Return the synthetic replay fixture result.' }] }, controller.signal);
      outcome = result.text === scenario.expectedText ? 'passed' : 'incorrect';
    } catch { outcome = controller.signal.aborted ? 'timed_out' : 'failed'; }
    finally {
      clearTimeout(timer);
      await pool.close();
      // Also close directly: baseline runtimes may omit source cleanup on close.
      await Promise.all(sources.map(item => item.source.close?.()));
    }
    const observations = sources.map(item => item.observation), attempts = observations.flatMap(item => item.attempts);
    tasks.push({ id: scenario.id, outcome, elapsedMs: Math.max(0, performance.now() - started), attempts: observations.reduce((n, item) => n + item.attemptsStarted, 0),
      failedAttemptMs: attempts.filter(item => item.outcome !== 'passed').reduce((n, item) => n + item.durationMs, 0),
      quotaAttempts: attempts.filter(item => item.errorCode === 'quota').length,
      advertisedQuotaWaitSeconds: attempts.filter(item => item.errorCode === 'quota').reduce((n, item) => n + (item.advertisedRetryAfterSeconds ?? 0), 0),
      cleanupComplete: observations.every(item => !item.activeAttempts && !item.activeTimers) });
  }
  const elapsedMs = Math.max(0, performance.now() - batchStarted), passed = tasks.filter(task => task.outcome === 'passed');
  return { version: 1 as const, kind: 'offline-fallback-replay', tasks, elapsedMs, completedTasks: passed.length, totalTasks: tasks.length,
    completionRate: passed.length / tasks.length, verifiedTasksPerHour: elapsedMs ? passed.length * 3600000 / elapsedMs : 0,
    limitation: 'Synthetic replay timing and verified fixture results only. Advertised quota waits are reported, never slept or reset. Summed attempt time is not exclusive wall-clock time. No provider traffic or coding-speed claim.' };
}

/** Scaled timing shapes from local observations; no captured prompts or provider payloads. */
export const fallbackReplayScenarios: readonly FallbackReplayScenario[] = [
  { id: 'stalled-after-progress', firstOutputMs: 20, deadlineMs: 500, expectedText: 'verified', sources: [
    { id: 'openference', reportsProgress: true, attempts: [{ durationMs: 100, outcome: 'failed', errorCode: 'upstream', failureReason: 'stream_incomplete', progress: [{ atMs: 3, kind: 'meaningful' }] }] },
    { id: 'runcrate', attempts: [{ durationMs: 5, outcome: 'passed', completion: { text: 'verified' } }] }
  ] },
  { id: 'opaque-native-turn-limit', firstOutputMs: 20, deadlineMs: 500, expectedText: 'verified', sources: [
    { id: 'mistral-vibe', attempts: [{ durationMs: 51, outcome: 'failed', errorCode: 'upstream', failureReason: 'turn_limit' }] },
    { id: 'openference', attempts: [{ durationMs: 7, outcome: 'passed', completion: { text: 'verified' } }] }
  ] },
  { id: 'healthy-slow-progress', firstOutputMs: 20, deadlineMs: 500, expectedText: 'verified', sources: [
    { id: 'openference', reportsProgress: true, attempts: [{ durationMs: 65, outcome: 'passed', completion: { text: 'verified' },
      progress: [3, 15, 27, 39, 51, 60].map(atMs => ({ atMs, kind: 'meaningful' as const })) }] }
  ] },
  { id: 'quota-then-success', firstOutputMs: 20, deadlineMs: 500, expectedText: 'verified', sources: [
    { id: 'zro', attempts: [{ durationMs: 2, outcome: 'failed', errorCode: 'quota', retryAfterSeconds: 3600 }] },
    { id: 'runcrate', attempts: [{ durationMs: 5, outcome: 'passed', completion: { text: 'verified' } }] }
  ] },
  { id: 'incorrect-fast-answer', firstOutputMs: 20, deadlineMs: 500, expectedText: 'verified', sources: [
    { id: 'runcrate', attempts: [{ durationMs: 2, outcome: 'passed', completion: { text: 'wrong' } }] }
  ] },
  { id: 'deadline-kept-in-denominator', firstOutputMs: 20, deadlineMs: 30, expectedText: 'verified', sources: [
    { id: 'pollinations', attempts: [{ durationMs: 100, outcome: 'passed', completion: { text: 'verified' } }] }
  ] }
];

export const currentReplayRuntime: ReplayRuntime = { Sources, SourceError };
