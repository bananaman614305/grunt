/** Offline cohort replay. Every provider, result, duration and held-out cost is synthetic. */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceStatus } from '../src/local/source-status.js';
import { SourceError } from '../src/local/source.js';
import { withRoutingWorkload } from '../src/local/routing-history.js';
import type { RoutingWorkload } from '../src/local/routing-history.js';
import type { ModelRequest, Source } from '../src/local/source.js';

type Observer = Pick<SourceStatus, 'complete' | 'routingWeight'>;
export interface ReplayRuntime {
  SourceStatus: new (ids: readonly string[], now: () => number) => Observer;
  withRoutingWorkload: typeof withRoutingWorkload;
}
const current: ReplayRuntime = { SourceStatus, withRoutingWorkload };
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Synthetic workload observation.' }], tools: [], cwd: '/synthetic', stream: false };
const ids = ['synthetic-a', 'synthetic-b'] as const;
export async function replayRoutingCohorts(runtime: ReplayRuntime = current) {
  let now = 1000;
  const status = new runtime.SourceStatus(ids, () => now);
  const observe = async (id: string, workload: RoutingWorkload, duration: number, failed = false) => {
    const source: Source = { id, available: async () => true, complete: async () => {
      now += duration;
      if (failed) throw new SourceError('upstream', 'Synthetic failure.');
      return { text: 'Synthetic response.' };
    } };
    await runtime.withRoutingWorkload(workload, () => status.complete(source, request, new AbortController().signal)).catch(() => {});
  };
  const result = (scenario: string) => {
    const weights = ids.map(id => status.routingWeight(id, false, 'interactive-tools'));
    const selections = [0, 0], draws = 1000, heldOutCostsMs = [90000, 2000];
    for (let i = 0; i < draws; i++) {
      const choice = (i + .5) / draws < weights[0]! / (weights[0]! + weights[1]!) ? 0 : 1;
      selections[choice] = selections[choice]! + 1;
    }
    return { scenario, workload: 'interactive-tools' as const, draws,
      weights: Object.fromEntries(ids.map((id, i) => [id, weights[i]])),
      selections: Object.fromEntries(ids.map((id, i) => [id, selections[i]])),
      simulatedMeanHeldOutMs: selections.reduce((sum, count, i) => sum + count * heldOutCostsMs[i]!, 0) / draws };
  };
  // Text samples deliberately have the opposite ordering from held-out tool
  // costs. This stress fixture exposes cross-workload leakage; it is not a
  // forecast of a provider's performance or a measured live speedup.
  for (let i = 0; i < 5; i++) {
    await observe(ids[0], 'interactive-text', 1000);
    await observe(ids[1], 'interactive-text', 60000);
  }
  const scenarios = [result('cold-tools-after-text-history')];
  await observe(ids[0], 'interactive-tools', 90000);
  await observe(ids[1], 'interactive-tools', 2000);
  scenarios.push(result('one-matching-tool-observation'));
  await observe(ids[0], 'interactive-tools', 90000);
  await observe(ids[1], 'interactive-tools', 2000);
  scenarios.push(result('two-matching-tool-observations'));
  const beforeFailure = status.routingWeight(ids[1], false, 'interactive-tools');
  await observe(ids[1], 'interactive-tools', 180000, true);
  const afterFailure = status.routingWeight(ids[1], false, 'interactive-tools');
  for (let i = 0; i < 5; i++) await observe(ids[1], 'background-text', 250);
  return { scenarios, matchingFailureCost: { beforeFailure, afterFailure,
    afterUnrelatedSuccesses: status.routingWeight(ids[1], false, 'interactive-tools') } };
}
export async function runRoutingReplay(args: string[]) {
  if (args.length && (args.length !== 2 || args[0] !== '--baseline')) throw new Error('Usage: routing-replay-benchmark.ts [--baseline /trusted/local/checkout]');
  const roots = [{ name: 'current', path: fileURLToPath(new URL('..', import.meta.url)), runtime: current }];
  if (args[1]) {
    const path = await realpath(resolve(args[1]));
    const [status, history] = await Promise.all([import(pathToFileURL(join(path, 'src/local/source-status.ts')).href), import(pathToFileURL(join(path, 'src/local/routing-history.ts')).href)]);
    roots.unshift({ name: 'baseline', path, runtime: { SourceStatus: status.SourceStatus, withRoutingWorkload: history.withRoutingWorkload } });
  }
  const implementations = [];
  for (const root of roots) implementations.push({ implementation: root.name,
    sourceSha256: Object.fromEntries(await Promise.all(['source-status.ts', 'routing-history.ts'].map(async file =>
      [file, createHash('sha256').update(await readFile(join(root.path, 'src/local', file))).digest('hex')]))),
    ...await replayRoutingCohorts(root.runtime) });
  return { version: 1, kind: 'offline-routing-cohort-replay', implementations,
    limitations: 'Synthetic fixed-duration observations and deterministic weighted draws, not live requests or throughput. Opposing workload rankings are a stress fixture, not provider ranking evidence. Existing failure-cost accounting is verified, not newly introduced. No network, account, quota, game or live routing operations.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await runRoutingReplay(process.argv.slice(2)), null, 2) + '\n');
}
