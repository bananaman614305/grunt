import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as ClixadSetup from './clixad-setup.js';
import type * as LocalRegistry from './registry.js';

const daemon = vi.hoisted(() => ({
  serve: vi.fn(), serverClose: vi.fn(), syncClose: vi.fn(), finished: vi.fn(),
  pollinations: vi.fn(), beatapi: vi.fn(), clixad: vi.fn(), perch: vi.fn()
}));
vi.mock('@hono/node-server', () => ({ serve: daemon.serve }));
vi.mock('./pollinations-setup.js', () => ({ setupPollinations: daemon.pollinations }));
vi.mock('./beatapi-setup.js', () => ({ setupBeatAPI: daemon.beatapi }));
vi.mock('./clixad-setup.js', async importOriginal => ({ ...await importOriginal<typeof ClixadSetup>(), setupClixad: daemon.clixad }));
vi.mock('./perch-setup.js', () => ({ setupPerch: daemon.perch }));
vi.mock('./registry.js', async importOriginal => {
  const actual = await importOriginal<typeof LocalRegistry>();
  const { bundledRegistry } = await import('../registry.js');
  return { ...actual, RegistrySync: class {
    enabled = bundledRegistry.adapters.filter(adapter => ['pollinations', 'beatapi', 'clixad', 'perch'].includes(adapter.id));
    constructor(options: { ensure?: unknown; afterEnsure?: unknown }) {
      if (options.ensure || options.afterEnsure) throw new Error('Registry downloads must not provision providers');
    }
    async load() {}
    async start() {
      daemon.finished();
    }
    async close() { daemon.syncClose(); }
  } };
});

import { start } from './main.js';
import { BrowserSquire } from './setup.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Sources } from './source.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('restarts registry downloads independently from serial checks without provisioning helpers or Squire', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-background-provisioning-'));
  directories.push(directory);
  const providers = ['pollinations', 'beatapi', 'clixad', 'perch'] as const;
  await recordDataSharingConsent(directory, providers);
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('Daemon restart must not connect a browser'));
  const signup = vi.spyOn(BrowserSquire.prototype, 'signup').mockRejectedValue(new Error('Daemon restart must not sign up'));
  const call = vi.spyOn(BrowserSquire.prototype, 'call').mockRejectedValue(new Error('Daemon restart must not provision'));
  const close = vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const check = vi.spyOn(Sources.prototype, 'check').mockResolvedValue({ outcome: 'passed', evidence: 'reply', lastSuccessAt: Date.now() });
  daemon.serve.mockReturnValue({ close: daemon.serverClose });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previousListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const running = start({ MILO_SOURCES: providers.join(','), MILO_CONFIG_DIR: directory, MILO_PORT: '18792' });
  try {
    await vi.waitFor(() => expect(daemon.finished).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledWith('pollinations', expect.any(AbortSignal));
    // Registry startup no longer creates a provisioning batch. The real daily
    // queue starts only its first access check; the next source waits its gap.
    for (const provider of providers) expect(daemon[provider]).not.toHaveBeenCalled();
    for (const operation of [connect, signup, call, close]) expect(operation).not.toHaveBeenCalled();
  } finally {
    await running.close();
    for (const signal of signals) for (const listener of process.listeners(signal)) {
      if (!previousListeners.get(signal)!.has(listener)) process.removeListener(signal, listener as () => void);
    }
  }
  expect(daemon.serverClose).toHaveBeenCalledOnce();
  expect(daemon.syncClose).toHaveBeenCalledOnce();
});
