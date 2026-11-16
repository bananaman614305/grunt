import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as RegistryModule from './registry.js';
import { Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { MaintenanceResult } from './maintenance.js';
import type * as MaintenanceModule from './maintenance.js';

const daemon = vi.hoisted(() => ({ serve: vi.fn(), close: vi.fn(), finished: vi.fn(), maintenance: undefined as {
  check(id: string, signal: AbortSignal): Promise<MaintenanceResult>; providers(): readonly string[]
} | undefined }));
vi.mock('@hono/node-server', () => ({ serve: daemon.serve }));
vi.mock('./maintenance.js', async importOriginal => ({ ...await importOriginal<typeof MaintenanceModule>(), DailyMaintenance: class {
  constructor(options: NonNullable<typeof daemon.maintenance>) { daemon.maintenance = options; }
  async start() {}
  async close() {}
  snapshot() { return {}; }
} }));
vi.mock('./registry.js', async importOriginal => {
  const actual = await importOriginal<typeof RegistryModule>();
  const { bundledRegistry } = await import('../registry.js');
  return { ...actual, RegistrySync: class {
    enabled = bundledRegistry.adapters.filter(adapter => ['kilo', 'perch'].includes(adapter.id));
    constructor(options: { ensure?: unknown; afterEnsure?: unknown }) {
      if (options.ensure || options.afterEnsure) throw new Error('Daemon registry sync must not provision providers');
    }
    async load() {}
    async start() { daemon.finished(); }
    async close() {}
  } };
});

import { start } from './main.js';
import { beginSetupSession } from './setup-session.js';
import { BrowserSquire } from './setup.js';
import { Kilo } from './kilo.js';
import { Perch } from './perch.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { bundledRegistry } from '../registry.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  daemon.maintenance = undefined;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-setup-runtime-')); directories.push(path); return path; }
const request = (cwd: string, model = 'grunt'): ModelRequest => ({ model, cwd, messages: [{ role: 'user', content: 'Hello while setup continues' }], tools: [], stream: false });

it('defers maintenance during an updater lease while allowing existing routes to answer', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['kilo']);
  const lease = await beginSetupSession(path, []);
  const complete = vi.spyOn(Kilo.prototype, 'complete').mockResolvedValue({ text: 'user request continues' });
  let handler!: (request: Request) => Promise<Response>;
  daemon.serve.mockImplementation((options: { fetch: typeof handler }) => { handler = options.fetch; return { close: daemon.close }; });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previous = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const running = start({ GRUNT_SOURCES: 'freellmapi,kilo', GRUNT_CONFIG_DIR: path, GRUNT_PORT: '18792' });
  try {
    await handler(new Request('http://localhost:18792/v1/status'));
    expect(await daemon.maintenance!.check('kilo', new AbortController().signal)).toEqual({ outcome: 'deferred', code: 'foreground' });
    expect(complete).not.toHaveBeenCalled();
    const response = await handler(new Request('http://localhost:18792/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kilo', cwd: path, messages: [{ role: 'user', content: 'Say hello' }] })
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe('kilo');
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    await running.close(); await lease.close();
    for (const signal of signals) for (const listener of process.listeners(signal)) if (!previous.get(signal)!.has(listener)) process.removeListener(signal, listener as () => void);
  }
});

it.each([false, true])('omits unresolved providers before availability or completion, including legacy routing=%s', async weighted => {
  const cwd = await directory();
  const pending: Source = { id: 'opencode', available: vi.fn(() => new Promise<boolean>(() => {})), complete: vi.fn(() => new Promise(() => {})) };
  const ready: Source = { id: 'kilo', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'ready route' })) };
  const sources = new Sources([pending, ready], weighted ? { registry: () => bundledRegistry } : undefined);
  sources.pending.add('opencode'); sources.preparing.add('opencode');
  try {
    expect(await sources.models()).toContain('kilo');
    expect(await sources.models()).not.toContain('opencode');
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'ready route' });
    await expect(sources.complete(request(cwd, 'opencode'), AbortSignal.timeout(1000))).rejects.toThrow('setup is still in progress');
    expect(pending.available).not.toHaveBeenCalled(); expect(pending.complete).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it.each([false, true])('allows only exact-ID verification while keeping automatic requests and models on ready sources, weighted=%s', async weighted => {
  const cwd = await directory();
  const pending: Source = { id: 'opencode', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'verification only' })) };
  const ready: Source = { id: 'kilo', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'ready route' })) };
  const sources = new Sources([pending, ready], weighted ? { registry: () => bundledRegistry } : undefined);
  sources.pending.add('opencode'); sources.verifying.add('opencode');
  try {
    expect(await sources.models()).not.toContain('opencode');
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'ready route' });
    await expect(sources.complete({ ...request(cwd, 'unknown-alias'), messages: [{ role: 'user', content: 'Another automatic task' }] }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'ready route' });
    expect(pending.available).not.toHaveBeenCalled(); expect(pending.complete).not.toHaveBeenCalled();
    await expect(sources.complete({ ...request(cwd, 'opencode'), messages: [{ role: 'user', content: 'Verify OpenCode itself' }] }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'verification only' });
    expect(pending.complete).toHaveBeenCalledOnce();
  } finally { await sources.close(); }
});

it('makes a failed verification only once without falling through to a ready provider', async () => {
  const cwd = await directory();
  const failed: Source = { id: 'opencode', available: vi.fn(async () => true), complete: vi.fn(async () => { throw new SourceError('refused', 'Provider refused this probe'); }) };
  const ready: Source = { id: 'kilo', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'must not answer the probe' })) };
  const sources = new Sources([failed, ready], { registry: () => bundledRegistry });
  sources.pending.add('opencode'); sources.verifying.add('opencode');
  try {
    await expect(sources.complete(request(cwd, 'opencode'), AbortSignal.timeout(1000))).rejects.toThrow('Provider refused this probe');
    expect(failed.complete).toHaveBeenCalledOnce(); expect(ready.complete).not.toHaveBeenCalled();
    expect(failed.available).not.toHaveBeenCalled(); expect(ready.available).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('refuses a pending verification when the provider has been removed from the current registry', async () => {
  const cwd = await directory();
  const source: Source = { id: 'opencode', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'must not dispatch' })) };
  const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => adapter.id === 'kilo') };
  const sources = new Sources([source], { registry: () => registry });
  sources.pending.add('opencode'); sources.verifying.add('opencode');
  try {
    await expect(sources.complete(request(cwd, 'opencode'), AbortSignal.timeout(1000))).rejects.toThrow('not in the current provider registry');
    expect(source.available).not.toHaveBeenCalled(); expect(source.complete).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('preserves registry modality restrictions for an exact pending verification', async () => {
  const cwd = await directory();
  const source: Source = { id: 'opencode', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'must not dispatch' })) };
  const sources = new Sources([source], { registry: () => bundledRegistry });
  sources.pending.add('opencode'); sources.verifying.add('opencode');
  try {
    await expect(sources.complete({ ...request(cwd, 'opencode'), imageInput: true }, AbortSignal.timeout(1000))).rejects.toThrow('does not support this input modality');
    expect(source.available).not.toHaveBeenCalled(); expect(source.complete).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('admits a repaired source immediately after a successful exact-source probe despite an older router bar', async () => {
  const cwd = await directory();
  const source: Source = { id: 'kilo', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'repaired' })).mockRejectedValueOnce(new SourceError('logged_out', 'Old login expired')) };
  const sources = new Sources([source], { registry: () => bundledRegistry });
  try {
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).rejects.toThrow('No eligible adapter');
    sources.pending.add('kilo'); sources.verifying.add('kilo');
    await expect(sources.complete(request(cwd, 'kilo'), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'repaired' });
    sources.pending.delete('kilo'); sources.verifying.delete('kilo');
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'repaired' });
  } finally { await sources.close(); }
});

it('routine background preparation does not displace an already usable coding route', async () => {
  const cwd = await directory();
  const source: Source = { id: 'kilo', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'same route' })) };
  const sources = new Sources([source], { registry: () => bundledRegistry });
  try {
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'same route' });
    sources.preparing.add('kilo');
    await expect(sources.complete(request(cwd), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'same route' });
    expect(source.complete).toHaveBeenCalledTimes(2);
  } finally { await sources.close(); }
});

it('serves the first ready source while another signup remains pending, then admits it without restart or duplicate setup', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['kilo', 'perch']);
  const lease = await beginSetupSession(path, ['kilo', 'perch']);
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('No duplicate browser setup'));
  const signup = vi.spyOn(BrowserSquire.prototype, 'signup').mockRejectedValue(new Error('No duplicate signup'));
  const kiloAvailable = vi.spyOn(Kilo.prototype, 'available').mockResolvedValue(true);
  const kiloComplete = vi.spyOn(Kilo.prototype, 'complete').mockResolvedValue({ text: 'hello from ready Kilo' });
  const perchAvailable = vi.spyOn(Perch.prototype, 'available').mockResolvedValue(true);
  const perchComplete = vi.spyOn(Perch.prototype, 'complete').mockResolvedValue({ text: 'hello from late Perch' });
  let handler!: (request: Request) => Promise<Response>;
  daemon.serve.mockImplementation((options: { fetch: typeof handler }) => { handler = options.fetch; return { close: daemon.close }; });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previous = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const running = start({ GRUNT_SOURCES: 'kilo,perch', GRUNT_CONFIG_DIR: path, GRUNT_PORT: '18792' });
  const complete = (model: string) => handler(new Request('http://localhost:18792/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request(path, model), messages: [{ role: 'user', content: `Hello from ${model}` }], max_tokens: 32 }) }));
  try {
    await vi.waitFor(() => expect(daemon.finished).toHaveBeenCalledOnce());
    expect(kiloAvailable).not.toHaveBeenCalled(); expect(perchAvailable).not.toHaveBeenCalled();
    expect(daemon.maintenance?.providers()).toEqual(['kilo', 'perch']);
    expect(await daemon.maintenance!.check('kilo', new AbortController().signal)).toEqual({ outcome: 'deferred', code: 'foreground' });
    expect(await daemon.maintenance!.check('perch', new AbortController().signal)).toEqual({ outcome: 'deferred', code: 'foreground' });
    await lease.release('kilo');
    const models = await handler(new Request('http://localhost:18792/v1/models'));
    const ids = (await models.json()).data.map((model: { id: string }) => model.id);
    expect(ids).toContain('kilo'); expect(ids).not.toContain('perch');
    const answer = await complete('grunt');
    expect(answer.status).toBe(200); expect(answer.headers.get('x-grunt-source')).toBe('kilo'); expect(answer.headers.get('x-grunt-preparing')).toBe('perch');
    expect((await answer.json()).choices[0].message.content).toBe('hello from ready Kilo');
    // Even an admitted route remains owned by foreground setup until its lease
    // closes. Maintenance yields without delaying the user's real request.
    expect(await daemon.maintenance!.check('kilo', new AbortController().signal)).toEqual({ outcome: 'deferred', code: 'foreground' });
    expect(perchAvailable).not.toHaveBeenCalled(); expect(perchComplete).not.toHaveBeenCalled();
    const blocked = await complete('perch'); expect(blocked.status).toBe(503);
    await lease.verify('perch');
    const probe = await complete('perch'); expect(probe.status).toBe(200); expect(probe.headers.get('x-grunt-source')).toBe('perch');
    expect((await (await handler(new Request('http://localhost:18792/v1/models'))).json()).data.map((model: { id: string }) => model.id)).not.toContain('perch');
    await lease.release('perch');
    const late = await complete('perch'); expect(late.status).toBe(200); expect(late.headers.get('x-grunt-source')).toBe('perch');
    expect((await late.json()).choices[0].message.content).toBe('hello from late Perch');
    expect(connect).not.toHaveBeenCalled(); expect(signup).not.toHaveBeenCalled();
    expect(kiloComplete).toHaveBeenCalledOnce(); expect(perchComplete).toHaveBeenCalledTimes(2); expect(daemon.serve).toHaveBeenCalledOnce();
    await lease.close();
    expect((await handler(new Request('http://localhost:18792/v1/models'))).status).toBe(200);
  } finally {
    await lease.close(); await running.close();
    for (const signal of signals) for (const listener of process.listeners(signal)) if (!previous.get(signal)!.has(listener)) process.removeListener(signal, listener as () => void);
  }
});

it('maintains only currently approved curated sources using exact replies and never provider provisioning', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['kilo']);
  const kiloComplete = vi.spyOn(Kilo.prototype, 'complete').mockResolvedValue({ text: 'maintenance hello' });
  const kiloAvailable = vi.spyOn(Kilo.prototype, 'available').mockResolvedValue(true);
  const perchComplete = vi.spyOn(Perch.prototype, 'complete').mockResolvedValue({ text: 'must not call' });
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('Maintenance must not connect Squire'));
  const signup = vi.spyOn(BrowserSquire.prototype, 'signup').mockRejectedValue(new Error('Maintenance must not sign up'));
  let handler!: (request: Request) => Promise<Response>;
  daemon.serve.mockImplementation((options: { fetch: typeof handler }) => { handler = options.fetch; return { close: daemon.close }; });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previous = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const running = start({ GRUNT_SOURCES: 'freellmapi,kilo,perch', GRUNT_CONFIG_DIR: path, GRUNT_PORT: '18792' });
  try {
    await handler(new Request('http://localhost:18792/v1/status'));
    expect(daemon.maintenance?.providers()).toEqual(['kilo', 'perch']);
    expect(await daemon.maintenance!.check('perch', new AbortController().signal)).toEqual({ outcome: 'deferred', code: 'consent' });
    expect(await daemon.maintenance!.check('kilo', new AbortController().signal)).toMatchObject({ outcome: 'passed', evidence: 'reply' });
    expect(await daemon.maintenance!.check('kilo', new AbortController().signal)).toMatchObject({ outcome: 'passed', evidence: 'reply' });
    expect(kiloComplete).toHaveBeenCalledOnce(); expect(kiloAvailable).not.toHaveBeenCalled(); expect(perchComplete).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled(); expect(signup).not.toHaveBeenCalled();
  } finally {
    await running.close();
    for (const signal of signals) for (const listener of process.listeners(signal)) if (!previous.get(signal)!.has(listener)) process.removeListener(signal, listener as () => void);
  }
});
