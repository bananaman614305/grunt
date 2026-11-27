import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { RoutingHistory } from './routing-history.js';
import { bundledRegistry } from '../registry.js';

const roots: string[] = [], stores: RoutingHistory[] = [], pools: Sources[] = [];
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'synthetic' }], tools: [], cwd: '/tmp', stream: false };
const fake = (id: string): Source => ({ id, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: id })) });
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function restarted(now: number, until: number) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-mixed-cooldown-')); roots.push(directory);
  const seed = await RoutingHistory.open(directory);
  await seed.failure('perch', new SourceError('quota', 'Preserved runtime cooldown'), (until - now) / 1000, false, now);
  await seed.close();
  const store = await RoutingHistory.open(directory); stores.push(store);
  const legacy = fake('codex'), held = fake('perch'), fallback = fake('kilo');
  const pool = new Sources([legacy, held, fallback]); pools.push(pool);
  pool.setChainRegistry(() => ({ ...bundledRegistry, adapters: bundledRegistry.adapters.filter(row => ['perch', 'kilo'].includes(row.id)) }));
  await pool.setRoutingHistory(store);
  return { pool, legacy, held, fallback, store };
}

it('exposes exact cold-restored quota deadlines in a mixed fixed-chain status without disabling legacy sources', async () => {
  const now = 1795213386458, until = 1795219200875;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { pool, legacy, held, fallback, store } = await restarted(now, until);
  expect(pool.status().sources.find(row => row.id === 'perch')).toMatchObject({ state: 'limited', errorCode: 'quota', retryAt: until });
  expect(pool.status().sources.find(row => row.id === 'codex')?.state).not.toBe('disabled');
  for (const source of [legacy, held, fallback]) {
    expect(source.available).not.toHaveBeenCalled(); expect(source.complete).not.toHaveBeenCalled();
  }
  expect((await store.snapshot(now)).performance).toEqual([]);
});

it('honors restored quota before a mixed foreground attempt and resumes the same fixed order after expiry', async () => {
  let now = 10000; const until = 70003;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { pool, legacy, held, fallback } = await restarted(now, until);
  const order: string[] = [];
  vi.mocked(legacy.complete).mockImplementation(async () => { order.push('codex'); throw new SourceError('upstream', 'synthetic'); });
  vi.mocked(held.complete).mockImplementation(async () => { order.push('perch'); return { text: 'perch' }; });
  vi.mocked(fallback.complete).mockImplementation(async () => { order.push('kilo'); return { text: 'kilo' }; });
  await expect(pool.complete({ ...request, model: 'perch' }, new AbortController().signal)).rejects.toBeInstanceOf(SourceError);
  expect(held.available).not.toHaveBeenCalled(); expect(held.complete).not.toHaveBeenCalled();
  expect((await pool.complete(request, new AbortController().signal)).text).toBe('kilo');
  expect(order).toEqual(['codex', 'kilo']);
  now = until + 1; order.length = 0;
  expect((await pool.complete(request, new AbortController().signal)).text).toBe('perch');
  expect(order).toEqual(['codex', 'perch']);
});
