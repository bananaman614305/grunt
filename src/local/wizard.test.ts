import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { configurePi, connectSquire, preflight, wizard, checkFallbackServices, checkService, checkServiceSources, serviceSources, loadRegistry, installedSources, installService } from './wizard.js';
import { createLocalApp } from './api.js';
import { Sources, SourceError } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Source } from './source.js';
import { approveDataSharing, dataSharingPolicies, recordDataSharingConsent } from './data-sharing.js';

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(async () => ['groq']), confirm: vi.fn(async () => false), isCancel: (value: unknown) => typeof value === 'symbol',
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), message: vi.fn(), success: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn(), clear: vi.fn() })
}));

let dir: string;
let consentDir: string;
beforeEach(async () => { consentDir = await mkdtemp(join(tmpdir(), 'grunt-wizard-consent-')); vi.stubEnv('MILO_CONFIG_DIR', consentDir); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); await rm(consentDir, { recursive: true, force: true }); });
const defaultIds = () => bundledRegistry.adapters.map(adapter => adapter.id);
const sharingIds = () => dataSharingPolicies(defaultIds()).map(policy => policy.provider);
const approvedBatch = async ({ providers }: { providers: readonly string[] }) => ({ approved: dataSharingPolicies(providers).map(policy => policy.provider), skipped: [] });
it('adds the Pi provider without removing user providers and preserves it on repeat setup', async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-pi-test-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ providers: { existing: { baseUrl: 'https://example.test' } }, other: 'keep' }));
  await configurePi(19878);
  await configurePi(19878);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ other: 'keep', providers: {
    existing: { baseUrl: 'https://example.test' }, grunt: { baseUrl: 'http://127.0.0.1:19878/v1', models: [{ id: 'grunt' }] }
  } });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, '{invalid');
  await expect(configurePi()).rejects.toThrow('Cannot read Pi');
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});

it('reuses working Squire without a session check or installer', async () => {
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  vi.stubEnv('MILO_SETUP_NO_HUMAN', '1');
  const run = vi.fn(async () => {}), hasBroker = vi.fn(async () => true);
  await connectSquire({ hasBroker, run });
  expect(run).not.toHaveBeenCalled();
  expect(hasBroker).not.toHaveBeenCalled();
});
it('refuses to reinstall an existing broker when its probe fails', async () => {
  vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('socket refused'));
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await expect(connectSquire({ hasBroker: async () => true, run })).rejects.toThrow('Existing trusty-squire-broker failed its connection probe: socket refused');
  expect(run).not.toHaveBeenCalled();
});
it('stops at a missing prerequisite with its fix before Squire or service changes', async () => {
  const run = vi.fn(async (binary: string) => { if (binary === 'tar') throw new Error('missing'); });
  await expect(preflight(run)).rejects.toThrow('Install tar');
  expect(run.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'tar']);
});
it('allows service onboarding before a coding harness such as Pi is installed', async () => {
  const run = vi.fn(async (binary: string) => { if (binary === 'pi') throw new Error('missing'); });
  await expect(preflight(run)).resolves.toBeUndefined();
  expect(run.mock.calls.map(([binary]) => binary)).not.toContain('pi');
});
it('installs once only when the probe fails and no broker exists', async () => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValueOnce(new Error('broker missing')).mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await connectSquire({ hasBroker: async () => false, run, installer: '/fixture/bin.js' });
  expect(run).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(2);
});

it.each(['freebuff', 'apinex'])('skips retired %s installation and signup while continuing OpenCode', async retired => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-retired-fallback-'));
  const run = vi.fn(async (_binary: string, args: string[]) => { if (args[0] === '--version') throw new Error('missing'); });
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() } };
  const signedIn = vi.fn(), login = vi.fn(), verify = vi.fn(async () => {});
  const result = await setupFallbacks({ directory: dir, adapters: [retired, 'opencode'], dataSharingApproved: [retired, 'opencode'],
    run, notify: () => {}, squire, signedIn, login, verify });
  expect(result.unavailable).toEqual([retired]);
  expect(run.mock.calls).toEqual([['opencode', ['--version']], ['npm', ['install', '--global', 'opencode-ai']]]);
  expect(verify).toHaveBeenCalledOnce();
  expect(signedIn).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled(); expect(squire.signup).not.toHaveBeenCalled();
});

it.each([true, false])('connects an account only when OpenCode requires it, reusing a vault entry (exists: %s)', async exists => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  const { SourceError } = await import('./source.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-fallback-test-'));
  const entry = { service: 'opencode', reference: 'vault://test', field_names: ['api_key'] };
  const list = vi.fn().mockResolvedValueOnce(exists ? [entry] : []).mockResolvedValue([entry]);
  const squire = { signup: vi.fn(async () => {}), credentials: { list, grant: vi.fn(async () => ({ base_url: 'https://grant.test/opencode', token: 'synthetic-grant' })) } };
  const verify = vi.fn().mockRejectedValueOnce(new SourceError('logged_out', 'OpenCode returned HTTP 401')).mockResolvedValue(undefined);
  const result = await setupFallbacks({ directory: dir, dataSharingApproved: ['freebuff', 'opencode'], run: async () => {}, notify: () => {}, squire, signedIn: async () => true, verify });
  expect(result.unavailable).toEqual([]);
  expect(squire.signup).toHaveBeenCalledTimes(exists ? 0 : 1);
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://test');
  expect(verify).toHaveBeenCalledTimes(2);
  expect((await stat(join(dir, 'opencode-free.json'))).mode & 0o777).toBe(0o600);
});


it('runs both free fallback setup steps on default installs and starts the service afterwards', async () => {
  const order: string[] = [];
  const actions = {
    preflight: vi.fn(async () => {}), connectSquire: vi.fn(async () => {}),
    setup: vi.fn(async () => ({ key: 'synthetic' })),
    setupFallbacks: vi.fn(async () => { order.push('fallbacks'); return { unavailable: [] }; }),
    approveDataSharing: approvedBatch,
    installService: vi.fn(async () => { order.push('service'); }),
    configurePi: vi.fn(async () => {}), checkService: vi.fn(async () => {}), checkFallbackServices: vi.fn(async () => {})
  };
  await wizard(undefined, actions);
  const { intro, outro } = await import('@clack/prompts');
  expect(intro).toHaveBeenCalledWith(expect.stringContaining('npx usegrunt setup'));
  expect(outro).toHaveBeenCalledWith('grunt is ready');
  expect(order).toEqual(['fallbacks', 'service']);
  expect(actions.setupFallbacks.mock.calls.map(([options]) => options.adapters)).toEqual([defaultIds()]);
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ run: expect.any(Function), notify: expect.any(Function) }));
  actions.setupFallbacks.mockClear();
  await wizard('groq', actions);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
});

it('pairs the local Freebuff CLI using its own login URL through Squire', async () => {
  const { loginFreebuff } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-login-test-'));
  const program = '#!' + process.execPath + '\nconsole.log("https://freebuff.com/login?auth_code=synthetic&cli_flow=fixture"); setTimeout(() => process.exit(0), 100);\n';
  await writeFile(join(dir, 'freebuff'), program, { mode: 0o700 });
  vi.stubEnv('PATH', dir + ':' + process.env.PATH);
  const squire = { signup: vi.fn(async () => {}), credentials: { list: vi.fn(), grant: vi.fn() } };
  await loginFreebuff(squire);
  expect(squire.signup).toHaveBeenCalledWith('freebuff', 'https://freebuff.com/login?auth_code=synthetic&cli_flow=fixture', expect.stringContaining('local CLI'));
});


async function service(sources: Sources) {
  let port = 0;
  const app = createLocalApp(sources, { get port() { return port; } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
const fake = (id: string, complete: Source['complete'] = async () => ({ text: `${id} ready` })): Source => ({ id, available: async () => true, complete });
it('fails an adapter check when another source answered for it', async () => {
  // Owner drop-in MILO_SOURCES=freellmapi,opencode,dots maps freebuff to milo, so FreeLLMAPI answers.
  const live = await service(new Sources([fake('freellmapi'), fake('opencode')]));
  const lines: string[] = [], unavailable: string[] = [];
  try { await checkFallbackServices(unavailable, live.port, line => lines.push(line), ['freebuff', 'opencode']); }
  finally { await live.close(); }
  expect(lines).toEqual(['freebuff: FAIL — freellmapi answered instead of freebuff', 'opencode: PASS — opencode answered through the grunt service']);
  expect(unavailable).toEqual(['freebuff']);
});
it('waits while grunt still prepares an adapter, then passes', async () => {
  let ready = false, calls = 0;
  const sources = new Sources([fake('opencode', async () => { calls++; if (!ready) throw new SourceError('not_installed', 'OpenCode is not installed'); return { text: 'ready' }; })]);
  sources.preparing.add('opencode');
  setTimeout(() => { ready = true; sources.preparing.delete('opencode'); }, 150);
  const live = await service(sources);
  const lines: string[] = [], unavailable: string[] = [];
  try { await checkFallbackServices(unavailable, live.port, line => lines.push(line), ['opencode'], { limit: 5000, interval: 50 }); }
  finally { await live.close(); }
  expect(lines).toEqual(['opencode: grunt is still preparing this adapter; waiting', 'opencode: PASS — opencode answered through the grunt service']);
  expect(unavailable).toEqual([]); expect(calls).toBeGreaterThan(1);
});
it('keeps waiting while an adapter prepares and another source answers in its place', async () => {
  let ready = false;
  // Like the service: background setup clears the sign-in bar, then drops the preparing mark.
  const finish = () => setTimeout(() => { ready = true; sources.healthy('opencode'); sources.preparing.delete('opencode'); }, 150);
  const sources = new Sources([fake('opencode', async () => { if (!ready) { finish(); throw new SourceError('logged_out', 'OpenCode is not signed in'); } return { text: 'ready' }; }), fake('freebuff')], { registry: () => bundledRegistry, random: () => 0 });
  sources.preparing.add('opencode');
  const live = await service(sources);
  const lines: string[] = [], unavailable: string[] = [];
  try { await checkFallbackServices(unavailable, live.port, line => lines.push(line), ['opencode'], { limit: 5000, interval: 50 }); }
  finally { await live.close(); }
  expect(lines).toEqual(['opencode: grunt is still preparing this adapter; waiting', 'opencode: PASS — opencode answered through the grunt service']);
  expect(unavailable).toEqual([]);
});
it('stops waiting at the limit and fails without retrying an adapter that is not preparing', async () => {
  let calls = 0;
  const sources = new Sources([fake('opencode', async () => { calls++; throw new SourceError('upstream', 'down'); }), fake('freebuff', async () => { throw new SourceError('upstream', 'down'); })]);
  sources.preparing.add('opencode');
  const live = await service(sources);
  const lines: string[] = [];
  try { await checkFallbackServices([], live.port, line => lines.push(line), ['opencode', 'freebuff'], { limit: 300, interval: 50 }); }
  finally { await live.close(); }
  expect(lines).toEqual(['opencode: grunt is still preparing this adapter; waiting', 'opencode: FAIL — grunt returned HTTP 503', 'freebuff: FAIL — grunt returned HTTP 503']);
  expect(calls).toBeGreaterThan(1);
});
it('names a unit override whose MILO_SOURCES lacks an adapter and leaves it unchanged', async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-unit-test-'));
  const dropIn = join(dir, '20-dots.conf'), other = join(dir, '10-other.conf');
  const content = '[Service]\nEnvironment="MILO_SOURCES=freellmapi,opencode,dots"\n';
  await writeFile(dropIn, content); await writeFile(other, '[Service]\nEnvironment="MILO_PORT=8788"\n');
  const run = vi.fn(async (args: string[]) => args.includes('Environment')
    ? 'GRUNT_DAEMON=1 MILO_PORT=8788 MILO_SOURCES=freellmapi,opencode,dots PATH=/usr/bin\n'
    : `${other} ${dropIn}\n`);
  const lines: string[] = [], unavailable: string[] = [];
  await checkServiceSources(unavailable, line => lines.push(line), ['freebuff', 'opencode'], () => serviceSources(run));
  expect(lines).toEqual([`freebuff: FAIL — ${dropIn} sets MILO_SOURCES=freellmapi,opencode,dots, which lacks freebuff. Setup does not edit it; add freebuff there or remove that setting.`]);
  expect(unavailable).toEqual(['freebuff']);
  expect(await readFile(dropIn, 'utf8')).toBe(content);
  expect(run.mock.calls.map(c => c[0])).toEqual([['show', 'milo.service', '-p', 'Environment', '--value'], ['show', 'milo.service', '-p', 'DropInPaths', '--value']]);
  await checkServiceSources(unavailable, line => lines.push(line), ['opencode'], async () => undefined);
  expect(lines).toHaveLength(1);
  // An adapter that setup already marked unavailable still gets the override named.
  await checkServiceSources(unavailable, line => lines.push(line), ['freebuff'], () => serviceSources(run));
  expect(lines[1]).toContain(`${dropIn} sets MILO_SOURCES=freellmapi,opencode,dots, which lacks freebuff`);
  expect(unavailable).toEqual(['freebuff']);
});

it('passes the live check when the model list takes longer than one second', async () => {
  const slow: Source = { ...fake('freebuff'), available: async () => { await new Promise(resolve => setTimeout(resolve, 1500)); return true; } };
  const live = await service(new Sources([slow]));
  try { await checkService(live.port, 10000); } finally { await live.close(); }
}, 15000);

it('still reports a service that never answers', async () => {
  const live = await service(new Sources([fake('opencode')]));
  await live.close();
  await expect(checkService(live.port, 2000)).rejects.toThrow('grunt service did not start; inspect its service status');
}, 10000);

const stubActions = (order: string[], overrides: Record<string, unknown> = {}) => ({
  banner: vi.fn(async () => { order.push('banner'); return false; }),
  preflight: vi.fn(async () => {}), connectSquire: vi.fn(async () => { order.push('squire'); }),
  setup: vi.fn(async () => ({ key: 'synthetic' })),
  loadRegistry: vi.fn(async () => { order.push('registry'); return { registry: bundledRegistry, origin: 'remote' as const }; }),
  setupFallbacks: vi.fn(async (options: { adapters?: string[] }) => { order.push(`signup:${options.adapters}`); return { unavailable: [] }; }),
  installService: vi.fn(async () => { order.push('service'); }),
  checkService: vi.fn(async () => {}),
  checkFallbackServices: vi.fn(async (_unavailable: string[], _port: number, notify: (line: string) => void, ids: string[]) => { order.push(`check:${ids}`); notify(`${ids[0]}: PASS — ${ids[0]} answered through the grunt service`); }),
  connectHarnesses: vi.fn(async () => { order.push('harnesses'); return []; }),
  approveDataSharing: vi.fn(approvedBatch),
  ...overrides
});
it('connects Kilo and restarts the daemon before reporting success', async () => {
  const order: string[] = [];
  const actions = stubActions(order);
  actions.setup.mockImplementation(async () => { order.push('grant'); return { key: 'synthetic' }; });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard('kilo', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['kilo'], { dataSharingApproved: sharingIds() });
  expect(order).toEqual(['banner', 'squire', 'grant', 'service', 'ready']);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.connectHarnesses).not.toHaveBeenCalled();
});
it('does not restart the daemon or report success when Kilo setup fails', async () => {
  const actions = stubActions([]);
  actions.setup.mockRejectedValue(new Error('No Kilo access'));
  await expect(wizard('kilo', actions)).rejects.toThrow('No Kilo access');
  expect(actions.installService).not.toHaveBeenCalled();
});
it.each([
  ['freebuff', 'opencode', 'kilo'],
  ['freellmapi', 'kilo', 'freebuff', 'opencode']
])('enables explicitly added NVIDIA while preserving saved sources %j', async (...previous) => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-add-nvidia-'));
  await writeFile(join(dir, 'installed-sources.json'), JSON.stringify(previous), { mode: 0o600 });
  const actions = stubActions([], { installedSources: () => installedSources(dir) });
  await wizard('nvidia', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['nvidia'], { dataSharingApproved: dataSharingPolicies(previous.filter(id => !['freebuff', 'apinex'].includes(id))).map(policy => policy.provider) });
  expect(actions.installService).toHaveBeenCalledWith([...previous.filter(id => !['freebuff', 'apinex'].includes(id)), 'nvidia']);
});
it('does not add unselected adapters when explicitly adding Kilo', async () => {
  const actions = stubActions([], { installedSources: async () => 'opencode' });
  await wizard('kilo', actions);
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'kilo']);
});
it('keeps registered API sources enabled across repeat service installs', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-sources-test-'));
  expect(await installedSources(dir)).toBe('opencode,kilo,zro');
  await writeFile(join(dir, 'router-admin.json'), '{}', { mode: 0o600 });
  expect(await installedSources(dir)).toBe('freellmapi,kilo,opencode,zro');
});
it('shows the banner, preamble, Squire notice, registry, each service and then the harness step in order', async () => {
  const { note } = await import('@clack/prompts');
  const order: string[] = [];
  vi.mocked(note).mockImplementation((_message, title) => { order.push(`note:${title}`); });
  await wizard(undefined, stubActions(order));
  expect(order).toEqual(['banner', 'note:What grunt does', 'note:Google sign-in for Trusty Squire', 'squire', 'registry',
    `signup:${defaultIds()}`, 'service', ...defaultIds().map(id => `check:${id}`), 'note:Free services', 'harnesses']);
});
it('gives every service its own result when one fails, then ends with the resume message', async () => {
  const { log, outro } = await import('@clack/prompts');
  const order: string[] = [];
  const actions = stubActions(order, {
    setupFallbacks: vi.fn(async (options: { adapters?: string[] }) => ({ unavailable: options.adapters?.includes('beatapi') ? ['beatapi'] : [] })),
    checkFallbackServices
  });
  const live = await service(new Sources(defaultIds().filter(id => id !== 'beatapi').map(id => fake(id))));
  vi.stubEnv('MILO_PORT', String(live.port));
  try { await expect(wizard(undefined, actions)).rejects.toThrow('Some adapters failed verification. Run usegrunt setup to resume.'); }
  finally { await live.close(); }
  expect(vi.mocked(log.error).mock.calls.map(([line]) => line)).toContain('beatapi: FAIL — setup incomplete');
  expect(vi.mocked(log.success).mock.calls.map(([line]) => line)).toContain('opencode: PASS — opencode answered through the grunt service');
  expect(outro).toHaveBeenCalledWith('grunt is ready; incomplete fallbacks: beatapi. Rerun setup to finish them.');
  expect(order).toContain('harnesses');
});
it('pulls the registry from the RegistrySync URL and says when it falls back to the bundled list', async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-registry-test-'));
  vi.stubEnv('MILO_CONFIG_DIR', dir);
  const fresh = { ...bundledRegistry, published: '2026-11-12T00:00:00Z' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 }));
  expect(await loadRegistry({ fetcher })).toEqual({ registry: fresh, origin: 'remote' });
  expect(fetcher).toHaveBeenCalledWith('https://api.grunt.run/v1/registry', expect.anything());
  expect((await loadRegistry({ fetcher: async () => { throw new Error('offline'); } })).origin).toBe('cache');
  await rm(dir, { recursive: true, force: true });
  expect(await loadRegistry({ fetcher: async () => { throw new Error('offline'); } })).toEqual({ registry: bundledRegistry, origin: 'bundled' });
  const { log } = await import('@clack/prompts');
  await wizard(undefined, stubActions([], { loadRegistry: async () => ({ registry: bundledRegistry, origin: 'bundled' }) }));
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Registry unreachable; using the list bundled with this version'));
});

it('preserves legacy API routing when default setup adds Kilo', async () => {
  const actions = stubActions([], { installedSources: async () => 'freellmapi,kilo,freebuff,opencode' });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledWith(['freellmapi', ...defaultIds()]);
});
it('keeps a vetted-only install across repeated setup even after Kilo creates a router login', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-vetted-repeat-'));
  await writeFile(join(dir, 'router-admin.json'), '{}', { mode: 0o600 });
  await writeFile(join(dir, 'installed-sources.json'), JSON.stringify(['freebuff', 'opencode', 'kilo']), { mode: 0o600 });
  expect(await installedSources(dir)).toBe('opencode,kilo');
  const actions = stubActions([], { installedSources: () => installedSources(dir) });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledWith(defaultIds());
});
it('uses one Squire client across default setup and closes it after verification', async () => {
  const squire = new BrowserSquire();
  const close = vi.spyOn(squire, 'close').mockResolvedValue();
  const actions = stubActions([], { createSquire: () => squire });
  await wizard(undefined, actions);
  expect(actions.connectSquire).toHaveBeenCalledWith({ squire });
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ squire }));
  expect(close).toHaveBeenCalledOnce();
});

it('cold-starts all eleven vetted sources after one shared sign-in and one consent batch', async () => {
  const ids = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'clixad', 'perch'];
  const order: string[] = [];
  const squire = new BrowserSquire();
  const connect = vi.spyOn(squire, 'connect').mockImplementation(async () => { order.push('identity-ready'); });
  const close = vi.spyOn(squire, 'close').mockResolvedValue();
  const prompt = vi.fn(async () => { order.push('sharing-approved'); return true; });
  const actions = stubActions(order, {
    installedSources: async () => undefined,
    createSquire: () => squire,
    connectSquire: vi.fn(async (options?: { squire?: BrowserSquire }) => { await options?.squire?.connect(); }),
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt })
  });
  await wizard(undefined, actions);
  expect(connect).toHaveBeenCalledOnce();
  expect(prompt).toHaveBeenCalledOnce();
  expect(order.indexOf('identity-ready')).toBeLessThan(order.indexOf('sharing-approved'));
  expect(order.indexOf('sharing-approved')).toBeLessThan(order.indexOf(`signup:${ids}`));
  expect(actions.setupFallbacks).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    squire, adapters: ids, dataSharingApproved: dataSharingPolicies(ids).map(policy => policy.provider)
  }));
  expect(actions.installService).toHaveBeenCalledExactlyOnceWith(ids);
  expect(actions.checkFallbackServices.mock.calls.map(call => call[3])).toEqual(ids.map(id => [id]));
  expect(actions.setup).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(['freebuff', 'apinex'])('rejects explicitly adding retired %s before any sign-in', async id => {
  const actions = stubActions([]);
  await expect(wizard(id, actions)).rejects.toThrow(`${id} routing is disabled`);
  expect(actions.connectSquire).not.toHaveBeenCalled();
  expect(actions.approveDataSharing).not.toHaveBeenCalled();
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.installService).not.toHaveBeenCalled();
});

it('removes both retired source IDs from an older saved selection while preserving custom routing', async () => {
  await writeFile(join(consentDir, 'installed-sources.json'), JSON.stringify(['freellmapi', 'freebuff', 'apinex', 'opencode']), { mode: 0o600 });
  await writeFile(join(consentDir, 'native-user-state'), 'preserved', { mode: 0o600 });
  expect(await installedSources(consentDir)).toBe('freellmapi,opencode');
  const actions = stubActions([], { installedSources: () => installedSources(consentDir) });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledExactlyOnceWith(['freellmapi', ...defaultIds()]);
  expect(await readFile(join(consentDir, 'native-user-state'), 'utf8')).toBe('preserved');
});

it('rejects unknown service selections before installing or touching saved state', async () => {
  const saved = JSON.stringify(['opencode', 'kilo']);
  await writeFile(join(consentDir, 'installed-sources.json'), saved, { mode: 0o600 });
  await expect(installService(['unrecognized-provider'])).rejects.toThrow('Invalid grunt service selection');
  expect(await readFile(join(consentDir, 'installed-sources.json'), 'utf8')).toBe(saved);
  await expect(stat(join(consentDir, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([[], ['freebuff', 'apinex']])('keeps an explicitly empty or retired-only saved selection empty (%j)', async (...ids) => {
  await writeFile(join(consentDir, 'installed-sources.json'), JSON.stringify(ids), { mode: 0o600 });
  await writeFile(join(consentDir, 'router-admin.json'), '{}', { mode: 0o600 });
  expect(await installedSources(consentDir)).toBe('');
});

it('replaces an older retired-only runtime with a guarded empty service when its cached registry has no active sources', async () => {
  const order: string[] = [];
  await writeFile(join(consentDir, 'installed-sources.json'), JSON.stringify(['freebuff', 'apinex']), { mode: 0o600 });
  const retiredRegistry = { ...bundledRegistry, adapters: [
    { id: 'freebuff', kind: 'agent' as const, tier: 'stable' as const, weight: 0.5, modalities: ['text' as const], install: 'npm:freebuff' },
    { id: 'apinex', kind: 'model' as const, tier: 'stable' as const, weight: 0.5, modalities: ['text' as const], install: 'builtin:apinex' }
  ] };
  const actions = stubActions(order, {
    installedSources: () => installedSources(consentDir),
    loadRegistry: async () => ({ registry: retiredRegistry, origin: 'cache' as const })
  });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledExactlyOnceWith([]);
  expect(actions.checkService).toHaveBeenCalledOnce();
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.checkFallbackServices).not.toHaveBeenCalled();
  expect(order).toEqual(['banner', 'squire', 'service', 'ready']);
});

it('replaces a retired-only runtime even when a new provider addition is declined', async () => {
  const order: string[] = [];
  const actions = stubActions(order, {
    installedSources: async () => 'freebuff,apinex',
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => false })
  });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard('tokenharbor', actions);
  expect(actions.installService).toHaveBeenCalledExactlyOnceWith([]);
  expect(actions.checkService).toHaveBeenCalledOnce();
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(order).toEqual(['banner', 'squire', 'service', 'ready']);
});

it('enables the API source when adding a custom provider after a vetted install', async () => {
  const actions = stubActions([], { installedSources: async () => 'freebuff,opencode,kilo' });
  await wizard('groq', actions);
  expect(actions.installService).toHaveBeenCalledWith([...new Set(['freellmapi', 'opencode', 'kilo', ...defaultIds()])]);
});

it('asks once for the sharing batch before parallel signup and reuses the saved approval', async () => {
  const order: string[] = [], scopes: string[][] = [];
  const prompt = vi.fn(async () => { order.push('approval'); return true; });
  const actions = stubActions(order, {
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt }),
    createSquire: () => {
      const squire = new BrowserSquire();
      vi.spyOn(squire, 'close').mockResolvedValue();
      vi.spyOn(squire, 'approveDataSharing').mockImplementation(ids => { scopes.push([...ids]); });
      return squire;
    }
  });
  expect(defaultIds()).toContain('tokenharbor');
  await wizard(undefined, actions);
  await wizard(undefined, actions);
  expect(prompt).toHaveBeenCalledOnce();
  expect(order.indexOf('approval')).toBeLessThan(order.indexOf(`signup:${defaultIds()}`));
  expect(scopes).toEqual([sharingIds(), sharingIds()]);
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: defaultIds(), dataSharingApproved: sharingIds() }));
  expect(actions.installService).toHaveBeenCalledWith(defaultIds());
});

it.each([false, Symbol('cancel')])('continues other onboarding when grouped data sharing is declined or cancelled', async answer => {
  const order: string[] = [];
  const prompt = vi.fn(async () => answer);
  const actions = stubActions(order, {
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt })
  });
  await wizard(undefined, actions);
  const remaining = defaultIds().filter(id => !sharingIds().includes(id));
  expect(prompt).toHaveBeenCalledOnce();
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: remaining }));
  expect(actions.installService).toHaveBeenCalledWith(remaining);
  expect(order).not.toContain('check:tokenharbor');
  expect(order).not.toContain('check:freebuff');
  expect(order).not.toContain('check:opencode');
  expect(order).not.toContain('check:kilo');
  expect(order).toContain('check:zro');
});

it.each([false, Symbol('cancel')])('upgrades the old runtime despite declined sharing without enabling a registry-removed source', async answer => {
  const adapters = bundledRegistry.adapters.filter(adapter => ['freebuff', 'opencode', 'kilo'].includes(adapter.id));
  const order: string[] = [];
  const actions = stubActions(order, {
    installedSources: async () => 'freellmapi,freebuff,opencode,kilo,zro',
    loadRegistry: async () => ({ registry: { ...bundledRegistry, adapters }, origin: 'remote' as const }),
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => answer })
  });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard(undefined, actions);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.installService).toHaveBeenCalledWith(['freellmapi', 'opencode', 'kilo']);
  expect(actions.checkService).toHaveBeenCalledOnce();
  expect(order).toEqual(['banner', 'squire', 'service', 'ready']);
  expect(actions.checkFallbackServices).not.toHaveBeenCalled();
  expect(actions.connectHarnesses).not.toHaveBeenCalled();
});

it('starts a guarded runtime without signup when sharing is declined on a fresh installation', async () => {
  const adapter = bundledRegistry.adapters.find(adapter => adapter.id === 'tokenharbor')!;
  const actions = stubActions([], {
    loadRegistry: async () => ({ registry: { ...bundledRegistry, adapters: [adapter] }, origin: 'remote' as const }),
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => false })
  });
  await wizard(undefined, actions);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.installService).toHaveBeenCalledWith(['tokenharbor']);
  expect(actions.checkService).toHaveBeenCalledOnce();
});

it.each(['tokenharbor', 'kilo', 'runcrate', 'mistral-vibe', 'clixad', 'perch'])('upgrades the previous runtime when the explicitly added %s is declined without enabling it', async add => {
  const order: string[] = [];
  const previous = ['freellmapi', 'freebuff', 'opencode'];
  const actions = stubActions(order, {
    installedSources: async () => previous.join(','),
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => false })
  });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard(add, actions);
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.installService).toHaveBeenCalledWith(previous.filter(id => id !== 'freebuff'));
  expect(actions.checkService).toHaveBeenCalledOnce();
  expect(order).toEqual(['banner', 'squire', 'service', 'ready']);
});

it('does not enable an explicitly declined addition after cancellation', async () => {
  const actions = stubActions([], {
    installedSources: async () => 'freebuff,opencode,kilo',
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => Symbol('cancel') })
  });
  await wizard('tokenharbor', actions);
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'kilo']);
  expect(actions.checkService).toHaveBeenCalledOnce();
});

it('adds Zro while preserving saved custom API routing and without enabling optional NVIDIA', async () => {
  const actions = stubActions([], { installedSources: async () => 'freellmapi,opencode' });
  await wizard('zro', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['zro'], { dataSharingApproved: ['opencode'] });
  expect(actions.installService).toHaveBeenCalledWith(['freellmapi', 'opencode', 'zro']);
});

it('keeps an already approved sharing source when adding a custom API provider', async () => {
  await recordDataSharingConsent(consentDir, sharingIds());
  const actions = stubActions([], {
    installedSources: async () => 'freebuff,opencode,kilo,tokenharbor',
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: false })
  });
  await wizard('groq', actions);
  expect(actions.installService).toHaveBeenCalledWith([...new Set(['freellmapi', 'opencode', 'kilo', 'tokenharbor', ...defaultIds()])]);
});

it('keeps Zro, LiveKit and a custom API source when sharing providers are declined during add', async () => {
  const actions = stubActions([], {
    installedSources: async () => 'freebuff,opencode,kilo',
    approveDataSharing: (options: Parameters<typeof approveDataSharing>[0]) => approveDataSharing({ ...options, interactive: true, prompt: async () => false })
  });
  await wizard('groq', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['groq'], {});
  expect(actions.installService).toHaveBeenCalledWith(['freellmapi', 'zro', 'livekit']);
});
