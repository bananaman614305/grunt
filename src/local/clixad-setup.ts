import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { executable } from './multiplexer.js';
import { DATA_SHARING_POLICIES, readDataSharingConsent } from './data-sharing.js';
import {
  Clixad, CLIXAD_CORE_SHA256, CLIXAD_DASHBOARD, CLIXAD_INTEGRITY, CLIXAD_MODEL, CLIXAD_TARBALL,
  clixadEnvironment, clixadPaths, prepareClixadDirectories, readClixadInstallReceipt,
  verifyClixadAccess, verifyClixadPublicModel, writeClixadInstallReceipt
} from './clixad.js';

export interface ClixadSetupSquire {
  signup(service: string, url: string, goal: string): Promise<void>;
  cancelSignup(provider: string): Promise<void>;
  approveDataSharing?(providers: readonly string[]): void;
}
interface CommandOptions { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onOutput?(chunk: string): void }
export type ClixadSetupCommand = (binary: string, args: string[], options: CommandOptions) => Promise<{ code: number | null; stdout: string }>;
const failure = () => new Error('Clixad free native setup did not complete; rerun usegrunt setup');
const modelFailure = () => new Error('Clixad already uses another model. Select GLM 5.3 Flash explicitly in the native CLI before rerunning setup; Grunt preserved the existing preference.');
export class ClixadNativeLoginRequired extends Error {
  readonly code = 'logged_out';
  constructor() {
    super('Sign in to the same Clixad account with the official CLI, then rerun usegrunt setup. The existing native profile was preserved.');
    this.name = 'ClixadNativeLoginRequired';
  }
}
function stop(child: ReturnType<typeof spawn>, force = false) {
  try { if (child.pid) { if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM'); else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } }
  catch { /* Only our owned process group is signalled. */ }
}
export const runClixadSetupCommand: ClixadSetupCommand = async (binary, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', bytes = 0, failed = false, oversized = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { stop(child); force ??= setTimeout(() => stop(child, true), 1000); force.unref(); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    const consume = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.length;
      if (bytes > 262144) { oversized = true; stop(child, true); return; }
      if (capture) stdout += chunk.toString('utf8');
      try { options.onOutput?.(chunk.toString('utf8')); } catch { failed = true; stop(child, true); }
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      options.signal.removeEventListener('abort', abort); if (force) clearTimeout(force); stop(child, true);
      if (options.signal.aborted || failed || oversized) reject(failure()); else resolveResult({ code, stdout });
    });
  });
};
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw failure(); return operation(); }), new Promise<never>((_resolve, reject) => {
      abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function coreFiles(directory: string) {
  const paths = clixadPaths(directory);
  for (const path of [paths.package, dirname(paths.entry)]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw failure();
  }
  for (const [name, expected] of Object.entries(CLIXAD_CORE_SHA256)) {
    const file = await open(join(dirname(paths.entry), name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 1048576) throw failure();
      if (createHash('sha256').update(await file.readFile()).digest('hex') !== expected) throw failure();
    } finally { await file.close(); }
  }
}
export async function installClixad(directory: string, options: { signal?: AbortSignal; fetcher?: typeof fetch; command?: ClixadSetupCommand } = {}) {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600000)]);
  if (!['linux', 'darwin'].includes(process.platform)) throw failure();
  signal.throwIfAborted(); const paths = await prepareClixadDirectories(directory);
  try { await readClixadInstallReceipt(directory); await coreFiles(directory); return paths; }
  catch { if (signal.aborted) throw failure(); }
  await rm(paths.installation, { force: true });
  const temporary = await mkdtemp(join(paths.home, '.install-'));
  try {
    const response = await bounded(() => (options.fetcher ?? fetch)(CLIXAD_TARBALL, { redirect: 'error', signal }), signal);
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 100 * 1024 * 1024) { void response.body?.cancel().catch(() => {}); throw failure(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await bounded(() => reader.read(), signal); if (part.done) break; size += part.value.byteLength; if (size > 100 * 1024 * 1024) throw failure(); chunks.push(part.value); }
    } finally { void reader.cancel().catch(() => {}); }
    const archive = Buffer.concat(chunks);
    if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== CLIXAD_INTEGRITY) throw failure();
    const tarball = join(temporary, 'clixad.tgz'), userconfig = join(temporary, 'user.npmrc'), globalconfig = join(temporary, 'global.npmrc');
    await writeFile(tarball, archive, { mode: 0o600, flag: 'wx' });
    await writeFile(userconfig, '', { mode: 0o600, flag: 'wx' }); await writeFile(globalconfig, '', { mode: 0o600, flag: 'wx' });
    signal.throwIfAborted();
    const env = Object.fromEntries(Object.entries(clixadEnvironment()).filter(([key]) => !/^npm_config_/i.test(key)));
    const result = await (options.command ?? runClixadSetupCommand)(await executable('npm'), ['install', '--prefix', paths.runtime, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false',
      '--registry=https://registry.npmjs.org', '--userconfig', userconfig, '--globalconfig', globalconfig, '--cache', join(paths.home, 'cache'), tarball], { cwd: paths.work, env, signal });
    signal.throwIfAborted(); if (result.code !== 0) throw failure();
    await coreFiles(directory); signal.throwIfAborted(); await writeClixadInstallReceipt(directory);
    if (signal.aborted) { await rm(paths.installation, { force: true }); throw failure(); }
    return paths;
  } catch { throw failure(); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
export interface ClixadSetupOptions {
  directory: string; squire: ClixadSetupSquire; signal?: AbortSignal; dataSharingApproved?: readonly string[]; notify?(line: string): void; background?: boolean;
  /** Test-only dependencies; production always uses the standard native home. */
  nativeDirectory?: string; install?: typeof installClixad; command?: ClixadSetupCommand; verify?: typeof verifyClixadAccess; fetcher?: typeof fetch;
}
async function nativeConfig(directory: string): Promise<boolean> {
  try {
    const home = await lstat(directory);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o077)) throw failure();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw failure(); }
  try {
    const config = await lstat(join(directory, 'config.json'));
    if (!config.isFile() || config.isSymbolicLink() || config.uid !== process.getuid?.() || (config.mode & 0o777) !== 0o600 || config.size < 1 || config.size > 65536) throw failure();
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw failure(); }
}
const clean = (value: string) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
async function login(options: ClixadSetupOptions, paths: ReturnType<typeof clixadPaths>, signal: AbortSignal) {
  const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal]);
  // The official login launches platform openers and has no no-open flag.
  // Suppress only this unmanaged child launch; Squire opens the real device URL.
  const openers = await mkdtemp(join(paths.home, '.login-openers-'));
  for (const name of ['open', 'xdg-open']) await writeFile(join(openers, name), '#!/bin/sh\nexit 0\n', { mode: 0o700, flag: 'wx' });
  let output = '', pairing: Promise<void> | undefined, failed = false;
  const run = (options.command ?? runClixadSetupCommand)(process.execPath, ['--input-type=module', '-e', 'process.umask(0o077); await import(process.argv[1]);', paths.entry, 'login'], {
    cwd: paths.work, env: { ...clixadEnvironment(), PATH: `${openers}:${process.env.PATH ?? '/usr/bin:/bin'}` }, signal: combined, onOutput(chunk) {
      output += chunk; if (output.length > 65536) { failed = true; lifetime.abort(); return; }
      if (pairing) return;
      const text = clean(output), url = text.match(/https:\/\/github\.com\/login\/device(?:\?[^\s]+)?(?=\s|$)/)?.[0];
      const code = text.match(/\b(?:[Ee]nter\s+)?[Cc]ode:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
      if (!url || !code) return;
      let address: URL;
      try { address = new URL(url); } catch { failed = true; lifetime.abort(); return; }
      if (address.origin !== 'https://github.com' || address.pathname !== '/login/device' || address.username || address.password || address.hash
        || [...address.searchParams.keys()].some(key => key !== 'user_code') || (address.searchParams.has('user_code') && address.searchParams.get('user_code') !== code)) { failed = true; lifetime.abort(); return; }
      address.searchParams.set('user_code', code);
      pairing = bounded(() => options.squire.signup('clixad', address.href,
        'Approve only the official Clixad native CLI GitHub device pairing started by Grunt, using the same personal GitHub identity just checked. Confirm the displayed device code matches this URL. Permit only read-only identity/profile and email scopes; stop on extra repository, organization, write or billing permissions. Never switch accounts, create another account, reveal tokens, add a payment method, fund a wallet, buy credits, subscribe, run offers, automate feedback or earn rewards. Required human verification needs normal browser handoff; stop on refusal. The CLI owns the token exchange and its fixed native config.'), combined);
      void pairing.catch(() => { failed = true; lifetime.abort(); });
    }
  });
  try { const result = await run; if (combined.aborted || failed || result.code !== 0 || !pairing) throw failure(); await pairing; if (combined.aborted) throw failure(); }
  finally { lifetime.abort(); await rm(openers, { recursive: true, force: true }); }
}
/** Explicit user setup only; the native wallet can claim its ordinary daily streak bonus. */
export async function setupClixad(options: ClixadSetupOptions): Promise<void> {
  if (!DATA_SHARING_POLICIES.some(policy => policy.provider === 'clixad')) throw new Error('Clixad data-sharing policy is unavailable');
  const approved = await readDataSharingConsent(options.directory, DATA_SHARING_POLICIES.map(policy => policy.provider));
  if (!approved.includes('clixad') || (options.dataSharingApproved && !options.dataSharingApproved.includes('clixad'))) throw new Error('Clixad requires the current grouped data-sharing approval');
  const deadline = new AbortController(), timeout = setTimeout(() => deadline.abort(), 600000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let browserStarted = false, cancellation: Promise<void> | undefined;
  const cancel = () => { if (browserStarted) cancellation ??= Promise.resolve().then(() => options.squire.cancelSignup('clixad')).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const native = options.nativeDirectory ?? join(homedir(), '.clixad');
  try {
    if (signal.aborted) throw failure(); options.squire.approveDataSharing?.(approved);
    if (options.background) {
      const source = new Clixad({ directory: options.directory, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
      try { if (!await bounded(() => source.available(), signal)) throw failure(); return; }
      finally { await source.close(); }
    }
    const paths = await (options.install ?? installClixad)(options.directory, { signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    await verifyClixadPublicModel({ signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    const existed = await nativeConfig(native);
    if (existed) {
      const current = await (options.command ?? runClixadSetupCommand)(process.execPath, [paths.entry, 'model'], { cwd: paths.work, env: clixadEnvironment(), signal });
      if (current.code !== 0) throw failure();
      if (clean(current.stdout).trim() !== `current model: ${CLIXAD_MODEL}`) throw modelFailure();
    }
    const verify = () => (options.verify ?? verifyClixadAccess)({ directory: options.directory, signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    try { await bounded(verify, signal); return; }
    catch (error) {
      if (signal.aborted || (error as { code?: string }).code !== 'logged_out') throw error;
      // An expired native token cannot reveal its original public identity.
      // Preserve that profile rather than pairing Squire's current account over it.
      if (existed) throw new ClixadNativeLoginRequired();
    }
    browserStarted = true;
    await bounded(() => options.squire.signup('clixad', CLIXAD_DASHBOARD,
      'Use this user\'s existing personal GitHub identity to check the ordinary Clixad account, or create its one normal free account if absent. Verify wallet balance exactly zero, GLM 5.3 Flash appears in the free catalog, and positive ordinary daily free allowance is available. Clixad uses optional prepaid credit packs: do not add a card, payment method, subscription, auto-charge, deposit or paid credits, and stop if any existing paid balance or billing condition is present. Do not change existing billing, switch identities, reset or rotate existing native authentication, create a public API key, run offers, earn credits, automate feedback, or claim rewards. The native CLI may perform its ordinary daily streak claim during this explicit setup only. Accept only required terms under the current grouped data-sharing approval; leave optional marketing off. The official CLI GitHub device pairing follows separately with read-only profile/email scopes. Stop on refusal and report required human verification for browser handoff.'), signal);
    if (signal.aborted) throw failure();
    if (!existed && await nativeConfig(native)) throw failure();
    await login(options, paths, signal);
    if (signal.aborted || !await nativeConfig(native)) throw failure();
    if (!existed) {
      const pin = await (options.command ?? runClixadSetupCommand)(process.execPath, [paths.entry, 'model', CLIXAD_MODEL], { cwd: paths.work, env: clixadEnvironment(), signal });
      if (pin.code !== 0) throw failure();
    }
    await bounded(verify, signal); if (signal.aborted) throw failure();
    options.notify?.('Clixad: native free GLM 5.3 Flash access verified');
  } catch (error) {
    if (browserStarted) cancel();
    if (error instanceof ClixadNativeLoginRequired) throw error;
    if (error instanceof Error && error.message === modelFailure().message) throw modelFailure();
    throw failure();
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', cancel);
    if (cancellation) { const timer = AbortSignal.timeout(5000); await bounded(() => cancellation!, timer).catch(() => {}); }
  }
}
