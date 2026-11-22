import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installClixad, runClixadSetupCommand, setupClixad } from './clixad-setup.js';
import type { ClixadSetupCommand } from './clixad-setup.js';
import { Clixad, CLIXAD_CORE_SHA256, CLIXAD_INTEGRITY, CLIXAD_MODEL, CLIXAD_TARBALL, clixadPaths, prepareClixadDirectories, readClixadInstallReceipt } from './clixad.js';
import type * as ClixadModule from './clixad.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import { planSteps } from './fixtures/key-only-goal.js';

const archive = Buffer.from('offline synthetic official archive fixture');
vi.mock('./clixad.js', async importOriginal => {
  const actual = await importOriginal<typeof ClixadModule>();
  const { createHash: hash } = await import('node:crypto');
  return { ...actual,
    CLIXAD_INTEGRITY: `sha512-${hash('sha512').update('offline synthetic official archive fixture').digest('base64')}`,
    CLIXAD_CORE_SHA256: Object.fromEntries(Object.keys(actual.CLIXAD_CORE_SHA256).map(name => [name, hash('sha256').update(`synthetic ${name}`).digest('hex')]))
  };
});
let directory: string, native: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-clixad-setup-')); native = join(directory, 'native'); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const fetcher = () => vi.fn<typeof fetch>(async url => {
  if (String(url) === CLIXAD_TARBALL) return new Response(archive);
  return Response.json({ data: [{ id: CLIXAD_MODEL, free: true, auto_mode: false, context_window: 262144 }] });
});
async function authenticate(contents = 'synthetic native token and preference fixture') { await mkdir(native, { recursive: true, mode: 0o700 }); await writeFile(join(native, 'config.json'), contents, { mode: 0o600 }); }
function squire() { return { signup: vi.fn(async () => {}), cancelSignup: vi.fn(async () => {}), approveDataSharing: vi.fn() }; }
async function fixture(existing = false) {
  await recordDataSharingConsent(directory, ['clixad']); const paths = await prepareClixadDirectories(directory);
  if (existing) await authenticate();
  const browser = squire(), verify = vi.fn(async () => {});
  if (!existing) verify.mockRejectedValueOnce(new SourceError('logged_out', 'synthetic native login required'));
  const command = vi.fn<ClixadSetupCommand>(async (_binary, args, options) => {
    if (args.at(-1) === 'login') {
      options.onOutput?.('terms and age notice\nOpen https://github.com/login/device and enter code: ABCD-EF12\n');
      await authenticate(); return { code: 0, stdout: 'native login success; private token never emitted' };
    }
    return { code: 0, stdout: `current model: ${CLIXAD_MODEL}\n` };
  });
  const install = vi.fn<typeof installClixad>(async () => paths), http = fetcher(), notify = vi.fn();
  return { directory, nativeDirectory: native, squire: browser, install, command, verify, fetcher: http, notify };
}

it('installs only the verified archive in a private npm prefix, disables scripts/audit/fund and reuses verified files', async () => {
  const http = fetcher();
  const command = vi.fn<ClixadSetupCommand>(async (_binary, args, options) => {
    expect(args).toContain('--ignore-scripts'); expect(args).toContain('--no-audit'); expect(args).toContain('--no-fund'); expect(args).toContain('--no-save');
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', clixadPaths(directory).runtime]);
    expect(options.cwd).toBe(clixadPaths(directory).work); expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.CLIXAD_GATEWAY_URL).toBeUndefined(); expect(options.env.CLIXAD_DASHBOARD_URL).toBeUndefined();
    const tarball = args.at(-1)!; expect(await readFile(tarball)).toEqual(archive); expect((await stat(tarball)).mode & 0o777).toBe(0o600);
    for (const name of Object.keys(CLIXAD_CORE_SHA256)) {
      const path = join(dirname(clixadPaths(directory).entry), name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, `synthetic ${name}`, { mode: 0o644 });
    }
    return { code: 0, stdout: 'npm output remains backend-only' };
  });
  const paths = await installClixad(directory, { fetcher: http, command });
  expect(http).toHaveBeenCalledOnce(); expect(http.mock.calls[0]![1]?.redirect).toBe('error'); expect(command).toHaveBeenCalledOnce();
  expect((await stat(paths.installation)).mode & 0o777).toBe(0o600); await expect(readClixadInstallReceipt(directory)).resolves.toMatchObject({ version: 1 });
  expect((await readdir(paths.home)).some(name => name.startsWith('.install-'))).toBe(false);
  await installClixad(directory, { fetcher: http, command }); expect(http).toHaveBeenCalledOnce(); expect(command).toHaveBeenCalledOnce();
  await writeFile(paths.entry, 'modified after receipt verification', { mode: 0o644 });
  await installClixad(directory, { fetcher: http, command }); expect(http).toHaveBeenCalledTimes(2); expect(command).toHaveBeenCalledTimes(2);
});

it('rejects an archive integrity mismatch before npm or any official CLI execution', async () => {
  const command = vi.fn<ClixadSetupCommand>(), http = vi.fn<typeof fetch>(async () => new Response('tampered archive'));
  await expect(installClixad(directory, { fetcher: http, command })).rejects.toThrow('free native setup did not complete');
  expect(command).not.toHaveBeenCalled(); await expect(stat(clixadPaths(directory).installation)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects an altered installed core before writing a trusted installation receipt', async () => {
  const command = vi.fn<ClixadSetupCommand>(async () => {
    for (const name of Object.keys(CLIXAD_CORE_SHA256)) { const path = join(dirname(clixadPaths(directory).entry), name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, 'modified core', { mode: 0o644 }); }
    return { code: 0, stdout: '' };
  });
  await expect(installClixad(directory, { fetcher: fetcher(), command })).rejects.toThrow('free native setup did not complete');
  await expect(stat(clixadPaths(directory).installation)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('pairs only the owned GitHub device flow, pins one new model, and verifies zero-wallet free access after login', async () => {
  const options = await fixture(); await setupClixad(options);
  expect(options.squire.signup).toHaveBeenCalledTimes(2);
  expect(options.squire.signup.mock.calls[0]![0]).toBe('clixad'); expect(options.squire.signup.mock.calls[0]![1]).toBe('https://app.clixad.io');
  const pairing = options.squire.signup.mock.calls[1] as unknown as [string, string, string, Record<string, string>];
  expect(pairing[3]).toEqual({ user_code: 'ABCD-EF12' });
  for (const call of options.squire.signup.mock.calls) expect(planSteps(String((call as unknown[])[2]))).toEqual([]);
  expect(pairing[0]).toBe('clixad'); expect(pairing[1]).toBe('https://github.com/login/device?user_code=ABCD-EF12');
  expect(pairing[2]).toContain('read-only identity/profile and email scopes'); expect(pairing[2]).toContain('CLI owns the token exchange');
  const login = options.command.mock.calls.find(([, args]) => args.at(-1) === 'login')!;
  expect(login[1]).toContain('process.umask(0o077); await import(process.argv[1]);'); expect(login[2].env.HOME).toBe(process.env.HOME);
  expect(login[2].env.PATH?.split(':')[0]).toContain('.login-openers-');
  const pins = options.command.mock.calls.filter(([, args]) => args.at(-2) === 'model' && args.at(-1) === CLIXAD_MODEL); expect(pins).toHaveLength(1);
  expect(options.verify).toHaveBeenCalledTimes(2); expect(options.squire.cancelSignup).not.toHaveBeenCalled();
  expect(JSON.stringify(options.notify.mock.calls)).not.toContain('synthetic native token');
  expect((await readdir(clixadPaths(directory).home)).some(name => name.startsWith('.login-openers-'))).toBe(false);
});

it('reuses current verified native auth without browser pairing, preference writes or reading its token', async () => {
  const options = await fixture(true), before = await readFile(join(native, 'config.json'), 'utf8');
  await setupClixad(options);
  expect(options.squire.signup).not.toHaveBeenCalled(); expect(options.verify).toHaveBeenCalledOnce();
  expect(options.command.mock.calls.map(([, args]) => args)).toEqual([[clixadPaths(directory).entry, 'model']]);
  expect(await readFile(join(native, 'config.json'), 'utf8')).toBe(before);
});

it('re-runs the browser sign-in and native device login when an existing native login has expired', async () => {
  const options = await fixture(true);
  options.verify.mockRejectedValueOnce(new SourceError('logged_out', 'synthetic-private-expired-token HTTP401'));
  await setupClixad(options);
  expect(options.squire.signup).toHaveBeenCalledTimes(2);
  expect(options.squire.signup.mock.calls[1]![1]).toBe('https://github.com/login/device?user_code=ABCD-EF12');
  expect(options.command.mock.calls.filter(([, args]) => args.at(-1) === 'login')).toHaveLength(1);
  // The existing model preference is kept, so no new pin is written.
  expect(options.command.mock.calls.filter(([, args]) => args.at(-2) === 'model' && args.at(-1) === CLIXAD_MODEL)).toHaveLength(0);
  expect(options.verify).toHaveBeenCalledTimes(2); expect(options.squire.cancelSignup).not.toHaveBeenCalled();
  expect(JSON.stringify(options.notify.mock.calls)).not.toContain('synthetic-private');
});

it('preserves an existing unrelated model choice and gives explicit model-selection guidance', async () => {
  const options = await fixture(true);
  options.command.mockResolvedValue({ code: 0, stdout: 'current model: another-model\n' });
  await expect(setupClixad(options)).rejects.toThrow('Grunt preserved the existing preference');
  expect(options.squire.signup).not.toHaveBeenCalled(); expect(options.verify).not.toHaveBeenCalled(); expect(options.command).toHaveBeenCalledOnce();
});

it.each(['quota', 'refused', 'upstream'])('does not reset existing authentication or pair around an access failure: %s', async code => {
  const options = await fixture(true); options.verify.mockRejectedValue(new SourceError(code as 'quota', 'private failure'));
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete'); expect(options.squire.signup).not.toHaveBeenCalled();
  expect(options.command).toHaveBeenCalledOnce();
});

it('requires current stored data-sharing consent before any installation, native process or browser action', async () => {
  const options = await fixture(); await rm(join(directory, 'data-sharing-consent.json'));
  await expect(setupClixad({ ...options, dataSharingApproved: ['clixad'] })).rejects.toThrow('current grouped data-sharing approval');
  expect(options.install).not.toHaveBeenCalled(); expect(options.command).not.toHaveBeenCalled(); expect(options.squire.signup).not.toHaveBeenCalled();
});

it('checks background availability without installing, claiming a streak, running native commands or opening a browser', async () => {
  const options = await fixture(true), available = vi.spyOn(Clixad.prototype, 'available').mockResolvedValue(true), close = vi.spyOn(Clixad.prototype, 'close').mockResolvedValue();
  await setupClixad({ ...options, background: true }); expect(available).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(options.install).not.toHaveBeenCalled(); expect(options.verify).not.toHaveBeenCalled(); expect(options.command).not.toHaveBeenCalled(); expect(options.squire.signup).not.toHaveBeenCalled();
  available.mockResolvedValue(false); await expect(setupClixad({ ...options, background: true })).rejects.toThrow('free native setup did not complete');
});

it('rejects unsafe native authentication permissions or symlinks without attempting login', async () => {
  const options = await fixture(true), file = join(native, 'config.json'); await chmod(file, 0o644);
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete');
  await rm(file); const target = join(directory, 'target'); await writeFile(target, 'synthetic', { mode: 0o600 }); await symlink(target, file);
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete'); expect(options.command).not.toHaveBeenCalled(); expect(options.squire.signup).not.toHaveBeenCalled();
});

it('does not overwrite authentication created elsewhere while browser account verification was pending', async () => {
  const options = await fixture(); options.squire.signup.mockImplementationOnce(async () => { await authenticate('unrelated newly created native auth'); });
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete'); expect(options.command).not.toHaveBeenCalled();
  expect(await readFile(join(native, 'config.json'), 'utf8')).toBe('unrelated newly created native auth');
});

it('cancels only this provider and prevents late browser success from causing native login or writes', async () => {
  const options = await fixture(); let finish!: () => void;
  options.squire.signup.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = setupClixad({ ...options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('free native setup did not complete');
  await vi.waitFor(() => expect(options.squire.signup).toHaveBeenCalledOnce()); controller.abort(new Error('private cancellation reason'));
  await rejected; finish(); await Promise.resolve();
  expect(options.squire.cancelSignup).toHaveBeenCalledOnce(); expect(options.squire.cancelSignup).toHaveBeenCalledWith('clixad'); expect(options.command).not.toHaveBeenCalled();
  await expect(stat(join(native, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('aborts an in-progress device pairing before the native CLI can persist authentication or pin a model', async () => {
  const options = await fixture(); let finish!: () => void;
  options.squire.signup.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
  options.command.mockImplementation(async (_binary, args, command) => {
    if (args.at(-1) !== 'login') throw new Error('No model write is allowed');
    command.onOutput?.('Open https://github.com/login/device and enter code: ABCD-EF12\n');
    return new Promise(resolve => { command.signal.addEventListener('abort', () => resolve({ code: 1, stdout: '' }), { once: true }); });
  });
  const controller = new AbortController(), pending = setupClixad({ ...options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('free native setup did not complete');
  await vi.waitFor(() => expect(options.squire.signup).toHaveBeenCalledTimes(2)); controller.abort(); await rejected;
  finish(); await Promise.resolve(); expect(options.command).toHaveBeenCalledOnce(); expect(options.squire.cancelSignup).toHaveBeenCalledWith('clixad');
  await expect(stat(join(native, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(clixadPaths(directory).home)).some(name => name.startsWith('.login-openers-'))).toBe(false);
});

it('stops before pairing or native access if the current public model catalog is not free', async () => {
  const options = await fixture(); options.fetcher.mockImplementation(async () => Response.json({ data: [{ id: CLIXAD_MODEL, free: false, auto_mode: false, context_window: 262144 }] }));
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete');
  expect(options.command).not.toHaveBeenCalled(); expect(options.verify).not.toHaveBeenCalled(); expect(options.squire.signup).not.toHaveBeenCalled();
});

it('bounds pairing to ten minutes and sanitizes the failure without closing another provider', async () => {
  const options = await fixture(); options.squire.signup.mockImplementation(async () => new Promise<void>(() => {}));
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => original(callback, ms === 600000 ? 30 : ms, ...args)) as typeof setTimeout);
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete'); expect(options.squire.cancelSignup).toHaveBeenCalledWith('clixad');
  expect(options.command).not.toHaveBeenCalled();
});

it('rejects spoofed GitHub device URLs rather than authorizing their codes', async () => {
  const options = await fixture(); options.command.mockImplementation(async (_binary, args, command) => {
    if (args.at(-1) === 'login') command.onOutput?.('Open https://github.com/login/device.evil and enter code: ABCD-EF12\n');
    return { code: 0, stdout: '' };
  });
  await expect(setupClixad(options)).rejects.toThrow('free native setup did not complete'); expect(options.squire.signup).toHaveBeenCalledTimes(1);
  expect(options.squire.cancelSignup).toHaveBeenCalledWith('clixad');
});

it('kills only the owned setup process group on cancellation and keeps raw stderr private', async () => {
  const pid = join(directory, 'child.pid'), controller = new AbortController();
  const script = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pid)},String(child.pid));process.stderr.write('synthetic-private-auth-url');setInterval(()=>{},1000);`;
  const pending = runClixadSetupCommand(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, env: process.env, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('free native setup did not complete'); await vi.waitFor(async () => expect(Number(await readFile(pid, 'utf8'))).toBeGreaterThan(0));
  controller.abort(new Error('synthetic-private-reason')); await rejected;
  if (process.platform === 'linux') { const status = await readFile(`/proc/${await readFile(pid, 'utf8')}/stat`, 'utf8').catch(() => 'gone'); expect(status === 'gone' || /^\d+ \(.+\) Z /.test(status)).toBe(true); }
});

it('uses the expected archive SRI format in the fixture so tampering tests exercise hashing', () => {
  expect(CLIXAD_INTEGRITY).toBe(`sha512-${createHash('sha512').update(archive).digest('base64')}`);
});
