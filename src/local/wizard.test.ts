import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { configurePi, connectSquire, preflight, wizard } from './wizard.js';

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

it('bootstraps a fresh Squire install before connecting, and leaves an existing session alone', async () => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await connectSquire({ hasSession: async () => false, run, installer: '/fixture/bin.js' });
  expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('bin.js'), 'connect', '--target=opencode', '--json'], true);
  expect(connect).toHaveBeenCalledOnce();
  run.mockClear();
  await connectSquire({ hasSession: async () => true, run });
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv('MILO_SETUP_NO_HUMAN', '1');
  await expect(connectSquire({ hasSession: async () => false, run, installer: '/fixture/bin.js' })).rejects.toThrow('stopped before onboarding');
  expect(run).not.toHaveBeenCalled();
});
it('stops at a missing prerequisite with its fix before Squire or service changes', async () => {
  const run = vi.fn(async (binary: string) => { if (binary === 'pi') throw new Error('missing'); });
  await expect(preflight(run)).rejects.toThrow('npm install --global @mariozechner/pi-coding-agent');
  expect(run.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'pi']);
});
it('repairs a missing broker service while reusing an existing Squire session', async () => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValueOnce(new Error('broker missing')).mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await connectSquire({ hasSession: async () => true, run, installer: '/fixture/bin.js' });
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
