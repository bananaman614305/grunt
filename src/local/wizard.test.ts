import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { configurePi, connectSquire, preflight, wizard, checkFallbackServices, checkServiceSources, serviceSources } from './wizard.js';
import { createLocalApp } from './api.js';
import { Sources, SourceError } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Source } from './source.js';

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(async () => ['groq']), isCancel: () => false,
  intro: vi.fn(), outro: vi.fn(), log: { info: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() })
}));

let dir: string;
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });
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
  const run = vi.fn(async (binary: string) => { if (binary === 'pi') throw new Error('missing'); });
  await expect(preflight(run)).rejects.toThrow('npm install --global @mariozechner/pi-coding-agent');
  expect(run.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'pi']);
});
it('installs once only when the probe fails and no broker exists', async () => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValueOnce(new Error('broker missing')).mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await connectSquire({ hasBroker: async () => false, run, installer: '/fixture/bin.js' });
  expect(run).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(2);
});

it.each([true, false])('sets up both default free routes, signing Freebuff in only when needed (signed in: %s)', async signed => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-fallback-test-'));
  let ready = signed;
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() } };
  const login = vi.fn(async () => { await squire.signup('freebuff', 'https://freebuff.com/login', 'pair'); ready = true; });
  const run = vi.fn(async () => {}), verify = vi.fn(async () => {});
  expect(await setupFallbacks({ directory: dir, run, notify: () => {}, squire, signedIn: async () => ready, login, verify })).toEqual({ unavailable: [] });
  expect(run.mock.calls).toEqual([['freebuff', ['--version']], ['freebuff', ['doctor']], ['tmux', ['-V']], ['opencode', ['--version']]]);
  expect(squire.signup).toHaveBeenCalledTimes(signed ? 0 : 1);
  expect(verify).toHaveBeenCalledOnce();
});

it('installs missing CLIs, continues OpenCode after Freebuff refusal, and skips signup for anonymous OpenCode', async () => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-fallback-test-'));
  const run = vi.fn(async (_binary: string, args: string[]) => { if (args[0] === '--version') throw new Error('missing'); });
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() } };
  const verify = vi.fn(async () => {});
  const result = await setupFallbacks({ directory: dir, run, notify: () => {}, squire, signedIn: async () => false, login: async () => { throw new Error('refused'); }, verify });
  expect(result.unavailable).toEqual(['freebuff']);
  expect(run.mock.calls).toContainEqual(['npm', ['install', '--global', 'freebuff'], true]);
  expect(run.mock.calls).toContainEqual(['npm', ['install', '--global', 'opencode-ai'], true]);
  expect(verify).toHaveBeenCalledOnce();
  expect(squire.signup).not.toHaveBeenCalled();
});

it.each([true, false])('connects an account only when OpenCode requires it, reusing a vault entry (exists: %s)', async exists => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  const { SourceError } = await import('./source.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-fallback-test-'));
  const entry = { service: 'opencode', reference: 'vault://test', field_names: ['api_key'] };
  const list = vi.fn().mockResolvedValueOnce(exists ? [entry] : []).mockResolvedValue([entry]);
  const squire = { signup: vi.fn(async () => {}), credentials: { list, grant: vi.fn(async () => ({ base_url: 'https://grant.test/opencode', token: 'synthetic-grant' })) } };
  const verify = vi.fn().mockRejectedValueOnce(new SourceError('logged_out', 'OpenCode returned HTTP 401')).mockResolvedValue(undefined);
  const result = await setupFallbacks({ directory: dir, run: async () => {}, notify: () => {}, squire, signedIn: async () => true, verify });
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
    installService: vi.fn(async () => { order.push('service'); }),
    configurePi: vi.fn(async () => {}), checkService: vi.fn(async () => {}), checkFallbackServices: vi.fn(async () => {})
  };
  await wizard(undefined, actions);
  const { intro, outro } = await import('@clack/prompts');
  expect(intro).toHaveBeenCalledWith(expect.stringContaining('npx usegrunt setup'));
  expect(outro).toHaveBeenCalledWith('grunt is ready');
  expect(order).toEqual(['fallbacks', 'service']);
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


it.each([true, false])('repairs an installed Freebuff without doctor before probing sign-in (repair works: %s)', async repaired => {
  const { setupFallbacks } = await import('./fallback-setup.js');
  dir = await mkdtemp(join(tmpdir(), 'milo-old-cli-test-'));
  let upgraded = false, signed = false;
  const output: string[] = [];
  const run = vi.fn(async (binary: string, args: string[]) => {
    if (binary === 'freebuff' && args[0] === 'doctor' && (!upgraded || !repaired)) throw new Error('invalid command: doctor; only login is accepted');
    if (binary === 'npm' && args.includes('freebuff@latest')) upgraded = true;
  });
  const signedIn = vi.fn(async () => { expect(upgraded).toBe(true); return signed; });
  const squire = { signup: vi.fn(async () => { signed = true; }), credentials: { list: vi.fn(), grant: vi.fn() } };
  const verify = vi.fn(async () => {});
  const result = await setupFallbacks({ directory: dir, run, notify: line => output.push(line), squire, signedIn,
    login: async browser => browser.signup('freebuff', 'https://freebuff.com/login', 'Pair the CLI'), verify });
  expect(run).toHaveBeenCalledWith('npm', ['install', '--global', 'freebuff@latest'], true);
  expect(squire.signup).toHaveBeenCalledTimes(repaired ? 1 : 0);
  expect(signedIn).toHaveBeenCalledTimes(repaired ? 2 : 0);
  expect(verify).toHaveBeenCalledOnce();
  expect(result.unavailable).toEqual(repaired ? [] : ['freebuff']);
  if (!repaired) expect(output.join(' ')).toContain('remove older Freebuff binaries earlier on PATH');
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
