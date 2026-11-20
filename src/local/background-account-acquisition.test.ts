import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LocalRegistry from './registry.js';
import type { Registry } from '../registry.js';

const daemon = vi.hoisted(() => ({
  serve: vi.fn(), serverClose: vi.fn(), started: vi.fn(), syncClose: vi.fn(),
  options: undefined as undefined | { changed?: (registry: Registry) => void; synced?: () => void }
}));
vi.mock('@hono/node-server', () => ({ serve: daemon.serve }));
vi.mock('./registry.js', async importOriginal => {
  const actual = await importOriginal<typeof LocalRegistry>();
  return { ...actual, RegistrySync: class {
    constructor(options: { changed?: (registry: Registry) => void; synced?: () => void }) { daemon.options = options; }
    async load() {}
    async start() { daemon.started(); daemon.options?.synced?.(); }
    async close() { daemon.syncClose(); }
  } };
});

import { start } from './main.js';
import { SourceRecovery } from './recovery.js';
import { Sources } from './source.js';
import { BrowserSquire } from './setup.js';
import { bundledRegistry } from '../registry.js';
import { recordDataSharingConsent } from './data-sharing.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.each([
  { settings: { GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '0' }, enabled: false },
  { settings: { MILO_BACKGROUND_ACCOUNT_ACQUISITION: '0' }, enabled: false },
  { settings: { GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '0', MILO_BACKGROUND_ACCOUNT_ACQUISITION: '1' }, enabled: false },
  { settings: {}, enabled: true },
  { settings: { GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '1' }, enabled: true },
  { settings: { GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '1', MILO_BACKGROUND_ACCOUNT_ACQUISITION: '0' }, enabled: true }
])('gates startup/sync and request-failure acquisition without disabling registry or daily health: $settings', async ({ settings, enabled }) => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-account-acquisition-')); directories.push(directory);
  await recordDataSharingConsent(directory, ['pollinations']);
  daemon.serve.mockReturnValue({ close: daemon.serverClose });
  // Synthetic health/recovery only. A failed guard cannot contact a provider,
  // create a browser session or start an account signup from these fixtures.
  const trigger = vi.spyOn(SourceRecovery.prototype, 'trigger').mockImplementation(() => {});
  const setup = vi.spyOn(Sources.prototype, 'setRecovery');
  const check = vi.spyOn(Sources.prototype, 'check').mockResolvedValue({ outcome: 'deferred', code: 'busy' });
  const unretire = vi.spyOn(Sources.prototype, 'unretire');
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('No live browser permitted'));
  const signup = vi.spyOn(BrowserSquire.prototype, 'signup').mockRejectedValue(new Error('No live signup permitted'));
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const original = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const running = start({ GRUNT_SOURCES: 'pollinations', GRUNT_CONFIG_DIR: directory, GRUNT_PORT: '18794', ...settings });
  try {
    await vi.waitFor(() => expect(daemon.started).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledWith('pollinations', expect.any(AbortSignal));
    expect(trigger).toHaveBeenCalledTimes(enabled ? 1 : 0);
    // Exercise the actual callbacks installed for both later registry syncs
    // and foreground request failures; their shared gate must stay disabled.
    daemon.options!.synced!();
    setup.mock.calls[0]![0]();
    expect(trigger).toHaveBeenCalledTimes(enabled ? 3 : 0);
    daemon.options!.changed!(bundledRegistry);
    daemon.options!.changed!({ ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString() });
    expect(unretire).toHaveBeenCalledExactlyOnceWith(bundledRegistry.adapters.map(adapter => adapter.id));
    expect(connect).not.toHaveBeenCalled(); expect(signup).not.toHaveBeenCalled();
  } finally {
    await running.close();
    for (const signal of signals) for (const listener of process.listeners(signal)) {
      if (!original.get(signal)!.has(listener)) process.removeListener(signal, listener as () => void);
    }
  }
  expect(daemon.serverClose).toHaveBeenCalledOnce(); expect(daemon.syncClose).toHaveBeenCalledOnce();
});
