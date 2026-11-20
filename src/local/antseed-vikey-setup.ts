import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readDataSharingConsent } from './data-sharing.js';
import { executable } from './multiplexer.js';
import { ANTSEED_LOCK_GZIP, ANTSEED_LOCK_SHA256 } from './antseed-vikey-lock.js';
import { AntseedVikey } from './antseed-vikey.js';

export const ANTSEED_CLI_VERSION = '0.1.253';
export const ANTSEED_ROUTER_VERSION = '0.1.53';
export const ANTSEED_BUYER_PEER = 'e4c4129c86752a2a8d092ddb0eb1c27cc4933c7b';
export const ANTSEED_BUYER_PORT = '8381';
export const ANTSEED_BUYER_UNIT = 'grunt-antseed-vikey.service';
const receiptVersion = 1;
const criticalFiles = ['node_modules/@antseed/cli/dist/cli/index.js', 'node_modules/@antseed/cli/dist/cli/commands/buyer/start.js',
  'node_modules/@antseed/cli/dist/plugins/drift.js', 'node_modules/@antseed/cli/dist/plugins/loader.js',
  'node_modules/@antseed/router-local/dist/index.js', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'];
const failure = () => new Error('Antseed free buyer setup did not complete; existing services were preserved');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const nativeAssets = {
  '127': { sha256: '94ce113ea2d9347fcd1cf8e46445cc271d1dbd02d05a64aa460442222f023b11', size: 1089479 },
  '137': { sha256: '99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312', size: 1089588 }
} as const;

// GitHub's published release-asset digests, reviewed for the pinned12.11.1
// release. Other platforms safely skip this source; no unpinned build fallback.
export function antseedNativeAsset(platform = process.platform, arch = process.arch, abi = process.versions.modules) {
  if (platform !== 'linux' || arch !== 'x64' || !(abi in nativeAssets)) return;
  const entry = nativeAssets[abi as keyof typeof nativeAssets];
  return { ...entry, url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v${abi}-linux-x64.tar.gz` };
}
export function antseedLock() {
  const text = gunzipSync(Buffer.from(ANTSEED_LOCK_GZIP, 'base64'), { maxOutputLength: 256 * 1024 }).toString();
  if (sha(text) !== ANTSEED_LOCK_SHA256) throw failure();
  return text;
}
export function antseedVikeyPaths(directory: string) {
  const home = resolve(directory, 'antseed-vikey');
  return { home, runtime: join(home, 'runtime'), nativeHome: join(home, 'home'), state: join(home, 'state'),
    config: join(home, 'state', 'config.json'), receipt: join(home, 'installation.json'),
    entry: join(home, 'runtime', 'node_modules', '@antseed', 'cli', 'dist', 'cli', 'index.js') };
}
export interface AntseedSetupCommandOptions { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }
export type AntseedSetupCommand = (binary: string, args: string[], options: AntseedSetupCommandOptions) => Promise<void>;
export interface AntseedVikeySetupOptions {
  directory: string; signal?: AbortSignal; dataSharingApproved?: readonly string[]; notify?(line: string): void;
  /** Isolated test dependencies. Standard onboarding never overrides them. */
  command?: AntseedSetupCommand; fetcher?: typeof fetch; unitDirectory?: string;
  nativeAsset?: NonNullable<ReturnType<typeof antseedNativeAsset>>;
  verify?: () => Promise<boolean>;
  checkPort?: () => Promise<boolean>;
}
const command: AntseedSetupCommand = async (binary, args, options) => {
  options.signal.throwIfAborted();
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: 'ignore', detached: true });
  let force: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch { /* Owned child already exited. */ } };
  const abort = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 1000); force.unref(); };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('error', () => reject(failure())); child.once('close', done); });
    options.signal.throwIfAborted(); if (code !== 0) throw failure();
  } finally { options.signal.removeEventListener('abort', abort); if (force) clearTimeout(force); kill('SIGKILL'); }
};
async function safeAncestors(path: string) {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw failure(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function privateDirectory(path: string) {
  await safeAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw failure();
}
async function unitDirectoryReady(path: string) {
  await safeAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw failure();
}
async function privateRead(path: string, limit = 256 * 1024) {
  await safeAncestors(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > limit) throw failure();
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export function antseedBuyerConfig() {
  return { identity: { displayName: 'Grunt free buyer' }, seller: { providers: {} },
    buyer: { maxPricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }, minPeerReputation: 0,
      routingPreferences: { preferFreePeers: false, maxInputUsdPerMillion: 0, minTrustScore: 0, allowedPeerIds: [ANTSEED_BUYER_PEER], blockedPeerIds: [] },
      proxyPort: Number(ANTSEED_BUYER_PORT), autoSweep: false, verifier: { enabled: false } },
    payments: { preferredMethod: 'crypto', crypto: { chainId: 'base-mainnet' } }, network: { bootstrapNodes: [] }, relayer: { enabled: false } };
}
function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  // No ambient provider keys, wallet/passphrase overrides, npm config, proxies,
  // NODE_OPTIONS or existing Antseed HOME can cross into this private buyer.
  return { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    ANTSEED_ENABLE_SETTLEMENT: 'false', ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1', ANTSEED_NO_UPDATE_CHECK: '1',
    NO_UPDATE_NOTIFIER: '1', npm_config_ignore_scripts: 'true' };
}
const quoted = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw failure();
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
};
export function antseedBuyerUnit(directory: string) {
  const p = antseedVikeyPaths(directory), env = isolatedEnvironment(p.nativeHome);
  const args = ['/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, p.entry,
    '--data-dir', p.state, '--config', p.config, 'buyer', 'start', '--router', 'local', '--port', ANTSEED_BUYER_PORT,
    '--peer', ANTSEED_BUYER_PEER, '--max-input-usd-per-million', '0', '--max-output-usd-per-million', '0'];
  return `[Unit]\nDescription=Grunt pinned Antseed free buyer\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUMask=0077\nNoNewPrivileges=true\nWorkingDirectory=${quoted(p.home)}\nExecStart=${args.map(quoted).join(' ')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
async function download(asset: NonNullable<ReturnType<typeof antseedNativeAsset>>, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher(asset.url, { signal, redirect: 'follow' });
  // GitHub release assets redirect to its object store; the reviewed content
  // digest, rather than the redirect destination, authenticates every byte.
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > asset.size) { await response.body?.cancel(); throw failure(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > asset.size) throw failure(); chunks.push(item.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== asset.size || sha(bytes) !== asset.sha256) throw failure();
  return bytes;
}
async function packageVersion(runtime: string, name: string, version: string) {
  const path = join(runtime, 'node_modules', name, 'package.json'); await safeAncestors(dirname(path)); const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o022) || s.size > 65536) throw failure();
  const data = JSON.parse(await readFile(path, 'utf8')) as { name?: string; version?: string };
  if (data.name !== name || data.version !== version) throw failure();
}
async function verifyInstallation(directory: string) {
  const p = antseedVikeyPaths(directory), saved = JSON.parse(await privateRead(p.receipt)) as Record<string, unknown>;
  if (saved.version !== receiptVersion || saved.lockSha256 !== ANTSEED_LOCK_SHA256 || saved.unitSha256 !== sha(antseedBuyerUnit(directory))) throw failure();
  if (typeof saved.files !== 'object' || !saved.files || Array.isArray(saved.files)) throw failure();
  if (Object.keys(saved.files).sort().join('\n') !== [...criticalFiles].sort().join('\n')) throw failure();
  for (const directory of [p.nativeHome, p.state, join(p.nativeHome, '.antseed', 'plugins')]) await privateDirectory(directory);
  const pluginModules = join(p.nativeHome, '.antseed', 'plugins', 'node_modules'), link = await lstat(pluginModules);
  if (!link.isSymbolicLink() || link.uid !== process.getuid?.() || await readlink(pluginModules) !== join(p.runtime, 'node_modules')) throw failure();
  for (const [relative, digest] of Object.entries(saved.files)) {
    if (!/^(?:node_modules\/[@a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.split('/').includes('..') || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw failure();
    const file = join(p.runtime, relative); await safeAncestors(dirname(file)); const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || sha(await readFile(file)) !== digest) throw failure();
  }
  if (await privateRead(p.config) !== JSON.stringify(antseedBuyerConfig()) + '\n') throw failure();
  await packageVersion(p.runtime, '@antseed/cli', ANTSEED_CLI_VERSION); await packageVersion(p.runtime, '@antseed/router-local', ANTSEED_ROUTER_VERSION);
  return p;
}
export async function installAntseedVikey(options: AntseedVikeySetupOptions) {
  const asset = options.nativeAsset ?? antseedNativeAsset();
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  if (!asset || !report.header?.glibcVersionRuntime) {
    throw new Error('Antseed free buyer currently supports Linux x64 glibc with Node22 or24 and a user systemd manager');
  }
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600000)]), run = options.command ?? command;
  signal.throwIfAborted(); await privateDirectory(options.directory);
  const paths = antseedVikeyPaths(options.directory); await privateDirectory(paths.home);
  // Existing managed installation is immutable. Corruption does not silently
  // reinstall over a running service; the user can repair it explicitly later.
  try { await lstat(paths.receipt); return await verifyInstallation(options.directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(); }
  try { await lstat(paths.runtime); throw failure(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(); }
  const temporary = await mkdtemp(join(paths.home, '.install-')); await chmod(temporary, 0o700); let promoted = false;
  try {
    const runtime = join(temporary, 'runtime'); await privateDirectory(runtime);
    const lock = antseedLock(), manifest = (JSON.parse(lock) as { packages: Record<string, unknown> }).packages[''];
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ ...(manifest as object), private: true }) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(runtime, 'package-lock.json'), lock, { mode: 0o600, flag: 'wx' });
    const userconfig = join(temporary, 'user.npmrc'), globalconfig = join(temporary, 'global.npmrc');
    await writeFile(userconfig, '', { mode: 0o600, flag: 'wx' }); await writeFile(globalconfig, '', { mode: 0o600, flag: 'wx' });
    const env = isolatedEnvironment(temporary);
    await run(await executable('npm'), ['ci', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
      '--userconfig', userconfig, '--globalconfig', globalconfig, '--cache', join(temporary, 'cache')], { cwd: runtime, env, signal });
    if (await readFile(join(runtime, 'package-lock.json'), 'utf8') !== lock) throw failure();
    await packageVersion(runtime, '@antseed/cli', ANTSEED_CLI_VERSION); await packageVersion(runtime, '@antseed/router-local', ANTSEED_ROUTER_VERSION);
    await packageVersion(runtime, 'better-sqlite3', '12.11.1');
    const archive = join(temporary, 'sqlite.tgz'); await writeFile(archive, await download(asset, signal, options.fetcher ?? fetch), { mode: 0o600, flag: 'wx' });
    const sqlite = join(runtime, 'node_modules', 'better-sqlite3');
    await run(await executable('tar'), ['--extract', '--gzip', '--file', archive, '--directory', sqlite, '--no-same-owner', '--no-same-permissions', 'build/Release/better_sqlite3.node'], { cwd: temporary, env, signal });
    const files: Record<string, string> = {};
    for (const relative of criticalFiles) {
      const stat = await lstat(join(runtime, relative)); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw failure();
      files[relative] = sha(await readFile(join(runtime, relative)));
    }
    signal.throwIfAborted(); await rename(runtime, paths.runtime); promoted = true;
    await privateDirectory(paths.nativeHome); await privateDirectory(paths.state);
    const pluginRoot = join(paths.nativeHome, '.antseed', 'plugins'); await privateDirectory(pluginRoot);
    await symlink(join(paths.runtime, 'node_modules'), join(pluginRoot, 'node_modules'));
    await writeFile(paths.config, JSON.stringify(antseedBuyerConfig()) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(paths.receipt, JSON.stringify({ version: receiptVersion, lockSha256: ANTSEED_LOCK_SHA256, unitSha256: sha(antseedBuyerUnit(options.directory)), files }) + '\n', { mode: 0o600, flag: 'wx' });
    return await verifyInstallation(options.directory);
  } catch {
    // This function never starts the service. A newly promoted but incomplete
    // runtime can be removed without touching protocol identity or user state.
    if (promoted) await rm(paths.runtime, { recursive: true, force: true });
    throw failure();
  }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
/** Called only after the source's curated eligibility is qualified. No inference. */
export async function setupAntseedVikey(options: AntseedVikeySetupOptions) {
  const approved = await readDataSharingConsent(options.directory, ['antseed-vikey']);
  if (!approved.includes('antseed-vikey') || options.dataSharingApproved && !options.dataSharingApproved.includes('antseed-vikey')) throw new Error('Antseed data sharing requires current setup approval');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600000)]), run = options.command ?? command;
  const paths = antseedVikeyPaths(options.directory), unitDirectory = options.unitDirectory ?? join(homedir(), '.config', 'systemd', 'user'), unit = join(unitDirectory, ANTSEED_BUYER_UNIT);
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir(),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
  // Check ownership before installing anything or changing an existing unit.
  let existing: string | undefined;
  try { existing = await privateRead(unit); if (existing !== antseedBuyerUnit(options.directory)) throw failure(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(); }
  if (existing === undefined) {
    const free = await (options.checkPort?.() ?? new Promise<boolean>(done => {
      const server = createServer(); server.once('error', () => done(false));
      server.listen(Number(ANTSEED_BUYER_PORT), '127.0.0.1', () => { server.close(() => done(true)); });
    }));
    if (!free) throw new Error('Antseed buyer port8381 belongs to another process; existing services were preserved');
  }
  try { await run('systemctl', ['--user', 'show-environment'], { cwd: options.directory, env, signal }); }
  catch { throw new Error('Antseed free buyer requires a running user systemd manager'); }
  await installAntseedVikey({ ...options, signal });
  await unitDirectoryReady(unitDirectory);
  if (existing === undefined) await writeFile(unit, antseedBuyerUnit(options.directory), { mode: 0o600, flag: 'wx' });
  await run('systemctl', ['--user', 'daemon-reload'], { cwd: paths.home, env, signal });
  await run('systemctl', ['--user', 'enable', '--now', ANTSEED_BUYER_UNIT], { cwd: paths.home, env, signal });
  const buyer = new AntseedVikey({ port: ANTSEED_BUYER_PORT });
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      signal.throwIfAborted();
      // Metadata only; the existing adapter checks the exact pinned zero-price
      // peer. Actual hello/context/tool qualification stays in the usual pipeline.
      if (await (options.verify?.() ?? buyer.available())) break;
      if (Date.now() >= deadline) throw new Error('Antseed buyer is installed but the pinned free peer is not ready');
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, 1000);
        const abort = () => { clearTimeout(timeout); reject(failure()); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
  } finally { await buyer.close(); }
  options.notify?.('Pinned Antseed free buyer is installed; provider qualification decides pool eligibility');
  return { port: ANTSEED_BUYER_PORT };
}
