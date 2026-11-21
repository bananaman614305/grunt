import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { setupLiveKit, installLiveKit } from './livekit-setup.js';
import { livekitPaths, readLiveKitFreeBuildReceipt, writeLiveKitFreeBuildReceipt } from './livekit.js';
import * as livekitSetup from './livekit-setup.js';
import { setup, FreeLLMAdmin } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { planSteps } from './fixtures/key-only-goal.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-livekit-setup-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function fixture(existing = true, changedDefault = false) {
  const paths = livekitPaths(directory), native = join(directory, 'native'), state = join(directory, 'state.json');
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(native, { mode: 0o700 });
  if (existing) await writeFile(join(native, 'cli-config.yaml'), 'native fixture owned by CLI\n', { mode: 0o600 });
  const before = existing ? [{ selector: 'personal', id: 'p_old', url: 'wss://personal-one.livekit.cloud', default: true }] : [];
  await writeFile(state, JSON.stringify(before));
  const binary = join(directory, "fake lk ' $(touch${IFS}$GRUNT_TEST_MARKER)");
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)}, native = ${JSON.stringify(native)}, evidence = ${JSON.stringify(join(directory, 'evidence.json'))};
if (args.includes('--version')) { console.log('lk version 2.19.4'); process.exit(0); }
if (args.includes('list')) {
 for (const p of JSON.parse(fs.readFileSync(state))) console.log('│ ' + (p.default ? '* ' : '') + p.selector + ' │ ' + p.id + ' │ ' + p.url + ' │ sensitive-key-never-persist │');
 process.exit(0);
}
if (args.includes('token')) {
 const stored = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence)) : {};
 stored.tokenArgs = args; stored.cwd = process.cwd();
 fs.writeFileSync(evidence, JSON.stringify(stored));
 console.log('synthetic.token.signature'); process.exit(0);
}
if (!args.includes('auth')) process.exit(1);
const stored = { HOME: process.env.HOME, livekitOverride: process.env.LiveKit_Url, lkOverride: process.env.LK_PROJECT, path: process.env.PATH, authArgs: args, size: process.stdout.columns };
fs.writeFileSync(evidence, JSON.stringify(stored));
const rl = readline.createInterface({input:process.stdin});
let phase = 'device';
console.log('What is the name of this device?');
rl.on('line', line => {
 if (phase === 'device') {
  phase = 'waiting'; console.log('https://cloud.livekit.io/cli/confirm-auth?t=ordinary-test-pairing');
  const poll = setInterval(() => {
   if (!fs.existsSync(${JSON.stringify(join(directory, 'approved'))})) return;
   clearInterval(poll);
   phase = 'default'; console.log('Make this project default?');
  }, 10);
 } else if (phase === 'default') {
  stored.defaultAnswer = line; phase = 'alias'; console.log('Choose a different alias');
 } else if (phase === 'alias') {
  stored.alias = line.trim(); fs.writeFileSync(evidence, JSON.stringify(stored));
  const before = JSON.parse(fs.readFileSync(state));
  if (${JSON.stringify(changedDefault)}) for (const p of before) p.default = false;
  before.push({selector:line.trim(), id:'p_free',url:'wss://grunt-free-xyz.livekit.cloud',default:${JSON.stringify(changedDefault)}});
  fs.writeFileSync(state, JSON.stringify(before));
  fs.writeFileSync(native + '/cli-config.yaml','native fixture owned by CLI\\n',{mode:0o600});
  console.log('Authenticated project [grunt-free]'); process.exit(0);
 }
});
`;
  await writeFile(binary, script, { mode: 0o700 });
  return { paths, native, binary, install: vi.fn(async () => binary) };
}
it('uses ordinary native pairing, preserves existing profiles/defaults, and reuses a private free receipt', async () => {
  const f = await fixture();
  await writeFile(join(directory, 'state.json'), JSON.stringify([{ selector: 'Personal.Default Project', id: 'p_old', url: 'wss://personal-one.livekit.cloud', default: true }]));
  vi.stubEnv('LiveKit_Url', 'https://wrong.invalid'); vi.stubEnv('LK_PROJECT', 'paid-project');
  vi.stubEnv('GRUNT_TEST_MARKER', join(directory, 'DO_NOT_CREATE'));
  const signup = vi.fn(async (_service: string, url: string, goal: string) => {
    expect(goal).toMatch(/grunt project/);
    expect(goal).not.toMatch(/Verify the Build free plan/);
    expect(planSteps(goal)).toEqual([]);
    expect(goal).not.toContain('API secret:');
    if (url.includes('/cli/confirm-auth')) await writeFile(join(directory, 'approved'), 'yes');
  });
  const options = { directory, squire: { signup }, install: f.install, nativeDirectory: f.native };
  await setupLiveKit(options);
  expect(signup).toHaveBeenCalledTimes(2);
  expect(signup.mock.calls[1]![0]).toBe('livekit');
  expect(signup.mock.calls[1]![1]).toBe('https://cloud.livekit.io/cli/confirm-auth?t=ordinary-test-pairing');
  const receipt = await readLiveKitFreeBuildReceipt(directory);
  expect(receipt).toMatchObject({ plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0, projectId: 'p_free', projectURL: 'wss://grunt-free-xyz.livekit.cloud' });
  expect((await stat(f.paths.receipt)).mode & 0o777).toBe(0o600);
  const evidence = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
  expect(evidence.HOME).toBe(process.env.HOME);
  expect(evidence.livekitOverride).toBeUndefined(); expect(evidence.lkOverride).toBeUndefined();
  expect(evidence.size).toBe(120);
  expect(evidence.defaultAnswer).toBe('n');
  expect(evidence.tokenArgs).toEqual(['--project', receipt.projectSelector, '--config', expect.any(String), 'token', 'create', '--inference', '--token-only', '--valid-for', '10m', '--identity', 'agent']);
  expect(JSON.stringify(receipt)).not.toContain('sensitive-key');
  expect((await readdir(f.paths.home)).some(name => name.startsWith('.openers-') || name.startsWith('.setup-work-'))).toBe(false);
  expect(await readdir(directory)).not.toContain('DO_NOT_CREATE');
  signup.mockClear();
  await setupLiveKit(options);
  expect(signup).not.toHaveBeenCalled();
}, 15000);

it('stops before native authentication and saves no receipt when the free account check is refused', async () => {
  const f = await fixture();
  await writeLiveKitFreeBuildReceipt(directory, { version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0,
    projectSelector: 'old-free', projectId: 'p_previous', projectURL: 'wss://grunt-free-previous.livekit.cloud', checkedAt: new Date().toISOString() });
  const original = await readFile(join(f.native, 'cli-config.yaml'), 'utf8');
  await expect(setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup: async () => { throw new Error('Account has billing sk-never-show-this'); } } })).rejects.toThrow('free Build account verification did not complete');
  expect(await readFile(join(f.native, 'cli-config.yaml'), 'utf8')).toBe(original);
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(directory, 'evidence.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('sets up a fresh native config without reading or capturing API secrets', async () => {
  const f = await fixture(false);
  const signup = vi.fn(async (_service: string, url: string, goal: string) => {
    if (url.includes('/cli/confirm-auth')) await writeFile(join(directory, 'approved'), 'yes');
    else expect(goal).toContain('Turn off optional Agent observability');
  });
  await setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup } });
  expect(await readLiveKitFreeBuildReceipt(directory)).toMatchObject({ projectId: 'p_free', plan: 'Build' });
  expect((await stat(join(f.native, 'cli-config.yaml'))).mode & 0o777).toBe(0o600);
}, 15000);

it('cleans up its native authentication when Squire pairing fails', async () => {
  const f = await fixture();
  await expect(setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup: async (_service, url) => {
    if (url.includes('/cli/confirm-auth')) throw new Error('Pairing refused');
  } } })).rejects.toThrow('browser pairing did not complete');
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(f.paths.home)).some(name => name.startsWith('.openers-') || name.startsWith('.setup-work-'))).toBe(false);
}, 15000);

it.each(['refusal', 'cancellation'])('bounds and sanitizes browser pairing after the native child has completed (%s)', async kind => {
  const f = await fixture();
  const controller = new AbortController();
  const signup = async (_service: string, url: string) => {
    if (!url.includes('/cli/confirm-auth')) return;
    await writeFile(join(directory, 'approved'), 'yes');
    await new Promise<void>((_resolve, reject) => {
      setTimeout(() => {
        if (kind === 'refusal') reject(new Error('sk-never-display-late-provider-secret'));
        else controller.abort();
      }, 300);
    });
  };
  await expect(setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, signal: controller.signal, squire: { signup } })).rejects.toThrow('browser pairing did not complete');
  expect(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')).alias).toMatch(/^grunt-free-/);
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('cancels an initial browser account check without waiting for its pending Squire promise', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const signup = vi.fn(async () => { await new Promise<void>(() => {}); });
  const pending = setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, signal: controller.signal, squire: { signup } });
  const rejected = expect(pending).rejects.toThrow('free Build account verification did not complete');
  await vi.waitFor(() => expect(signup).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refreshes an expired free approval after the browser check while reusing the existing native project', async () => {
  const f = await fixture();
  const project = { selector: 'grunt-free', id: 'p_free', url: 'wss://grunt-free-xyz.livekit.cloud', default: false };
  const before = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  await writeFile(join(directory, 'state.json'), JSON.stringify([...before, project]));
  await writeFile(f.paths.receipt, JSON.stringify({ version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0,
    projectSelector: project.selector, projectId: project.id, projectURL: project.url, checkedAt: new Date(Date.now() - 31 * 86400000).toISOString() }), { mode: 0o600 });
  const signup = vi.fn(async (_service: string, url: string) => {
    expect(url).toBe('https://cloud.livekit.io');
    await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup } });
  expect(signup).toHaveBeenCalledOnce();
  expect(await readLiveKitFreeBuildReceipt(directory)).toMatchObject({ projectSelector: 'grunt-free', projectId: 'p_free' });
  expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toEqual([...before, project]);
  expect(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')).authArgs).toBeUndefined();
});

it('fails closed rather than approving a project when native auth changes the old default', async () => {
  const f = await fixture(true, true);
  await expect(setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup: async (_service, url) => {
    if (url.includes('/cli/confirm-auth')) await writeFile(join(directory, 'approved'), 'yes');
  } } })).rejects.toThrow('previous default');
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it.each(['permissions', 'symlink'])('does not read or reuse unsafe native credentials (%s)', async kind => {
  const f = await fixture();
  if (kind === 'permissions') await chmod(join(f.native, 'cli-config.yaml'), 0o644);
  else {
    await rm(join(f.native, 'cli-config.yaml')); await symlink(join(directory, 'other-config'), join(f.native, 'cli-config.yaml'));
  }
  const signup = vi.fn();
  await expect(setupLiveKit({ directory, nativeDirectory: f.native, install: f.install, squire: { signup } })).rejects.toThrow('Unsafe LiveKit');
  expect(signup).not.toHaveBeenCalled();
});

it('rejects unsupported platforms and corrupted official release archives before executing them', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('corrupt release'));
  await expect(installLiveKit(directory, { platform: 'win32', arch: 'x64', fetcher })).rejects.toThrow('Linux and macOS');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(installLiveKit(directory, { platform: 'linux', arch: 'x64', fetcher })).rejects.toThrow('checksum');
  expect(fetcher).toHaveBeenCalledWith('https://github.com/livekit/livekit-cli/releases/download/v2.19.4/lk_2.19.4_linux_amd64.tar.gz', expect.any(Object));
  await expect(stat(livekitPaths(directory).binary)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('routes LiveKit setup to native signup without creating an API key or local aggregator', async () => {
  const native = vi.spyOn(livekitSetup, 'setupLiveKit').mockResolvedValue();
  const router = vi.spyOn(FreeLLMAdmin.prototype, 'login');
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const controller = new AbortController();
  await expect(setup(() => {}, ['livekit'], { directory, squire, signal: controller.signal })).resolves.toEqual({});
  expect(native).toHaveBeenCalledWith({ directory, squire, notify: expect.any(Function), signal: controller.signal });
  expect(router).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it('starts LiveKit with the other native free routes in parallel and isolates a refused free account', async () => {
  const started: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connect = vi.fn(async () => {});
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const setupProvider = vi.fn<typeof setup>(async (_notify, providers, options) => {
    const id = providers![0]!;
    started.push(id);
    expect(options).toMatchObject({ directory, squire });
    await gate;
    if (id === 'livekit') throw new Error('Build account requirement not met');
    return {};
  });
  const pending = setupFallbacks({ directory, adapters: ['livekit', 'zro', 'mistral-vibe'], dataSharingApproved: ['mistral-vibe'],
    run: vi.fn(), notify: vi.fn(), squire, connect, setupProvider });
  await vi.waitFor(() => expect(started).toEqual(['livekit', 'zro', 'mistral-vibe']));
  release();
  expect(await pending).toEqual({ unavailable: ['livekit'] });
  expect(connect).toHaveBeenCalledOnce();
});

it('matches only the Grunt-owned LiveKit project URL', async () => {
  const { LIVEKIT_GRUNT_PROJECT_URL } = await import('./livekit-setup.js');
  for (const url of ['wss://grunt-my6sw682.livekit.cloud', 'wss://grunt-free-xyz.livekit.cloud']) expect(LIVEKIT_GRUNT_PROJECT_URL.test(url)).toBe(true);
  for (const url of ['wss://grunt-staging-ab12.livekit.cloud', 'wss://grunt-free-a-b.livekit.cloud', 'wss://other-xyz.livekit.cloud', 'wss://grunt-xyz.livekit.cloud.example']) expect(LIVEKIT_GRUNT_PROJECT_URL.test(url)).toBe(false);
});
