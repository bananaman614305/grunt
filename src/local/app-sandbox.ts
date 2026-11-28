import { spawn, execFile } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, openSync } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { configRoot } from '../brand.js';
import { ID_PATTERN, safePublicHttpsUrl } from '../registry.js';
import type { DeclarativeAppInstaller, DeclarativeAppPlatform } from '../registry.js';
import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { SourceError } from './source.js';

const execFileAsync = promisify(execFile);

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_REDIRECTS = 5;
const MAX_OPENER_BYTES = 16 * 1024;

export const SANDBOX_HOME = '/sandbox/home';
export const SANDBOX_PKG = '/sandbox/pkg';
export const SANDBOX_WORK = '/sandbox/work';
export const SANDBOX_OPENERS = '/sandbox/openers';
export const SANDBOX_OPENER_PIPE = '/sandbox/opener.pipe';

export interface AppSandboxPaths {
  appsRoot: string;
  root: string;
  pkg: string;
  home: string;
  tmp: string;
  // Kept outside the per-app directory so the sandboxed CLI can never read or tamper with it.
  stateFile: string;
}

export interface DeclarativeAppState {
  version: 1;
  installerFingerprint: string;
  installedAt: string;
  binaryRelPath: string;
  lastSignupAttemptAt?: number;
  signupBackoffUntil?: number;
  lastSignupFailure?: string;
}

const appLocks = new Map<string, Promise<void>>();

/** Serialize install, active use, and cleanup per app id. */
export async function withAppLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = appLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveLock => { release = resolveLock; });
  const tail = previous.then(() => current);
  appLocks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (appLocks.get(key) === tail) appLocks.delete(key);
  }
}

export function appSandboxPaths(id: string, directory = configRoot()): AppSandboxPaths {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid declarative app id: ${id}`);
  const appsRoot = resolve(directory, 'apps');
  const root = join(appsRoot, id);
  return {
    appsRoot,
    root,
    pkg: join(root, 'pkg'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    stateFile: join(appsRoot, `${id}.state.json`)
  };
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || !hasOwnerMode(st, 0, 0o077)) {
    throw new SourceError('not_installed', `Unsafe private app directory: ${path}`);
  }
}

export async function prepareAppDirectories(id: string, directory = configRoot()): Promise<AppSandboxPaths> {
  const paths = appSandboxPaths(id, directory);
  await ensurePrivateDir(resolve(directory));
  await ensurePrivateDir(paths.appsRoot);
  await ensurePrivateDir(paths.root);
  await ensurePrivateDir(paths.home);
  await ensurePrivateDir(paths.tmp);
  return paths;
}

export async function readAppState(id: string, directory = configRoot()): Promise<DeclarativeAppState | undefined> {
  const paths = appSandboxPaths(id, directory);
  try {
    const file = await openPrivateFile(paths.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await file.stat();
      if (!st.isFile() || !hasOwnerMode(st, 0o600) || st.size > 16384) return undefined;
      const parsed = JSON.parse(await file.readFile('utf8')) as Partial<DeclarativeAppState>;
      if (parsed.version !== 1 || typeof parsed.installerFingerprint !== 'string' || typeof parsed.binaryRelPath !== 'string' || typeof parsed.installedAt !== 'string') {
        return undefined;
      }
      return parsed as DeclarativeAppState;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export async function writeAppState(id: string, state: DeclarativeAppState, directory = configRoot()): Promise<void> {
  const paths = appSandboxPaths(id, directory);
  await ensurePrivateDir(paths.appsRoot);
  const temporary = join(paths.appsRoot, `.${id}.state.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temporary, paths.stateFile);
  } finally { await rm(temporary, { force: true }); }
}

export async function listInstalledApps(directory = configRoot()): Promise<{ id: string; state?: DeclarativeAppState }[]> {
  const appsRoot = resolve(directory, 'apps');
  let entries;
  try { entries = await readdir(appsRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && ID_PATTERN.test(entry.name)) ids.add(entry.name);
    else if (entry.isFile() && entry.name.endsWith('.state.json')) {
      const id = entry.name.slice(0, -'.state.json'.length);
      if (ID_PATTERN.test(id)) ids.add(id);
    }
  }
  const results: { id: string; state?: DeclarativeAppState }[] = [];
  for (const id of [...ids].sort()) {
    const state = await readAppState(id, directory);
    results.push({ id, ...(state ? { state } : {}) });
  }
  return results;
}

export async function cleanAppSandbox(id: string, directory = configRoot()): Promise<boolean> {
  return withAppLock(`${resolve(directory)}:${id}`, async () => {
    const paths = appSandboxPaths(id, directory);
    const existed = existsSync(paths.root) || existsSync(paths.stateFile);
    await rm(paths.root, { recursive: true, force: true });
    await rm(paths.stateFile, { force: true });
    return existed;
  });
}

export async function pruneRetiredAppSandboxes(activeIds: ReadonlySet<string>, directory = configRoot()): Promise<string[]> {
  const installed = await listInstalledApps(directory);
  const removed: string[] = [];
  for (const app of installed) {
    if (!activeIds.has(app.id)) {
      if (await cleanAppSandbox(app.id, directory)) removed.push(app.id);
    }
  }
  return removed;
}

export function currentPlatform(): DeclarativeAppPlatform | undefined {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  return undefined;
}

export function stripSandboxEnv(
  extra: Record<string, string> = {},
  sandboxHome: string,
  pathEntries: string[],
  sandboxTmp = SANDBOX_WORK
): NodeJS.ProcessEnv {
  return {
    HOME: sandboxHome,
    USER: 'grunt-app',
    LOGNAME: 'grunt-app',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    TMPDIR: sandboxTmp,
    PATH: pathEntries.join(':'),
    ...extra
  };
}

async function resolveExecutableOnPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* next */ }
  }
  return undefined;
}

export type SandboxBackend = { kind: 'bwrap'; binary: string } | { kind: 'sandbox-exec'; binary: string };

let cachedBackend: Promise<SandboxBackend | undefined> | undefined;
export async function detectSandboxBackend(): Promise<SandboxBackend | undefined> {
  if (process.platform === 'linux') {
    const bin = await resolveExecutableOnPath('bwrap');
    return bin ? { kind: 'bwrap', binary: bin } : undefined;
  }
  if (process.platform === 'darwin') {
    const bin = existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : await resolveExecutableOnPath('sandbox-exec');
    return bin ? { kind: 'sandbox-exec', binary: bin } : undefined;
  }
  return undefined;
}

export async function requireSandboxBackend(): Promise<SandboxBackend> {
  cachedBackend ??= detectSandboxBackend();
  const backend = await cachedBackend;
  if (!backend) {
    cachedBackend = undefined;
    throw new SourceError(
      'not_installed',
      process.platform === 'linux'
        ? 'Sandboxed app providers require bubblewrap (bwrap). Install bwrap and retry.'
        : process.platform === 'darwin'
          ? 'Sandboxed app providers require macOS sandbox-exec.'
          : 'Sandboxed app providers are not supported on this platform yet.'
    );
  }
  return backend;
}

export interface RuntimeMount {
  hostPath: string;
  mountPath: string;
  kind: 'file' | 'dir';
  pathDir?: string;
}

export interface SandboxMountSpec {
  mode: 'install' | 'auth' | 'run';
  pkgDir: string;
  workDir: string;
  homeDir?: string;
  openerDir?: string;
  openerPipePath?: string;
  extraRuntimeMounts?: RuntimeMount[];
  env?: Record<string, string>;
}

function escapeSeatbelt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** Generate a macOS Seatbelt profile that hides host $HOME and limits reads/writes to exact sandbox paths. */
export function buildMacOsSandboxProfile(spec: SandboxMountSpec, hostHome = homedir()): string {
  const realHostHome = escapeSeatbelt(resolve(hostHome));
  const pkg = escapeSeatbelt(resolve(spec.pkgDir));
  const work = escapeSeatbelt(resolve(spec.workDir));
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* (subpath "${realHostHome}"))`,
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/private/tmp") (subpath "/tmp"))',
    `(allow file-read*${spec.mode === 'install' ? ' file-write*' : ''} (subpath "${pkg}"))`,
    `(allow file-read* file-write* (subpath "${work}"))`
  ];
  if (spec.homeDir && spec.mode !== 'install') {
    lines.push(`(allow file-read* file-write* (subpath "${escapeSeatbelt(resolve(spec.homeDir))}"))`);
  }
  if (spec.openerDir) {
    lines.push(`(allow file-read* (subpath "${escapeSeatbelt(resolve(spec.openerDir))}"))`);
  }
  if (spec.openerPipePath) {
    lines.push(`(allow file-read* file-write* (literal "${escapeSeatbelt(resolve(spec.openerPipePath))}"))`);
  }
  for (const rt of spec.extraRuntimeMounts ?? []) {
    const matcher = rt.kind === 'file' ? 'literal' : 'subpath';
    lines.push(`(allow file-read* (${matcher} "${escapeSeatbelt(resolve(rt.hostPath))}"))`);
  }
  return lines.join('\n') + '\n';
}

export function sandboxPathsFor(backend: SandboxBackend, pkgDir: string, workDir: string): { pkg: string; work: string } {
  return backend.kind === 'sandbox-exec'
    ? { pkg: resolve(pkgDir), work: resolve(workDir) }
    : { pkg: SANDBOX_PKG, work: SANDBOX_WORK };
}

async function resolveNpmPackageDir(realNode: string): Promise<{ npmPkgDir: string; npmCliRel: string; hostNpmCli: string } | undefined> {
  const candidates = [
    join(dirname(realNode), 'npm'),
    join(dirname(dirname(realNode)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidate of candidates) {
    try {
      const realNpm = await realpath(candidate);
      // Standard npm layout: <npmPkgDir>/bin/npm-cli.js
      if (basename(realNpm) !== 'npm-cli.js' || basename(dirname(realNpm)) !== 'bin') continue;
      const npmPkgDir = dirname(dirname(realNpm));
      const pkgJson = JSON.parse(await readFile(join(npmPkgDir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkgJson.name !== 'npm') continue;
      return { npmPkgDir, npmCliRel: join('bin', 'npm-cli.js'), hostNpmCli: realNpm };
    } catch { /* try next */ }
  }
  return undefined;
}

/**
 * Collect minimal read-only runtime mounts.
 * Never mounts parent directories (like $HOME or ~/.local/bin) wholesale:
 * - node and uv are mounted as exact single files.
 * - npm is mounted only during npm installation and restricted to its verified npm package directory.
 */
export async function collectHostRuntimeMounts(options: {
  needsNpm?: boolean;
  needsUv?: boolean;
  nodePath?: string;
  uvPath?: string;
} = {}): Promise<{
  mounts: RuntimeMount[];
  nodeBin: string;
  hostNodeBin: string;
  npmCliPath?: string;
  hostNpmCliPath?: string;
  uvBin?: string;
  hostUvBin?: string;
}> {
  const mounts: RuntimeMount[] = [];
  const realNode = await realpath(options.nodePath ?? process.execPath);
  let nodeBin = realNode;
  if (!realNode.startsWith('/usr/')) {
    nodeBin = '/opt/grunt-rt/node/bin/node';
    mounts.push({
      hostPath: realNode,
      mountPath: nodeBin,
      kind: 'file',
      pathDir: '/opt/grunt-rt/node/bin'
    });
  }

  let npmCliPath: string | undefined;
  let hostNpmCliPath: string | undefined;
  if (options.needsNpm) {
    const resolvedNpm = await resolveNpmPackageDir(realNode);
    if (resolvedNpm) {
      hostNpmCliPath = resolvedNpm.hostNpmCli;
      if (resolvedNpm.npmPkgDir.startsWith('/usr/')) {
        npmCliPath = resolvedNpm.hostNpmCli;
      } else {
        mounts.push({
          hostPath: resolvedNpm.npmPkgDir,
          mountPath: '/opt/grunt-rt/npm',
          kind: 'dir'
        });
        npmCliPath = join('/opt/grunt-rt/npm', resolvedNpm.npmCliRel);
      }
    }
  }

  let uvBin: string | undefined;
  let hostUvBin: string | undefined;
  if (options.needsUv) {
    const realUv = options.uvPath ? await realpath(options.uvPath) : await resolveExecutableOnPath('uv');
    if (realUv) {
      hostUvBin = realUv;
      if (!realUv.startsWith('/usr/')) {
        uvBin = '/opt/grunt-rt/uv/uv';
        mounts.push({
          hostPath: realUv,
          mountPath: uvBin,
          kind: 'file',
          pathDir: '/opt/grunt-rt/uv'
        });
      } else {
        uvBin = realUv;
      }
    }
  }

  return {
    mounts,
    nodeBin,
    hostNodeBin: realNode,
    ...(npmCliPath ? { npmCliPath } : {}),
    ...(hostNpmCliPath ? { hostNpmCliPath } : {}),
    ...(uvBin ? { uvBin } : {}),
    ...(hostUvBin ? { hostUvBin } : {})
  };
}

/**
 * Build bwrap argv for Linux containment:
 * - Never mounts host $HOME or any host project directory.
 * - Mounts apps/<id>/pkg RO during auth/run, RW only during staging install.
 * - Mounts apps/<id>/home RW during auth/run, omitted during staging install.
 * - Mounts resolved /etc/resolv.conf RO so systemd-resolved DNS works.
 * - Mounts only exact runtime files (never parent directories wholesale).
 */
export async function buildBwrapInvocation(
  program: string,
  args: string[],
  spec: SandboxMountSpec
): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
  const bwrapArgs: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/sandbox'
  ];

  for (const sysDir of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
    if (existsSync(sysDir)) bwrapArgs.push('--ro-bind', sysDir, sysDir);
  }
  for (const etcEntry of ['/etc/ssl', '/etc/ca-certificates', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d']) {
    if (existsSync(etcEntry)) bwrapArgs.push('--ro-bind', etcEntry, etcEntry);
  }
  if (existsSync('/etc/resolv.conf')) {
    try {
      const resolvedResolv = await realpath('/etc/resolv.conf');
      bwrapArgs.push('--ro-bind', resolvedResolv, '/etc/resolv.conf');
    } catch { /* ignore */ }
  }

  const pathEntries: string[] = [];
  if (spec.openerDir) {
    bwrapArgs.push('--ro-bind', resolve(spec.openerDir), SANDBOX_OPENERS);
    pathEntries.push(SANDBOX_OPENERS);
  }
  if (spec.openerPipePath) {
    bwrapArgs.push('--bind', resolve(spec.openerPipePath), SANDBOX_OPENER_PIPE);
  }

  // Package directory: RW only during install, RO forever at runtime.
  bwrapArgs.push(spec.mode === 'install' ? '--bind' : '--ro-bind', resolve(spec.pkgDir), SANDBOX_PKG);
  pathEntries.push(join(SANDBOX_PKG, 'node_modules', '.bin'), join(SANDBOX_PKG, 'bin'));

  // Auth/state home: RW during auth/run, completely absent during install.
  if (spec.homeDir && spec.mode !== 'install') {
    bwrapArgs.push('--bind', resolve(spec.homeDir), SANDBOX_HOME);
  } else {
    bwrapArgs.push('--dir', SANDBOX_HOME);
  }

  // Empty per-request / staging work directory.
  bwrapArgs.push('--bind', resolve(spec.workDir), SANDBOX_WORK);

  // Exact runtime files/packages bound RO at neutral paths.
  if (spec.extraRuntimeMounts?.length) {
    bwrapArgs.push('--tmpfs', '/opt');
    for (const rt of spec.extraRuntimeMounts) {
      bwrapArgs.push('--ro-bind', resolve(rt.hostPath), rt.mountPath);
      if (rt.pathDir) pathEntries.push(rt.pathDir);
    }
  }
  pathEntries.push('/usr/local/bin', '/usr/bin', '/bin');

  bwrapArgs.push('--chdir', SANDBOX_WORK, '--', program, ...args);
  const env = stripSandboxEnv(spec.env ?? {}, SANDBOX_HOME, pathEntries);
  return { args: bwrapArgs, env, cwd: resolve(spec.workDir) };
}

export async function spawnSandboxed(
  program: string,
  args: string[],
  spec: SandboxMountSpec,
  options: { stdio?: StdioOptions; backend?: SandboxBackend } = {}
): Promise<ChildProcess> {
  const backend = options.backend ?? await requireSandboxBackend();
  const stdio: StdioOptions = options.stdio ?? ['pipe', 'pipe', 'pipe'];
  if (backend.kind === 'bwrap') {
    const built = await buildBwrapInvocation(program, args, spec);
    return spawn(backend.binary, built.args, { cwd: built.cwd, env: built.env, stdio, detached: true });
  }
  // macOS sandbox-exec
  const profile = buildMacOsSandboxProfile(spec);
  const home = spec.homeDir && spec.mode !== 'install' ? resolve(spec.homeDir) : resolve(spec.workDir);
  const pathEntries = [
    ...(spec.openerDir ? [resolve(spec.openerDir)] : []),
    join(resolve(spec.pkgDir), 'node_modules', '.bin'),
    join(resolve(spec.pkgDir), 'bin'),
    ...(spec.extraRuntimeMounts ?? []).filter(rt => rt.kind === 'file').map(rt => dirname(resolve(rt.hostPath))),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ];
  const env = stripSandboxEnv(
    { ...(spec.env ?? {}), ...(spec.openerPipePath ? { GRUNT_OPENER_PIPE: resolve(spec.openerPipePath) } : {}) },
    home,
    pathEntries,
    resolve(spec.workDir)
  );
  return spawn(backend.binary, ['-p', profile, program, ...args], { cwd: resolve(spec.workDir), env, stdio, detached: true });
}

export interface OpenerPipe {
  openerDir: string;
  pipePath: string;
  onFd3Data(chunk: Buffer): void;
  close(): Promise<void>;
}

/**
 * Host-owned pipe capture for open/xdg-open shims:
 * - Captures URLs written directly to inherited host pipe FD 3 (when child preserves FD 3).
 * - Falls back to a host-owned kernel named pipe (FIFO) FD when a CLI spawns xdg-open with
 *   stdio: 'ignore' and close_fds=true (Node/Python/Go).
 * Never uses Unix domain sockets and never persists URLs to disk.
 */
export async function createOpenerPipe(
  scratchDir: string,
  onUrl: (url: string) => void
): Promise<OpenerPipe> {
  const dir = await mkdtemp(join(scratchDir, 'openers-'));
  const openerDir = join(dir, 'bin');
  await mkdir(openerDir, { mode: 0o700 });
  const pipePath = join(dir, 'opener.pipe');
  await execFileAsync('mkfifo', ['-m', '600', pipePath]);

  const shimScript = [
    '#!/bin/sh',
    '[ -n "$1" ] || exit 0',
    'if { printf \'%.4096s\\n\' "$1" >&3; } 2>/dev/null; then exit 0; fi',
    `PIPE="\${GRUNT_OPENER_PIPE:-${SANDBOX_OPENER_PIPE}}"`,
    '[ -p "$PIPE" ] && printf \'%.4096s\\n\' "$1" > "$PIPE" 2>/dev/null || true'
  ].join('\n') + '\n';
  for (const name of ['open', 'xdg-open', 'x-www-browser', 'www-browser']) {
    await writeFile(join(openerDir, name), shimScript, { mode: 0o755, flag: 'wx' });
  }

  let totalBytes = 0;
  const makeLineConsumer = () => {
    let buf = '';
    return (chunk: Buffer) => {
      if (totalBytes >= MAX_OPENER_BYTES) return;
      const remaining = MAX_OPENER_BYTES - totalBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      totalBytes += slice.length;
      buf += slice.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (line) onUrl(line);
      }
    };
  };

  const onFifoData = makeLineConsumer();
  const onFd3Data = makeLineConsumer();
  const fifoFd = openSync(pipePath, constants.O_RDWR | constants.O_NONBLOCK);
  const fifoStream = new Socket({ fd: fifoFd, readable: true, writable: false });
  fifoStream.on('data', chunk => onFifoData(chunk as Buffer));
  fifoStream.on('error', () => {});

  return {
    openerDir,
    pipePath,
    onFd3Data,
    close: async () => {
      fifoStream.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function runSandboxedCommand(
  program: string,
  args: string[],
  spec: SandboxMountSpec,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes?: number;
    stdin?: string;
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
    onOpenerData?: (chunk: Buffer) => void;
    backend?: SandboxBackend;
  }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  options.signal.throwIfAborted();
  const stdio: StdioOptions = options.onOpenerData
    ? [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe']
    : [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  const child = await spawnSandboxed(program, args, spec, {
    stdio,
    ...(options.backend ? { backend: options.backend } : {})
  });
  if (options.onOpenerData && child.stdio[3]) {
    child.stdio[3].on('data', chunk => options.onOpenerData!(chunk as Buffer));
    child.stdio[3].on('error', () => {});
  }
  const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return await new Promise((resolveResult, reject) => {
    let stdout = '', stderr = '', bytes = 0, failure: unknown;
    const partial = { stdout: '', stderr: '' };
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    };
    const fail = (err: unknown) => { failure ??= err; kill(); };
    const abort = () => fail(options.signal.reason);
    const timer = setTimeout(() => fail(new SourceError('timeout', 'Sandboxed app command timed out')), options.timeoutMs);
    options.signal.addEventListener('abort', abort, { once: true });

    const consume = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > limit) { fail(new SourceError('upstream', 'Sandboxed app output exceeded limit')); return; }
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr = (stderr + text).slice(-65536);
      if (!options.onLine) return;
      partial[stream] += text;
      let nl: number;
      while ((nl = partial[stream].indexOf('\n')) !== -1) {
        const line = partial[stream].slice(0, nl).replace(/\r$/, '');
        partial[stream] = partial[stream].slice(nl + 1);
        try { options.onLine(line, stream); } catch (err) { fail(err); return; }
      }
    };

    child.stdout?.on('data', chunk => consume(chunk as Buffer, 'stdout'));
    child.stderr?.on('data', chunk => consume(chunk as Buffer, 'stderr'));
    child.stdin?.on('error', () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    child.once('error', () => fail(new SourceError('not_installed', 'Sandboxed app command could not start')));
    child.once('close', code => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      kill();
      if (!failure && !options.signal.aborted && options.onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (partial[stream].trim()) {
            try { options.onLine(partial[stream].replace(/\r$/, ''), stream); } catch (err) { failure = err; }
          }
        }
      }
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else resolveResult({ stdout, stderr, code });
    });
    if (options.signal.aborted) abort();
  });
}

async function fetchPublicHttpsBytes(urlString: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  let current = urlString;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!safePublicHttpsUrl(current)) throw new SourceError('refused', 'Archive download URL must be a public HTTPS URL');
    const response = await fetcher(current, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === MAX_REDIRECTS) throw new SourceError('upstream', 'Archive download redirect failed');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) throw new SourceError('upstream', `Archive download returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new SourceError('upstream', 'Archive exceeds maximum supported size');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) throw new SourceError('upstream', 'Archive exceeds maximum supported size');
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
  throw new SourceError('upstream', 'Archive download failed');
}

/** Validate tar.gz entries before extraction: reject traversal, absolute paths, links, special files, and oversized archives. */
export async function validateTarGzArchive(archivePath: string, signal: AbortSignal): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['-tvzf', archivePath], { signal, maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split('\n').filter(Boolean);
  if (lines.length > MAX_ARCHIVE_ENTRIES) throw new SourceError('refused', 'Archive contains too many entries');
  let totalBytes = 0;
  for (const line of lines) {
    const typeChar = line[0];
    // Allow only regular files (-) and directories (d). Reject symlinks (l), hardlinks (h), devices (b/c), FIFOs (p).
    if (typeChar !== '-' && typeChar !== 'd') {
      throw new SourceError('refused', 'Archive contains disallowed link or special file');
    }
    // Parse standard `tar -tv` columns: perms owner size date time name...
    const match = line.match(/^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match) throw new SourceError('refused', 'Could not parse archive entry metadata');
    const size = Number(match[1]);
    const entryPath = match[2]!.trim();
    if (!Number.isSafeInteger(size) || size < 0) throw new SourceError('refused', 'Invalid archive entry size');
    totalBytes += size;
    if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new SourceError('refused', 'Archive exceeds maximum uncompressed size');
    if (entryPath.startsWith('/') || entryPath.includes('\\') || entryPath.split('/').some(seg => seg === '..')) {
      throw new SourceError('refused', 'Archive contains unsafe path traversal');
    }
  }
}

export function installerFingerprint(installer: DeclarativeAppInstaller): string {
  return JSON.stringify(installer);
}

/**
 * Install a declarative app into a disposable staging directory (with NO auth home or project mounted),
 * verify the resulting binary stays inside staging, then atomically promote staging -> apps/<id>/pkg.
 */
export async function installDeclarativeApp(
  id: string,
  installer: DeclarativeAppInstaller,
  options: { directory?: string; signal: AbortSignal; fetcher?: typeof fetch; backend?: SandboxBackend }
): Promise<{ paths: AppSandboxPaths; state: DeclarativeAppState }> {
  const directory = options.directory ?? configRoot();
  return withAppLock(`${resolve(directory)}:${id}`, async () => {
    const paths = await prepareAppDirectories(id, directory);
    const fingerprint = installerFingerprint(installer);
    const existing = await readAppState(id, directory);
    if (existing && existing.installerFingerprint === fingerprint && existsSync(join(paths.pkg, existing.binaryRelPath))) {
      return { paths, state: existing };
    }

    const stagingRoot = await mkdtemp(join(paths.appsRoot, `.staging-${id}-`));
    const stagingPkg = join(stagingRoot, 'pkg');
    const stagingWork = join(stagingRoot, 'work');
    await mkdir(stagingPkg, { mode: 0o700 });
    await mkdir(stagingWork, { mode: 0o700 });

    try {
      const backend = options.backend ?? await requireSandboxBackend();
      const visible = sandboxPathsFor(backend, stagingPkg, stagingWork);
      const runtime = await collectHostRuntimeMounts({
        needsNpm: installer.type === 'npm',
        needsUv: installer.type === 'uv'
      });
      const effectiveNodeBin = backend.kind === 'sandbox-exec' ? runtime.hostNodeBin : runtime.nodeBin;
      const effectiveNpmCli = backend.kind === 'sandbox-exec' ? runtime.hostNpmCliPath : runtime.npmCliPath;
      const effectiveUvBin = backend.kind === 'sandbox-exec' ? runtime.hostUvBin : runtime.uvBin;
      const spec: SandboxMountSpec = {
        mode: 'install',
        pkgDir: stagingPkg,
        workDir: stagingWork,
        extraRuntimeMounts: runtime.mounts
      };

      let binaryRelPath: string;
      if (installer.type === 'npm') {
        if (!effectiveNpmCli) throw new SourceError('not_installed', `${id} requires npm alongside Node.js`);
        const pkgSpec = installer.version ? `${installer.package}@${installer.version}` : installer.package;
        const npmArgs = [
          effectiveNpmCli,
          'install', '--prefix', visible.pkg, '--no-audit', '--no-fund', '--package-lock=false',
          ...(installer.allowPostinstall ? [] : ['--ignore-scripts']),
          pkgSpec
        ];
        const res = await runSandboxedCommand(effectiveNodeBin, npmArgs, spec, {
          signal: options.signal, timeoutMs: 300000, maxOutputBytes: 4 * 1024 * 1024, backend
        });
        if (res.code !== 0) throw new SourceError('not_installed', `${id} npm installation failed`);
        binaryRelPath = join('node_modules', '.bin', installer.bin);
      } else if (installer.type === 'uv') {
        if (!effectiveUvBin) throw new SourceError('not_installed', `${id} requires uv to be installed on PATH`);
        const pkgSpec = installer.version ? `${installer.package}==${installer.version}` : installer.package;
        const res = await runSandboxedCommand(effectiveUvBin, ['tool', 'install', '--no-config', '--force', pkgSpec], {
          ...spec,
          env: {
            UV_TOOL_DIR: join(visible.pkg, 'tools'),
            UV_TOOL_BIN_DIR: join(visible.pkg, 'bin'),
            UV_CACHE_DIR: join(visible.work, 'uv-cache'),
            UV_PYTHON_INSTALL_DIR: join(visible.pkg, 'python')
          }
        }, {
          signal: options.signal, timeoutMs: 300000, maxOutputBytes: 4 * 1024 * 1024, backend
        });
        if (res.code !== 0) throw new SourceError('not_installed', `${id} uv installation failed`);
        binaryRelPath = join('bin', installer.bin);
      } else {
        const platform = currentPlatform();
        const url = platform ? installer.urls[platform] : undefined;
        if (!url) throw new SourceError('not_installed', `${id} has no archive for platform ${platform ?? process.platform}`);
        if (installer.format === 'zip') throw new SourceError('not_installed', `${id} zip archive format is not supported in Phase 1`);
        const bytes = await fetchPublicHttpsBytes(url, options.signal, options.fetcher);
        const archivePath = join(stagingWork, 'release.tar.gz');
        await writeFile(archivePath, bytes, { mode: 0o600, flag: 'wx' });
        await validateTarGzArchive(archivePath, options.signal);
        const res = await runSandboxedCommand('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', join(visible.work, 'release.tar.gz'), '-C', visible.pkg], spec, {
          signal: options.signal, timeoutMs: 60000, maxOutputBytes: 1024 * 1024, backend
        });
        if (res.code !== 0) throw new SourceError('not_installed', `${id} archive extraction failed`);
        binaryRelPath = installer.bin;
      }

      // Verify the resolved executable stays strictly inside stagingPkg.
      const candidatePath = join(stagingPkg, binaryRelPath);
      const realStaging = await realpath(stagingPkg);
      const realBin = await realpath(candidatePath).catch(() => undefined);
      if (!realBin || (realBin !== realStaging && !realBin.startsWith(realStaging + sep))) {
        throw new SourceError('refused', `${id} installed binary escaped staging directory`);
      }
      const binStat = await lstat(realBin);
      if (!binStat.isFile()) throw new SourceError('not_installed', `${id} installed binary is not a regular file`);
      await chmod(realBin, 0o755);

      // Atomic swap stagingPkg -> paths.pkg
      const backup = join(paths.root, `.pkg-old-${randomUUID()}`);
      let hadOld = false;
      try {
        if (existsSync(paths.pkg)) { await rename(paths.pkg, backup); hadOld = true; }
        await rename(stagingPkg, paths.pkg);
        const state: DeclarativeAppState = {
          ...(existing ? {
            ...(existing.lastSignupAttemptAt !== undefined ? { lastSignupAttemptAt: existing.lastSignupAttemptAt } : {}),
            ...(existing.signupBackoffUntil !== undefined ? { signupBackoffUntil: existing.signupBackoffUntil } : {}),
            ...(existing.lastSignupFailure !== undefined ? { lastSignupFailure: existing.lastSignupFailure } : {})
          } : {}),
          version: 1,
          installerFingerprint: fingerprint,
          installedAt: new Date().toISOString(),
          binaryRelPath
        };
        await writeAppState(id, state, directory);
        if (hadOld) await rm(backup, { recursive: true, force: true });
        return { paths, state };
      } catch (err) {
        if (hadOld && !existsSync(paths.pkg)) await rename(backup, paths.pkg).catch(() => {});
        throw err;
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

export async function appsCommand(args: string[], directory = configRoot()): Promise<void> {
  const sub = args[0] ?? 'list';
  if (sub === 'list') {
    const installed = await listInstalledApps(directory);
    if (!installed.length) {
      console.log('No sandboxed declarative apps installed.');
      return;
    }
    for (const app of installed) {
      console.log(`${app.id}${app.state ? ` (installed ${app.state.installedAt})` : ' (partial)'}`);
    }
    return;
  }
  if (sub === 'clean') {
    const target = args[1];
    if (!target || target === '--all') {
      const installed = await listInstalledApps(directory);
      if (!installed.length) { console.log('No sandboxed declarative apps to remove.'); return; }
      for (const app of installed) await cleanAppSandbox(app.id, directory);
      console.log(`Removed ${installed.length} sandboxed app(s): ${installed.map(a => a.id).join(', ')}`);
      return;
    }
    if (!ID_PATTERN.test(target)) throw new Error(`Invalid app id: ${target}`);
    const removed = await cleanAppSandbox(target, directory);
    console.log(removed ? `Removed sandboxed app ${target}.` : `Sandboxed app ${target} is not installed.`);
    return;
  }
  throw new Error('Usage: usegrunt apps <list | clean [<id> | --all]>');
}
