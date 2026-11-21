import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LIVEKIT_CLI_VERSION, livekitPaths, livekitEnvironment, parseLiveKitProjects, readLiveKitFreeBuildReceipt, writeLiveKitFreeBuildReceipt } from './livekit.js';

const exec = promisify(execFile);
// Official v2.19.4 checksums.txt, pinned with the release rather than fetched as
// a mutable trust decision during installation.
const archives: Record<string, string> = {
  darwin_amd64: '281c8db91cd83ead131e16c4f857db80a6cdbc59996584961ce7b0c6d34b2789',
  darwin_arm64: '0732343947a08c1cb495bf7a5c4a0dab2cc2caecd1f67d9eba3fdf01ae3f2cee',
  linux_amd64: 'cb0f769201faa13956a3999bee078ec63fd5f22b855a79c09d648283e50debae',
  linux_arm64: '368b12e35fff71ff14867800f747da3714ec2a56b61b855d552c3d79ef4a9586'
};
const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('LiveKit setup requires a private directory owned by this user with mode 0700');
}
async function nativeConfig(directory: string, missing = false) {
  await privateDirectory(directory);
  try {
    const stat = await lstat(join(directory, 'cli-config.yaml'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || (!missing && stat.size === 0)) throw new Error('Unsafe LiveKit native CLI config; it must be owned by this user with mode 0600');
  } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function command(binary: string, args: string[], cwd: string, signal?: AbortSignal) {
  try {
    return (await exec(binary, args, { cwd, env: livekitEnvironment(), signal, timeout: 30000, maxBuffer: 262144 })).stdout;
  } catch { signal?.throwIfAborted(); throw new Error('LiveKit native CLI command failed; rerun usegrunt setup'); }
}
export async function installLiveKit(directory: string, options: { signal?: AbortSignal; fetcher?: typeof fetch; platform?: string; arch?: string } = {}) {
  const platform = options.platform ?? process.platform;
  const arch = (options.arch ?? process.arch) === 'x64' ? 'amd64' : options.arch ?? process.arch;
  const checksum = archives[`${platform}_${arch}`];
  if (!checksum) throw new Error('LiveKit automatic installation supports Linux and macOS on x64 or arm64');
  const paths = livekitPaths(directory);
  await privateDirectory(paths.home);
  const bin = join(paths.home, 'bin');
  await privateDirectory(bin);
  const work = join(paths.home, 'work');
  await privateDirectory(work);
  try {
    const stat = await lstat(paths.binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('unsafe');
    await access(paths.binary, constants.X_OK);
    if (clean(await command(paths.binary, ['--version'], work, options.signal)).trim() === `lk version ${LIVEKIT_CLI_VERSION}`) return paths.binary;
  } catch { options.signal?.throwIfAborted(); }
  const temporary = await mkdtemp(join(paths.home, '.install-'));
  try {
    const name = `lk_${LIVEKIT_CLI_VERSION}_${platform}_${arch}.tar.gz`;
    const response = await (options.fetcher ?? fetch)(`https://github.com/livekit/livekit-cli/releases/download/v${LIVEKIT_CLI_VERSION}/${name}`, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'follow' });
    if (!response.ok || Number(response.headers.get('content-length')) > 100 * 1024 * 1024) throw new Error('LiveKit release download failed');
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > 100 * 1024 * 1024 || createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('LiveKit release checksum did not match the pinned official release');
    const path = join(temporary, 'release.tar.gz');
    await writeFile(path, archive, { mode: 0o600, flag: 'wx' });
    await command('tar', ['-xzf', path, '-C', temporary, 'lk'], work, options.signal);
    const binary = join(temporary, 'lk');
    const stat = await lstat(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Invalid LiveKit release binary');
    await chmod(binary, 0o700);
    if (clean(await command(binary, ['--version'], work, options.signal)).trim() !== `lk version ${LIVEKIT_CLI_VERSION}`) throw new Error('LiveKit release version did not match');
    await rename(binary, paths.binary);
    return paths.binary;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
interface Signup { signup(service: string, url: string, goal: string): Promise<void> }
interface SetupOptions {
  directory: string; squire: Signup; signal?: AbortSignal; notify?(line: string): void;
  /** Test-only dependencies; production always uses the standard native home. */
  nativeDirectory?: string; install?: typeof installLiveKit;
}
async function awaitBrowser(promise: Promise<void>, signal: AbortSignal, message: string) {
  let aborted: (() => void) | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new Error(message));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    })]);
  } catch { throw new Error(message); }
  finally { if (aborted) signal.removeEventListener('abort', aborted); }
}
async function verifyAccount(options: SetupOptions) {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 600000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    await awaitBrowser(Promise.resolve().then(() => options.squire.signup('livekit', 'https://cloud.livekit.io', 'Use the personal Google identity already connected to Squire to sign up for LiveKit Cloud, or reuse its existing account. Do not open billing pages to audit the plan. Reuse the owned empty grunt-free project, or create that one ordinary empty free project if absent. Turn off optional Agent observability on this owned grunt-free project, leaving unrelated projects unchanged. Do not create rooms, deploy agents, enable hosting or billing, buy credits, inspect API secrets, switch accounts or alter other projects. Finish once the free project is ready; native CLI pairing follows separately if needed. Required human verification needs browser handoff; stop on refusal.')), signal, 'LiveKit free Build account verification did not complete; rerun usegrunt setup');
  } finally { clearTimeout(timeout); }
}
async function verifyProject(binary: string, selector: string, work: string, signal?: AbortSignal) {
  // This signs locally through the official CLI and performs no inference.
  // The short-lived token remains backend-only and is discarded immediately.
  const token = (await command(binary, ['--project', selector, '--config', join(work, 'livekit.toml'), 'token', 'create', '--inference', '--token-only', '--valid-for', '10m', '--identity', 'agent'], work, signal)).trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 16384) throw new Error('LiveKit native project authentication is unavailable; rerun usegrunt setup');
}
async function authenticate(binary: string, options: SetupOptions, work: string) {
  // pkg/browser ignores BROWSER and directly executes these platform openers.
  // Suppress only that unmanaged launch; Squire visits the real pairing URL.
  const openers = await mkdtemp(join(livekitPaths(options.directory).home, '.openers-'));
  for (const name of ['open', 'xdg-open', 'x-www-browser', 'www-browser']) await writeFile(join(openers, name), '#!/bin/sh\nexit 0\n', { mode: 0o700, flag: 'wx' });
  const shell = `stty rows 40 cols 120 && exec ${quote(binary)} --config ${quote(join(work, 'livekit.toml'))} cloud auth --timeout 600`;
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', shell] : ['-qefc', shell, '/dev/null'];
  const child = spawn('script', args, { cwd: work, env: { ...livekitEnvironment(), PATH: `${openers}:${process.env.PATH ?? '/usr/bin:/bin'}`, TERM: 'xterm-256color', NO_COLOR: '1', LK_NO_SKILLS_PROMPT: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let buffer = '', failure: Error | undefined, paired = false;
  let pairing: Promise<void> | undefined;
  const answered = new Set<string>();
  let force: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
  const stop = (hard = false) => { try { if (child.pid) process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Owned process already exited. */ } };
  const abort = () => { stop(); force ??= setTimeout(() => stop(true), 1000); force.unref(); };
  const deadline = setTimeout(() => { failure = new Error('LiveKit native login timed out; rerun usegrunt setup'); timeoutController.abort(); }, 600000);
  signal.addEventListener('abort', abort, { once: true });
  const read = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-65536);
    const text = clean(buffer);
    const answer = (key: string, value: string) => { if (!answered.has(key)) { answered.add(key); child.stdin.write(value); } };
    if (/install livekit.*skills|install.*coding agent.*skills/i.test(text)) answer('skills', 'n\n');
    if (/what is the name of this device\?/i.test(text)) answer('device', '\x15grunt\n');
    if (/make this project default\?/i.test(text)) answer('default', 'n\n');
    if (/choose a different alias/i.test(text)) answer('alias', `\x15grunt-free-${randomUUID().slice(0, 8)}\n`);
    const match = text.match(/https:\/\/cloud\.livekit\.io\/cli\/confirm-auth\?[^\s\x1b]+/);
    if (match && !paired) {
      const url = new URL(match[0]);
      if (!url.searchParams.get('t') || url.username || url.password || url.hash) { failure = new Error('LiveKit returned an invalid native pairing URL'); abort(); return; }
      paired = true;
      pairing = awaitBrowser(Promise.resolve().then(() => options.squire.signup('livekit', url.href, 'Approve only the LiveKit native CLI pairing started by Grunt. Select exactly the owned grunt-free project. Do not select another existing or paid project. Keep the $2.50 monthly inference hard stop and no payment method, paid credits or automatic billing. Never view, copy or reveal an API secret. Do not enable agent hosting, create rooms, buy credits, change another project, or switch accounts. Report any human verification for browser handoff; stop on refusal.')), signal, 'LiveKit browser pairing did not complete; rerun usegrunt setup');
      void pairing.catch(() => { failure = new Error('LiveKit browser pairing did not complete; rerun usegrunt setup'); abort(); });
    }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  if (signal.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(new Error('LiveKit native login requires the standard script PTY utility'))); child.once('close', resolve); });
    if (signal.aborted) throw new Error('LiveKit native login was cancelled or timed out; rerun usegrunt setup');
    if (failure || code !== 0 || !paired) throw failure ?? new Error('LiveKit native login did not complete');
    await pairing;
  } finally {
    clearTimeout(deadline); if (force) clearTimeout(force);
    signal.removeEventListener('abort', abort); stop(true); child.stdin.destroy();
    await rm(openers, { recursive: true, force: true });
  }
}
export async function setupLiveKit(options: SetupOptions) {
  options.signal?.throwIfAborted();
  const binary = await (options.install ?? installLiveKit)(options.directory, options.signal ? { signal: options.signal } : {});
  const paths = livekitPaths(options.directory);
  const work = await mkdtemp(join(paths.home, '.setup-work-'));
  try {
    await writeFile(join(work, 'livekit.toml'), '', { mode: 0o600, flag: 'wx' });
    const native = options.nativeDirectory ?? join(homedir(), '.livekit');
    await nativeConfig(native, true);
    const before = parseLiveKitProjects(await command(binary, ['--config', join(work, 'livekit.toml'), 'project', 'list'], work, options.signal));
    try {
      const receipt = await readLiveKitFreeBuildReceipt(options.directory);
      if (before.some(project => project.selector === receipt.projectSelector && project.id === receipt.projectId && project.url === receipt.projectURL)) {
        await nativeConfig(native);
        await verifyProject(binary, receipt.projectSelector, work, options.signal);
        return;
      }
    } catch { options.signal?.throwIfAborted(); }
    // A fresh browser check replaces any previous billing approval immediately.
    await rm(paths.receipt, { force: true });
    await verifyAccount(options);
    const existing = before.filter(project => /^wss:\/\/grunt-free-[a-z0-9-]+\.livekit\.cloud$/.test(project.url));
    if (existing.length && existing.some(project => project.id !== existing[0]!.id || project.url !== existing[0]!.url)) throw new Error('Multiple LiveKit grunt-free projects need an explicit selection before setup can continue');
    if (existing.length) {
      const project = existing[0]!;
      let usable = false;
      try { await verifyProject(binary, project.selector, work, options.signal); usable = true; }
      catch { options.signal?.throwIfAborted(); }
      if (usable) {
        await writeLiveKitFreeBuildReceipt(options.directory, { version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0, projectSelector: project.selector, projectId: project.id, projectURL: project.url, checkedAt: new Date().toISOString() });
        options.notify?.('LiveKit: verified free Build project reused with its existing native login');
        return;
      }
    }
    await authenticate(binary, options, work);
    await nativeConfig(native);
    const after = parseLiveKitProjects(await command(binary, ['--config', join(work, 'livekit.toml'), 'project', 'list'], work, options.signal));
    const oldDefault = before.find(project => project.default);
    if (oldDefault && after.find(project => project.default)?.selector !== oldDefault.selector) throw new Error('LiveKit CLI changed the previous default project; restore it before rerunning setup');
    if (before.some(old => !after.some(project => project.selector === old.selector && project.id === old.id && project.url === old.url))) throw new Error('LiveKit CLI changed an existing project profile; setup stopped');
    const added = after.filter(project => !before.some(old => old.selector === project.selector));
    if (added.length !== 1) throw new Error('LiveKit native login did not identify exactly one newly authorized free project');
    const project = added[0]!;
    if (!/^wss:\/\/grunt-free-[a-z0-9-]+\.livekit\.cloud$/.test(project.url)) throw new Error('LiveKit authorized a different project than the verified grunt-free project');
    await verifyProject(binary, project.selector, work, options.signal);
    await writeLiveKitFreeBuildReceipt(options.directory, { version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0, projectSelector: project.selector, projectId: project.id, projectURL: project.url, checkedAt: new Date().toISOString() });
    options.notify?.('LiveKit: native free Build project connected for DeepSeek V4.1 Flash');
  } finally { await rm(work, { recursive: true, force: true }); }
}
