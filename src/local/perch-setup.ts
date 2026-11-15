import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Perch from './perch.js';
import { runPerchCommand, verifyPerchCoreFiles } from './perch-process.js';
import type { PerchProcesses } from './perch-process.js';
import { DATA_SHARING_POLICIES, readDataSharingConsent } from './data-sharing.js';

export interface PerchSignup {
  signup(service: string, url: string, goal: string): Promise<void>;
  cancelSignup?(service: string): Promise<void>;
  approveDataSharing?(providers: readonly string[]): void;
}
export interface PerchInstallOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  command?: typeof runPerchCommand;
}
const setupFailure = () => new Error('Perch active Starter verification or native login did not complete; rerun usegrunt setup');
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw setupFailure();
      return operation();
    }), new Promise<never>((_resolve, reject) => {
      abort = () => reject(setupFailure());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } catch { throw setupFailure(); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function archiveBytes(response: Response, signal: AbortSignal) {
  const limit = 32 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) throw new Error('Perch official package download failed');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await bounded(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Perch official package exceeded its supported size');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A cancelled body can still be closing. */ }
  }
}

/** Install the verified official package under Grunt, without lifecycle scripts or global PATH changes. */
export async function installPerch(directory: string, options: PerchInstallOptions = {}) {
  if (options.signal?.aborted) throw setupFailure();
  const paths = await Perch.preparePerchDirectories(directory);
  try { await Perch.verifyPerchInstallation(directory, options.signal); return paths; }
  catch { if (options.signal?.aborted) throw setupFailure(); }
  const temporary = await mkdtemp(join(paths.home, '.install-'));
  const run = options.command ?? runPerchCommand;
  const signal = options.signal ?? new AbortController().signal;
  try {
    const download = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const response = await bounded(() => (options.fetcher ?? fetch)(Perch.PERCH_NPM_TARBALL_URL, { signal: download, redirect: 'error' }), download);
    const bytes = await archiveBytes(response, download);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== Perch.PERCH_NPM_INTEGRITY
      || createHash('sha256').update(bytes).digest('hex') !== Perch.PERCH_TARBALL_SHA256) throw new Error('Perch official package integrity verification failed');
    const archive = join(temporary, 'package.tgz');
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
    const env = Perch.perchEnvironment(directory);
    const extracted = await run('tar', ['-xzf', archive, '-C', temporary], { cwd: temporary, env, signal, timeoutMs: 30000, maxOutputBytes: 65536 });
    if (extracted.code !== 0) throw new Error('Perch official package extraction failed');
    const packagePath = join(temporary, 'package');
    const metadata = await lstat(packagePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error('Perch package directory is unsafe');
    await verifyPerchCoreFiles(packagePath, Perch.PERCH_CORE_SHA256, signal);
    const userNpmrc = join(temporary, 'user.npmrc'), globalNpmrc = join(temporary, 'global.npmrc');
    await writeFile(userNpmrc, '', { mode: 0o600, flag: 'wx' });
    await writeFile(globalNpmrc, '', { mode: 0o600, flag: 'wx' });
    const npmEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key) && !/^node_(?:options|path)$/i.test(key)));
    const dependencies = await run('npm', ['install', '--prefix', packagePath, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
      '--registry=https://registry.npmjs.org', '--userconfig', userNpmrc, '--globalconfig', globalNpmrc], {
      cwd: temporary, env: npmEnv, signal, timeoutMs: 300000, maxOutputBytes: 65536
    });
    if (dependencies.code !== 0) throw new Error('Perch private dependency installation failed');
    await verifyPerchCoreFiles(packagePath, Perch.PERCH_CORE_SHA256, signal);
    await chmod(packagePath, 0o700);
    await chmod(join(packagePath, 'bin', 'perch'), 0o700);
    if (signal.aborted) throw setupFailure();
    // Replace only this managed, fixed-version package. Native auth and all
    // other Perch profiles remain outside the installation directory.
    const previous = join(paths.versionHome, `.previous-${randomUUID()}`);
    let moved = false, installed = false;
    try {
      try { await rename(paths.package, previous); moved = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(packagePath, paths.package); installed = true;
      await Perch.writePerchInstallReceipt(directory);
      await Perch.verifyPerchInstallation(directory, signal);
      if (signal.aborted) throw setupFailure();
    } catch (error) {
      if (installed) await rm(paths.package, { recursive: true, force: true });
      if (moved) { await rename(previous, paths.package); moved = false; }
      await rm(paths.installReceipt, { force: true });
      throw error;
    } finally { if (moved) await rm(previous, { recursive: true, force: true }); }
    return paths;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export interface PerchSetupOptions {
  directory: string;
  squire: PerchSignup;
  signal?: AbortSignal;
  dataSharingApproved?: readonly string[];
  background?: boolean;
  notify?(line: string): void;
  fetcher?: typeof fetch;
  processes?: PerchProcesses;
  /** Offline test dependencies. Production uses the verified native implementation. */
  install?: typeof installPerch;
  identity?: typeof Perch.verifyPerchIdentity;
  configureMemory?: typeof Perch.configurePerchMemory;
  verifyMemory?: typeof Perch.verifyPerchMemory;
}
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(value)) throw setupFailure();
  return value.trim().toLowerCase();
}
const freeGoal = (identity?: string) => `Use only the existing authorized personal account${identity ? ` whose native CLI email is ${JSON.stringify(identity)}` : ' using the personal Google identity already connected to Squire'}. Open the visible account settings in this Perch web app using the top-right avatar button labelled Open account settings; use Account and Billing to verify the plan and allowance, and Privacy to verify the Starter Data Program. Verify this exact account has ACTIVE Starter ($0), with a vetted recurring allowance of at least 20,000 Perch Tokens per month; 20,000 is the conservative supported monthly floor, not a claim about a larger displayed offer. Exclude one-time bonuses when checking this recurring floor. A Starter placeholder before activation is insufficient: if no active plan exists, use the ordinary See plans / Start Free action to activate Starter only. Never activate a paid trial, Pro, Ultra, a subscription, a pass, purchases, top-ups or overage. Do not add a card or payment method. If paid billing, paid credits, a paid plan or overage is visible, stop without changing it. Do not assert hidden saved-card inventory. Verify the optional Starter Data Program is OFF; if it is on, turn off only that optional program through normal settings and verify the saved OFF state. Leave optional marketing off. Do not enable optional memory or claim it is disabled unless the UI actually verifies that state. Do not switch identities, downgrade, remove billing, create a duplicate account or enable BYOK. Finish only after confirming active Starter and Data Program OFF for this identity. Report required human verification for browser handoff; stop on refusal and do not bypass verification.`;
async function browser(options: PerchSetupOptions, url: string, goal: string, signal: AbortSignal) {
  await bounded(() => options.squire.signup('perch', url, goal), signal);
}
async function nativeLogin(options: PerchSetupOptions, signal: AbortSignal, expectedEmail?: string) {
  const paths = Perch.perchPaths(options.directory), run = options.processes?.command ?? runPerchCommand;
  const temporary = await mkdtemp(join(paths.home, '.login-'));
  const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal]);
  let pairing: Promise<void> | undefined, pairingURL: string | undefined;
  try {
    await Perch.verifyPerchStartupIsolation(temporary);
    for (const name of ['settings', 'state', 'grants', 'telemetry', 'nativeHome', 'consent', 'splash', 'background']) await mkdir(join(temporary, name), { mode: 0o700 });
    // The unmodified CLI executes platform opener commands. Squire owns the
    // actual trusted HTTPS pairing page; suppress only the unmanaged launch.
    for (const name of ['open', 'xdg-open', 'x-www-browser', 'www-browser']) await writeFile(join(temporary, name), '#!/bin/sh\nexit 0\n', { mode: 0o700, flag: 'wx' });
    const result = await run(process.execPath, [paths.binary, 'login', 'google'], {
      cwd: temporary, env: { ...Perch.perchEnvironment(options.directory, temporary), PATH: `${temporary}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      signal: combined, timeoutMs: 600000, maxOutputBytes: 65536,
      onLine(line) {
        const match = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').match(/https:\/\/[^\s"'<>`]+/);
        if (!match) return;
        // The official login command first prints its application homepage as
        // prose, before emitting the actual scoped native authorization URL.
        if (['https://app.perchai.app', 'https://app.perchai.app/', 'https://app.perchai.app.', 'https://app.perchai.app/.'].includes(match[0])) return;
        const url = new URL(match[0]);
        if (url.origin !== 'https://app.perchai.app' || url.pathname !== '/api/perch-terminal/cli-auth/start' || url.username || url.password || url.hash) throw setupFailure();
        if (pairingURL) { if (url.href !== pairingURL) throw setupFailure(); return; }
        pairingURL = url.href;
        pairing = browser(options, url.href, `Complete only the Perch native CLI Google sign-in started by this Grunt process, using the same personal Starter account just verified${expectedEmail ? ` with email ${JSON.stringify(expectedEmail)}` : ''}. Authorize this native pairing only. Do not create/copy/reveal an API key or native auth token; the official CLI owns its callback and credential storage. Do not switch accounts, create a duplicate, buy a plan, enable a trial, add a card, pay for credits, enable overage, or opt in to the optional Starter Data Program. Stop on refusal; report CAPTCHA, passkey, phone or email verification for human handoff without bypassing it.`, combined);
        void pairing.catch(() => lifetime.abort());
      }
    });
    if (result.code !== 0 || !pairing) throw setupFailure();
    await pairing;
    if (signal.aborted) throw setupFailure();
  } finally { lifetime.abort(); await rm(temporary, { recursive: true, force: true }); }
}

/** Foreground verifies normal Starter activation; background only reuses verified native state. */
export async function setupPerch(options: PerchSetupOptions): Promise<void> {
  const approved = [...new Set([...(options.dataSharingApproved ?? []), ...await readDataSharingConsent(options.directory, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
  if (!approved.includes('perch')) throw new Error('Perch data sharing requires the grouped setup approval');
  const deadline = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 600000);
  const paths = Perch.perchPaths(options.directory);
  const identify = options.identity ?? Perch.verifyPerchIdentity;
  const readMemory = options.verifyMemory ?? Perch.verifyPerchMemory;
  const configureMemory = options.configureMemory ?? Perch.configurePerchMemory;
  let completed = false;
  try {
    if (signal.aborted) throw setupFailure();
    if (options.background) await Perch.verifyPerchInstallation(options.directory, signal);
    else {
      options.squire.approveDataSharing?.(approved);
      await (options.install ?? installPerch)(options.directory, { signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}), ...(options.processes ? { command: options.processes.command } : {}) });
    }
    await Perch.verifyPerchStartupIsolation(paths.work);
    let saved: Perch.PerchFreePlanReceipt | undefined;
    try { saved = await Perch.readPerchFreePlanReceipt(options.directory); } catch { /* A fresh foreground check is required. */ }
    if (options.background && !saved) throw setupFailure();
    let identity = await bounded(() => identify(options.directory, signal, options.processes), signal);
    if (identity) identity = { email: email(identity.email) };
    if (saved && identity && sameEmail(saved.email, identity.email)) {
      let memory: Awaited<ReturnType<typeof Perch.verifyPerchMemory>> | undefined;
      try {
        memory = await bounded(() => readMemory(options.directory, signal, options.processes), signal);
      } catch { if (signal.aborted || options.background) throw setupFailure(); }
      if (memory) {
        if (!sameEmail(identity.email, email(memory.email))) throw setupFailure();
        completed = true; options.notify?.('Perch: existing Starter native login and memory-off settings verified'); return;
      }
    }
    await rm(paths.receipt, { force: true });
    if (options.background) throw new Error('Perch requires foreground Starter setup');
    if (saved && identity && !sameEmail(saved.email, identity.email)) throw setupFailure();
    const expected = identity?.email ?? saved?.email;
    await browser(options, 'https://chat.perchai.app/', freeGoal(expected), signal);
    if (!identity) {
      await nativeLogin(options, signal, expected);
      await Perch.assertPerchPrivateAuth(options.directory);
      identity = await bounded(() => identify(options.directory, signal, options.processes), signal);
      if (!identity || (expected && !sameEmail(expected, identity.email))) throw setupFailure();
      identity = { email: email(identity.email) };
      await browser(options, 'https://chat.perchai.app/', freeGoal(identity.email), signal);
    }
    if (signal.aborted) throw setupFailure();
    const configured = await bounded(() => configureMemory(options.directory, signal, options.processes), signal);
    if (!sameEmail(identity.email, email(configured.email))) throw setupFailure();
    const memory = await bounded(() => readMemory(options.directory, signal, options.processes), signal);
    if (!sameEmail(identity.email, email(memory.email))) throw setupFailure();
    if (signal.aborted) throw setupFailure();
    await Perch.writePerchFreePlanReceipt(options.directory, { version: 1, plan: 'Starter', email: identity.email, monthlyAllowancePT: 20000, dataProgramEnabled: false,
      memoryUseEnabled: false, memoryLearningEnabled: false, checkedAt: new Date().toISOString() });
    if (signal.aborted) throw setupFailure();
    completed = true;
    options.notify?.('Perch: active Starter verified with the optional Data Program and both native memory switches off');
  } catch {
    await rm(paths.receipt, { force: true }).catch(() => {});
    throw setupFailure();
  } finally {
    clearTimeout(timer);
    if (!completed && !options.background) {
      deadline.abort();
      await bounded(() => options.squire.cancelSignup?.('perch') ?? Promise.resolve(), AbortSignal.timeout(10000)).catch(() => {});
    }
  }
}
