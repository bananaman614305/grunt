import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { compareWorkloadPairs, createWorkloadManifest, loadWorkloadRuntime, measureWorkloadBatch, runWorkloadBenchmark, workloadManifestDigest, workloadPairOrder } from './workload-benchmark.js';
import type { WorkloadBatch, WorkloadManifest } from './workload-benchmark.js';

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const fourKinds = (): WorkloadManifest => ({ ...createWorkloadManifest(42, 4), tasks: [
  { id: 'task-1', kind: 'answer', value: 4 }, { id: 'task-2', kind: 'fallback', value: 5 },
  { id: 'task-3', kind: 'incorrect', value: 6 }, { id: 'task-4', kind: 'timeout', value: 7 },
] });

it('repeats seeded pair order and alternates baseline/current position', () => {
  expect(workloadPairOrder(20261122, 0)).toEqual(workloadPairOrder(20261122, 0));
  expect(workloadPairOrder(20261122, 1)).toEqual([...workloadPairOrder(20261122, 0)].reverse());
  expect(workloadPairOrder(20261122, 2)).toEqual(workloadPairOrder(20261122, 0));
});

it('pins a reproducible workload and accounts for incorrect answers, timeouts and retries', async () => {
  const log = quiet();
  try {
    const manifest = fourKinds(), result = await measureWorkloadBatch({ Sources, SourceError }, manifest, 2);
    expect(createWorkloadManifest(42)).toEqual(createWorkloadManifest(42));
    expect(workloadManifestDigest(createWorkloadManifest(42))).not.toBe(workloadManifestDigest(createWorkloadManifest(43)));
    expect(result.outcomes).toEqual({ verified: 2, incorrect: 1, failed: 0, timed_out: 1 });
    expect(result.attempts).toBe(5); expect(result.retryAttempts).toBe(1); expect(result.verificationFailures).toBe(1);
    expect(result.tokens.unknownInputAttempts).toBe(2); expect(result.tokens.kind).toBe('synthetic');
    expect(result.makespanMs).toBeGreaterThanOrEqual(manifest.timing.taskDeadlineMs - 5);
    expect(result.verifiedTasksPerHour).toBeCloseTo(2 * 3600000 / result.makespanMs);
    expect(result.tasks.map(task => task.id)).toEqual(manifest.tasks.map(task => task.id));
    expect(result.processResources.sampledPeakRssBytes).toBeGreaterThan(0);
  } finally { log.mockRestore(); }
});

it('does not accept a fast incorrect runtime as completed work', async () => {
  class WrongRuntime { async complete() { return { text: '{"square":-1}' }; } async close() {} }
  const manifest = { ...createWorkloadManifest(1, 4), tasks: [{ id: 'task-1', kind: 'answer' as const, value: 12 }] };
  const result = await measureWorkloadBatch({ Sources: WrongRuntime, SourceError }, manifest);
  expect(result.outcomes.verified).toBe(0); expect(result.outcomes.incorrect).toBe(1); expect(result.verifiedTasksPerHour).toBe(0);
  expect(result.verifiedTaskLatencyMs).toEqual({ median: null, p90: null });
});

it('bounds in-flight tasks and closes every task pool before deleting fixture trees', async () => {
  let active = 0, peak = 0, closed = 0;
  const roots: string[] = [];
  class ObservedRuntime {
    async complete(request: ModelRequest) {
      roots.push(request.cwd); active++; peak = Math.max(peak, active);
      try {
        await new Promise(done => setTimeout(done, 5));
        const input = JSON.parse(await readFile(join(request.cwd, 'input.json'), 'utf8')) as { value: number };
        return { text: JSON.stringify({ square: input.value * input.value }) };
      } finally { active--; }
    }
    async close() { closed++; }
  }
  const manifest = createWorkloadManifest(3, 8);
  const result = await measureWorkloadBatch({ Sources: ObservedRuntime, SourceError }, { ...manifest, tasks: manifest.tasks.map(task => ({ id: task.id, value: task.value, kind: 'answer' as const })) }, 2);
  expect(result.outcomes.verified).toBe(8); expect(peak).toBe(2); expect(closed).toBe(8); expect(active).toBe(0);
  for (const root of roots) await expect(readFile(join(root, 'input.json'))).rejects.toThrow();
});

it('applies scoped synthetic library repairs and checks them independently', async () => {
  const log = quiet();
  try {
    const manifest: WorkloadManifest = { ...createWorkloadManifest(4, 4), tasks: [
      { id: 'task-1', kind: 'repository', value: 3, repair: 'sum' },
      { id: 'task-2', kind: 'repository', value: 4, repair: 'normalize' },
      { id: 'task-3', kind: 'repository', value: 5, repair: 'clamp' },
      { id: 'task-4', kind: 'incorrect', value: 6, repair: 'sum' },
    ] };
    const result = await measureWorkloadBatch({ Sources, SourceError }, manifest, 2);
    expect(result.outcomes).toEqual({ verified: 3, incorrect: 1, failed: 0, timed_out: 0 });
    class UnsafeRuntime {
      async complete() { return { text: JSON.stringify({ path: '../escape.mjs', replacement: 'throw new Error("must not run")' }) }; }
      async close() {}
    }
    const bad = await measureWorkloadBatch({ Sources: UnsafeRuntime, SourceError }, { ...manifest, tasks: manifest.tasks.slice(0, 1) });
    expect(bad.outcomes.incorrect).toBe(1); expect(bad.outcomes.verified).toBe(0);
  } finally { log.mockRestore(); }
});

it('settles cancellation and closes every replay source, including timeout tasks', async () => {
  let active = 0;
  class TrackedSources extends Sources {
    constructor(sources: Source[], routing?: undefined, disabled?: ReadonlySet<string>, firstOutputMs?: number) {
      super(sources.map(source => ({ ...source, complete: async (request, signal, output) => {
        active++;
        try { return await source.complete(request, signal, output); } finally { active--; }
      } })), routing, disabled, firstOutputMs);
    }
  }
  const log = quiet();
  try {
    const result = await measureWorkloadBatch({ Sources: TrackedSources, SourceError }, fourKinds(), 4);
    expect(result.outcomes.timed_out).toBe(1); expect(active).toBe(0);
    await new Promise(done => setTimeout(done, 5)); expect(active).toBe(0);
  } finally { log.mockRestore(); }
});

it('compares paired batches with failures included and rejects incompatible baselines', async () => {
  const original = await measureWorkloadBatch({ Sources, SourceError }, { ...createWorkloadManifest(1, 4), tasks: [{ id: 'task-1', kind: 'answer' as const, value: 3 }] });
  const baseline: WorkloadBatch = { ...original, makespanMs: 100 };
  const current: WorkloadBatch = { ...baseline, makespanMs: 50 };
  const comparison = compareWorkloadPairs(Array.from({ length: 3 }, () => ({ baseline, current })), 4);
  expect(comparison.throughputRatio).toBe(2); expect(comparison.pairedBootstrap95).toEqual({ low: 2, high: 2, samples: 2000 });
  expect(comparison.baselineBatchMs).toBe(300); expect(comparison.currentBatchMs).toBe(150);
  expect(() => compareWorkloadPairs([{ baseline, current: { ...current, manifestDigest: 'different' } }])).toThrow('Cannot compare');
  expect(() => compareWorkloadPairs([{ baseline, current: { ...current, environmentDigest: 'different' } }])).toThrow('Cannot compare');
  expect(() => compareWorkloadPairs([{ baseline, current: { ...current, concurrency: 2 } }])).toThrow('Cannot compare');
  expect(compareWorkloadPairs([{ baseline, current }]).pairedBootstrap95).toBeNull();
  const zero: WorkloadBatch = { ...current, tasks: current.tasks.map(task => ({ ...task, outcome: 'incorrect' as const })), outcomes: { verified: 0, incorrect: 1, failed: 0, timed_out: 0 } };
  expect(compareWorkloadPairs(Array.from({ length: 3 }, () => ({ baseline, current: zero }))).throughputRatio).toBe(0);
  expect(compareWorkloadPairs(Array.from({ length: 3 }, () => ({ baseline, current: zero }))).pairedBootstrap95).toEqual({ low: 0, high: 0, samples: 2000 });
  expect(() => compareWorkloadPairs([{ baseline, current: { ...current, makespanMs: 0 } }])).toThrow('Invalid measured');
});

it('validates CLI work bounds before executing runtime imports or tasks', async () => {
  await expect(runWorkloadBenchmark(['--repetitions', '0'])).rejects.toThrow('Repetitions');
  await expect(runWorkloadBenchmark(['--tasks', '1000'])).rejects.toThrow('Task count');
  await expect(runWorkloadBenchmark(['--concurrency', '2,2'])).rejects.toThrow('distinct');
  await expect(runWorkloadBenchmark(['--seed', '-1'])).rejects.toThrow('Seed');
  await expect(runWorkloadBenchmark(['--baseline'])).rejects.toThrow('Usage');
  await expect(runWorkloadBenchmark(['--wat', 'value'])).rejects.toThrow('Unknown');
  for (const value of ['99', '10001', '100.5', 'NaN', 'Infinity']) await expect(runWorkloadBenchmark(['--baseline', '/missing-must-not-be-imported', '--task-deadline-ms', value])).rejects.toThrow('Task deadline');
  await expect(runWorkloadBenchmark(['--task-deadline-ms'])).rejects.toThrow('Usage');
});

it('pins configured offline deadlines in reproducible manifests and retains timed-out negative controls', async () => {
  const log = quiet();
  try {
    const args = ['--repetitions', '1', '--tasks', '10', '--concurrency', '4', '--seed', '42', '--task-deadline-ms', '2000'];
    const first = await runWorkloadBenchmark(args), second = await runWorkloadBenchmark(args);
    expect(createWorkloadManifest(42, 10).timing.taskDeadlineMs).toBe(120);
    expect(first.manifest.timing.taskDeadlineMs).toBe(2000);
    expect(first.manifestDigest).toBe(workloadManifestDigest(first.manifest));
    expect(first.manifestDigest).not.toBe(workloadManifestDigest(createWorkloadManifest(42, 10)));
    expect(second.manifestDigest).toBe(first.manifestDigest);
    for (const result of [first, second]) {
      expect(result.runs[0]!.current.outcomes).toEqual({ verified: 8, incorrect: 1, failed: 0, timed_out: 1 });
      expect(result.runs[0]!.current.tasks.find(task => task.kind === 'timeout')).toMatchObject({ outcome: 'timed_out', cleanupComplete: true });
    }
  } finally { log.mockRestore(); }
}, 15000);

it('runs the compiled harness in a source-free installed package without Git or tsx', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-built-workload-'));
  try {
    await mkdir(join(root, 'dist/local'), { recursive: true });
    await mkdir(join(root, '.config'));
    await writeFile(join(root, '.config', 'secret.json'), 'must never enter fingerprints');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'usegrunt', version: '0.0.0-fixture', type: 'module' }));
    for (const name of ['workload-benchmark', 'fallback-replay']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(root, 'dist/local', `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText);
    }
    // This fixed local runtime makes packaging behavior testable without compiling
    // the whole project or loading any provider modules in a child process.
    await writeFile(join(root, 'dist/local/source.js'), `export class SourceError extends Error { constructor(code, message) { super(message); this.code = code; } }
export class Sources {
  constructor(sources) { this.sources = sources; }
  async complete(request, signal) {
    if (request.cwd.endsWith('task-1')) await new Promise(done => setTimeout(done, 70));
    for (const source of this.sources) { try { return await source.complete(request, signal); } catch (error) { if (signal.aborted) throw error; } }
    throw new SourceError('upstream', 'Synthetic sources exhausted');
  }
  async close() { await Promise.all(this.sources.map(source => source.close?.())); }
}`);
    const invoke = () => promisify(execFile)(process.execPath, [join(root, 'dist/local/workload-benchmark.js'), '--baseline', root, '--repetitions', '1', '--tasks', '4', '--concurrency', '1', '--task-deadline-ms', '2000'], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const first = JSON.parse((await invoke()).stdout);
    expect(first.manifest.timing.taskDeadlineMs).toBe(2000);
    expect(first.identities.current).toMatchObject({ version: '0.0.0-fixture', commit: null, runtimeFormat: 'built', entrypoint: 'dist/local/source.js' });
    expect(first.identities.baseline).toEqual(first.identities.current);
    expect(first.runs[0].current.outcomes.verified).toBe(4);
    expect(first.runs[0].baseline.outcomes.verified).toBe(4);
    await writeFile(join(root, '.config', 'secret.json'), 'different secret must remain excluded');
    const second = JSON.parse((await invoke()).stdout);
    expect(second.identities.current.codeTreeDigest).toBe(first.identities.current.codeTreeDigest);
    for (const name of ['grunt-runtime', 'milo-runtime']) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0-fixture', type: 'module' }));
      const installed = JSON.parse((await invoke()).stdout);
      expect(installed.identities.current).toMatchObject({ version: '0.0.0-fixture', commit: null, runtimeFormat: 'built' });
      expect(installed.runs[0].current.outcomes.verified).toBe(4);
    }
    await rm(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'src/local'), { recursive: true });
    await writeFile(join(root, 'src/local/source.ts'), 'export class Sources {}');
    await expect(loadWorkloadRuntime(root, 'built')).rejects.toThrow('source harness with --import tsx');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
