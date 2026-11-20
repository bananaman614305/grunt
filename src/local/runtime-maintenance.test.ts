import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sources } from './source.js';
import { createSourceMaintenance } from './runtime-maintenance.js';
import { recordDataSharingConsent } from './data-sharing.js';
import type { SetupSessionState } from './setup-session.js';

const directories: string[] = [], queues: ReturnType<typeof createSourceMaintenance>[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime('2026-11-20T12:00:00Z'); });
afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.close())); vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(ids = ['numes'], refreshSession?: () => Promise<SetupSessionState | undefined>) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-runtime-maintenance-')); directories.push(directory);
  const sources = new Sources(ids.map(id => ({ id, available: async () => true, complete: async () => ({ text: 'synthetic' }) })));
  const check = vi.spyOn(sources, 'check').mockResolvedValue({ outcome: 'passed', evidence: 'reply' });
  const queue = createSourceMaintenance(sources, { directory, ...(refreshSession ? { refreshSession } : {}) }); queues.push(queue);
  return { directory, sources, check, queue };
}
async function settled(test: () => boolean) {
  for (let attempt = 0; attempt < 2000; attempt++) { if (test() && vi.getTimerCount() === 1) return; await delay(1); }
  throw new Error('Maintenance did not settle');
}

it('covers every installed vetted source including additional runtime sources and keeps custom sources excluded', async () => {
  const ids = ['nous', 'kenari', 'numes', 'goedel', 'antseed-vikey', 'reflection-beam'];
  const f = await fixture([...ids, 'freebuff', 'custom']); await f.queue.start();
  expect(Object.keys(f.queue.snapshot())).toEqual(ids);
  expect(f.sources.status().sources.find(source => source.id === 'numes')?.maintenance).toBeDefined();
  expect(f.check).not.toHaveBeenCalled();
});

it('keeps provider-specific consent gating in shared custom runtime wiring', async () => {
  const f = await fixture(); await f.queue.start(); await vi.advanceTimersByTimeAsync(0);
  await settled(() => f.queue.snapshot().numes?.outcome === 'deferred');
  expect(f.queue.snapshot().numes).toMatchObject({ code: 'consent' }); expect(f.check).not.toHaveBeenCalled();
  await recordDataSharingConsent(f.directory, ['numes']); await vi.advanceTimersByTimeAsync(5 * 60000);
  await settled(() => f.queue.snapshot().numes?.outcome === 'passed');
  expect(f.check).toHaveBeenCalledExactlyOnceWith('numes', expect.any(AbortSignal));
});

it('defers the check when foreground setup acquired the provider during the consent read', async () => {
  const refresh = vi.fn<() => Promise<SetupSessionState | undefined>>()
    .mockResolvedValueOnce(undefined).mockResolvedValue({ owned: new Set(['numes']), pending: new Set(), verifying: new Set() });
  const f = await fixture(['numes'], refresh); await recordDataSharingConsent(f.directory, ['numes']);
  await f.queue.start(); await vi.advanceTimersByTimeAsync(0);
  await settled(() => f.queue.snapshot().numes?.outcome === 'deferred');
  expect(f.queue.snapshot().numes).toMatchObject({ code: 'foreground' }); expect(f.check).not.toHaveBeenCalled();
});
