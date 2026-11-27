import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { removeGroupWrite } from './private-tree.js';

const execute = promisify(execFile);

export const SQUIRE_PACKAGE_NAME = '@trusty-squire/mcp';
export const SQUIRE_COMPATIBLE_MAJOR = 1;
export const SQUIRE_RUNTIME_DIR = 'squire-runtime';
export const SQUIRE_LATEST_URL = 'https://registry.npmjs.org/@trusty-squire%2Fmcp/latest';
export const SQUIRE_CHECK_COOLDOWN_MS = 15 * 60 * 1000;
export const SQUIRE_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
export const SQUIRE_METADATA_TIMEOUT_MS = 5_000;
export const SQUIRE_INSTALL_TIMEOUT_MS = 120_000;

const HINT_FILENAME = 'squire-client-path';
const VERSIONS_DIR = 'versions';
const STATE_FILENAME = 'state.json';
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_RETAINED_VERSIONS = 2;
const MISSING_SQUIRE_MESSAGE = 'Connect Trusty Squire separately, then rerun usegrunt setup';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ANY_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
  raw: string;
}

export type SquireInstallRun = (
  binary: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }
) => Promise<string>;

export interface SquireResolutionOptions {
  autoUpdate?: boolean;
  fetcher?: typeof fetch;
  run?: SquireInstallRun;
  now?: () => number;
  signal?: AbortSignal;
  bundled?: boolean;
  packagedDir?: string | null;
  metadataTimeoutMs?: number;
  installTimeoutMs?: number;
  cooldownMs?: number;
  failureCooldownMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedSquirePackage {
  source: 'packaged' | 'hinted' | 'managed';
  packageDir: string;
  version?: string;
  binPath: string;
  signupEntry: string;
  updated: boolean;
}

interface LocalSquireCandidate {
  source: 'packaged' | 'hinted' | 'managed';
  packageDir: string;
  version?: string;
  parsedVersion?: ParsedSemver;
  binPath: string;
  signupEntry: string;
}

interface SquireUpdateState {
  checkedAt?: number;
  failedAt?: number;
  latestVersion?: string;
  activeVersion?: string;
}

type RemoteVersionResult =
  | { status: 'compatible'; version: string; parsed: ParsedSemver }
  | { status: 'incompatible'; version?: string };

const inFlightResolutions = new Map<string, Promise<ResolvedSquirePackage>>();

export function parseStableSemver(value: string): ParsedSemver | undefined {
  const match = STABLE_SEMVER.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: undefined,
    raw: value
  };
}

export function parseSemver(value: string): ParsedSemver | undefined {
  const match = ANY_SEMVER.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    raw: value
  };
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return 0;
}

const isBundledDaemon = (options?: SquireResolutionOptions): boolean =>
  options?.bundled ?? (typeof GRUNT_DAEMON_BUNDLE !== 'undefined');

const packagedClient = () => join(dirname(fileURLToPath(import.meta.resolve(SQUIRE_PACKAGE_NAME))), 'bin.js');

function shouldAutoUpdate(options?: SquireResolutionOptions): boolean {
  if (options?.autoUpdate !== undefined) return options.autoUpdate;
  const env = options?.env ?? process.env;
  if (env.GRUNT_SQUIRE_AUTO_UPDATE === '0') return false;
  if (env.GRUNT_SQUIRE_AUTO_UPDATE === '1') return true;
  if (env.VITEST && options?.fetcher === undefined && options?.run === undefined) return false;
  return true;
}

const defaultRun: SquireInstallRun = async (binary, args, options = {}) => {
  const { stdout } = await execute(binary, args, {
    ...options,
    timeout: options.timeout ?? SQUIRE_INSTALL_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024
  });
  return stdout;
};

function sanitizeInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !/^npm_config_/i.test(key) && !/^(?:node_options|node_path|tar_options)$/i.test(key)
    )
  );
}

async function assertOwnedPrivateDir(dirPath: string): Promise<void> {
  const info = await lstat(dirPath);
  if (!info.isDirectory() || info.isSymbolicLink() || !hasOwnerMode(info, 0o700)) {
    throw new Error('Managed Squire runtime directory is unsafe');
  }
}

async function assertOwnedNonWritableDir(dirPath: string): Promise<void> {
  const info = await lstat(dirPath);
  if (!info.isDirectory() || info.isSymbolicLink() || !hasOwnerMode(info, 0o000, 0o022)) {
    throw new Error('Managed Squire package directory is unsafe');
  }
}

async function assertOwnedNonWritableFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || !hasOwnerMode(info, 0o000, 0o022)) {
    throw new Error('Managed Squire package file is unsafe');
  }
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertOwnedPrivateDir(dirPath);
}

async function readManifestFromPackageDir(packageDir: string, strictOwned: boolean): Promise<{ name?: unknown; version?: unknown }> {
  const manifestPath = join(packageDir, 'package.json');
  if (strictOwned) {
    const file = await openPrivateFile(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || !hasOwnerMode(info, 0o000, 0o022) || info.size > MAX_MANIFEST_BYTES) {
        throw new Error('Managed Squire package manifest is unsafe');
      }
      return JSON.parse(await file.readFile('utf8')) as { name?: unknown; version?: unknown };
    } finally {
      await file.close();
    }
  }
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new Error('Squire package manifest is invalid');
  }
  return JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
}

async function verifyManagedVersionDir(versionDir: string, expectedVersion: string): Promise<LocalSquireCandidate | undefined> {
  const parsedExpected = parseStableSemver(expectedVersion);
  if (!parsedExpected || parsedExpected.major !== SQUIRE_COMPATIBLE_MAJOR) return undefined;
  try {
    await assertOwnedPrivateDir(versionDir);
    const nodeModulesDir = join(versionDir, 'node_modules');
    const scopeDir = join(nodeModulesDir, '@trusty-squire');
    const packageDir = join(scopeDir, 'mcp');
    const distDir = join(packageDir, 'dist');
    const signupEntry = join(distDir, 'signup.js');
    const binPath = join(distDir, 'bin.js');

    await assertOwnedNonWritableDir(nodeModulesDir);
    await assertOwnedNonWritableDir(scopeDir);
    await assertOwnedNonWritableDir(packageDir);
    await assertOwnedNonWritableDir(distDir);
    await assertOwnedNonWritableFile(signupEntry);
    await assertOwnedNonWritableFile(binPath);

    const manifest = await readManifestFromPackageDir(packageDir, true);
    if (manifest.name !== SQUIRE_PACKAGE_NAME || manifest.version !== expectedVersion) {
      return undefined;
    }

    return {
      source: 'managed',
      packageDir,
      version: expectedVersion,
      parsedVersion: parsedExpected,
      binPath,
      signupEntry
    };
  } catch {
    return undefined;
  }
}

async function inspectPackagedDir(packageDir: string): Promise<LocalSquireCandidate | undefined> {
  try {
    const distDir = join(packageDir, 'dist');
    const signupEntry = join(distDir, 'signup.js');
    const binPath = join(distDir, 'bin.js');
    const signupInfo = await stat(signupEntry);
    if (!signupInfo.isFile()) return undefined;
    const manifest = await readManifestFromPackageDir(packageDir, false);
    if (manifest.name !== SQUIRE_PACKAGE_NAME || typeof manifest.version !== 'string') {
      return undefined;
    }
    const parsedVersion = parseSemver(manifest.version);
    if (!parsedVersion) return undefined;
    return {
      source: 'packaged',
      packageDir,
      version: manifest.version,
      parsedVersion,
      binPath,
      signupEntry
    };
  } catch {
    return undefined;
  }
}

async function findPackagedSquireDir(): Promise<string | undefined> {
  if (typeof import.meta.resolve === 'function') {
    try {
      const distDir = dirname(fileURLToPath(import.meta.resolve(SQUIRE_PACKAGE_NAME)));
      return dirname(distDir);
    } catch {
      // Fall through to ancestor node_modules lookup.
    }
  }
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(current, 'node_modules', '@trusty-squire', 'mcp');
    try {
      const info = await stat(join(candidate, 'package.json'));
      if (info.isFile()) return candidate;
    } catch {
      // Continue walking up ancestor directories.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readPackagedSquirePackage(options?: SquireResolutionOptions): Promise<LocalSquireCandidate | undefined> {
  if (options?.packagedDir === null) return undefined;
  if (typeof options?.packagedDir === 'string') {
    return inspectPackagedDir(options.packagedDir);
  }
  const packageDir = await findPackagedSquireDir();
  if (!packageDir) return undefined;
  return inspectPackagedDir(packageDir);
}

async function readHintedSquirePackage(directory: string): Promise<LocalSquireCandidate | undefined> {
  let file: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    file = await openPrivateFile(
      join(directory, HINT_FILENAME),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return undefined;
  }
  let binPath: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || !hasOwnerMode(info, 0o600) || info.size > 32768) return undefined;
    binPath = (await file.readFile('utf8')).trim();
    if (!isAbsolute(binPath) || binPath.includes('\0')) return undefined;
  } finally {
    await file.close();
  }

  const distDir = dirname(binPath);
  const signupEntry = join(distDir, 'signup.js');
  const packageDir = dirname(distDir);

  try {
    const signupInfo = await stat(signupEntry);
    if (!signupInfo.isFile()) return undefined;
  } catch {
    return undefined;
  }

  try {
    const manifest = await readManifestFromPackageDir(packageDir, false);
    if (manifest.name === SQUIRE_PACKAGE_NAME && typeof manifest.version === 'string') {
      const parsedVersion = parseSemver(manifest.version);
      if (parsedVersion) {
        return {
          source: 'hinted',
          packageDir,
          version: manifest.version,
          parsedVersion,
          binPath,
          signupEntry
        };
      }
    }
  } catch {
    // Allow hinted bin/signup paths even when package.json is unavailable.
  }

  return {
    source: 'hinted',
    packageDir,
    binPath,
    signupEntry
  };
}

async function readManagedSquirePackage(directory: string): Promise<LocalSquireCandidate | undefined> {
  const runtimeRoot = join(directory, SQUIRE_RUNTIME_DIR);
  const versionsDir = join(runtimeRoot, VERSIONS_DIR);
  try {
    await assertOwnedPrivateDir(runtimeRoot);
    await assertOwnedPrivateDir(versionsDir);
  } catch {
    return undefined;
  }

  let entries: string[];
  try {
    entries = await readdir(versionsDir);
  } catch {
    return undefined;
  }

  const compatible = entries
    .map(name => ({ name, parsed: parseStableSemver(name) }))
    .filter((item): item is { name: string; parsed: ParsedSemver } =>
      item.parsed !== undefined && item.parsed.major === SQUIRE_COMPATIBLE_MAJOR
    )
    .sort((a, b) => compareSemver(b.parsed, a.parsed));

  for (const entry of compatible) {
    const verified = await verifyManagedVersionDir(join(versionsDir, entry.name), entry.name);
    if (verified) return verified;
  }
  return undefined;
}

function sourcePriority(source: LocalSquireCandidate['source']): number {
  switch (source) {
    case 'packaged': return 3;
    case 'managed': return 2;
    case 'hinted': return 1;
  }
}

function pickBestLocal(candidates: readonly (LocalSquireCandidate | undefined)[]): LocalSquireCandidate | undefined {
  const present = candidates.filter((candidate): candidate is LocalSquireCandidate => candidate !== undefined);
  if (present.length === 0) return undefined;
  present.sort((a, b) => {
    if (a.parsedVersion && b.parsedVersion) {
      const cmp = compareSemver(b.parsedVersion, a.parsedVersion);
      if (cmp !== 0) return cmp;
    } else if (a.parsedVersion) {
      return -1;
    } else if (b.parsedVersion) {
      return 1;
    }
    return sourcePriority(b.source) - sourcePriority(a.source);
  });
  return present[0];
}

async function readUpdateState(directory: string): Promise<SquireUpdateState | undefined> {
  const runtimeRoot = join(directory, SQUIRE_RUNTIME_DIR);
  try {
    await assertOwnedPrivateDir(runtimeRoot);
  } catch {
    return undefined;
  }
  let file: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    file = await openPrivateFile(
      join(runtimeRoot, STATE_FILENAME),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return undefined;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || !hasOwnerMode(info, 0o600) || info.size > MAX_STATE_BYTES) return undefined;
    const raw = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const state: SquireUpdateState = {};
    if (typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt)) state.checkedAt = raw.checkedAt;
    if (typeof raw.failedAt === 'number' && Number.isFinite(raw.failedAt)) state.failedAt = raw.failedAt;
    if (typeof raw.latestVersion === 'string') state.latestVersion = raw.latestVersion;
    if (typeof raw.activeVersion === 'string') state.activeVersion = raw.activeVersion;
    return state;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

async function writeUpdateState(directory: string, state: SquireUpdateState): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const runtimeRoot = join(directory, SQUIRE_RUNTIME_DIR);
    await ensurePrivateDir(runtimeRoot);
    const temporary = join(runtimeRoot, `.${STATE_FILENAME}-${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(runtimeRoot, STATE_FILENAME));
    } finally {
      await rm(temporary, { force: true });
    }
  } catch {
    // Cooldown metadata is best-effort; never break embedded signup if writing state fails.
  }
}

async function readBoundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Registry response unavailable or too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('Registry response too large');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Reader lock may already be released on cancellation.
    }
  }
}

async function fetchLatestCompatibleVersion(
  fetcher: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<RemoteVersionResult> {
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetcher(SQUIRE_LATEST_URL, {
    signal,
    redirect: 'error',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
  });
  const payload = JSON.parse((await readBoundedBytes(response, MAX_METADATA_BYTES, signal)).toString('utf8')) as {
    name?: unknown;
    version?: unknown;
  } | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'incompatible' };
  }
  if (payload.name !== SQUIRE_PACKAGE_NAME || typeof payload.version !== 'string') {
    return { status: 'incompatible' };
  }
  const parsed = parseStableSemver(payload.version);
  if (!parsed || parsed.major !== SQUIRE_COMPATIBLE_MAJOR) {
    return { status: 'incompatible', version: payload.version };
  }
  return { status: 'compatible', version: parsed.raw, parsed };
}

async function pruneOldManagedVersions(versionsDir: string, keepVersion: string): Promise<void> {
  try {
    const entries = await readdir(versionsDir);
    const valid = entries
      .map(name => ({ name, parsed: parseStableSemver(name) }))
      .filter((item): item is { name: string; parsed: ParsedSemver } =>
        item.parsed !== undefined && item.parsed.major === SQUIRE_COMPATIBLE_MAJOR
      )
      .sort((a, b) => compareSemver(b.parsed, a.parsed));

    const retained = new Set<string>([keepVersion]);
    for (const item of valid) {
      if (retained.size >= MAX_RETAINED_VERSIONS) break;
      retained.add(item.name);
    }

    for (const item of valid) {
      if (!retained.has(item.name)) {
        await rm(join(versionsDir, item.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Pruning older runtime copies is best-effort.
  }
}

async function installManagedVersion(
  directory: string,
  targetVersion: string,
  options?: SquireResolutionOptions
): Promise<LocalSquireCandidate> {
  const parsed = parseStableSemver(targetVersion);
  if (!parsed || parsed.major !== SQUIRE_COMPATIBLE_MAJOR) {
    throw new Error('Refusing incompatible Squire version');
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtimeRoot = join(directory, SQUIRE_RUNTIME_DIR);
  await ensurePrivateDir(runtimeRoot);
  const versionsDir = join(runtimeRoot, VERSIONS_DIR);
  await ensurePrivateDir(versionsDir);

  const targetDir = join(versionsDir, targetVersion);
  const existing = await verifyManagedVersionDir(targetDir, targetVersion);
  if (existing) return existing;

  const temporary = await mkdtemp(join(runtimeRoot, '.install-'));
  if (process.platform !== 'win32') await chmod(temporary, 0o700);

  try {
    const staging = join(temporary, 'runtime');
    await mkdir(staging, { mode: 0o700 });
    await writeFile(
      join(staging, 'package.json'),
      JSON.stringify({
        name: 'grunt-squire-runtime',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: {
          [SQUIRE_PACKAGE_NAME]: targetVersion
        }
      }) + '\n',
      { flag: 'wx', mode: 0o600 }
    );

    const userNpmrc = join(temporary, 'user.npmrc');
    const globalNpmrc = join(temporary, 'global.npmrc');
    await writeFile(userNpmrc, '', { flag: 'wx', mode: 0o600 });
    await writeFile(globalNpmrc, '', { flag: 'wx', mode: 0o600 });

    const run = options?.run ?? defaultRun;
    const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installTimeoutMs = options?.installTimeoutMs ?? SQUIRE_INSTALL_TIMEOUT_MS;
    await run(
      npmBinary,
      [
        'install',
        '--prefix', staging,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--workspaces=false',
        '--registry=https://registry.npmjs.org',
        '--userconfig', userNpmrc,
        '--globalconfig', globalNpmrc
      ],
      {
        env: sanitizeInstallEnv(options?.env ?? process.env),
        timeout: installTimeoutMs,
        ...(options?.signal ? { signal: options.signal } : {})
      }
    );

    if (process.platform !== 'win32') {
      await removeGroupWrite(staging);
      await chmod(staging, 0o700);
    }

    const verifiedStaging = await verifyManagedVersionDir(staging, targetVersion);
    if (!verifiedStaging) {
      throw new Error('Installed Squire package failed verification');
    }

    try {
      await rename(staging, targetDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        const raced = await verifyManagedVersionDir(targetDir, targetVersion);
        if (raced) return raced;
      }
      throw error;
    }

    const verifiedTarget = await verifyManagedVersionDir(targetDir, targetVersion);
    if (!verifiedTarget) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('Published Squire runtime failed verification');
    }

    await pruneOldManagedVersions(versionsDir, targetVersion);
    return verifiedTarget;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function toResolved(candidate: LocalSquireCandidate, updated: boolean): ResolvedSquirePackage {
  return {
    source: candidate.source,
    packageDir: candidate.packageDir,
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
    binPath: candidate.binPath,
    signupEntry: candidate.signupEntry,
    updated
  };
}

async function resolveLocalCandidates(
  directory: string,
  options?: SquireResolutionOptions
): Promise<{
  managed: LocalSquireCandidate | undefined;
  packaged: LocalSquireCandidate | undefined;
  hinted: LocalSquireCandidate | undefined;
  bestLocal: LocalSquireCandidate | undefined;
}> {
  const bundled = isBundledDaemon(options);
  const [managed, hinted, packaged] = await Promise.all([
    readManagedSquirePackage(directory),
    bundled ? readHintedSquirePackage(directory) : Promise.resolve(undefined),
    !bundled || options?.packagedDir !== undefined ? readPackagedSquirePackage(options) : Promise.resolve(undefined)
  ]);

  let effectivePackaged = packaged;
  if (bundled && !managed && !hinted && options?.packagedDir === undefined) {
    effectivePackaged = await readPackagedSquirePackage(options);
  }

  return {
    managed,
    packaged: effectivePackaged,
    hinted,
    bestLocal: pickBestLocal([managed, effectivePackaged, hinted])
  };
}

export async function resolveFallbackSquirePackage(
  directory: string,
  options?: SquireResolutionOptions
): Promise<ResolvedSquirePackage | undefined> {
  const bundled = isBundledDaemon(options);
  const [hinted, packaged] = await Promise.all([
    bundled ? readHintedSquirePackage(directory) : Promise.resolve(undefined),
    readPackagedSquirePackage(options)
  ]);
  const fallback = pickBestLocal([packaged, hinted]);
  return fallback ? toResolved(fallback, false) : undefined;
}

async function resolveSquirePackageUncoalesced(
  directory: string,
  options?: SquireResolutionOptions
): Promise<ResolvedSquirePackage> {
  options?.signal?.throwIfAborted();
  const { managed, bestLocal } = await resolveLocalCandidates(directory, options);

  if (!shouldAutoUpdate(options)) {
    if (bestLocal) return toResolved(bestLocal, false);
    throw new Error(MISSING_SQUIRE_MESSAGE);
  }

  const now = options?.now ?? Date.now;
  const currentTime = now();
  const cooldownMs = options?.cooldownMs ?? SQUIRE_CHECK_COOLDOWN_MS;
  const failureCooldownMs = options?.failureCooldownMs ?? SQUIRE_FAILURE_COOLDOWN_MS;
  const state = await readUpdateState(directory);

  if (bestLocal && state) {
    const withinSuccessCooldown =
      state.checkedAt !== undefined && currentTime >= state.checkedAt && currentTime - state.checkedAt < cooldownMs;
    const withinFailureCooldown =
      state.failedAt !== undefined && currentTime >= state.failedAt && currentTime - state.failedAt < failureCooldownMs;
    if (withinSuccessCooldown || withinFailureCooldown) {
      return toResolved(bestLocal, false);
    }
  }

  const fetcher = options?.fetcher ?? fetch;
  const metadataTimeoutMs = options?.metadataTimeoutMs ?? SQUIRE_METADATA_TIMEOUT_MS;

  let remote: RemoteVersionResult;
  try {
    remote = await fetchLatestCompatibleVersion(fetcher, metadataTimeoutMs, options?.signal);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    await writeUpdateState(directory, { ...state, failedAt: now() });
    if (bestLocal) return toResolved(bestLocal, false);
    throw new Error(MISSING_SQUIRE_MESSAGE);
  }

  if (remote.status === 'incompatible') {
    await writeUpdateState(directory, {
      checkedAt: now(),
      ...(remote.version ? { latestVersion: remote.version } : {}),
      ...(managed?.version ? { activeVersion: managed.version } : {})
    });
    if (bestLocal) return toResolved(bestLocal, false);
    throw new Error(MISSING_SQUIRE_MESSAGE);
  }

  if (bestLocal?.parsedVersion && compareSemver(remote.parsed, bestLocal.parsedVersion) <= 0) {
    await writeUpdateState(directory, {
      checkedAt: now(),
      latestVersion: remote.version,
      ...(managed?.version ? { activeVersion: managed.version } : {})
    });
    return toResolved(bestLocal, false);
  }

  try {
    const installed = await installManagedVersion(directory, remote.version, options);
    await writeUpdateState(directory, {
      checkedAt: now(),
      latestVersion: remote.version,
      activeVersion: remote.version
    });
    return toResolved(installed, true);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    await writeUpdateState(directory, { ...state, failedAt: now() });
    if (bestLocal) return toResolved(bestLocal, false);
    throw new Error(MISSING_SQUIRE_MESSAGE);
  }
}

export function resolveSquirePackage(
  directory: string,
  options?: SquireResolutionOptions
): Promise<ResolvedSquirePackage> {
  const canCoalesce =
    options?.fetcher === undefined
    && options?.run === undefined
    && options?.now === undefined
    && options?.signal === undefined
    && options?.packagedDir === undefined
    && shouldAutoUpdate(options);

  if (!canCoalesce) {
    return resolveSquirePackageUncoalesced(directory, options);
  }

  const key = `${resolve(directory)}:${isBundledDaemon(options) ? '1' : '0'}`;
  const existing = inFlightResolutions.get(key);
  if (existing) return existing;

  const pending = resolveSquirePackageUncoalesced(directory, options).finally(() => {
    if (inFlightResolutions.get(key) === pending) {
      inFlightResolutions.delete(key);
    }
  });
  inFlightResolutions.set(key, pending);
  return pending;
}

export async function saveSquireClientPath(directory: string) {
  const temporary = join(directory, `.${HINT_FILENAME}-${randomUUID()}`);
  try {
    await writeFile(temporary, packagedClient(), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, HINT_FILENAME));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function squireClientPath(directory: string, options?: SquireResolutionOptions): Promise<string> {
  const resolved = await resolveSquirePackage(directory, {
    autoUpdate: false,
    ...options
  });
  return resolved.binPath;
}
