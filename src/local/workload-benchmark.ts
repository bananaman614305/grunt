import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createReplaySource } from './fallback-replay.js';
import type { Completion, ModelRequest, Source } from './source.js';
import type { ReplayObservation, ReplayRuntime } from './fallback-replay.js';

/** A synthetic workload exercises the runtime, not an autonomous coding model. */
export interface WorkloadRuntime {
  Sources: new (sources: Source[], routing?: undefined, disabled?: ReadonlySet<string>, firstOutputMs?: number) => {
    complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
    close(): Promise<void>;
  };
  SourceError: ReplayRuntime['SourceError'];
}
export interface WorkloadIdentity { version: string; sourceDigest: string; codeTreeDigest: string; commit: string | null; runtimeFormat: 'source' | 'built'; entrypoint: string }
export type WorkloadTaskKind = 'answer' | 'repository' | 'fallback' | 'incorrect' | 'timeout';
export type WorkloadRepair = 'sum' | 'normalize' | 'clamp';
export interface WorkloadTask { id: string; kind: WorkloadTaskKind; value: number; repair?: WorkloadRepair }
export interface WorkloadManifest {
  version: 1; seed: number; tasks: readonly WorkloadTask[];
  timing: { answerMs: number; progressMs: number; firstOutputMs: number; stalledFailureMs: number; taskDeadlineMs: number };
}
export type WorkloadOutcome = 'verified' | 'incorrect' | 'failed' | 'timed_out';
export interface WorkloadTaskResult {
  id: string; kind: WorkloadTaskKind; outcome: WorkloadOutcome; durationMs: number; attempts: number; retryAttempts: number;
  inputTokens: number; outputTokens: number; unknownInputTokenAttempts: number; unknownOutputTokenAttempts: number;
  cleanupComplete: boolean;
}
export interface WorkloadBatch {
  manifestDigest: string; environmentDigest: string; concurrency: number; tasks: WorkloadTaskResult[];
  makespanMs: number; verifiedTasksPerHour: number; outcomes: Record<WorkloadOutcome, number>;
  verifiedTaskLatencyMs: { median: number | null; p90: number | null };
  attempts: number; retryAttempts: number; verificationFailures: number;
  tokens: { input: number; output: number; unknownInputAttempts: number; unknownOutputAttempts: number; kind: 'synthetic' };
  processResources: { userCpuMs: number; systemCpuMs: number; sampledPeakRssBytes: number; maxRssLifetimeKiB: number };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;
const boundedInteger = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in ${min}–${max}.`);
};
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function createWorkloadManifest(seed = 20261122, count = 20): WorkloadManifest {
  boundedInteger(seed, 0, 0xffffffff, 'Seed'); boundedInteger(count, 4, 100, 'Task count');
  const next = random(seed);
  const tasks = Array.from({ length: count }, (_, index): WorkloadTask => {
    const repair = (['sum', 'normalize', 'clamp'] as const)[index % 3]!;
    const kind: WorkloadTaskKind = index % 10 === 8 ? 'incorrect' : index % 10 === 9 ? 'timeout' : index % 3 === 0 ? 'fallback' : index % 3 === 1 ? 'answer' : 'repository';
    return { id: `task-${index + 1}`, kind, value: Math.floor(next() * 10000) + 1, ...(kind === 'answer' ? {} : { repair }) };
  });
  return { version: 1, seed, tasks, timing: { answerMs: 3, progressMs: 1, firstOutputMs: 15, stalledFailureMs: 75, taskDeadlineMs: 120 } };
}
export const workloadManifestDigest = (manifest: WorkloadManifest) => hash(manifest);
export function workloadPairOrder(seed: number, repetition: number): ('baseline' | 'current')[] {
  boundedInteger(seed, 0, 0xffffffff, 'Seed'); boundedInteger(repetition, 0, 9, 'Repetition');
  return ((repetition % 2 === 0) === (random(seed)() < .5)) ? ['baseline', 'current'] : ['current', 'baseline'];
}
export function workloadEnvironment() {
  // Paths, host identity, environment variables and credentials never enter reports.
  return { node: process.versions.node, platform: process.platform, arch: process.arch, fixtureVersion: 1 };
}
function validateManifest(manifest: WorkloadManifest) {
  boundedInteger(manifest.seed, 0, 0xffffffff, 'Seed'); boundedInteger(manifest.tasks.length, 1, 100, 'Task count');
  if (manifest.version !== 1 || new Set(manifest.tasks.map(task => task.id)).size !== manifest.tasks.length) throw new Error('Invalid workload manifest.');
  for (const task of manifest.tasks) {
    if (!/^task-\d{1,3}$/.test(task.id) || !['answer', 'repository', 'fallback', 'incorrect', 'timeout'].includes(task.kind) || !Number.isSafeInteger(task.value)
      || task.repair !== undefined && !['sum', 'normalize', 'clamp'].includes(task.repair) || task.kind === 'repository' && !task.repair) throw new Error('Invalid workload task.');
  }
  for (const [key, value] of Object.entries(manifest.timing)) boundedInteger(value, 1, key === 'taskDeadlineMs' ? 10000 : 5000, 'Fixture timing');
}

function repositoryFixture(task: WorkloadTask) {
  if (!task.repair) return undefined;
  const definitions = {
    sum: { initial: 'export function solve(values) { return values.length; }', replacement: 'export function solve(values) { return values.reduce((sum, value) => sum + value, 0); }',
      cases: [[[], 0], [[2, 3, -1], 4], [[task.value, -task.value, 9], 9]] },
    normalize: { initial: 'export function solve(value) { return value; }', replacement: 'export function solve(value) { return value.trim().replace(/\\s+/g, " "); }',
      cases: [['  hello   world  ', 'hello world'], ['', ''], ['one\n two\tthree', 'one two three']] },
    clamp: { initial: 'export function solve(value) { return Math.max(0, value); }', replacement: 'export function solve(value) { return Math.min(100, Math.max(0, value)); }',
      cases: [[-2, 0], [0, 0], [67, 67], [101, 100], [task.value + 100, 100]] },
  };
  return definitions[task.repair];
}

async function applyAndVerifyFixture(directory: string, text: string, task: WorkloadTask) {
  const fixture = repositoryFixture(task);
  if (!fixture) return false;
  let patch: unknown;
  try { patch = JSON.parse(text); } catch { return false; }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length !== 2 || !('path' in patch) || !('replacement' in patch)
    || patch.path !== 'src/solution.mjs' || typeof patch.replacement !== 'string') return false;
  // Only the two fixed fixture programs can execute. This is not an arbitrary-code sandbox.
  if (![fixture.initial, fixture.replacement].includes(patch.replacement)) return false;
  await writeFile(join(directory, 'src/solution.mjs'), patch.replacement);
  const content = await readFile(join(directory, 'src/solution.mjs'), 'utf8');
  const program = content.replace(/^export function solve/, 'function solve')
    + `\n${JSON.stringify(fixture.cases)}.every(([input, expected]) => JSON.stringify(solve(input)) === JSON.stringify(expected));`;
  return runInNewContext(program, Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } }) === true;
}

export async function measureWorkloadBatch(runtime: WorkloadRuntime, manifest: WorkloadManifest, concurrency = 1): Promise<WorkloadBatch> {
  manifest = structuredClone(manifest);
  validateManifest(manifest); boundedInteger(concurrency, 1, 4, 'Concurrency');
  const cpuStart = process.cpuUsage(), started = performance.now();
  const root = await mkdtemp(join(tmpdir(), 'grunt-workload-'));
  const results: WorkloadTaskResult[] = new Array(manifest.tasks.length);
  let sampledPeakRssBytes = process.memoryUsage().rss, cursor = 0;
  const sampler = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 10);
  const task = async (fixture: WorkloadTask): Promise<WorkloadTaskResult> => {
    const began = performance.now(), directory = join(root, fixture.id), controller = new AbortController();
    let attempts = 0, inputTokens = 0, outputTokens = 0, unknownInputTokenAttempts = 0, unknownOutputTokenAttempts = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined, pool: InstanceType<WorkloadRuntime['Sources']> | undefined;
    const observations: ReplayObservation[] = [];
    let outcome: WorkloadOutcome = 'failed';
    const wrap = (source: Source): Source => ({ ...source, complete: async (request, signal, output) => {
      attempts++;
      try {
        const reply = await source.complete(request, signal, output);
        if (reply.inputTokens === undefined) unknownInputTokenAttempts++; else inputTokens += reply.inputTokens;
        if (reply.outputTokens === undefined) unknownOutputTokenAttempts++; else outputTokens += reply.outputTokens;
        return reply;
      } catch (error) { unknownInputTokenAttempts++; unknownOutputTokenAttempts++; throw error; }
    } });
    try {
      deadline = setTimeout(() => controller.abort(new Error('Synthetic task deadline exceeded.')), manifest.timing.taskDeadlineMs);
      await mkdir(directory);
      // Reset and prepare each task's own synthetic file tree inside the measured batch.
      const repair = repositoryFixture(fixture);
      await writeFile(join(directory, 'input.json'), JSON.stringify({ value: fixture.value, operation: fixture.repair ?? 'square' }));
      if (repair) {
        await mkdir(join(directory, 'src'));
        await writeFile(join(directory, 'src/solution.mjs'), repair.initial);
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'grunt-synthetic-fixture', private: true, type: 'module' }));
        await writeFile(join(directory, 'acceptance.json'), JSON.stringify(repair.cases));
      }
      const expected = JSON.stringify({ square: fixture.value * fixture.value });
      const validText = repair ? JSON.stringify({ path: 'src/solution.mjs', replacement: fixture.kind === 'incorrect' ? repair.initial : repair.replacement })
        : fixture.kind === 'incorrect' ? JSON.stringify({ square: -1 }) : expected;
      const sources: Source[] = [];
      if (fixture.kind === 'fallback') {
        const stalled = createReplaySource('kilo', [{ durationMs: manifest.timing.stalledFailureMs, outcome: 'failed', errorCode: 'upstream', progress: [{ atMs: manifest.timing.progressMs, kind: 'meaningful' }] }], { reportsProgress: true, SourceError: runtime.SourceError });
        sources.push(wrap(stalled.source)); observations.push(stalled.observation);
      }
      const reply = createReplaySource('numes', [{ durationMs: fixture.kind === 'timeout' ? manifest.timing.taskDeadlineMs * 2 : manifest.timing.answerMs, outcome: 'passed', completion: { text: validText, inputTokens: 12, outputTokens: 8 } }], { SourceError: runtime.SourceError });
      sources.push(wrap(reply.source)); observations.push(reply.observation);
      pool = new runtime.Sources(sources, undefined, new Set(), manifest.timing.firstOutputMs);
      const request: ModelRequest = { model: 'grunt', cwd: directory, messages: [{ role: 'user', content: repair ? 'Repair src/solution.mjs against acceptance.json; return a scoped replacement patch.' : 'Read the synthetic square fixture and return its result.' }], tools: [], stream: false };
      const completion = await pool.complete(request, controller.signal);
      if (controller.signal.aborted) { outcome = 'timed_out'; }
      else {
        // Acceptance is exact and independent of the runtime's own success status.
        let accepted = repair ? await applyAndVerifyFixture(directory, completion.text, fixture) : false;
        try {
          const parsed: unknown = JSON.parse(completion.text);
          if (!repair) accepted = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && Object.keys(parsed).length === 1 && 'square' in parsed && parsed.square === fixture.value * fixture.value;
        } catch { /* Incorrect JSON is a failed task, not an omitted sample. */ }
        if (!accepted) outcome = 'incorrect';
        else if (repair) outcome = controller.signal.aborted ? 'timed_out' : 'verified';
        else {
          await writeFile(join(directory, 'result.json'), completion.text);
          const saved = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as { square: number };
          outcome = controller.signal.aborted ? 'timed_out' : saved.square === fixture.value * fixture.value ? 'verified' : 'incorrect';
        }
      }
    } catch { outcome = controller.signal.aborted ? 'timed_out' : 'failed'; }
    finally {
      if (deadline) clearTimeout(deadline);
      controller.abort();
      try { await pool?.close(); } catch { outcome = 'failed'; }
    }
    const cleanupComplete = observations.every(observation => observation.activeAttempts === 0 && observation.activeTimers === 0);
    if (!cleanupComplete) outcome = 'failed';
    else if (performance.now() - began >= manifest.timing.taskDeadlineMs) outcome = 'timed_out';
    return { id: fixture.id, kind: fixture.kind, outcome, durationMs: performance.now() - began, attempts, retryAttempts: Math.max(0, attempts - 1), inputTokens, outputTokens, unknownInputTokenAttempts, unknownOutputTokenAttempts, cleanupComplete };
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, manifest.tasks.length) }, async () => {
      while (cursor < manifest.tasks.length) { const index = cursor++; results[index] = await task(manifest.tasks[index]!); }
    }));
  } finally { clearInterval(sampler); await rm(root, { recursive: true, force: true }); }
  // Include cancellation settlement and fixture cleanup in batch makespan.
  const makespanMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  const outcomes: Record<WorkloadOutcome, number> = { verified: 0, incorrect: 0, failed: 0, timed_out: 0 };
  for (const result of results) outcomes[result.outcome]++;
  const verifiedTimes = results.filter(result => result.outcome === 'verified').map(result => result.durationMs);
  return { manifestDigest: workloadManifestDigest(manifest), environmentDigest: hash(workloadEnvironment()), concurrency, tasks: results,
    makespanMs, verifiedTasksPerHour: outcomes.verified * 3600000 / makespanMs, outcomes,
    verifiedTaskLatencyMs: { median: percentile(verifiedTimes, .5), p90: percentile(verifiedTimes, .9) },
    attempts: results.reduce((sum, result) => sum + result.attempts, 0), retryAttempts: results.reduce((sum, result) => sum + result.retryAttempts, 0), verificationFailures: outcomes.incorrect,
    tokens: { input: results.reduce((sum, result) => sum + result.inputTokens, 0), output: results.reduce((sum, result) => sum + result.outputTokens, 0),
      unknownInputAttempts: results.reduce((sum, result) => sum + result.unknownInputTokenAttempts, 0), unknownOutputAttempts: results.reduce((sum, result) => sum + result.unknownOutputTokenAttempts, 0), kind: 'synthetic' },
    processResources: { userCpuMs: cpu.user / 1000, systemCpuMs: cpu.system / 1000, sampledPeakRssBytes, maxRssLifetimeKiB: process.resourceUsage().maxRSS } };
}

export function compareWorkloadPairs(pairs: readonly { baseline: WorkloadBatch; current: WorkloadBatch }[], seed = 20261122) {
  if (!pairs.length) throw new Error('At least one paired run is required.');
  const reference = pairs[0]!.baseline;
  for (const pair of pairs) for (const batch of [pair.baseline, pair.current]) {
    if (batch.manifestDigest !== reference.manifestDigest || batch.environmentDigest !== reference.environmentDigest || batch.concurrency !== reference.concurrency) throw new Error('Cannot compare different workloads, environments or concurrency.');
    if (!Number.isFinite(batch.makespanMs) || batch.makespanMs <= 0 || Object.values(batch.outcomes).some(value => !Number.isSafeInteger(value) || value < 0)
      || Object.values(batch.outcomes).reduce((sum, value) => sum + value, 0) !== batch.tasks.length
      || (['verified', 'incorrect', 'failed', 'timed_out'] as const).some(outcome => batch.tasks.filter(task => task.outcome === outcome).length !== batch.outcomes[outcome])) throw new Error('Invalid measured workload batch.');
  }
  const baselineMs = pairs.reduce((sum, pair) => sum + pair.baseline.makespanMs, 0), currentMs = pairs.reduce((sum, pair) => sum + pair.current.makespanMs, 0);
  const baselineVerified = pairs.reduce((sum, pair) => sum + pair.baseline.outcomes.verified, 0), currentVerified = pairs.reduce((sum, pair) => sum + pair.current.outcomes.verified, 0);
  const verifiedTaskRegressions = pairs.flatMap((pair, repetition) => pair.baseline.tasks.filter(task => task.outcome === 'verified' && !pair.current.tasks.some(current => current.id === task.id && current.outcome === 'verified')).map(task => ({ repetition, taskId: task.id })));
  const ratios: number[] = [], next = random(seed);
  if (pairs.length >= 3 && baselineVerified > 0) for (let sample = 0; sample < 2000; sample++) {
    let before = 0, after = 0, beforeCount = 0, afterCount = 0;
    for (let draw = 0; draw < pairs.length; draw++) {
      const pair = pairs[Math.floor(next() * pairs.length)]!; before += pair.baseline.makespanMs; after += pair.current.makespanMs;
      beforeCount += pair.baseline.outcomes.verified; afterCount += pair.current.outcomes.verified;
    }
    if (beforeCount > 0) ratios.push((afterCount / after) / (beforeCount / before));
  }
  return { pairs: pairs.length, baselineVerified, currentVerified, baselineBatchMs: baselineMs, currentBatchMs: currentMs,
    verifiedTasksPerHour: { baseline: baselineVerified * 3600000 / baselineMs, current: currentVerified * 3600000 / currentMs },
    throughputRatio: baselineVerified ? (currentVerified / currentMs) / (baselineVerified / baselineMs) : null,
    equalCompletionCount: baselineVerified === currentVerified,
    qualityPreserved: verifiedTaskRegressions.length === 0,
    verifiedTaskRegressions,
    pairedBootstrap95: ratios.length ? { low: percentile(ratios, .025), high: percentile(ratios, .975), samples: ratios.length } : null,
    uncertainty: 'Seeded paired bootstrap over whole repeated batches; small samples and same-process resource measurements limit interpretation. Failed, incorrect and timed-out tasks remain in elapsed-time denominators.' };
}
async function runtimeCodeDigest(root: string, format: 'source' | 'built') {
  const paths: string[] = [], maxFiles = 2048, maxBytes = 16 * 1024 * 1024;
  let bytes = 0, visited = 0;
  const visit = async (relative: string, depth = 0): Promise<void> => {
    if (++visited > maxFiles) throw new Error('Runtime fingerprint exceeds bounded file count.');
    if (depth > 8) throw new Error('Runtime fingerprint exceeds bounded directory depth.');
    let info;
    try { info = await lstat(join(root, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && depth === 0) return; throw error; }
    if (info.isSymbolicLink()) throw new Error('Runtime fingerprint requires ordinary code files.');
    if (info.isDirectory()) {
      const entries = await readdir(join(root, relative));
      if (entries.length > maxFiles) throw new Error('Runtime fingerprint exceeds bounded file count.');
      for (const name of entries.sort()) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        await visit(join(relative, name), depth + 1);
      }
    } else if (info.isFile() && !relative.endsWith('.test.ts') && !relative.endsWith('.test.js')
      && (format === 'source' ? /\.ts$/.test(relative) : /\.(?:js|mjs|json)$/.test(relative))) {
      if (paths.length >= maxFiles || info.size > 2 * 1024 * 1024 || (bytes += info.size) > maxBytes) throw new Error('Runtime fingerprint exceeds bounded code size.');
      paths.push(relative);
    }
  };
  // Hash only shipped/development implementation trees, never user configuration,
  // credentials, node_modules, arbitrary repository paths or Git's private data.
  await visit(format === 'source' ? 'src' : 'dist');
  for (const relative of ['package.json', ...(format === 'source' ? ['registry/adapters.json', 'pnpm-lock.yaml'] : [])]) {
    try {
      const info = await lstat(join(root, relative));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024 || (bytes += info.size) > maxBytes) throw new Error('Runtime fingerprint exceeds bounded code size.');
      paths.push(relative);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const digest = createHash('sha256');
  for (const relative of paths.sort()) {
    const data = await readFile(join(root, relative));
    if (data.length > 2 * 1024 * 1024) throw new Error('Runtime fingerprint code changed beyond its size bound.');
    digest.update(relative); digest.update('\0'); digest.update(data); digest.update('\0');
  }
  return digest.digest('hex');
}
export async function loadWorkloadRuntime(root: string, preferredFormat: 'source' | 'built' = import.meta.url.endsWith('.ts') ? 'source' : 'built') {
  const canonical = await realpath(root);
  const metadata = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (!['usegrunt', 'grunt-runtime'].includes(metadata.name ?? '') || typeof metadata.version !== 'string') throw new Error('Baseline must be a trusted Grunt source checkout or built package.');
  const exists = async (relative: string) => { try { return (await lstat(join(canonical, relative))).isFile(); } catch { return false; } };
  const runtimeFormat = preferredFormat === 'source' && await exists('src/local/source.ts') ? 'source' : 'built';
  const entrypoint = runtimeFormat === 'source' ? 'src/local/source.ts' : 'dist/local/source.js', source = join(canonical, entrypoint);
  if (!await exists(entrypoint)) throw new Error('Compiled workload benchmarks require a built Grunt baseline; build it first, or run the source harness with --import tsx.');
  let commit: string | null = null;
  try {
    // A package installed inside a different Git repository does not inherit that
    // repository's commit identity. Linked Grunt worktrees remain supported.
    const top = await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--show-toplevel'], { cwd: canonical, timeout: 5000 });
    if (await realpath(top.stdout.trim()) === canonical) {
      const result = await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: canonical, timeout: 5000 });
      if (/^[a-f0-9]{40}\s*$/.test(result.stdout)) commit = result.stdout.trim();
    }
  } catch { /* Installed packages have code digests without a Git identity. */ }
  const identity: WorkloadIdentity = { version: metadata.version, sourceDigest: createHash('sha256').update(await readFile(source)).digest('hex'),
    codeTreeDigest: await runtimeCodeDigest(canonical, runtimeFormat), commit, runtimeFormat, entrypoint };
  const runtime = await import(pathToFileURL(source).href) as WorkloadRuntime;
  if (typeof runtime.Sources !== 'function' || typeof runtime.SourceError !== 'function') throw new Error('Baseline has no compatible Sources runtime.');
  return { runtime, identity };
}
export async function runWorkloadBenchmark(args: string[]) {
  let baseline: string | undefined, repetitions = 3, count = 20, seed = 20261122, concurrency = [1, 2, 4], taskDeadlineMs = 120;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index]; if (!value) throw new Error('Usage: benchmark:workload [--baseline CHECKOUT] [--repetitions 1–10] [--tasks 4–100] [--seed INTEGER] [--concurrency 1,2,4] [--task-deadline-ms 100–10000]');
    if (flag === '--baseline') baseline = value;
    else if (flag === '--repetitions') repetitions = Number(value);
    else if (flag === '--tasks') count = Number(value);
    else if (flag === '--seed') seed = Number(value);
    else if (flag === '--concurrency') concurrency = value.split(',').map(Number);
    else if (flag === '--task-deadline-ms') taskDeadlineMs = Number(value);
    else throw new Error('Unknown workload benchmark argument.');
  }
  boundedInteger(repetitions, 1, 10, 'Repetitions');
  boundedInteger(taskDeadlineMs, 100, 10000, 'Task deadline');
  if (!concurrency.length || new Set(concurrency).size !== concurrency.length || concurrency.some(value => ![1, 2, 4].includes(value))) throw new Error('Concurrency sweep must contain distinct values from 1,2,4.');
  const manifest = createWorkloadManifest(seed, count), environment = workloadEnvironment();
  manifest.timing.taskDeadlineMs = taskDeadlineMs;
  const current = await loadWorkloadRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const previous = baseline ? await loadWorkloadRuntime(baseline) : undefined;
  const runs: { concurrency: number; repetition: number; order: ('baseline' | 'current')[]; current: WorkloadBatch; baseline?: WorkloadBatch }[] = [];
  for (const cap of concurrency) for (let repetition = 0; repetition < repetitions; repetition++) {
    const order: ('baseline' | 'current')[] = previous ? workloadPairOrder(seed, repetition) : ['current'];
    let before: WorkloadBatch | undefined, after: WorkloadBatch | undefined;
    for (const side of order) {
      const measured = await measureWorkloadBatch(side === 'baseline' ? previous!.runtime : current.runtime, manifest, cap);
      if (side === 'baseline') before = measured; else after = measured;
    }
    runs.push({ concurrency: cap, repetition, order, current: after!, ...(before ? { baseline: before } : {}) });
  }
  const replayModule = fileURLToPath(new URL('./fallback-replay.js', import.meta.url));
  const replayBytes = await readFile(replayModule.replace(/\.js$/, '.ts')).catch(() => readFile(replayModule));
  const harnessDigest = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(replayBytes).digest('hex');
  return { version: 1, kind: 'verified-synthetic-workload-benchmark', manifest, manifestDigest: workloadManifestDigest(manifest), harnessDigest, environment,
    identities: { current: current.identity, ...(previous ? { baseline: previous.identity } : {}) }, runs,
    comparisons: previous ? concurrency.map(cap => ({ concurrency: cap, ...compareWorkloadPairs(runs.filter(run => run.concurrency === cap).map(run => ({ baseline: run.baseline!, current: run.current })), seed) })) : [],
    limitations: [
      'Synthetic deterministic responses exercise routing, cancellation, scoped fixture-library repairs, independent acceptance cases and scheduling; they do not measure autonomous coding quality or real provider latency.',
      'Timing uses scaled fixtures. Concurrency applies only to this benchmark and never changes live worker admission or provider selection.',
      'Every task starts with an isolated synthetic file tree. Incorrect answers and deadline failures are intentionally included as negative controls.',
      'Token counts are synthetic fixture metadata; failed attempts have unknown usage. CPU/RSS cover this benchmark process, with sampled RSS and lifetime max RSS explicitly distinguished.',
      'Provider modules are fake; no provider inference, accounts, production game files, or external checks are used. Baseline imports execute the user-selected trusted local checkout.',
    ] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkloadBenchmark(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error('Workload benchmark failed; check arguments and trusted baseline compatibility. Compiled runs require built checkouts; source-only comparisons require the source harness with --import tsx.'); process.exitCode = 1;
  });
}
