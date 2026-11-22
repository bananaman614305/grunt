import { performance } from 'node:perf_hooks';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Completion, ModelRequest, Source } from './source.js';
import { Sources, SourceError } from './source.js';
import { currentReplayRuntime, fallbackReplayScenarios, runFallbackReplay } from './fallback-replay.js';
import type { ReplayRuntime } from './fallback-replay.js';

interface BenchmarkRuntime {
  Sources: new (sources: Source[], routing?: undefined, disabled?: ReadonlySet<string>, firstOutputMs?: number) => {
    complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
    close(): Promise<void>;
  };
  SourceError: new (code: 'upstream', message: string) => Error;
}
export interface TaskMeasurement {
  scenario: string;
  completedTasks: number;
  attempts: number;
  medianMs: number;
  p90Ms: number;
}
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;

/** Deterministic synthetic tasks: no provider traffic, project reads, credentials or tools. */
export async function measureFallbackTasks(runtime: BenchmarkRuntime, iterations = 7, timing = { firstOutputMs: 30, failMs: 160, outputMs: 5, answerMs: 5 }): Promise<TaskMeasurement> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Use 1–100 benchmark iterations.');
  const times: number[] = [];
  let attempts = 0;
  for (let index = 0; index < iterations; index++) {
    const number = index + 3;
    const stalled: Source & { reportsProgress: boolean } = {
      id: 'kilo', reportsOutput: true, reportsProgress: true, available: async () => true,
      complete: (_request, signal, output) => {
        attempts++;
        return new Promise((_resolve, reject) => {
          const progress = setTimeout(() => output?.(), timing.outputMs);
          const finish = setTimeout(() => {
            cleanup(); reject(new runtime.SourceError('upstream', 'Synthetic stream stopped.'));
          }, timing.failMs);
          const abort = () => { cleanup(); reject(signal.reason); };
          const cleanup = () => { clearTimeout(progress); clearTimeout(finish); signal.removeEventListener('abort', abort); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    };
    const answer: Source = {
      id: 'numes', available: async () => true,
      complete: async () => {
        attempts++;
        await new Promise(done => setTimeout(done, timing.answerMs));
        return { text: JSON.stringify({ square: number * number }) };
      }
    };
    const pool = new runtime.Sources([stalled, answer], undefined, new Set(), timing.firstOutputMs);
    const request: ModelRequest = { model: 'grunt', cwd: '/tmp', messages: [{ role: 'user', content: `Return the square of ${number}.` }], tools: [], stream: false };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Synthetic benchmark deadline exceeded.')), 5000);
    try {
      const started = performance.now();
      const result = await pool.complete(request, deadline.signal);
      const parsed: unknown = JSON.parse(result.text);
      if (!parsed || typeof parsed !== 'object' || !('square' in parsed) || parsed.square !== number * number) throw new Error('Benchmark task verification failed.');
      times.push(performance.now() - started);
    } finally { clearTimeout(timer); await pool.close(); }
  }
  return { scenario: 'verified-synthetic-task-after-stream-stall', completedTasks: times.length, attempts, medianMs: percentile(times, .5), p90Ms: percentile(times, .9) };
}

async function loadRuntime(root: string): Promise<BenchmarkRuntime> {
  const path = await realpath(root);
  // Deliberately import source from the requested checkout for matched before/after runs.
  // Running this developer command authorizes execution of that local checkout.
  return import(pathToFileURL(resolve(path, 'src/local/source.ts')).href) as Promise<BenchmarkRuntime>;
}
async function replayComparison(baseline: string | undefined, iterations: number) {
  const beforeRuntime = baseline ? await loadRuntime(baseline) as ReplayRuntime : undefined;
  const before: Awaited<ReturnType<typeof runFallbackReplay>>[] = [], current: Awaited<ReturnType<typeof runFallbackReplay>>[] = [];
  for (let index = 0; index < iterations; index++) {
    // Interleave order rather than letting warmup/load systematically favor one checkout.
    if (beforeRuntime && index % 2 === 0) before.push(await runFallbackReplay(beforeRuntime, fallbackReplayScenarios));
    current.push(await runFallbackReplay(currentReplayRuntime, fallbackReplayScenarios));
    if (beforeRuntime && index % 2 === 1) before.push(await runFallbackReplay(beforeRuntime, fallbackReplayScenarios));
  }
  const summarize = (runs: typeof current) => {
    const tasks = runs.flatMap(run => run.tasks), elapsedMs = runs.reduce((n, run) => n + run.elapsedMs, 0);
    const completedTasks = tasks.filter(task => task.outcome === 'passed').length;
    return { totalTasks: tasks.length, completedTasks, completionRate: completedTasks / tasks.length,
      elapsedMs, medianBatchMs: percentile(runs.map(run => run.elapsedMs), .5), p90BatchMs: percentile(runs.map(run => run.elapsedMs), .9),
      verifiedTasksPerHour: elapsedMs ? completedTasks * 3600000 / elapsedMs : 0,
      attempts: tasks.reduce((n, task) => n + task.attempts, 0),
      failedAttemptMs: tasks.reduce((n, task) => n + task.failedAttemptMs, 0),
      quotaAttempts: tasks.reduce((n, task) => n + task.quotaAttempts, 0),
      advertisedQuotaWaitSeconds: tasks.reduce((n, task) => n + task.advertisedQuotaWaitSeconds, 0),
      cleanupComplete: tasks.every(task => task.cleanupComplete), runs };
  };
  return { version: 1, kind: 'offline-fallback-replay-comparison', iterations, ...(beforeRuntime ? { baseline: summarize(before) } : {}), current: summarize(current),
    limitation: 'Scaled synthetic replay fixtures only, including incorrect/failed/timed-out tasks in the denominator. Alternating checkout order. No provider calls; quota hints are not slept or reset. No general coding-task speedup is inferred.' };
}
export async function runEfficiencyBenchmark(args: string[]) {
  let baseline: string | undefined, iterations = 7, replay = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--replay') { replay = true; continue; }
    const value = args[++i];
    if (!value) throw new Error('Usage: benchmark:efficiency [--replay] [--baseline CHECKOUT] [--iterations 1–100]');
    if (flag === '--baseline') baseline = value;
    else if (flag === '--iterations') iterations = Number(value);
    else throw new Error('Unknown benchmark argument.');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Use 1–100 benchmark iterations.');
  if (replay) return replayComparison(baseline, iterations);
  const before = baseline ? await measureFallbackTasks(await loadRuntime(baseline), iterations) : undefined;
  const current = await measureFallbackTasks({ Sources, SourceError }, iterations);
  return {
    version: 1, kind: 'synthetic-runtime-benchmark', iterations,
    fixture: { firstOutputDeadlineMs: 30, stoppedStreamFailureMs: 160, firstProgressMs: 5, fallbackAnswerMs: 5 },
    ...(before ? { baseline: before } : {}), current,
    ...(before ? { medianSpeedup: before.medianMs / current.medianMs } : {}),
    limitation: 'Synthetic stream-stall fixture with scaled deadlines, not real provider latency or a general coding-task speedup. Every task checks the final result. No network or provider requests are made.'
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEfficiencyBenchmark(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error('Efficiency benchmark failed; check arguments, checkout dependencies and task verification.'); process.exitCode = 1;
  });
}
