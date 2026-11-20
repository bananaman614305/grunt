import { expect, it, vi } from 'vitest';
import { createRuntimeRoutingHistory } from './runtime-routing.js';
import type { RoutingHistory } from './routing-history.js';

it('loads observations before readiness and flushes once before closing the shared store', async () => {
  const order: string[] = [];
  const history = { close: vi.fn(async () => { order.push('close'); }) } as unknown as RoutingHistory;
  const sources = {
    setRoutingHistory: vi.fn(async (value: RoutingHistory) => { expect(value).toBe(history); order.push('attach'); }),
    flushRoutingHistory: vi.fn(async () => { order.push('flush'); })
  };
  const runtime = createRuntimeRoutingHistory(sources, { directory: '/synthetic/private', open: async () => history });
  await runtime.ready;
  expect(order).toEqual(['attach']);
  await Promise.all([runtime.close(), runtime.close()]);
  expect(order).toEqual(['attach', 'flush', 'close']);
});

it('keeps the daemon usable after a history storage failure without leaking the error', async () => {
  const sources = { setRoutingHistory: vi.fn(), flushRoutingHistory: vi.fn(async () => {}) };
  const notify = vi.fn();
  const runtime = createRuntimeRoutingHistory(sources, {
    directory: '/synthetic/private', notify,
    open: async () => { throw new Error('private-path-token-and-database-details'); }
  });
  await expect(runtime.ready).resolves.toBeUndefined();
  expect(sources.setRoutingHistory).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('Routing history is unavailable; using current-session observations.');
  expect(JSON.stringify(notify.mock.calls)).not.toContain('private-path-token');
  await runtime.close();
});

it('waits for an in-progress open when shutdown begins during startup', async () => {
  let finish!: (value: RoutingHistory) => void;
  const history = { close: vi.fn(async () => {}) } as unknown as RoutingHistory;
  const sources = { setRoutingHistory: vi.fn(async () => {}), flushRoutingHistory: vi.fn(async () => {}) };
  const runtime = createRuntimeRoutingHistory(sources, {
    directory: '/synthetic/private', open: () => new Promise(resolve => { finish = resolve; })
  });
  const closed = runtime.close();
  expect(sources.flushRoutingHistory).not.toHaveBeenCalled();
  finish(history);
  await closed;
  expect(sources.setRoutingHistory).toHaveBeenCalledWith(history);
  expect(sources.flushRoutingHistory).toHaveBeenCalledTimes(1);
  expect(history.close).toHaveBeenCalledTimes(1);
});
