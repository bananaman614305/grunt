import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDataSharingConsent, recordDataSharingConsent } from './data-sharing.js';
import { beginSetupSession, readSetupSession } from './setup-session.js';
import { SourceRecovery } from './recovery.js';
import { SourceError, Sources } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Source } from './source.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'grunt-recovery-')); dirs.push(dir); return dir; };
// Once setup has been observed, lease release marks the end of the pass.
const finished = (dir: string) => vi.waitFor(async () => {
  expect(await readSetupSession(dir)).toBeUndefined();
});

describe('source recovery', () => {
  it('adds providers with default or recorded data-sharing approval, one run at a time', async () => {
    const dir = await directory();
    await recordDataSharingConsent(dir, ['kilo']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = vi.fn(async () => { await gate; return { unavailable: [] }; });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kilo', 'perch', 'kenari', 'zro'], open: async () => 0, notify: () => {}, setup });
    recovery.trigger(); recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    expect(setup.mock.calls[0]![0]).toMatchObject({ adapters: ['kilo'], background: true });
    release();
    await vi.waitFor(() => expect(setup.mock.calls.map(call => (call as unknown as [{ adapters: string[] }])[0].adapters)).toEqual([['kilo'], ['perch'], ['kenari'], ['zro']]));
    expect(await readDataSharingConsent(dir, ['perch', 'kenari'])).toEqual(['perch', 'kenari']);
    await recovery.close();
    recovery.trigger();
    expect(setup).toHaveBeenCalledTimes(4);
  });

  it('reports the route it is signing up, so status can show it connecting', async () => {
    const dir = await directory();
    const seen: (string | undefined)[] = [];
    const opening = vi.fn((id: string | undefined) => { seen.push(id); });
    const setup = vi.fn(async (options: { adapters?: string[] }) => {
      expect(seen.at(-1)).toBe(options.adapters![0]);
      if (options.adapters![0] === 'perch') throw new Error('squire unavailable');
      return { unavailable: [] };
    });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['perch', 'zro'], open: async () => 0, notify: () => {}, opening, setup });
    recovery.trigger();
    await vi.waitFor(() => expect(seen).toEqual(['perch', undefined, 'zro', undefined]));
    await recovery.close();
  });

  it('skips explicit policies and revokes their receipts under the opt-out', async () => {
    vi.stubEnv('GRUNT_SETUP_NO_DATA_SHARING', '1');
    const dir = await directory();
    await recordDataSharingConsent(dir, ['kilo']);
    const setup = vi.fn();
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kenari', 'kilo'], open: async () => 0, notify: () => {}, setup });
    recovery.trigger();
    await vi.waitFor(async () => expect(await readDataSharingConsent(dir, ['kenari', 'kilo'])).toEqual([]));
    await recovery.close();
    expect(setup).not.toHaveBeenCalled();
  });

  it('keeps running after a failed run so the next exhaustion can try again', async () => {
    const dir = await directory();
    await recordDataSharingConsent(dir, ['kilo']);
    const setup = vi.fn().mockRejectedValueOnce(new Error('squire unavailable')).mockResolvedValue({ unavailable: [] });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kilo'], open: async () => 0, notify: () => {}, setup });
    recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    await finished(dir);
    recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
    await recovery.close();
    quiet.mockRestore();
  });
});

describe('low open routes', () => {
  const adapters = (setup: ReturnType<typeof vi.fn>) => setup.mock.calls.map(call => (call as unknown as [{ adapters: string[] }])[0].adapters[0]);

  it('starts a pass when a drop leaves fewer than two routes open', async () => {
    const dir = await directory();
    let open = 2;
    const setup = vi.fn(async () => { open++; return { unavailable: [] }; });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['zro'], open: async () => open, notify: () => {}, setup });
    await recovery.lowRoutes();
    expect(setup).not.toHaveBeenCalled();
    open = 1;
    await recovery.lowRoutes();
    await vi.waitFor(() => expect(adapters(setup)).toEqual(['zro']));
    await recovery.close();
  });

  it('joins a running pass instead of starting a second one', async () => {
    const dir = await directory();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = vi.fn(async () => { await gate; return { unavailable: [] }; });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['zro', 'livekit'], open: async () => 0, notify: () => {}, setup });
    recovery.synced();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    await recovery.lowRoutes(); await recovery.lowRoutes();
    release();
    await vi.waitFor(() => expect(adapters(setup)).toEqual(['zro', 'livekit']));
    await recovery.close();
  });

  it.each(['unavailable', 'throw'])('skips a failed signup (%s) until the next registry sync', async failure => {
    const dir = await directory();
    const setup = vi.fn(async () => {
      if (failure === 'throw') throw new Error('signup failed');
      return { unavailable: ['zro'] };
    });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['zro'], open: async () => 0, notify: () => {}, setup });
    await recovery.lowRoutes();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    await finished(dir);
    for (let flap = 0; flap < 3; flap++) { await recovery.lowRoutes(); }
    expect(setup).toHaveBeenCalledTimes(1);
    // The 6 h registry pass is unchanged: it retries the failed signup.
    recovery.synced();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
    await finished(dir);
    // Request-failure triggers keep their behavior too.
    recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(3));
    await recovery.close();
  });

  it('reacquires a successful signup after it becomes a candidate again', async () => {
    const dir = await directory();
    let open = 1;
    const setup = vi.fn(async () => { open++; return { unavailable: [] }; });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => open < 2 ? ['zro'] : [], open: async () => open, notify: () => {}, setup });
    await recovery.lowRoutes();
    await vi.waitFor(() => expect(open).toBe(2));
    await finished(dir);
    expect(adapters(setup)).toEqual(['zro']);
    open = 1;
    await recovery.lowRoutes();
    await vi.waitFor(() => expect(open).toBe(2));
    expect(adapters(setup)).toEqual(['zro', 'zro']);
    await recovery.close();
  });

  it.each(['primary', 'worker', 'fixed', 'maintenance'])('reports one quota hold before backoff in %s routing', async mode => {
    const ids = mode === 'primary' ? ['opencode', 'kilo'] : ['zro', 'livekit'];
    const registry = { ...bundledRegistry, adapters: ids.map(id => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, weight: 0.5 })) };
    const limited: Source = { id: ids[0]!, available: async () => true, complete: async () => { throw new SourceError('quota', 'Quota exhausted', 120); } };
    const healthy: Source = { id: ids[1]!, available: async () => true, complete: async () => ({ text: 'ok' }) };
    const fixed = mode === 'fixed';
    const sources = new Sources([limited, healthy], fixed ? undefined : { registry: () => registry, random: () => 0 });
    if (fixed) sources.setWorkerRegistry(() => registry);
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    const request = { model: 'grunt', cwd: process.cwd(), messages: [{ role: 'user' as const, content: 'hi' }], tools: [], stream: false,
      ...(mode === 'worker' ? { worker: { id: 'quota-worker', onSource: () => {} } } : {}) };
    try {
      if (mode === 'maintenance') {
        expect(await sources.check(limited.id, AbortSignal.timeout(1000))).toMatchObject({ outcome: 'failed', code: 'quota' });
        expect(await sources.check(limited.id, AbortSignal.timeout(1000))).toMatchObject({ outcome: 'deferred', code: 'quota' });
      }
      expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'ok' });
      expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'ok' });
      expect(sources.dispatchEligible(limited.id)).toBe(false);
      expect(sources.dispatchEligible(healthy.id)).toBe(true);
      expect(dropped.mock.calls).toEqual([[limited.id]]);
    } finally { await sources.close(); }
  });

  it('reports a route once when a failure benches it', async () => {
    const registry = { ...bundledRegistry, adapters: ['opencode', 'kilo'].map(id => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, weight: 0.5 })) };
    const quota = (id: string): Source => ({ id, available: async () => true, complete: async () => { throw new SourceError('quota', `${id} is out of quota`); } });
    const sources = new Sources([quota('opencode'), quota('kilo')], { registry: () => registry, random: () => 0 });
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    const request = { model: 'grunt', cwd: '/tmp', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], stream: false };
    await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
    await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(dropped.mock.calls.map(([id]) => id).sort()).toEqual(['kilo', 'opencode']);
    await sources.close();
  });

  it.each(['false', 'throw', 'quota', 'quota-with-retry'])('reports an availability loss once per transition (%s)', async mode => {
    let available = true;
    let now = 1000;
    const lost: Source = { id: 'zro', available: async () => {
      if (available) return true;
      if (mode === 'throw') throw new SourceError('logged_out', 'Credentials revoked');
      if (mode.startsWith('quota')) throw new SourceError('quota', 'Quota exhausted', mode === 'quota-with-retry' ? 120 : undefined);
      return false;
    }, complete: async () => ({ text: 'zro' }) };
    const healthy: Source = { id: 'opencode', available: async () => true, complete: async () => ({ text: 'ok' }) };
    const sources = new Sources([lost, healthy], { registry: () => bundledRegistry, random: () => 0, now: () => now });
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    const probe = async () => {
      if (!available && mode === 'throw') await expect(sources.models()).rejects.toThrow('Credentials revoked');
      else await sources.models();
    };
    try {
      await probe();
      expect(dropped).not.toHaveBeenCalled();
      expect(sources.openRoute('zro')).toBe(true);
      available = false;
      await probe();
      await probe();
      expect(dropped.mock.calls).toEqual([['zro']]);
      expect(sources.openRoute('zro')).toBe(false);
      expect(sources.openRoute('opencode')).toBe(true);
      expect(await sources.complete({ model: 'grunt', cwd: process.cwd(), messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false }, AbortSignal.timeout(1000))).toEqual({ text: 'ok' });
      expect(dropped).toHaveBeenCalledTimes(1);
      available = true;
      now += 121000;
      await probe();
      expect(sources.openRoute('zro')).toBe(true);
      available = false;
      await probe();
      await probe();
      expect(dropped.mock.calls).toEqual([['zro'], ['zro']]);
    } finally { await sources.close(); }
  });

  it.each(['logged_out', 'not_installed', 'upstream', 'timeout'] as const)('reports non-quota maintenance loss once (%s)', async code => {
    const lost: Source = { id: 'zro', available: async () => true, complete: async () => { throw new SourceError(code, 'Maintenance failed'); } };
    const sources = new Sources([lost], { registry: () => bundledRegistry });
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    try {
      await sources.models();
      await sources.check('zro', AbortSignal.timeout(1000));
      await sources.check('zro', AbortSignal.timeout(1000));
      expect(dropped.mock.calls).toEqual([['zro']]);
      expect(sources.openRoute('zro')).toBe(false);
      await sources.models();
      expect(sources.openRoute('zro')).toBe(true);
      await sources.check('zro', AbortSignal.timeout(1000));
      expect(dropped.mock.calls).toEqual([['zro'], ['zro']]);
    } finally { await sources.close(); }
  });

  it('starts acquisition after a maintenance loss leaves one open route', async () => {
    const dir = await directory();
    let available = true;
    const lost: Source = { id: 'zro', available: async () => available, complete: async () => { available = false; throw new SourceError('logged_out', 'Credentials rejected'); } };
    const healthy: Source = { id: 'opencode', available: async () => true, complete: async () => ({ text: 'ok' }) };
    const sources = new Sources([lost, healthy], { registry: () => bundledRegistry });
    const setup = vi.fn(async () => ({ unavailable: ['livekit'] }));
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['livekit'],
      open: async () => (await Promise.all(sources.sources.map(async source => await sources.available(source) && sources.openRoute(source.id)))).filter(Boolean).length,
      notify: () => {}, setup });
    sources.setRouteDropped(() => { void recovery.lowRoutes(); });
    try {
      await sources.models();
      await sources.check('zro', AbortSignal.timeout(1000));
      await vi.waitFor(() => expect(adapters(setup)).toEqual(['livekit']));
    } finally { await recovery.close(); await sources.close(); }
  });

  it.each([[0, 5, 1], [120001, 6, 0]])('counts fresh access after a quota hold advances %i ms', async (elapsed, expectedOpen, expectedSignups) => {
    const dir = await directory();
    let now = 1000;
    const providers: Source[] = ['zro', 'kilo', 'opencode', 'runcrate', 'tokenharbor', 'pollinations'].map(id => ({
      id, supportsFunctionTools: true, available: async () => true,
      complete: async () => { if (id === 'zro') throw new SourceError('quota', 'Quota exhausted', 120); return { text: 'ok' }; },
    }));
    const sources = new Sources(providers, { registry: () => bundledRegistry, now: () => now });
    const setup = vi.fn(async () => ({ unavailable: ['livekit'] }));
    const live = async (source: Source) => await sources.available(source) && sources.openRoute(source.id);
    const open = async () => (await Promise.all(providers.map(live))).filter(Boolean).length;
    const recoveryOpen = vi.fn(open);
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['livekit'], open: recoveryOpen, notify: () => {}, setup });
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    try {
      expect(await open()).toBe(6);
      expect(await sources.check('zro', AbortSignal.timeout(1000))).toMatchObject({ outcome: 'failed', code: 'quota' });
      expect(sources.openRoute('zro')).toBe(false);
      now += elapsed;
      expect(await open()).toBe(expectedOpen);
      expect(await live(providers[0]!)).toBe(elapsed > 120000);
      recovery.synced();
      if (expectedSignups) await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(expectedSignups));
      else await vi.waitFor(() => expect(recoveryOpen).toHaveBeenCalledTimes(1));
      await finished(dir);
      await recovery.close();
      expect(setup).toHaveBeenCalledTimes(expectedSignups);
      expect(dropped.mock.calls).toEqual([['zro']]);
    } finally { await recovery.close(); await sources.close(); }
  });

  it.each(['upstream', 'quota'] as const)('preserves a newer maintenance failure during an access check (%s)', async code => {
    let release!: (available: boolean) => void;
    const source: Source = { id: 'zro', available: vi.fn(async () => true), complete: async () => { throw new SourceError(code, 'Maintenance failed', code === 'quota' ? 120 : undefined); } };
    const sources = new Sources([source], { registry: () => bundledRegistry });
    const dropped = vi.fn();
    sources.setRouteDropped(dropped);
    try {
      await sources.models();
      vi.mocked(source.available).mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
      const checking = sources.available(source);
      expect(await sources.check('zro', AbortSignal.timeout(1000))).toMatchObject({ outcome: 'failed', code });
      release(true);
      expect(await checking).toBe(true);
      expect(sources.openRoute('zro')).toBe(false);
      expect(dropped.mock.calls).toEqual([['zro']]);
    } finally { await sources.close(); }
  });
});

describe('Sources recovery trigger', () => {
  const failing = (id: string, code: SourceError['code']): Source => ({
    id, available: async () => false, complete: async () => { throw new SourceError(code, `${id} cannot answer`); }
  });
  const request = { model: 'grunt', cwd: '/tmp', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], stream: false };

  it('starts recovery when no source can answer', async () => {
    const recover = vi.fn();
    const sources = new Sources([failing('opencode', 'quota')]);
    sources.setRecovery(recover);
    await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow('cannot answer');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('does not start recovery for a refusal or a timeout', async () => {
    const recover = vi.fn();
    for (const code of ['refused', 'timeout'] as const) {
      const sources = new Sources([failing('opencode', code)]);
      sources.setRecovery(recover);
      await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
    }
    expect(recover).not.toHaveBeenCalled();
  });

  it('does not start recovery when a source answers', async () => {
    const recover = vi.fn();
    const sources = new Sources([{ id: 'opencode', available: async () => true, complete: async () => ({ text: 'ok' }) }]);
    sources.setRecovery(recover);
    expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'ok' });
    expect(recover).not.toHaveBeenCalled();
  });
});

it('owns the setup lease during discovery and every signup, then releases it', async () => {
  const dir = await directory();
  let releaseDiscovery!: () => void;
  let discovered!: () => void;
  const discovering = new Promise<void>(resolve => { discovered = resolve; });
  const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  const setup = vi.fn(async () => {
    await expect(beginSetupSession(dir, ['zro'])).rejects.toThrow('Cannot coordinate');
    done();
    return { unavailable: [] };
  });
  const recovery = new SourceRecovery({ directory: dir, candidates: async () => {
    discovered(); await discoveryGate; return ['zro'];
  }, open: async () => 0, setup, notify: () => {} });
  try {
    recovery.trigger();
    await discovering;
    await expect(beginSetupSession(dir, ['zro'])).rejects.toThrow('Cannot coordinate');
    releaseDiscovery();
    await completed;
    await recovery.close();
    expect(setup).toHaveBeenCalledOnce();
    const foreground = await beginSetupSession(dir, ['zro']);
    await foreground.close();
  } finally { releaseDiscovery(); await recovery.close(); }
});


it.each(['reused', 'unavailable', 'pre-signup error'])('does not count a %s setup result as a signup', async outcome => {
  const dir = await directory(), signedUp = vi.fn();
  const setup = vi.fn(async () => {
    if (outcome === 'pre-signup error') throw new Error('vault unavailable');
    return { unavailable: outcome === 'unavailable' ? ['goedel'] : [] };
  });
  const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['goedel'], open: async () => 0, notify: () => {}, setup, signedUp });
  try {
    recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    await recovery.close();
    expect(signedUp).not.toHaveBeenCalled();
  } finally { await recovery.close(); }
});
