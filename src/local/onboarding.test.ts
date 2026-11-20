import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setupFallbacks } from './fallback-setup.js';
import { withTerminal } from './terminal.js';
import { BrowserSquire } from './setup.js';
import { SourceError, Sources } from './source.js';
import { FreeLLMAPI } from './freellmapi.js';
import { createLocalApp } from './api.js';
import { parallelMap } from './parallel.js';
import { VerificationQueue } from './verification-queue.js';
import { bundledRegistry, validateRegistry } from '../registry.js';

const dirs: string[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-onboarding-')); dirs.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('overlaps agent setup with anonymous Kilo and shares one Squire connection for OpenCode and Zro', async () => {
  const release = deferred(), started = new Set<string>();
  const entry = { service: 'opencode', reference: 'vault://opencode', field_names: ['api_key'] };
  const squire = {
    signup: vi.fn(async () => {}), runs: { start: vi.fn(), get: vi.fn() },
    credentials: { list: vi.fn(async () => [entry]), grant: vi.fn(async () => ({ base_url: 'https://grant.test/opencode', token: 'synthetic-grant' })) }
  };
  let checked = false;
  const connect = vi.fn(async () => { await release.promise; });
  const provider = vi.fn(async (_notify: (line: string) => void, providers?: string[]) => { started.add(providers![0]!); await release.promise; return {}; });
  const pending = setupFallbacks({ dataSharingApproved: ['opencode', 'kilo'], directory: await directory(), adapters: ['opencode', 'kilo', 'zro'], squire, connect,
    run: async () => {}, notify: () => {},
    verify: async () => { started.add('opencode'); if (!checked) { checked = true; throw new SourceError('logged_out', 'sign in'); } },
    setupProvider: provider });
  // Anonymous Kilo starts while both account-based routes await one connection.
  await vi.waitFor(() => { expect(started).toEqual(new Set(['opencode', 'kilo'])); expect(connect).toHaveBeenCalledOnce(); });
  release.resolve();
  expect(await pending).toEqual({ unavailable: [] });
  expect(started).toEqual(new Set(['opencode', 'kilo', 'zro']));
  expect(connect).toHaveBeenCalledOnce();
  expect(provider).toHaveBeenCalledWith(expect.any(Function), ['kilo'], expect.objectContaining({ squire, directory: expect.any(String), dataSharingApproved: expect.arrayContaining(['kilo']) }));
});

it('isolates a Kilo refusal and completes the other free routes', async () => {
  const verify = vi.fn(async () => {});
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const result = await setupFallbacks({ dataSharingApproved: ['opencode', 'kilo'], directory: await directory(), adapters: ['opencode', 'kilo', 'zro'], squire,
    run: async () => {}, notify: () => {}, verify,
    setupProvider: async (_notify, providers) => { if (providers?.includes('kilo')) throw new Error('refused'); return {}; } });
  expect(result).toEqual({ unavailable: ['kilo'] }); expect(verify).toHaveBeenCalledOnce();
});

it('bounds dozens of jobs and waits for started jobs before returning a failure', async () => {
  const hold = deferred(), entered: number[] = [];
  let active = 0, peak = 0;
  const pending = parallelMap(Array.from({ length: 24 }, (_, i) => i), async i => {
    entered.push(i); active++; peak = Math.max(peak, active);
    await hold.promise; active--;
    if (i === 0) throw new Error('refused');
    return i;
  });
  expect(entered).toEqual([0, 1, 2]); hold.resolve();
  await expect(pending).rejects.toThrow('refused');
  expect(active).toBe(0); expect(peak).toBe(3);
});

it('cancels queued jobs and waits for active work before closing shared resources', async () => {
  const hold = deferred(), controller = new AbortController(), entered: number[] = [];
  const pending = parallelMap([0, 1, 2, 3, 4], async i => { entered.push(i); await hold.promise; }, 2, controller.signal);
  controller.abort(); hold.resolve();
  await expect(pending).rejects.toThrow(); expect(entered).toEqual([0, 1]);
});

it('groups simultaneous human handoffs and serializes later batches', async () => {
  const hold = deferred(), batches: string[][] = [];
  let active = 0, peak = 0;
  const queue = new VerificationQueue(async items => { active++; peak = Math.max(peak, active); batches.push(items.map(item => item.service)); await hold.promise; active--; });
  const first = queue.wait({ service: 'kilo', url: 'https://one.test' });
  const second = queue.wait({ service: 'freebuff', url: 'https://two.test' });
  await vi.waitFor(() => expect(batches).toEqual([['kilo', 'freebuff']]));
  const third = queue.wait({ service: 'opencode', url: 'https://three.test' });
  hold.resolve(); await Promise.all([first, second, third]);
  expect(batches).toEqual([['kilo', 'freebuff'], ['opencode']]); expect(peak).toBe(1);
});

it('rejects every waiting verification when a handoff is cancelled', async () => {
  const queue = new VerificationQueue(async () => { throw new Error('cancelled'); });
  const result = await Promise.allSettled([queue.wait({ service: 'kilo', url: 'https://one.test' }), queue.wait({ service: 'opencode', url: 'https://two.test' })]);
  expect(result.every(item => item.status === 'rejected')).toBe(true);
});

it('shares vault metadata and egress grants, then refreshes metadata after capture', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name === 'list_credentials') return { credentials: [{ service: 'kilo', reference: 'vault://kilo', field_names: ['api_key'] }] };
    if (name === 'grant_app_access') return { base_url: 'https://grant.test/kilo', token: 'synthetic-grant' };
    if (name === 'operate_drive') return { status: 'complete', session_id: 'browser' };
    if (name === 'operate_finish') return {};
    throw new Error('unexpected');
  });
  await Promise.all([squire.credentials.list(), squire.credentials.list()]);
  expect(call.mock.calls.filter(([name]) => name === 'list_credentials')).toHaveLength(1);
  await Promise.all([squire.credentials.grant('vault://kilo'), squire.credentials.grant('vault://kilo')]);
  expect(call.mock.calls.filter(([name]) => name === 'grant_app_access')).toHaveLength(1);
  await squire.signup('kilo', 'https://app.kilo.ai/profile', 'capture');
  await squire.credentials.list();
  expect(call.mock.calls.filter(([name]) => name === 'list_credentials')).toHaveLength(2);
});

it('does not cache failed grants', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ base_url: 'https://grant.test', token: 'synthetic' });
  await expect(squire.credentials.grant('vault://kilo')).rejects.toThrow('offline');
  await expect(squire.credentials.grant('vault://kilo')).resolves.toHaveProperty('token', 'synthetic');
  expect(call).toHaveBeenCalledTimes(2);
});

it('pins Kilo installer and capabilities instead of accepting executable registry data', () => {
  const kilo = bundledRegistry.adapters.find(a => a.id === 'kilo')!;
  for (const change of [{ install: 'npm:untrusted' }, { install: 'builtin:other' }, { kind: 'agent' }, { modalities: ['image'] }]) {
    expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...kilo, ...change }] })).toThrow();
  }
});

it.each(['custom/freebuff', 'groq/gpt-oss', 'cache', null])('never credits a backend fallback to Kilo (%s)', async route => {
  const source = new FreeLLMAPI({ id: 'kilo', model: 'kilo-auto/free', key: 'synthetic', fetcher: async () => Response.json({ choices: [{ message: { content: 'a different provider answered' } }] }, { headers: route ? { 'X-Routed-Via': route } : {} }) });
  const app = createLocalApp(new Sources([source]));
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kilo', messages: [{ role: 'user', content: 'ready?' }] }) });
  expect(response.status).not.toBe(200);
  expect(response.headers.get('x-grunt-source')).not.toBe('kilo');
});
it('credits Kilo only when the backend confirms its Kilo model route', async () => {
  const source = new FreeLLMAPI({ id: 'kilo', model: 'kilo-auto/free', key: 'synthetic', fetcher: async () => Response.json({ choices: [{ message: { content: 'Kilo answered' } }] }, { headers: { 'X-Routed-Via': 'custom/kilo-auto/free' } }) });
  const app = createLocalApp(new Sources([source]));
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kilo', messages: [{ role: 'user', content: 'ready?' }] }) });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('kilo');
});

it('shares terminal ownership between privileged installers and provider confirmations', async () => {
  const hold = deferred(), order: string[] = [];
  const installer = withTerminal(async () => { order.push('sudo'); await hold.promise; order.push('sudo done'); });
  await vi.waitFor(() => expect(order).toEqual(['sudo']));
  const queue = new VerificationQueue(items => withTerminal(async () => { order.push(`confirm ${items.map(item => item.service).join(',')}`); }));
  const verification = queue.wait({ service: 'kilo', url: 'https://one.test' });
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual(['sudo']);
  hold.resolve(); await Promise.all([installer, verification]);
  expect(order).toEqual(['sudo', 'sudo done', 'confirm kilo']);
});
