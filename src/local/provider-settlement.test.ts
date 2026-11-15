import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { setupFallbacks } from './fallback-setup.js';
import { BrowserSquire } from './setup.js';
import { DATA_SHARING_POLICIES } from './data-sharing.js';
import { SETUP_CONCURRENCY } from './parallel.js';

type Options = Parameters<typeof setupFallbacks>[0];
const directories: string[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(overrides: Partial<Options> = {}): Promise<Options> {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-provider-settlement-'));
  directories.push(directory);
  return {
    directory, run: async () => {}, notify: () => {}, verify: async () => {},
    dataSharingApproved: DATA_SHARING_POLICIES.map(policy => policy.provider),
    squire: { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } },
    setupProvider: async () => ({}), ...overrides
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('announces a completed provider while another signup still waits', async () => {
  const slow = deferred(), events: [string, boolean][] = [];
  let finished = false;
  const pending = setupFallbacks(await fixture({ adapters: ['kilo', 'zro'],
    setupProvider: async (_notify, providers) => { if (providers?.includes('zro')) await slow.promise; return {}; },
    onSettled: (id, available) => { events.push([id, available]); }
  })).finally(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(events).toEqual([['kilo', true]]));
    expect(finished).toBe(false);
  } finally { slow.resolve(); }
  await expect(pending).resolves.toEqual({ unavailable: [] });
  expect(events).toEqual([['kilo', true], ['zro', true]]);
});

it('starts anonymous routes before a reordered registry can fill every worker with Squire login', async () => {
  const login = deferred(), events: [string, boolean][] = [], started: string[] = [];
  const ids = ['zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'clixad', 'perch', 'opencode', 'kilo'];
  const connect = vi.fn(async () => { await login.promise; });
  const verify = vi.fn(async () => {});
  let finished = false;
  const pending = setupFallbacks(await fixture({ adapters: ids, connect, verify,
    setupProvider: async (_notify, requested) => {
      const id = requested![0]!; started.push(id);
      if (id === 'zro' || id === 'clixad') throw new Error('Free account needs verification');
      return {};
    },
    onSettled: (id, available) => { events.push([id, available]); }
  })).finally(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(events.slice().sort()).toEqual([['kilo', true], ['opencode', true]]));
    expect(started).toEqual(['kilo']);
    expect(verify).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
  } finally { login.resolve(); }
  await expect(pending).resolves.toEqual({ unavailable: ['zro', 'clixad'] });
  expect(events).toHaveLength(ids.length);
  expect(new Set(events.map(([id]) => id)).size).toBe(ids.length);
  expect(connect).toHaveBeenCalledOnce();
});

it('does not occupy a provider worker while an observer verifies a ready route', async () => {
  const providers = deferred(), observer = deferred();
  const ids = ['kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations'];
  const started: string[] = [], events: string[] = [];
  let finished = false;
  const pending = setupFallbacks(await fixture({ adapters: ids,
    setupProvider: async (_notify, requested) => {
      const id = requested![0]!; started.push(id);
      if (id !== 'kilo') await providers.promise;
      return {};
    },
    onSettled: async id => { events.push(id); if (id === 'kilo') await observer.promise; }
  })).finally(() => { finished = true; });
  try {
    // More providers start than the worker limit, although the first callback
    // and every other initially started provider are still waiting.
    await vi.waitFor(() => expect(started).toHaveLength(SETUP_CONCURRENCY + 1));
    expect(events).toEqual(['kilo']);
    expect(finished).toBe(false);
    providers.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(ids.length));
    expect(finished).toBe(false);
  } finally { providers.resolve(); observer.resolve(); }
  await expect(pending).resolves.toEqual({ unavailable: [] });
});

it('settles retired, unapproved and failed providers once without claiming readiness', async () => {
  const events: [string, boolean][] = [], setupProvider = vi.fn<NonNullable<Options['setupProvider']>>(async (_notify, providers) => {
    if (providers?.includes('zro')) throw new Error('Provider refused free access');
    return {};
  });
  const options = await fixture({ adapters: ['kilo', 'kilo', 'zro', 'freebuff', 'apinex', 'beatapi', 'opencode'],
    dataSharingApproved: ['kilo'], setupProvider, onSettled: (id, available) => { events.push([id, available]); }
  });
  await expect(setupFallbacks(options)).resolves.toEqual({ unavailable: ['zro', 'freebuff', 'apinex', 'beatapi', 'opencode'] });
  expect(events.sort()).toEqual([
    ['apinex', false], ['beatapi', false], ['freebuff', false], ['kilo', true], ['opencode', false], ['zro', false]
  ]);
  expect(setupProvider.mock.calls.map(([, providers]) => providers?.[0]).sort()).toEqual(['kilo', 'zro']);
});

it('waits for other providers and observers before surfacing a callback failure and closing Squire', async () => {
  const provider = deferred(), observer = deferred(), observing = deferred();
  const error = new Error('Daemon verification failed');
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  const close = vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const options = await fixture({ adapters: ['zro', 'kilo'],
    setupProvider: async (_notify, providers) => { if (providers?.includes('kilo')) await provider.promise; return {}; },
    onSettled: async id => {
      if (id === 'zro') throw error;
      observing.resolve(); await observer.promise;
    }
  });
  delete options.squire;
  let finished = false;
  const pending = setupFallbacks(options).then(
    value => { finished = true; return { value }; },
    reason => { finished = true; return { reason }; }
  );
  try {
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    provider.resolve(); await observing.promise;
    expect(finished).toBe(false);
    expect(close).not.toHaveBeenCalled();
  } finally { provider.resolve(); observer.resolve(); }
  expect(await pending).toEqual({ reason: error });
  expect(close).toHaveBeenCalledOnce();
});

it('waits for successful provider observers even after an unsupported provider fails', async () => {
  const provider = deferred(), observer = deferred(), observed = deferred();
  const events: [string, boolean][] = [];
  let finished = false;
  const pending = setupFallbacks(await fixture({ adapters: ['unsupported-provider', 'zro'],
    setupProvider: async () => { await provider.promise; return {}; },
    onSettled: async (id, available) => {
      events.push([id, available]);
      if (id === 'zro') { observed.resolve(); await observer.promise; }
    }
  })).then(value => { finished = true; return { value }; }, reason => { finished = true; return { reason }; });
  try {
    await vi.waitFor(() => expect(events).toContainEqual(['unsupported-provider', false]));
    expect(finished).toBe(false);
    provider.resolve(); await observed.promise;
    expect(finished).toBe(false);
  } finally { provider.resolve(); observer.resolve(); }
  expect((await pending as { reason: Error }).reason.message).toBe('Unsupported vetted adapter');
  expect(events).toContainEqual(['zro', true]);
});

it('settles active and unstarted providers as unavailable on cancellation', async () => {
  const hold = deferred(), controller = new AbortController();
  const ids = ['kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations'];
  const started: string[] = [], events: [string, boolean][] = [];
  const pending = setupFallbacks(await fixture({ adapters: ids, signal: controller.signal,
    setupProvider: async (_notify, providers) => { started.push(providers![0]!); await hold.promise; return {}; },
    onSettled: (id, available) => { events.push([id, available]); }
  })).then(value => ({ value }), reason => ({ reason }));
  try {
    await vi.waitFor(() => expect(started).toHaveLength(SETUP_CONCURRENCY));
    controller.abort();
  } finally { hold.resolve(); }
  expect(await pending).toHaveProperty('reason');
  expect(started).toHaveLength(SETUP_CONCURRENCY);
  expect(events).toHaveLength(ids.length);
  expect(new Set(events.map(([id]) => id)).size).toBe(ids.length);
  expect(events.every(([, available]) => available === false)).toBe(true);
});

it('does not claim readiness when setup starts with an already aborted signal', async () => {
  const controller = new AbortController(); controller.abort();
  const events: [string, boolean][] = [], setupProvider = vi.fn(async () => ({}));
  const options = await fixture({ adapters: ['kilo', 'zro'], signal: controller.signal, setupProvider,
    onSettled: (id, available) => { events.push([id, available]); }
  });
  await expect(setupFallbacks(options)).rejects.toThrow();
  expect(setupProvider).not.toHaveBeenCalled();
  expect(events).toEqual([['kilo', false], ['zro', false]]);
});

it('preserves cancellation while awaiting an observer and keeps Squire open until it finishes', async () => {
  const hold = deferred(), observing = deferred(), controller = new AbortController();
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  const close = vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const options = await fixture({ adapters: ['zro'], signal: controller.signal,
    onSettled: async () => { observing.resolve(); await hold.promise; }
  });
  delete options.squire;
  let finished = false;
  const pending = setupFallbacks(options).then(value => { finished = true; return { value }; }, reason => { finished = true; return { reason }; });
  try {
    await observing.promise;
    controller.abort();
    expect(finished).toBe(false);
    expect(close).not.toHaveBeenCalled();
  } finally { hold.resolve(); }
  expect(await pending).toHaveProperty('reason');
  expect(close).toHaveBeenCalledOnce();
});
