import { expect, it } from 'vitest';
import { SourceStatus } from './source-status.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { routingWorkloads, withRoutingWorkload } from './routing-history.js';
import type { RoutingWorkload } from './routing-history.js';

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Synthetic routing observation.' }], tools: [], cwd: '/tmp', stream: false };
function fixture() {
  let now = 1000;
  const status = new SourceStatus(['kilo'], () => now);
  const record = async (workload: RoutingWorkload, duration: number, code?: 'upstream' | 'quota') => {
    const source: Source = { id: 'kilo', available: async () => true, complete: async () => {
      now += duration;
      if (code) throw new SourceError(code, 'Synthetic routing observation.');
      return { text: 'Synthetic response.' };
    } };
    await withRoutingWorkload(workload, () => status.complete(source, request, new AbortController().signal)).catch(() => {});
  };
  return { status, record };
}

it.each(routingWorkloads)('does not borrow unrelated completed-call cost for a cold %s cohort', async workload => {
  const f = fixture(), unrelated = routingWorkloads.find(value => value !== workload)!;
  for (let i = 0; i < 5; i++) await f.record(unrelated, 1000);
  expect(f.status.routingWeight('kilo')).toBeGreaterThan(1);
  expect(f.status.routingWeight('kilo', workload.startsWith('background'), workload)).toBe(1);
});

it('keeps one matching observation neutral instead of substituting the mixed aggregate', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.record('interactive-text', 1000);
  await f.record('interactive-tools', 120000);
  expect(f.status.routingWeight('kilo', false, 'interactive-tools')).toBe(1);
  await f.record('interactive-tools', 120000);
  expect(f.status.routingWeight('kilo', false, 'interactive-tools')).toBe(.25);
});

it('keeps matching failure cost authoritative while excluding quota waits from performance', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.record('interactive-tools', 1000);
  const healthy = f.status.routingWeight('kilo', false, 'interactive-tools');
  await f.record('interactive-tools', 180000, 'upstream');
  const failed = f.status.routingWeight('kilo', false, 'interactive-tools');
  expect(failed).toBeLessThan(healthy / 10);
  await f.record('interactive-tools', 60000, 'quota');
  expect(f.status.routingWeight('kilo', false, 'interactive-tools')).toBe(failed);
  for (let i = 0; i < 5; i++) await f.record('background-text', 250);
  expect(f.status.routingWeight('kilo', false, 'interactive-tools')).toBe(failed);
});
