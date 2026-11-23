import { expect, it } from 'vitest';
import { replayRoutingCohorts, runRoutingReplay } from '../../scripts/routing-replay-benchmark.js';

it('replays mixed workloads without borrowing aggregate evidence and keeps failed-call cost', async () => {
  const result = await replayRoutingCohorts();
  const [cold, sparse, matched] = result.scenarios;
  expect(cold?.weights).toEqual({ 'synthetic-a': 1, 'synthetic-b': 1 });
  expect(cold?.selections).toEqual({ 'synthetic-a': 500, 'synthetic-b': 500 });
  expect(sparse?.weights).toEqual(cold?.weights);
  expect(matched?.weights).toEqual({ 'synthetic-a': .25, 'synthetic-b': 4 });
  expect(matched?.selections).toEqual({ 'synthetic-a': 59, 'synthetic-b': 941 });
  expect(result.matchingFailureCost.afterFailure).toBeLessThan(result.matchingFailureCost.beforeFailure / 10);
  expect(result.matchingFailureCost.afterUnrelatedSuccesses).toBe(result.matchingFailureCost.afterFailure);
  expect(await replayRoutingCohorts()).toEqual(result);
});

it('rejects unbounded or remote baseline options before importing a runtime', async () => {
  await expect(runRoutingReplay(['--url', 'https://example.invalid'])).rejects.toThrow('Usage:');
  await expect(runRoutingReplay(['--baseline'])).rejects.toThrow('Usage:');
});
