import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import type { setupFallbacks } from './fallback-setup.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { configurePi, connectSquire, preflight, wizard, checkFallbackServices, checkService, checkServiceSources, serviceSources, loadRegistry, installedSources, installService, probeSetupOperator } from './wizard.js';
import { createLocalApp } from './api.js';
import { Sources, SourceError } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Source } from './source.js';
import { approveDataSharing, dataSharingPolicies, readDataSharingConsent, recordDataSharingConsent } from './data-sharing.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(async () => 'https://example.test/v1'), multiselect: vi.fn(async () => ['groq']), confirm: vi.fn(async () => false), isCancel: (value: unknown) => typeof value === 'symbol',
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), message: vi.fn(), success: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn(), clear: vi.fn() })
}));

let dir: string;
let consentDir: string;
beforeEach(async () => { consentDir = await mkdtemp(join(tmpdir(), 'grunt-wizard-consent-')); vi.stubEnv('GRUNT_CONFIG_DIR', consentDir); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); await rm(consentDir, { recursive: true, force: true }); });
const defaultIds = () => bundledRegistry.adapters.map(adapter => adapter.id);
const sharingIds = () => dataSharingPolicies(defaultIds()).map(policy => policy.provider);
const approvedBatch = async ({ providers }: { providers: readonly string[] }) => ({ approved: dataSharingPolicies(providers).map(policy => policy.provider), skipped: [] });
it('adds the Pi provider without removing user providers and preserves it on repeat setup', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-pi-test-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ providers: { existing: { baseUrl: 'https://example.test' } }, other: 'keep' }), { mode: 0o600 });
  await configurePi(19878);
  await configurePi(19878);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ other: 'keep', providers: {
    existing: { baseUrl: 'https://example.test' }, grunt: { baseUrl: 'http://127.0.0.1:19878/v1', models: [{ id: 'grunt' }] }
  } });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, '{invalid');
  await expect(configurePi()).rejects.toThrow('Cannot safely update Pi models config');
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});

it('configures Pi in a group-writable agent directory and names the cause when it cannot', async () => {
  const { setupFailureReason } = await import('./setup-failure.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-pi-umask-'));
  // umask 002 (Ubuntu's default) makes Pi's own ~/.pi/agent 775.
  await chmod(dir, 0o775);
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ providers: {} }), { mode: 0o664 });
  await expect(configurePi(19878)).resolves.toMatchObject({ changed: true });
  expect(JSON.parse(await readFile(path, 'utf8')).providers.grunt.baseUrl).toBe('http://127.0.0.1:19878/v1');
  const reason = async () => setupFailureReason(await configurePi(19878).then(() => undefined, (error: unknown) => error));
  await writeFile(path, '{invalid');
  expect(await reason()).toBe('Pi models.json is not valid JSON');
  await writeFile(path, JSON.stringify({ providers: { grunt: { baseUrl: 'https://remote.example.test/v1' } } }));
  expect(await reason()).toBe('Pi has an unmanaged grunt provider');
  await rm(path);
  await writeFile(join(dir, 'elsewhere.json'), '{}');
  await symlink(join(dir, 'elsewhere.json'), path);
  expect(await reason()).toBe('Pi models.json is a symbolic link');
  await rm(path);
  await chmod(dir, 0o777);
  try { expect(await reason()).toBe('Pi agent directory is writable by every user'); }
  finally { await chmod(dir, 0o775); }
});

it('reuses an already-connected embedded signup session without starting a browser ceremony', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const canonicalDir = realpathSync(consentDir);
  const ensureSession = vi.fn(async options => {
    expect(options.profileDir).toBe(join(canonicalDir, 'browser-profile'));
    expect(options.sessionPath).toBe(join(canonicalDir, 'signup-session.json'));
    return {
      status: 'already_connected' as const,
      session: {
        apiBaseUrl: 'https://trusty-squire-api.fly.dev',
        accountId: 'acct_existing',
        agentSessionToken: 'tok_existing',
        machineToken: 'mach_existing',
        savedAt: new Date().toISOString()
      },
      providers: ['google' as const],
      browserLocation: { kind: 'none' as const }
    };
  });
  const readSession = vi.fn(async () => ({
    apiBaseUrl: 'https://trusty-squire-api.fly.dev',
    accountId: 'acct_existing',
    agentSessionToken: 'tok_existing',
    machineToken: 'mach_existing',
    savedAt: new Date().toISOString()
  }));
  const state = await connectSquire({ directory: consentDir, embeddedRuntime: { ensureSession, readSession } });
  expect(state).toBe('existing');
  expect(ensureSession).toHaveBeenCalledOnce();
});
it('stops before interactive embedded sign-in when GRUNT_SETUP_NO_HUMAN=1 and no session exists', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const ensureSession = vi.fn();
  await expect(connectSquire({ directory: consentDir, embeddedRuntime: { ensureSession } })).rejects.toThrow('needs human verification');
  expect(ensureSession).not.toHaveBeenCalled();
});
it('checks the user service manager without looking for npm or tar', async () => {
  const run = vi.fn(async (_binary: string) => { throw new Error('missing'); });
  await expect(preflight(run)).rejects.toThrow('Sign in to a user session with a working service manager');
  expect(run.mock.calls.map(([binary]) => binary)).toEqual([process.platform === 'darwin' ? 'launchctl' : 'systemctl']);
});
it('allows service onboarding before a coding harness such as Pi is installed', async () => {
  const run = vi.fn(async (binary: string) => { if (binary === 'pi') throw new Error('missing'); });
  await expect(preflight(run)).resolves.toBeUndefined();
  expect(run.mock.calls.map(([binary]) => binary)).not.toContain('pi');
});
it('runs embedded Google sign-in in-process using Grunt isolated paths when not yet connected', async () => {
  const seenOpen: unknown[] = [];
  const canonicalDir = realpathSync(consentDir);
  const ensureSession = vi.fn(async options => {
    expect(options.profileDir).toBe(join(canonicalDir, 'browser-profile'));
    expect(options.sessionPath).toBe(join(canonicalDir, 'signup-session.json'));
    await options.onSignInOpen?.({
      confirmUrl: 'https://trusty-squire.example/confirm',
      setupCode: 'ABCD-1234',
      browserLocation: { kind: 'host_screen' }
    });
    return {
      status: 'connected' as const,
      session: {
        apiBaseUrl: 'https://trusty-squire-api.fly.dev',
        accountId: 'acct_new',
        agentSessionToken: 'tok_new',
        machineToken: 'mach_new',
        savedAt: new Date().toISOString()
      },
      providers: ['google' as const],
      browserLocation: { kind: 'host_screen' as const }
    };
  });
  const state = await connectSquire({
    directory: consentDir,
    onSignInOpen: info => { seenOpen.push(info); },
    embeddedRuntime: { ensureSession }
  });
  expect(state).toBe('installed');
  expect(ensureSession).toHaveBeenCalledOnce();
  expect(seenOpen).toHaveLength(1);
});

it.each(['freebuff', 'apinex'])('skips retired %s installation and signup while continuing OpenCode', async retired => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-retired-fallback-'));
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
  dir = await mkdtemp(join(tmpdir(), 'grunt-fallback-test-'));
  const entry = { service: 'opencode', reference: 'vault://test', field_names: ['api_key'] };
  const list = vi.fn().mockResolvedValueOnce(exists ? [entry] : []).mockResolvedValue([entry]);
  const squire = { signup: vi.fn(async () => {}), credentials: { list, grant: vi.fn(async () => ({ base_url: 'https://grant.test/opencode', token: 'synthetic-grant' })) } };
  const verify = vi.fn().mockRejectedValueOnce(new SourceError('logged_out', 'OpenCode returned HTTP 401')).mockResolvedValue(undefined);
  const result = await setupFallbacks({ directory: dir, dataSharingApproved: ['freebuff', 'opencode'], run: async () => {}, notify: () => {}, squire, verify });
  expect(result.unavailable).toEqual([]);
  expect(squire.signup).toHaveBeenCalledTimes(exists ? 0 : 1);
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://test');
  expect(verify).toHaveBeenCalledTimes(2);
  expect((await stat(join(dir, 'opencode-free.json'))).mode & 0o777).toBe(0o600);
});


it('starts the service before connecting the free providers on default installs', async () => {
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
  expect(intro).not.toHaveBeenCalled();
  expect(outro).not.toHaveBeenCalled();
  expect(order).toEqual(['service', 'fallbacks']);
  expect(actions.setupFallbacks.mock.calls.map(([options]) => options.adapters)).toEqual([defaultIds()]);
  expect(actions.setup).not.toHaveBeenCalled();
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ run: expect.any(Function), notify: expect.any(Function) }));
  actions.setupFallbacks.mockClear();
  await wizard('zro', actions);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
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
it('smoke-tests a real completion through model grunt and names a failure without copying it', async () => {
  const { smokeTest } = await import('./wizard.js');
  const prompts: string[] = [];
  const live = await service(new Sources([fake('kilo', async request => { prompts.push(String(request.messages.at(-1)?.content)); return { text: 'grunt is ready.' }; })]));
  try { await expect(smokeTest(live.port, new AbortController().signal)).resolves.toBeUndefined(); }
  finally { await live.close(); }
  expect(prompts).toEqual([expect.stringMatching(/^Reply only: grunt is ready\./)]);
  const failing = await service(new Sources([fake('kilo', async () => { throw new SourceError('quota', 'synthetic upstream detail'); })]));
  try {
    const { setupFailureReason } = await import('./setup-failure.js');
    const error = await smokeTest(failing.port, new AbortController().signal).then(() => undefined, (failure: unknown) => failure);
    expect(setupFailureReason(error)).toBe('quota exhausted');
    expect(String(error)).not.toContain('synthetic upstream detail');
  } finally { await failing.close(); }
});
it('fails an adapter check when another source answered for it', async () => {
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
it('names a unit override whose GRUNT_SOURCES lacks an adapter and leaves it unchanged', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-unit-test-'));
  const dropIn = join(dir, '20-sources.conf'), other = join(dir, '10-other.conf');
  const content = '[Service]\nEnvironment="GRUNT_SOURCES=codex,opencode,kilo"\n';
  await writeFile(dropIn, content); await writeFile(other, '[Service]\nEnvironment="GRUNT_PORT=8788"\n');
  const run = vi.fn(async (args: string[]) => args.includes('Environment')
    ? 'GRUNT_DAEMON=1 GRUNT_PORT=8788 GRUNT_SOURCES=codex,opencode,kilo PATH=/usr/bin\n'
    : `${other} ${dropIn}\n`);
  const lines: string[] = [], unavailable: string[] = [];
  await checkServiceSources(unavailable, line => lines.push(line), ['freebuff', 'opencode'], () => serviceSources(run));
  expect(lines).toEqual([`freebuff: FAIL — ${dropIn} sets GRUNT_SOURCES=codex,opencode,kilo, which lacks freebuff. Setup does not edit it; add freebuff there or remove that setting.`]);
  expect(unavailable).toEqual(['freebuff']);
  expect(await readFile(dropIn, 'utf8')).toBe(content);
  expect(run.mock.calls.map(c => c[0])).toEqual([['show', 'grunt.service', '-p', 'Environment', '--value'], ['show', 'grunt.service', '-p', 'DropInPaths', '--value']]);
  await checkServiceSources(unavailable, line => lines.push(line), ['opencode'], async () => undefined);
  expect(lines).toHaveLength(1);
  // An adapter that setup already marked unavailable still gets the override named.
  await checkServiceSources(unavailable, line => lines.push(line), ['freebuff'], () => serviceSources(run));
  expect(lines[1]).toContain(`${dropIn} sets GRUNT_SOURCES=codex,opencode,kilo, which lacks freebuff`);
  expect(unavailable).toEqual(['freebuff']);
});

it('uses the primary Grunt source setting and names its overriding file', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-unit-primary-test-'));
  const dropIn = join(dir, '20-grunt.conf');
  const content = '[Service]\nEnvironment="GRUNT_SOURCES=kilo"\n'; await writeFile(dropIn, content);
  const run = vi.fn(async (args: string[]) => args.includes('Environment')
    ? 'GRUNT_SOURCES=kilo "OTHER=GRUNT_SOURCES=misleading"\n' : dropIn);
  const lines: string[] = [];
  await checkServiceSources([], line => lines.push(line), ['opencode'], () => serviceSources(run));
  expect(lines).toEqual([`opencode: FAIL — ${dropIn} sets GRUNT_SOURCES=kilo, which lacks opencode. Setup does not edit it; add opencode there or remove that setting.`]);
  expect(run.mock.calls.every(([args]) => args.includes('grunt.service'))).toBe(true);
  expect(await readFile(dropIn, 'utf8')).toBe(content);
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
  setupFallbacks: vi.fn(async (options: Parameters<typeof setupFallbacks>[0]) => { await options.connect?.(); order.push(`signup:${options.adapters}`); return { unavailable: [] }; }),
  installService: vi.fn(async () => { order.push('service'); }),
  checkService: vi.fn(async () => {}),
  checkFallbackServices: vi.fn(async (_unavailable: string[], _port: number, notify: (line: string) => void, ids: string[]) => { order.push(`check:${ids}`); notify(`${ids[0]}: PASS — ${ids[0]} answered through the grunt service`); }),
  connectHarnesses: vi.fn(async () => { order.push('harnesses'); return []; }),
  approveDataSharing: vi.fn(approvedBatch),
  ...overrides
});
it('enables explicit sources in unattended default setup without asking', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const actions = stubActions([], { approveDataSharing });
  await wizard(undefined, actions);
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.arrayContaining(['nous', 'kenari']) }));
  expect(await readDataSharingConsent(consentDir, ['nous', 'kenari'])).toEqual(['nous', 'kenari']);
});
it('automatically accepts material terms for unattended setup and add', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const actions = stubActions([], { approveDataSharing });
  await wizard(undefined, actions);
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: defaultIds() }));
  expect(await readDataSharingConsent(consentDir, ['freepi'])).toEqual(['freepi']);
  const added = stubActions([], { approveDataSharing });
  await wizard('freepi', added);
  expect(added.setup).toHaveBeenCalled();
  const { confirm } = await import('@clack/prompts');
  expect(confirm).not.toHaveBeenCalled();
});

// OpenCode's CLI is a signup driver even when the registry lists no OpenCode route.
it('records OpenCode driver consent when the registry omits OpenCode', async () => {
  const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => adapter.id === 'zro') };
  const actions = stubActions([], { approveDataSharing, loadRegistry: async () => ({ registry, origin: 'remote' as const }) });
  await wizard(undefined, actions);
  expect(await readDataSharingConsent(consentDir, ['opencode'])).toEqual(['opencode']);
});

it('leaves explicit sources out of default setup and add with the data-sharing opt-out', async () => {
  const policy = dataSharingPolicies(['kilo'])[0]!;
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  vi.stubEnv('GRUNT_SETUP_NO_DATA_SHARING', '1');
  policy.approval = 'explicit';
  try {
    const first = stubActions([], { approveDataSharing });
    await wizard(undefined, first);
    const others = defaultIds().filter(id => !dataSharingPolicies([id]).some(entry => entry.approval === 'explicit' || entry.approval === 'material'));
    expect(first.installService).toHaveBeenCalledWith(others, expect.anything());
    expect(first.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: others }));
    expect(await readDataSharingConsent(consentDir, ['kilo'])).toEqual([]);

    const add = stubActions([], { approveDataSharing });
    await wizard('kilo', add);
    expect(add.connectSquire).not.toHaveBeenCalled();
    expect(add.setup).not.toHaveBeenCalled();
    expect(add.installService).not.toHaveBeenCalled();
  } finally { delete policy.approval; }
});
it('groups Kenari and Nous consent before automatic setup', async () => {
  const approve = vi.fn(async (options: Parameters<typeof approveDataSharing>[0]) => {
    await recordDataSharingConsent(consentDir, options.providers);
    return approvedBatch(options);
  });
  const actions = stubActions([], { approveDataSharing: approve });
  await wizard(undefined, actions);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve.mock.calls[0]?.[0].providers).toEqual(expect.arrayContaining(['kenari', 'nous']));
  expect(await readDataSharingConsent(consentDir, ['kenari', 'nous'])).toEqual(expect.arrayContaining(['kenari', 'nous']));
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.arrayContaining(['kenari', 'nous']) }));
});
it('connects Kilo and restarts the daemon before reporting success', async () => {
  const order: string[] = [];
  const actions = stubActions(order);
  actions.setup.mockImplementation(async () => { order.push('grant'); return { key: 'synthetic' }; });
  actions.checkService.mockImplementation(async () => { order.push('ready'); });
  await wizard('kilo', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['kilo'], expect.objectContaining({ dataSharingApproved: sharingIds() }));
  expect(order).toEqual(['banner', 'registry', 'squire', 'grant', 'service', 'ready', 'check:kilo']);
  expect(actions.setupFallbacks).not.toHaveBeenCalled();
  expect(actions.connectHarnesses).not.toHaveBeenCalled();
});
it('adds the anonymous Reflection route without asking for a Squire login', async () => {
  const actions = stubActions([]);
  await wizard('reflection-beam', actions);
  expect(actions.connectSquire).not.toHaveBeenCalled();
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['reflection-beam'], expect.objectContaining({ dataSharingApproved: sharingIds() }));
  expect(actions.checkFallbackServices).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), expect.any(Function), ['reflection-beam']);
});
it('adds the portable Antseed source without an unrelated browser sign-in', async () => {
  const actions = stubActions([]);
  await wizard('antseed-vikey', actions);
  expect(actions.connectSquire).not.toHaveBeenCalled();
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['antseed-vikey'], expect.objectContaining({ dataSharingApproved: expect.arrayContaining([...sharingIds(), 'antseed-vikey']) }));
  expect(actions.checkFallbackServices).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), expect.any(Function), ['antseed-vikey']);
});
it('does not restart the daemon or report success when Kilo setup fails', async () => {
  const actions = stubActions([]);
  actions.setup.mockRejectedValue(new Error('No Kilo access'));
  await expect(wizard('kilo', actions)).rejects.toThrow('No Kilo access');
  expect(actions.installService).not.toHaveBeenCalled();
});
it('requests a BeatAPI model upgrade on explicit add', async () => {
  const actions = stubActions([], { installedSources: async () => 'opencode,beatapi' });
  await wizard('beatapi', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['beatapi'],
    expect.objectContaining({ upgradeBeatAPI: true }));
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'beatapi']);
});
it.each([
  ['freebuff', 'opencode', 'kilo'],
  ['freellmapi', 'kilo', 'freebuff', 'opencode']
])('enables explicitly added NVIDIA while preserving saved sources %j', async (...previous) => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-add-nvidia-'));
  await writeFile(join(dir, 'installed-sources.json'), JSON.stringify(previous), { mode: 0o600 });
  const actions = stubActions([], { installedSources: () => installedSources(dir) });
  await wizard('nvidia', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['nvidia'], expect.objectContaining({ dataSharingApproved: dataSharingPolicies(previous.filter(id => !['freebuff', 'apinex', 'freellmapi'].includes(id))).map(policy => policy.provider) }));
  expect(actions.installService).toHaveBeenCalledWith([...previous.filter(id => !['freebuff', 'apinex', 'freellmapi'].includes(id)), 'nvidia']);
});
it('does not add unselected adapters when explicitly adding Kilo', async () => {
  const actions = stubActions([], { installedSources: async () => 'opencode' });
  await wizard('kilo', actions);
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'kilo']);
});
it('pulls the registry from the RegistrySync URL and silently falls back to the bundled list', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-registry-test-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', dir);
  const fresh = { ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString() };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 }));
  expect(await loadRegistry({ fetcher })).toEqual({ registry: fresh, origin: 'remote' });
  expect(fetcher).toHaveBeenCalledWith('https://grunt.run/registry.json', expect.anything());
  expect((await loadRegistry({ fetcher: async () => { throw new Error('offline'); } })).origin).toBe('cache');
  await rm(dir, { recursive: true, force: true });
  expect(await loadRegistry({ fetcher: async () => { throw new Error('offline'); } })).toEqual({ registry: bundledRegistry, origin: 'bundled' });
  const { log } = await import('@clack/prompts');
  await wizard(undefined, stubActions([], { loadRegistry: async () => ({ registry: bundledRegistry, origin: 'bundled' }) }));
  expect(log.warn).not.toHaveBeenCalled();
});

it('keeps newly bundled onboarding sources when both cached and remote registries are stale', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-stale-onboarding-registry-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', dir);
  const stale = { ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) - 1000).toISOString(), adapters: [bundledRegistry.adapters[1]] };
  await writeFile(join(dir, 'registry.json'), JSON.stringify({ registry: stale, etag: '"old-onboarding"' }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(stale));
  expect(await loadRegistry({ fetcher })).toEqual({ registry: bundledRegistry, origin: 'bundled' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, options] of fetcher.mock.calls) expect(options?.headers).toEqual({});
});

it('keeps a vetted-only install across repeated setup when a retired provider was previously saved', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-vetted-repeat-'));
  await writeFile(join(dir, 'installed-sources.json'), JSON.stringify(['freebuff', 'opencode', 'kilo']), { mode: 0o600 });
  expect(await installedSources(dir)).toBe('opencode,kilo');
  const actions = stubActions([], { installedSources: () => installedSources(dir) });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledWith(defaultIds(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it('uses one Squire client across default setup and closes it after verification', async () => {
  const squire = new BrowserSquire();
  const close = vi.spyOn(squire, 'close').mockResolvedValue();
  const actions = stubActions([], { createSquire: () => squire });
  await wizard(undefined, actions);
  expect(actions.connectSquire).toHaveBeenCalledWith(expect.objectContaining({ squire, signal: expect.any(AbortSignal) }));
  expect(actions.setupFallbacks).toHaveBeenCalledWith(expect.objectContaining({ squire }));
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

it('removes retired sources from an older saved selection and preserves user state', async () => {
  await writeFile(join(consentDir, 'installed-sources.json'), JSON.stringify(['freellmapi', 'freebuff', 'apinex', 'opencode']), { mode: 0o600 });
  await writeFile(join(consentDir, 'native-user-state'), 'preserved', { mode: 0o600 });
  expect(await installedSources(consentDir)).toBe('opencode');
  const actions = stubActions([], { installedSources: () => installedSources(consentDir) });
  await wizard(undefined, actions);
  expect(actions.installService).toHaveBeenCalledExactlyOnceWith(defaultIds(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
  expect(await installedSources(consentDir)).toBe('');
});

it('adds Zro while preserving saved OpenCode routing', async () => {
  const actions = stubActions([], { installedSources: async () => 'opencode' });
  await wizard('zro', actions);
  expect(actions.setup).toHaveBeenCalledWith(expect.any(Function), ['zro'], expect.objectContaining({ dataSharingApproved: ['opencode'] }));
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'zro']);
});

it('gives add the live registry hints, as setup has', async () => {
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'close').mockResolvedValue();
  const useRegistry = vi.spyOn(squire, 'useRegistry');
  const registry = structuredClone(bundledRegistry);
  registry.adapters.find(adapter => adapter.id === 'zro')!.hints = 'Live hint: press Create key.';
  const actions = stubActions([], { createSquire: () => squire, loadRegistry: vi.fn(async () => ({ registry, origin: 'remote' as const })) });
  await wizard('zro', actions);
  expect(actions.loadRegistry).toHaveBeenCalledOnce();
  expect(useRegistry.mock.calls[0]![0]()).toBe(registry);
});

it('keeps an already approved sharing source when adding a supported provider', async () => {
  await recordDataSharingConsent(consentDir, sharingIds());
  const actions = stubActions([], {
    installedSources: async () => 'freebuff,opencode,kilo,tokenharbor',
    approveDataSharing
  });
  await wizard('zro', actions);
  expect(actions.installService).toHaveBeenCalledWith(['opencode', 'kilo', 'tokenharbor', 'zro']);
});

it.each(['refused', 'quota'] as const)('does not retry a settled %s provider while its verification header still says preparing', async code => {
  const complete = vi.fn(async () => { throw new SourceError(code, 'synthetic provider refusal'); });
  const sources = new Sources([fake('opencode', complete)]);
  sources.preparing.add('opencode');
  sources.verifying.add('opencode');
  const live = await service(sources), unavailable: string[] = [];
  try {
    await checkFallbackServices(unavailable, live.port, () => {}, ['opencode'], { limit: 3000, interval: 1, retryPreparing: false });
  } finally { await live.close(); }
  expect(complete).toHaveBeenCalledOnce();
  expect(unavailable).toEqual(['opencode']);
});

it.each(['https://example.test/v1', 'groq', 'cerebras', 'unknown'])('rejects an unsupported provider before setup (%s)', async input => {
  const actions = stubActions([]);
  await expect(wizard(input, actions)).rejects.toThrow('Choose a supported provider');
  expect(actions.preflight).not.toHaveBeenCalled();
  expect(actions.setup).not.toHaveBeenCalled();
});

it('marks only the fixed Free-Pi setup probes as public context', async () => {
  const observed: boolean[] = [];
  const source = fake('freepi', async request => {
    observed.push(request.publicContext === true);
    return request.tools.length ? { text: '', calls: [{ id: 'setup-call', type: 'function', function: { name: 'setup_ready', arguments: '{}' } }] } : { text: 'ready' };
  });
  const live = await service(new Sources([source]));
  const unavailable: string[] = [];
  try {
    await checkFallbackServices(unavailable, live.port, () => {}, ['freepi']);
    await expect(probeSetupOperator(live.port, 'freepi', new AbortController().signal)).resolves.toBe(true);
    expect(unavailable).toEqual([]);
    expect(observed).toEqual([true, true]);
  } finally { await live.close(); }
});
