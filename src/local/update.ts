import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beginSetupSession } from './setup-session.js';
import { configRoot, gruntEnv } from '../brand.js';
import { serviceEnvironment, serviceEnvironmentTokens as environmentTokens } from './service-environment.js';
import { migrateManagedPiWorkingContext } from './harnesses.js';
import { migrateAutomaticPool } from './automatic-pool.js';

const execute = promisify(execFile);
const LATEST = 'https://registry.npmjs.org/usegrunt/latest';
const MAX_ARCHIVE = 16 * 1024 * 1024;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export type UpdateRun = (binary: string, args: string[], options?: { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<string>;
export interface UpdateOptions {
  env?: NodeJS.ProcessEnv; directory?: string; fetcher?: typeof fetch; run?: UpdateRun;
  signal?: AbortSignal; platform?: 'linux' | 'darwin'; notify?: (line: string) => void;
  now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
interface Service { identity: string; port: number; node: string; active: boolean; automaticSources?: string[]; stop(): Promise<void>; start(): Promise<void> }
const failed = (message: string) => new Error(message);
const runCommand: UpdateRun = async (binary, args, options = {}) => {
  try { return (await execute(binary, args, { ...options, timeout: options.timeout ?? 30000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch { throw failed(`Could not run ${basename(binary)} while updating Grunt`); }
};
function port(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw failed('Could not determine the installed Grunt port safely');
  return Number(value);
}
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw failed('Grunt update requires a private, owned installation directory');
}
function unquote(value: string) { return value.replace(/^"(.*)"$/, '$1'); }
function systemdDecode(value: string) { return value.replace(/\\x([a-fA-F0-9]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
function escaped(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function serviceInfo(directory: string, platform: string, run: UpdateRun, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Service> {
  const entry = join(directory, 'runtime', 'dist', 'local', 'main.js');
  const opts = { env, signal };
  if (platform === 'linux') {
    const properties = ['LoadState', 'ExecStart', 'Environment', 'EnvironmentFiles', 'UnsetEnvironment', 'ActiveState'];
    const candidates = await Promise.all(['grunt.service', 'milo.service'].map(async identity => {
      const values = await Promise.all(properties.map(property => run('systemctl', ['--user', 'show', identity, '-p', property, '--value'], opts))).catch(() => undefined);
      if (!values || values[0]?.trim() !== 'loaded') return;
      const effective = serviceEnvironment(values[2] ?? '');
      return { identity, values, effective };
    }));
    const loaded = candidates.filter(candidate => candidate !== undefined);
    const matching = loaded.filter(candidate => {
      const stateDirectory = gruntEnv('CONFIG_DIR', candidate.effective);
      return stateDirectory?.startsWith('/') && resolve(stateDirectory) === directory;
    });
    if (matching.length > 1) throw failed('Multiple Grunt services own this configuration directory; stop the duplicate before updating');
    const selectedService = matching[0];
    if (!selectedService) throw failed(loaded.length ? 'The Grunt service uses a different configuration directory; its runtime was not changed' : 'No installed Grunt service was found; run npx usegrunt setup first');
    const { identity, effective } = selectedService;
    const [, rawExec, , files, unset, state] = selectedService.values as [string, string, string, string, string, string];
    const exec = systemdDecode(rawExec), node = unquote(exec.match(/(?:^|[ {])path=([^;]+);/)?.[1]?.trim() ?? '');
    const argv = exec.match(/argv\[\]=(.*?);/)?.[1]?.trim();
    if (!node.startsWith('/') || !['node', 'nodejs'].includes(basename(node)) || !new RegExp(`(?:^|[\\s"'])${escaped(entry)}(?=$|[\\s"';])`).test(exec)
      || ![`${node} ${entry}`, `"${node}" "${entry}"`, `${node} "${entry}"`, `"${node}" ${entry}`].includes(argv ?? '')) {
      throw failed('The existing Grunt service does not use the managed runtime; its configuration was not changed');
    }
    // Environment files or explicit removals can override Environment. Refuse
    // an ambiguous endpoint rather than probing another project's port.
    if (files.trim() || environmentTokens(unset).some(value => ['GRUNT_PORT', 'GRUNT_CONFIG_DIR', 'MILO_PORT', 'MILO_CONFIG_DIR'].some(name => value === name || value.startsWith(name + '=')))) throw failed('The installed Grunt port uses an unsupported environment override; its configuration was not changed');
    const selected = port(gruntEnv('PORT', effective));
    if (!['active', 'inactive', 'failed'].includes(state.trim())) throw failed('The Grunt service is changing state; retry the update after it settles');
    const selectionOverride = environmentTokens(unset).some(value => /^(?:GRUNT|MILO)_(?:SOURCES|DAEMON)(?:=|$)/.test(value));
    const automaticSources = !selectionOverride && gruntEnv('DAEMON', effective) === '1' ? gruntEnv('SOURCES', effective)?.split(',').map(id => id.trim()).filter(Boolean) : undefined;
    return { identity, port: selected, node, active: state.trim() === 'active', ...(automaticSources ? { automaticSources } : {}),
      stop: () => run('systemctl', ['--user', 'stop', identity], { env, timeout: 210000 }).then(() => {}),
      start: () => run('systemctl', ['--user', 'start', identity], { env }).then(() => {}) };
  }
  const domain = `gui/${process.getuid!()}`;
  const readVariable = (plist: string, name: string) => run('plutil', ['-extract', `EnvironmentVariables.${name}`, 'raw', '-o', '-', plist], opts).then(value => value.replace(/\r?\n$/, '')).catch(() => undefined);
  const candidates = await Promise.all(['ai.grunt.service', 'ai.milo.service'].map(async identity => {
    const target = `${domain}/${identity}`;
    const print = await run('launchctl', ['print', target], opts).catch(() => undefined);
    if (print === undefined) return;
    const plist = unquote(print.match(/^\s*path = (.+)$/m)?.[1]?.trim() ?? '');
    if (!plist.startsWith('/')) throw failed('No installed Grunt service was found; run npx usegrunt setup first');
    const stat = await lstat(plist);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw failed('The existing Grunt service file is unsafe');
    const primary = await readVariable(plist, 'GRUNT_CONFIG_DIR');
    const stateDirectory = primary ?? await readVariable(plist, 'MILO_CONFIG_DIR');
    return { identity, target, print, plist, stateDirectory };
  }));
  const loaded = candidates.filter(candidate => candidate !== undefined);
  const matching = loaded.filter(candidate => candidate.stateDirectory?.startsWith('/') && resolve(candidate.stateDirectory) === directory);
  if (matching.length > 1) throw failed('Multiple Grunt services own this configuration directory; stop the duplicate before updating');
  const selectedService = matching[0];
  if (!selectedService) throw failed(loaded.length ? 'The Grunt service uses a different configuration directory; its runtime was not changed' : 'No installed Grunt service was found; run npx usegrunt setup first');
  const { identity, target, print, plist } = selectedService;
  // Loaded waiting/exited KeepAlive jobs can restart themselves during a
  // filesystem swap. Support running jobs only until their intent can be
  // distinguished safely from an intentionally paused launchd service.
  if (!/^\s*state = running\s*$/m.test(print)) throw failed('Start the installed Grunt macOS service before updating; its configuration was not changed');
  // plutil preserves paths containing spaces without evaluating shell text.
  const [argumentsText, portText] = await Promise.all([
    run('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], opts),
    readVariable(plist, 'GRUNT_PORT').then(value => value ?? readVariable(plist, 'MILO_PORT'))
  ]);
  let args: unknown; try { args = JSON.parse(argumentsText); } catch { throw failed('The existing Grunt service arguments could not be verified'); }
  if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== 'string' || !args[0].startsWith('/') || !['node', 'nodejs'].includes(basename(args[0])) || args[1] !== entry) throw failed('The existing Grunt service does not use the managed runtime; its configuration was not changed');
  const readSetting = (name: string) => readVariable(plist, 'GRUNT_' + name).then(value => value ?? readVariable(plist, 'MILO_' + name));
  const managed = await readSetting('DAEMON'), selected = await readSetting('SOURCES');
  const automaticSources = managed === '1' ? selected?.split(',').map(id => id.trim()).filter(Boolean) : undefined;
  return { identity, port: port(portText), node: args[0], active: true, ...(automaticSources ? { automaticSources } : {}),
    stop: async () => {
      try { await run('launchctl', ['bootout', target], { env, timeout: 210000 }); }
      catch {
        // A previous bootout may have succeeded before cancellation, or a
        // failed bootstrap may never have registered its replacement. Only
        // treat this as stopped when the live domain confirms no such job.
        const listing = await run('launchctl', ['print', domain], { env });
        if (!new RegExp(`^${escaped(domain)} = \\{`).test(listing) || !/^\s*services = \{\s*$/m.test(listing)
          || listing.includes(identity)) throw failed('Could not confirm the Grunt macOS service is stopped');
      }
    },
    start: () => run('launchctl', ['bootstrap', domain, plist], { env }).then(() => {}) };
}
async function bytes(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw failed('The Grunt update download is unavailable or too large'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > limit) throw failed('The Grunt update download is too large'); chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function latest(fetcher: typeof fetch, signal: AbortSignal) {
  let metadata: unknown;
  try { metadata = JSON.parse((await bytes(await fetcher(LATEST, { signal, redirect: 'error', headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' } }), 1024 * 1024, signal)).toString()); }
  catch { throw failed('Could not fetch the latest Grunt release from npm'); }
  const pkg = metadata as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } } | null;
  if (!pkg || pkg.name !== 'usegrunt' || typeof pkg.version !== 'string' || !semver.test(pkg.version) || !pkg.dist || typeof pkg.dist.tarball !== 'string' || typeof pkg.dist.integrity !== 'string') throw failed('npm returned invalid Grunt release metadata');
  const expected = `https://registry.npmjs.org/usegrunt/-/usegrunt-${pkg.version}.tgz`;
  if (pkg.dist.tarball !== expected || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.dist.integrity)) throw failed('npm returned an unsupported Grunt artifact');
  const archive = await bytes(await fetcher(expected, { signal, redirect: 'error' }), MAX_ARCHIVE, signal);
  const digest = createHash('sha512').update(archive).digest(), wanted = Buffer.from(pkg.dist.integrity.slice(7), 'base64');
  if (wanted.length !== digest.length || !timingSafeEqual(digest, wanted)) throw failed('Grunt download integrity verification failed');
  return { version: pkg.version, archive };
}
function vetArchive(names: string, verbose: string) {
  const paths = names.trimEnd().split('\n'), entries = verbose.trimEnd().split('\n');
  let expanded = 0;
  if (paths.length > 1024 || new Set(paths).size !== paths.length || entries.length !== paths.length || !paths.includes('package/package.json') || !paths.includes('package/dist/local/main.js')) throw failed('The Grunt archive has an unsupported layout');
  for (const [index, path] of paths.entries()) {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.') || !(/^package\/(?:package\.json|README\.md)$/.test(path) || /^package\/(?:dist(?:\/[A-Za-z0-9._-]+)*\/?)?$/.test(path)) || !['-', 'd'].includes(entries[index]?.[0] ?? '')) {
      throw failed('The Grunt archive contains an unsafe path or link');
    }
    const prefix = entries[index]!.slice(0, entries[index]!.lastIndexOf(path));
    // tar formats differ between GNU and BSD. Conservatively bound every
    // numeric column; this includes size in both supported verbose formats.
    expanded += Math.max(0, ...prefix.split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number));
    if (expanded > 64 * 1024 * 1024) throw failed('The expanded Grunt archive is too large');
  }
}
async function status(fetcher: typeof fetch, selected: number, signal: AbortSignal) {
  const response = await fetcher(`http://127.0.0.1:${selected}/v1/status`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
  if (response.status === 404) { await response.body?.cancel(); return { legacy: true, active: 0 }; }
  const body = JSON.parse((await bytes(response, 128 * 1024, signal)).toString()) as { version?: unknown; activeRequests?: unknown; sources?: unknown };
  if (body.version !== 1 || !Number.isSafeInteger(body.activeRequests) || Number(body.activeRequests) < 0 || !Array.isArray(body.sources)) throw failed('The installed Grunt status could not be verified');
  return { legacy: false, active: Number(body.activeRequests) };
}

/** Refresh the managed backend without rerunning signup or rewriting its unit. */
export async function updateRuntime(options: UpdateOptions = {}): Promise<{ version: string; port: number; backup: string; active: boolean }> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform)) throw failed('Grunt update requires Linux with systemd or macOS with launchd');
  const directory = resolve(options.directory ?? configRoot(env));
  const runtime = join(directory, 'runtime');
  try { await privateDirectory(directory); await privateDirectory(runtime); await access(join(runtime, 'dist/local/main.js'), constants.R_OK); }
  catch { throw failed('No safe installed Grunt runtime was found; run npx usegrunt setup first'); }
  const lease = await beginSetupSession(directory, []);
  const cancellation = new AbortController(), cancel = () => cancellation.abort(failed('Grunt update cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([lease.signal, cancellation.signal, ...(options.signal ? [options.signal] : [])]);
  const run = options.run ?? runCommand, fetcher = options.fetcher ?? fetch;
  const preparationEnv = { ...env };
  // Staging must not execute caller-provided tar hooks or Node preloads. The
  // actual service retains its own unchanged environment and interpreter.
  for (const key of ['TAR_OPTIONS', 'NODE_OPTIONS', 'NODE_PATH']) delete preparationEnv[key];
  const now = options.now ?? Date.now, wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const notify = (message: string) => { try { options.notify?.(message); } catch { /* Progress output must not interrupt a runtime transaction. */ } };
  const migratePi = async (port: number) => {
    try {
      if ((await migrateManagedPiWorkingContext(port, env)).contextChanged) notify('Updated the managed Pi working context');
    } catch {
      // A custom or malformed harness file must not roll back a healthy daemon.
      notify('Grunt updated; Pi working-context migration was skipped. Repair the Pi profile before retrying setup.');
    }
  };
  let temporary: string | undefined, backup: string | undefined, stopped = false, swapped = false;
  let service: Service | undefined;
  let rollbackSelection: (() => Promise<void>) | undefined;
  try {
    signal.throwIfAborted();
    service = await serviceInfo(directory, platform, run, env, signal);
    notify('Fetching the latest Grunt release from npm');
    const download = await latest(fetcher, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
    signal.throwIfAborted();
    temporary = await mkdtemp(join(directory, '.update-'));
    const archive = join(temporary, 'release.tgz'), unpacked = join(temporary, 'unpacked');
    await writeFile(archive, download.archive, { flag: 'wx', mode: 0o600 }); await mkdir(unpacked, { mode: 0o700 });
    const [names, verbose] = await Promise.all([run('tar', ['-tzf', archive], { env: preparationEnv, signal }), run('tar', ['-tvzf', archive], { env: preparationEnv, signal })]);
    vetArchive(names, verbose);
    await run('tar', ['-xzf', archive, '-C', unpacked], { env: preparationEnv, signal });
    const candidate = join(unpacked, 'package'); await chmod(candidate, 0o700);
    const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; type?: unknown; dependencies?: unknown };
    if (manifest.name !== 'usegrunt' || manifest.version !== download.version || manifest.type !== 'module' || !manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) throw failed('The downloaded Grunt package does not match its release metadata');
    if (Object.entries(manifest.dependencies).some(([name, version]) => !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)
      || typeof version !== 'string' || !version.trim() || version.length > 256 || !/^[0-9A-Za-z.*^~<>=| +_-]+$/.test(version))) throw failed('The downloaded Grunt package has an unsupported dependency source');
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'grunt-runtime', version: download.version, private: true, type: 'module', dependencies: manifest.dependencies }), { mode: 0o600 });
    notify(`Preparing Grunt ${download.version}`);
    await run('npm', ['install', '--prefix', candidate, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--registry=https://registry.npmjs.org'], { env: preparationEnv, signal, timeout: 300000 });
    // Import without executing the CLI guard, including older releases where
    // --help could accidentally start another daemon.
    await run(service.node, ['--input-type=module', '-e', 'process.argv[1]="";await import(process.argv[2]);', '-', pathToFileURL(join(candidate, 'dist/local/main.js')).href], { env: preparationEnv, signal });
    const currentService = await serviceInfo(directory, platform, run, env, signal);
    if (currentService.identity !== service.identity || currentService.port !== service.port || currentService.node !== service.node || currentService.active !== service.active
      || currentService.automaticSources?.join(',') !== service.automaticSources?.join(',')) throw failed('The Grunt service changed while preparing the update; retry without changing its configuration');
    const deadline = now() + 180000;
    for (; service.active;) {
      signal.throwIfAborted();
      const state = await status(fetcher, service.port, signal);
      if (!state.active) break;
      if (now() >= deadline) throw failed('Grunt is busy; update again after current requests finish');
      notify('Waiting for active Grunt requests to finish');
      await wait(1000, signal);
    }
    signal.throwIfAborted();
    if (service.active) { notify('Restarting the existing Grunt service'); stopped = true; await service.stop(); }
    signal.throwIfAborted();
    backup = join(directory, `runtime-backup-${randomUUID()}`);
    await rename(runtime, backup);
    try { await rename(candidate, runtime); swapped = true; }
    catch (error) { await rename(backup, runtime); backup = undefined; throw error; }
    signal.throwIfAborted();
    rollbackSelection = await migrateAutomaticPool(directory, service.automaticSources);
    signal.throwIfAborted();
    if (!service.active) {
      notify(`Grunt ${download.version} is installed; the service remains stopped`);
      await migratePi(service.port);
      return { version: download.version, port: service.port, backup, active: false };
    }
    await service.start();
    const readyBy = now() + 30000; let ready = false;
    while (now() < readyBy) {
      signal.throwIfAborted();
      try { if (!(await status(fetcher, service.port, signal)).legacy) { ready = true; break; } } catch { /* Give the existing service manager time to launch. */ }
      await wait(250, signal);
    }
    if (!ready) throw failed('The updated Grunt daemon did not become ready');
    notify(`Grunt ${download.version} is ready on port ${service.port}`);
    await migratePi(service.port);
    return { version: download.version, port: service.port, backup, active: true };
  } catch (error) {
    if (rollbackSelection) await rollbackSelection().catch(() => notify('Automatic source selection cleanup needs attention; restoring the previous runtime'));
    if ((stopped || swapped) && service) {
      try {
        if (stopped) await service.stop();
        if (swapped && backup) { await rename(runtime, join(directory, `runtime-failed-${randomUUID()}`)); await rename(backup, runtime); }
        if (stopped) await service.start();
      } catch { throw failed('Grunt update failed and the previous service could not be restarted; the saved runtime backup was retained'); }
      throw failed('Grunt update failed; the previous runtime and service were restored');
    }
    throw error instanceof Error ? error : failed('Grunt update failed before changing the installed service');
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => { notify('The temporary update download was retained for cleanup'); });
      await lease.close().catch(() => { notify('The completed update lease could not be removed; its owner will expire on exit'); });
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
}
