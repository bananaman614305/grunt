import { expect, it } from 'vitest';
import { parallelMap, SETUP_CONCURRENCY } from './parallel.js';

it('overlaps six setup jobs while preserving order and waiting for started work after a failure', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  let active = 0, peak = 0;
  const result = parallelMap(Array.from({ length: 18 }, (_, i) => i), async i => {
    started.push(i); active++; peak = Math.max(peak, active);
    await hold; active--;
    if (i === 0) throw new Error('one provider refused');
    return i;
  }, SETUP_CONCURRENCY);
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  release();
  await expect(result).rejects.toThrow('one provider refused');
  expect(peak).toBe(6); expect(active).toBe(0);
  expect(started).toEqual(Array.from({ length: 18 }, (_, i) => i));
});

it('returns results in catalog order when concurrent setup finishes out of order', async () => {
  const releases: (() => void)[] = [];
  const result = parallelMap([0, 1, 2], async i => {
    await new Promise<void>(resolve => { releases[i] = resolve; });
    return `provider-${i}`;
  }, SETUP_CONCURRENCY);
  releases[2]!(); releases[0]!(); releases[1]!();
  await expect(result).resolves.toEqual(['provider-0', 'provider-1', 'provider-2']);
});
