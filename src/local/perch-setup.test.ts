import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as Perch from './perch.js';
import type { PerchProcesses } from './perch-process.js';
import { installPerch, setupPerch } from './perch-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

// Tiny deterministic package fixtures exercise the installer's real digest and
// core-file checks without downloading or executing the vendor's native bundle.
vi.mock('./perch.js', async importOriginal => {
  const actual = await importOriginal<typeof Perch>();
  const { createHash } = await import('node:crypto');
  const archive = Buffer.from('perch-offline-official-archive-fixture');
  const core = { 'bin/perch': 'official wrapper fixture', 'dist/perch.mjs': 'official engine fixture', 'package.json': '{"name":"perchai-cli","version":"2.4.132"}' };
  return { ...actual,
    PERCH_NPM_INTEGRITY: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    PERCH_TARBALL_SHA256: createHash('sha256').update(archive).digest('hex'),
    PERCH_CORE_SHA256: Object.fromEntries(Object.entries(core).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')]))
  };
});
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-perch-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const plan = (email = 'person@example.test') => ({ version: 1 as const, plan: 'Starter' as const, email, monthlyAllowancePT: 20000 as const, dataProgramEnabled: false as const,
  memoryUseEnabled: false as const, memoryLearningEnabled: false as const, checkedAt: new Date().toISOString() });
async function fixture() {
  const paths = await Perch.preparePerchDirectories(directory);
  vi.spyOn(Perch, 'verifyPerchStartupIsolation').mockResolvedValue();
  const identity = vi.fn<typeof Perch.verifyPerchIdentity>().mockResolvedValueOnce(null).mockResolvedValue({ email: 'person@example.test' });
  const configureMemory = vi.fn<typeof Perch.configurePerchMemory>().mockResolvedValue({ email: 'person@example.test' });
  const verifyMemory = vi.fn<typeof Perch.verifyPerchMemory>().mockResolvedValue({ email: 'person@example.test' });
  const install = vi.fn<typeof installPerch>().mockResolvedValue(paths);
  const command = vi.fn<PerchProcesses['command']>(async (_program, _args, options) => {
    options.onLine?.('Signing in using https://app.perchai.app.', 'stdout');
    options.onLine?.('Open https://app.perchai.app/api/perch-terminal/cli-auth/start?state=private-pairing-nonce', 'stdout');
    await writeFile(paths.authFile, 'synthetic CLI-owned private session', { mode: 0o600 });
    return { code: 0, stdout: 'native login completed' };
  });
  const processes = { command, acp: vi.fn<PerchProcesses['acp']>() };
  const squire = { signup: vi.fn(async (_provider: string, _url: string, _goal: string) => {}), cancelSignup: vi.fn(async () => {}), approveDataSharing: vi.fn() };
  return { paths, identity, configureMemory, verifyMemory, install, command, processes, squire,
    options: { directory, squire, identity, configureMemory, verifyMemory, install, processes, dataSharingApproved: ['perch'] } };
}

it('requires grouped consent before installation, browser work, or native identity requests', async () => {
  const f = await fixture();
  await expect(setupPerch({ ...f.options, dataSharingApproved: [] })).rejects.toThrow('grouped setup approval');
  expect(f.install).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
});

it('verifies active Starter before official native pairing and checks the exact native email afterward', async () => {
  const f = await fixture(), notify = vi.fn();
  await recordDataSharingConsent(directory, ['perch', 'kilo']);
  await setupPerch({ ...f.options, dataSharingApproved: [], notify });
  expect(f.squire.signup.mock.calls.map(([provider]) => provider)).toEqual(['perch', 'perch', 'perch']);
  // The native app host is a download landing page in ordinary browsers.
  expect(f.squire.signup.mock.calls.map(([, url]) => url)).toEqual([
    'https://chat.perchai.app/',
    'https://app.perchai.app/api/perch-terminal/cli-auth/start?state=private-pairing-nonce',
    'https://chat.perchai.app/'
  ]);
  expect(f.squire.signup.mock.calls[0]![2]).toContain('activate Starter only');
  expect(f.squire.signup.mock.calls[0]![2]).toContain('Do not open billing to audit the plan');
  expect(f.squire.signup.mock.calls[0]![2]).toContain('turn the optional Starter Data Program OFF');
  expect(f.squire.signup.mock.calls[2]![2]).toContain('person@example.test');
  expect(f.squire.signup.mock.calls[2]![2]).not.toContain('paymentMethodPresent');
  expect(f.command.mock.calls[0]![0]).toBe(process.execPath);
  expect(f.command.mock.calls[0]![1]).toEqual([f.paths.binary, 'login', 'google']);
  const processOptions = f.command.mock.calls[0]![2];
  expect(processOptions.timeoutMs).toBe(600000);
  expect(processOptions.env.HOME).toBe(process.env.HOME);
  expect(processOptions.env.PERCH_CLI_AUTH_DIR).toBe(f.paths.auth);
  expect(processOptions.cwd.startsWith(f.paths.home)).toBe(true);
  expect(await Perch.readPerchFreePlanReceipt(directory)).toMatchObject({ ...plan(), checkedAt: expect.any(String) });
  expect((await stat(f.paths.receipt)).mode & 0o777).toBe(0o600);
  expect((await stat(f.paths.authFile)).mode & 0o777).toBe(0o600);
  expect(f.squire.approveDataSharing).toHaveBeenCalledWith(['kilo', 'perch']);
  expect(f.configureMemory).toHaveBeenCalledOnce(); expect(f.verifyMemory).toHaveBeenCalledOnce();
  expect(f.configureMemory.mock.invocationCallOrder[0]).toBeGreaterThan(f.squire.signup.mock.invocationCallOrder[2]!);
  expect(f.verifyMemory.mock.invocationCallOrder[0]).toBeGreaterThan(f.configureMemory.mock.invocationCallOrder[0]!);
  expect(JSON.stringify(notify.mock.calls)).not.toMatch(/nonce|session|token|https:/i);
  expect((await readdir(f.paths.home)).some(name => name.startsWith('.login-'))).toBe(false);
});

it('reuses a current receipt only after a native refresh-and-identity check without more OAuth', async () => {
  const f = await fixture();
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  await Perch.writePerchFreePlanReceipt(directory, plan());
  const before = await readFile(f.paths.receipt, 'utf8');
  await setupPerch(f.options);
  expect(f.identity).toHaveBeenCalledOnce(); expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  expect(f.verifyMemory).toHaveBeenCalledOnce(); expect(f.configureMemory).not.toHaveBeenCalled();
  expect(await readFile(f.paths.receipt, 'utf8')).toBe(before);
});

it('refreshes expired plan verification for the same valid native identity without creating another login', async () => {
  const f = await fixture();
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  await writeFile(f.paths.receipt, JSON.stringify({ ...plan(), checkedAt: new Date(Date.now() - 31 * 86400000).toISOString() }), { mode: 0o600 });
  await setupPerch(f.options);
  expect(f.squire.signup).toHaveBeenCalledOnce();
  expect(f.squire.signup.mock.calls[0]![2]).toContain('person@example.test');
  expect(f.command).not.toHaveBeenCalled();
  expect(await Perch.readPerchFreePlanReceipt(directory)).toMatchObject({ ...plan(), checkedAt: expect.any(String) });
});

it('invalidates a mismatched native identity without switching accounts or repeating sign-in', async () => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  f.identity.mockReset().mockResolvedValue({ email: 'different@example.test' });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['paid plan', 'Starter placeholder not activated'])('does not pair or save Starter access when the initial plan check reports %s', async state => {
  const f = await fixture();
  f.squire.signup.mockRejectedValue(new Error(`${state}: private-native-token`));
  await expect(setupPerch(f.options)).rejects.toThrow('Perch active Starter verification or native login did not complete');
  expect(f.command).not.toHaveBeenCalled();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.squire.cancelSignup).toHaveBeenCalledWith('perch');
});

it('refuses a wrong post-pair native account instead of binding the prior free receipt to it', async () => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  f.identity.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ email: 'different@example.test' });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.squire.signup).toHaveBeenCalledTimes(2);
  expect(f.squire.signup.mock.calls[1]![2]).toContain('person@example.test');
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires final active-Starter and privacy confirmation after native pairing', async () => {
  const f = await fixture();
  f.squire.signup.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('inactive or Data Program enabled'));
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.identity).toHaveBeenCalledTimes(2);
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['https://attacker.test/api/perch-terminal/cli-auth/start', 'https://app.perchai.app/api/perch-terminal/cli-auth/start/other', 'https://app.perchai.app/api/perch-terminal/cli-auth/start.'])('never forwards an untrusted pairing URL to Squire (%s)', async url => {
  const f = await fixture();
  f.command.mockImplementation(async (_program, _args, options) => {
    options.onLine?.(`Open ${url}`, 'stdout');
    return { code: 0, stdout: '' };
  });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.squire.signup).toHaveBeenCalledTimes(1);
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves punctuation in the actual native authorization query unchanged', async () => {
  const f = await fixture();
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation((program, args, options) => original(program, args, {
    ...options,
    onLine: (line, stream) => options.onLine?.(line.replace('state=private-pairing-nonce', 'state=private-pairing-nonce.'), stream)
  }));
  await setupPerch(f.options);
  expect(f.squire.signup.mock.calls[1]![1]).toBe('https://app.perchai.app/api/perch-terminal/cli-auth/start?state=private-pairing-nonce.');
});

it('honors the native login expiry without patching its timeout or retrying a new authorization', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (_program, _args, options) => {
    options.onLine?.('https://app.perchai.app/api/perch-terminal/cli-auth/start?state=expired', 'stdout');
    return { code: 1, stdout: 'native callback expired' };
  });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.command).toHaveBeenCalledOnce();
  expect(f.command.mock.calls[0]![1]).toEqual([f.paths.binary, 'login', 'google']);
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('sanitizes a late browser refusal after the native command has exited', async () => {
  const f = await fixture();
  f.squire.signup.mockImplementation(async (_provider, url) => {
    if (url.includes('/cli-auth/start')) { await new Promise(resolve => setTimeout(resolve, 30)); throw new Error('private-native-token'); }
  });
  const error = await setupPerch(f.options).then(() => null, reason => reason as Error);
  expect(error?.message).toBe('Perch active Starter verification or native login did not complete; rerun usegrunt setup');
  expect(error?.message).not.toContain('private-native-token');
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels pending browser work after native completion without closing another provider', async () => {
  const f = await fixture(), controller = new AbortController();
  f.squire.signup.mockImplementation(async (_provider, url) => {
    if (url.includes('/cli-auth/start')) await new Promise<void>(() => {});
  });
  const pending = setupPerch({ ...f.options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('active Starter verification');
  await vi.waitFor(() => expect(f.squire.signup).toHaveBeenCalledTimes(2));
  controller.abort(new Error('private cancellation reason'));
  await rejected;
  expect(f.squire.cancelSignup).toHaveBeenCalledWith('perch');
  expect(f.squire.cancelSignup).toHaveBeenCalledOnce();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('background reuse performs only verified installation and native identity checks', async () => {
  const f = await fixture();
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  await Perch.writePerchFreePlanReceipt(directory, plan());
  const verify = vi.spyOn(Perch, 'verifyPerchInstallation').mockResolvedValue();
  await setupPerch({ ...f.options, background: true });
  expect(verify).toHaveBeenCalledOnce(); expect(f.identity).toHaveBeenCalledOnce();
  expect(f.install).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
  expect(f.verifyMemory).toHaveBeenCalledOnce(); expect(f.configureMemory).not.toHaveBeenCalled();
  expect(f.squire.approveDataSharing).not.toHaveBeenCalled();
});

it('background setup cannot install, activate a plan, log in, or change privacy when no receipt exists', async () => {
  const f = await fixture();
  vi.spyOn(Perch, 'verifyPerchInstallation').mockResolvedValue();
  await expect(setupPerch({ ...f.options, background: true })).rejects.toThrow('active Starter verification');
  expect(f.install).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
  expect(f.squire.cancelSignup).not.toHaveBeenCalled();
});

it('rejects a corrupt package before extracting or executing anything', async () => {
  const command = vi.fn<PerchProcesses['command']>();
  await expect(installPerch(directory, { command, fetcher: async () => new Response('corrupt archive') })).rejects.toThrow('integrity');
  expect(command).not.toHaveBeenCalled();
  const paths = Perch.perchPaths(directory);
  await expect(stat(paths.installReceipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(paths.home)).some(name => name.startsWith('.install-'))).toBe(false);
});

it.each([false, true])('installs a verified private fixture without scripts/global changes and rejects dependency-time core mutation (%s)', async tamper => {
  const paths = await Perch.preparePerchDirectories(directory);
  await writeFile(paths.authFile, 'synthetic CLI-owned auth remains untouched', { mode: 0o600 });
  const verify = vi.spyOn(Perch, 'verifyPerchInstallation').mockRejectedValueOnce(new Error('not installed')).mockResolvedValue();
  const receipt = vi.spyOn(Perch, 'writePerchInstallReceipt').mockResolvedValue();
  const command = vi.fn<PerchProcesses['command']>(async (program, args) => {
    if (program === 'tar') {
      const root = join(String(args[args.indexOf('-C') + 1]), 'package');
      await mkdir(join(root, 'bin'), { recursive: true, mode: 0o700 }); await mkdir(join(root, 'dist'), { mode: 0o700 });
      await writeFile(join(root, 'bin/perch'), 'official wrapper fixture', { mode: 0o700 });
      await writeFile(join(root, 'dist/perch.mjs'), 'official engine fixture', { mode: 0o600 });
      await writeFile(join(root, 'package.json'), '{"name":"perchai-cli","version":"2.4.132"}', { mode: 0o600 });
    } else if (program === 'npm') {
      expect(args).toContain('--ignore-scripts'); expect(args).toContain('--omit=dev'); expect(args).not.toContain('--global');
      expect(args).toContain('--registry=https://registry.npmjs.org');
      expect(args[args.indexOf('--userconfig') + 1]).not.toBe(args[args.indexOf('--globalconfig') + 1]);
      const packageRoot = String(args[args.indexOf('--prefix') + 1]);
      expect(packageRoot.startsWith(paths.home)).toBe(true);
      if (tamper) await writeFile(join(packageRoot, 'dist/perch.mjs'), 'modified engine');
    }
    return { code: 0, stdout: '' };
  });
  const operation = installPerch(directory, { command, fetcher: async () => new Response('perch-offline-official-archive-fixture') });
  if (tamper) { await expect(operation).rejects.toThrow('pinned release'); expect(receipt).not.toHaveBeenCalled(); }
  else {
    await expect(operation).resolves.toMatchObject({ binary: paths.binary });
    expect(receipt).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledTimes(2);
    expect((await stat(paths.binary)).mode & 0o777).toBe(0o700);
  }
  expect(await readFile(paths.authFile, 'utf8')).toBe('synthetic CLI-owned auth remains untouched');
  expect(command.mock.calls.map(([program]) => program)).toEqual(['tar', 'npm']);
});

it('repairs changed native memory settings only during foreground setup after plan reverification', async () => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  f.verifyMemory.mockRejectedValueOnce(new Error('Use memory is On')).mockResolvedValue({ email: 'person@example.test' });
  await setupPerch(f.options);
  expect(f.squire.signup).toHaveBeenCalledOnce();
  expect(f.configureMemory).toHaveBeenCalledOnce(); expect(f.verifyMemory).toHaveBeenCalledTimes(2);
  expect(f.configureMemory.mock.invocationCallOrder[0]).toBeGreaterThan(f.squire.signup.mock.invocationCallOrder[0]!);
  expect(await Perch.readPerchFreePlanReceipt(directory)).toMatchObject({ memoryUseEnabled: false, memoryLearningEnabled: false });
  expect(f.command).not.toHaveBeenCalled();
});

it('background checks reject changed memory settings without altering them or opening a browser', async () => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  const before = await readFile(f.paths.receipt);
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  f.verifyMemory.mockRejectedValue(new Error('Learn new memories is On'));
  vi.spyOn(Perch, 'verifyPerchInstallation').mockResolvedValue();
  await expect(setupPerch({ ...f.options, background: true })).rejects.toThrow('active Starter verification');
  expect(f.configureMemory).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  expect(await readFile(f.paths.receipt)).toEqual(before);
});

it.each(['identity request failed', 'identity unavailable', 'identity changed', 'memory request failed', 'memory account changed'])('background failure preserves the existing receipt byte-for-byte: %s', async failure => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  const before = await readFile(f.paths.receipt);
  const modified = (await stat(f.paths.receipt)).mtimeMs;
  vi.spyOn(Perch, 'verifyPerchInstallation').mockResolvedValue();
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  if (failure === 'identity request failed') f.identity.mockRejectedValue(new Error('temporary native OAuth network failure'));
  if (failure === 'identity unavailable') f.identity.mockResolvedValue(null);
  if (failure === 'identity changed') f.identity.mockResolvedValue({ email: 'different@example.test' });
  if (failure === 'memory request failed') f.verifyMemory.mockRejectedValue(new Error('temporary memory settings network failure'));
  if (failure === 'memory account changed') f.verifyMemory.mockResolvedValue({ email: 'different@example.test' });
  await expect(setupPerch({ ...f.options, background: true })).rejects.toThrow('active Starter verification');
  expect(await readFile(f.paths.receipt)).toEqual(before);
  expect((await stat(f.paths.receipt)).mtimeMs).toBe(modified);
  expect(f.configureMemory).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.squire.cancelSignup).not.toHaveBeenCalled();
  expect(f.squire.approveDataSharing).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
});

it.each(['expired plan', 'changed privacy'])('background rejects %s without deleting or rewriting the local verification', async failure => {
  const f = await fixture();
  const saved = failure === 'expired plan'
    ? { ...plan(), checkedAt: new Date(Date.now() - 31 * 86400000).toISOString() }
    : { ...plan(), dataProgramEnabled: true };
  await writeFile(f.paths.receipt, JSON.stringify(saved) + '\n', { mode: 0o600 });
  const before = await readFile(f.paths.receipt);
  const modified = (await stat(f.paths.receipt)).mtimeMs;
  vi.spyOn(Perch, 'verifyPerchInstallation').mockResolvedValue();
  await expect(setupPerch({ ...f.options, background: true })).rejects.toThrow('active Starter verification');
  expect(await readFile(f.paths.receipt)).toEqual(before);
  expect((await stat(f.paths.receipt)).mtimeMs).toBe(modified);
  expect(f.identity).not.toHaveBeenCalled(); expect(f.verifyMemory).not.toHaveBeenCalled();
  expect(f.configureMemory).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
});

it('does not treat a changed memory account as a setting that foreground setup may repair', async () => {
  const f = await fixture();
  await Perch.writePerchFreePlanReceipt(directory, plan());
  f.identity.mockReset().mockResolvedValue({ email: 'person@example.test' });
  f.verifyMemory.mockResolvedValue({ email: 'other@example.test' });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.configureMemory).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['configuration', 'readback'])('does not issue a free receipt if native memory %s belongs to a different account', async stage => {
  const f = await fixture();
  if (stage === 'configuration') f.configureMemory.mockResolvedValue({ email: 'other@example.test' });
  else f.verifyMemory.mockResolvedValue({ email: 'other@example.test' });
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.squire.cancelSignup).toHaveBeenCalledWith('perch');
});

it('does not claim memory-off proof when the native configuration or fresh readback fails', async () => {
  const f = await fixture();
  f.verifyMemory.mockRejectedValue(new Error('Use memory remains On'));
  await expect(setupPerch(f.options)).rejects.toThrow('active Starter verification');
  expect(f.configureMemory).toHaveBeenCalledOnce();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('never writes a late receipt after cancellation while native memory configuration is pending', async () => {
  const f = await fixture(), controller = new AbortController();
  let release!: (value: { email: string }) => void;
  f.configureMemory.mockImplementation(async () => await new Promise(resolve => { release = resolve; }));
  const pending = setupPerch({ ...f.options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('active Starter verification');
  await vi.waitFor(() => expect(f.configureMemory).toHaveBeenCalledOnce());
  controller.abort(); await rejected;
  release({ email: 'person@example.test' });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.verifyMemory).not.toHaveBeenCalled();
  await expect(stat(f.paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});
