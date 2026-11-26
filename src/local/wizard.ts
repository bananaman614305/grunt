import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, mkdtemp, rm, access, lstat, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupFallbacks } from './fallback-setup.js';
import { parallelMap } from './parallel.js';
import { withTerminal } from './terminal.js';
import { copyDaemon, daemonFile, legacyDaemonFile } from './daemon-files.js';
import { BrowserSquire, PROVIDERS, providerURL, setup, squireEnvironment } from './setup.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry, disabledAdapters, knownAdapters } from '../registry.js';
import { writeAutomaticPool } from './automatic-pool.js';
import { banner } from './banner.js';
import { approveDataSharing, DATA_SHARING_MANUAL_APPROVAL, DATA_SHARING_OPT_OUT, requiresManualDataSharing } from './data-sharing.js';
import { configurePi, connectHarness, detectHarnesses, HARNESSES, launchLines, listFreeModels, nextDriver, onPath, probeFreeModel, signupHarness, runHarness } from './harnesses.js';
import type { Harness } from './harnesses.js';
import type { SignupAgent } from './signup-mcp.js';
import { beginSetupSession } from './setup-session.js';
import { configRoot, gruntEnv } from '../brand.js';
import { SetupTable } from './setup-table.js';
import { setupFailureReason, signupOperatorUnavailable } from './setup-failure.js';
import { fetchStatus } from './dashboard.js';
import { select, isCancel } from '@clack/prompts';
import { serviceEnvironment } from './service-environment.js';
import { registerWindowsService, startWindowsService, stopWindowsService, taskScheduler, windowsService, writeWindowsLauncher } from './windows-service.js';
import { saveSquireClientPath } from './squire-client-path.js';

export const configDir = (env = process.env) => configRoot(env);
export async function command(binary: string, args: string[], interactive = false, signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
  signal?.throwIfAborted();
  const run = () => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, { stdio: interactive ? 'inherit' : 'ignore', ...(signal ? { signal } : {}), ...(env ? { env } : {}) });
    child.once('error', () => reject(new Error(`Could not run ${binary}`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} failed; inspect its service status before retrying`)));
  });
  await (interactive ? withTerminal(run) : run());
}
export async function squireBrokerExists() {
  const service = process.platform === 'darwin'
    ? ['launchctl', ['print', `gui/${process.getuid!()}/ai.trustysquire.trusty-squire-broker`]] as const
    : ['systemctl', ['--user', 'is-active', 'trusty-squire-broker']] as const;
  if (process.platform !== 'win32') {
    try { await promisify(execFile)(service[0], [...service[1]], { timeout: 10000 }); return true; }
    catch { /* An inactive service can still own the broker installation. */ }
  }
  if (process.platform === 'linux') {
    try {
      const { stdout } = await promisify(execFile)('systemctl', ['--user', 'list-unit-files', 'trusty-squire-broker*.service', '--no-legend', '--no-pager'], { timeout: 10000 });
      if (/^trusty-squire-broker\S*\.service\s/m.test(stdout)) return true;
    } catch { /* Socket discovery remains available without a service manager. */ }
  }
  const home = homedir();
  const serviceFile = process.platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', 'ai.trustysquire.trusty-squire-broker.plist')
    : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', 'trusty-squire-broker.service');
  try { await access(serviceFile); return true; } catch { /* Check socket discovery too. */ }
  const discovery = join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bot/broker/discovery.js');
  const program = `const {brokerSocketPath} = await import(${JSON.stringify(pathToFileURL(discovery).href)}); const {existsSync} = await import('node:fs'); process.stdout.write(existsSync(brokerSocketPath()) ? 'present' : 'missing');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { env: squireEnvironment(), timeout: 10000 });
  return result.stdout === 'present';
}
async function squireBootstrapEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  signal?.throwIfAborted();
  const directory = configDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !hasOwnerMode(parent, 0o700)) {
    throw new Error('Squire setup requires a private grunt configuration directory');
  }
  const path = join(directory, 'squire-opencode.json');
  const file = await openPrivateFile(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600) || stat.size > 262144) {
      throw new Error('Squire setup requires a private grunt-owned client configuration file');
    }
    signal?.throwIfAborted();
    if (!stat.size) await file.writeFile('{}\n');
  } finally { await file.close(); }
  signal?.throwIfAborted();
  // The supported Squire override applies only to this installer child. It
  // must never rewrite the user's OpenCode config or a provider grant config.
  return { ...process.env, OPENCODE_CONFIG: path };
}
export async function connectSquire(options: { hasBroker?: () => Promise<boolean>; run?: typeof command; installer?: string; squire?: BrowserSquire; signal?: AbortSignal } = {}) {
  const probe = async () => {
    options.signal?.throwIfAborted();
    const squire = options.squire ?? new BrowserSquire(options.signal ? { signal: options.signal } : {});
    try { await squire.connect(); options.signal?.throwIfAborted(); }
    finally { if (!options.squire) await squire.close(); }
  };
  try { await probe(); return 'existing' as const; }
  catch (error) {
    options.signal?.throwIfAborted();
    const exists = await (options.hasBroker || squireBrokerExists)();
    options.signal?.throwIfAborted();
    if (exists) {
      throw new Error(`Existing trusty-squire-broker failed its connection probe: ${error instanceof Error ? error.message : String(error)}. Repair the broker, then rerun usegrunt setup.`, { cause: error });
    }
  }
  if (gruntEnv('SETUP_NO_HUMAN') === '1') throw new Error('Squire login needs human verification; stopped before onboarding');
  // Only a machine without a broker may enter the installer.
  const bin = options.installer || join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
  const env = await squireBootstrapEnvironment(options.signal);
  options.signal?.throwIfAborted();
  await (options.run || command)(process.execPath, [bin, 'connect', '--target=opencode', '--json'], false, options.signal, env);
  await probe();
  return 'installed' as const;
}
export async function preflight(run = command) {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || major >= 25 || (major === 22 && minor < 13)) throw new Error('Install an up-to-date Node.js 22 or 24 LTS, then run npx usegrunt setup.');
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new Error('Run setup on Linux with systemd, macOS with launchd, or Windows with Task Scheduler.');
  if (gruntEnv('ROUTER_RUNTIME') === 'docker') {
    try { await run('docker', ['info']); } catch { throw new Error('Install and start Docker Desktop, then run npx usegrunt setup.'); }
  }
  try {
    if (process.platform === 'linux') await run('systemctl', ['--user', 'show-environment']);
    else if (process.platform === 'darwin') await run('launchctl', ['print', `gui/${process.getuid!()}`]);
    else await run(taskScheduler, ['/query']);
  } catch { throw new Error('Sign in to a user session with a working service manager, then run npx usegrunt setup.'); }
}
const systemdQuote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\n', '\\n') + '"';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// Without lingering, the systemd user manager and its services stop at logout
// and start again only at the next login, not at boot.
async function enableLinger(signal?: AbortSignal) {
  try { await command('loginctl', ['--no-ask-password', 'enable-linger'], false, signal); }
  catch {
    signal?.throwIfAborted();
    console.log('– local service: stops at logout until lingering is enabled; run loginctl enable-linger');
  }
}
export async function installedSources(directory = configDir()) {
  try {
    const sources: unknown = JSON.parse(await readFile(join(directory, 'installed-sources.json'), 'utf8'));
    if (!Array.isArray(sources) || sources.some(id => typeof id !== 'string' || ![...knownAdapters, 'freellmapi'].includes(id))) throw new Error('Invalid saved grunt sources');
    return [...new Set(sources)].filter(id => !disabledAdapters.has(id)).join(',');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await access(join(directory, 'router-admin.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'opencode,kilo,zro';
  }
  return 'freellmapi,kilo,opencode,zro';
}
export async function installService(adapters?: string[], options: { signal?: AbortSignal } = {}) {
  const stage = async <T>(operation: () => Promise<T>) => {
    options.signal?.throwIfAborted();
    const result = await operation();
    options.signal?.throwIfAborted();
    return result;
  };
  options.signal?.throwIfAborted();
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new Error('grunt background service requires systemd, launchd, or Task Scheduler');
  const selected = [...new Set(adapters ?? (await stage(() => installedSources())).split(','))].filter(id => id && !disabledAdapters.has(id));
  if (selected.some(id => !knownAdapters.has(id) && id !== 'freellmapi')) throw new Error('Invalid grunt service selection');
  const directory = resolve(configDir()), runtime = join(directory, 'runtime');
  // npx cache entries can disappear. Keep a backend runtime outside that cache.
  const dist = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : '../', import.meta.url));
  const port = gruntEnv('PORT') || '8788';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid grunt service port');
  await stage(() => mkdir(runtime, { recursive: true, mode: 0o700 }));
  const info = await stage(() => lstat(runtime));
  if (!info.isDirectory() || !hasOwnerMode(info, 0o700)) throw new Error('Grunt setup requires a private runtime directory');
  await stage(() => copyDaemon(dist, runtime, options.signal));
  const entry = join(runtime, daemonFile);
  const env: Record<string, string> = { GRUNT_DAEMON: '1', GRUNT_CONFIG_DIR: directory, GRUNT_PORT: port, GRUNT_SOURCES: selected.join(',') };
  if (process.platform !== 'win32') env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  else if (process.env.PATH) env.PATH = process.env.PATH;
  await stage(() => saveSquireClientPath(directory));
  const routerURL = gruntEnv('FREELLMAPI_URL');
  if (routerURL) env.GRUNT_FREELLMAPI_URL = routerURL;
  const opencodeConfig = join(directory, 'opencode-free.json');
  try { await stage(() => readFile(opencodeConfig)); env.OPENCODE_CONFIG = opencodeConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const effectivePort = await stage(() => installBackgroundService('grunt', entry, env, { ...options, automaticPool: true, selectedSources: selected })) ?? port;
  await stage(() => writeFile(join(directory, 'installed-sources.json'), JSON.stringify(selected), { mode: 0o600 }));
  const portStage = join(directory, `.installed-port-${randomUUID()}`);
  try {
    await stage(() => writeFile(portStage, JSON.stringify(Number(effectivePort)), { flag: 'wx', mode: 0o600 }));
    await stage(() => rename(portStage, join(directory, 'installed-port.json')));
  } finally { await rm(portStage, { force: true }); }
}
export async function installBackgroundService(name: string, entry: string, env: Record<string, string>, options: { signal?: AbortSignal; automaticPool?: boolean; selectedSources?: readonly string[] } = {}) {
  const stage = async <T>(operation: () => Promise<T>) => {
    options.signal?.throwIfAborted();
    const result = await operation();
    options.signal?.throwIfAborted();
    return result;
  };
  const run = (binary: string, args: string[]) => stage(() => command(binary, args, false, options.signal));
  options.signal?.throwIfAborted();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid service name');
  if (process.platform === 'win32') {
    const directory = env.GRUNT_CONFIG_DIR;
    if (name !== 'grunt' || !directory || entry !== join(directory, 'runtime', daemonFile)) throw new Error('Windows Task Scheduler requires the managed Grunt daemon');
    const scheduledCommand = (binary: string, args: string[]) => stage(() => promisify(execFile)(binary, args, { timeout: 10000, ...(options.signal ? { signal: options.signal } : {}) })).then(result => result.stdout);
    const existing = await windowsService(directory, scheduledCommand);
    const effective = existing?.environment ?? env;
    const port = effective.GRUNT_PORT;
    if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Could not determine the installed Grunt port safely');
    if (options.automaticPool && effective.GRUNT_SOURCES) await stage(() => writeAutomaticPool(directory, [...new Set(effective.GRUNT_SOURCES!.split(','))], options.selectedSources));
    if (existing) {
      if (existing.state === 1) throw new Error('Enable the installed Grunt task in Task Scheduler, then rerun setup');
      await stopWindowsService(directory, scheduledCommand);
    } else {
      await stage(() => writeWindowsLauncher(join(directory, 'runtime'), env));
      await registerWindowsService(directory, scheduledCommand);
    }
    await startWindowsService(directory, scheduledCommand);
    return port;
  }
  // Existing service files can contain custom ports, endpoints and drop-ins.
  // Keep either installed identity and its configuration intact on reruns.
  const legacy = name === 'grunt' ? 'milo' : name === 'grunt-router' ? 'milo-router' : undefined;
  if (legacy) {
    const existing: { identity: string; file: string; contents: string; mode: number }[] = [];
    for (const identity of [name, legacy]) {
      const file = process.platform === 'linux'
        ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${identity}.service`)
        : join(homedir(), 'Library', 'LaunchAgents', `ai.${identity}.service.plist`);
      try {
        const info = await stage(() => lstat(file));
        if (!info.isFile() || info.isSymbolicLink() || !hasOwnerMode(info, 0, 0o022) || info.size > 262144) throw new Error('The existing Grunt service file is unsafe');
        existing.push({ identity, file, mode: info.mode & 0o777, contents: await stage(() => readFile(file, 'utf8')) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (existing.length > 1) throw new Error('Multiple Grunt service identities are installed; resolve the duplicate before setup');
    const installedService = existing[0];
    if (installedService) {
      const { identity, file, contents, mode } = installedService;
      const linux = process.platform === 'linux';
      const argument = linux ? systemdQuote(entry) : `<string>${xml(entry)}</string>`;
      let next = contents;
      if (!contents.includes(argument)) {
        const previous = join(dirname(entry), legacyDaemonFile);
        if (name === 'grunt' && linux) {
          const previousArgument = systemdQuote(previous);
          next = contents.replace(/^ExecStart=.*$/m, line => line.replace(previousArgument, () => argument));
        } else if (name === 'grunt') {
          next = contents.replace(`<string>${xml(previous)}</string>`, () => argument);
        }
        if (next === contents) throw new Error('The existing Grunt service uses a different runtime; its configuration was not changed');
      }
      let port: string | undefined, serviceSources: string[] | undefined;
      if (name === 'grunt') {
        if (process.platform === 'linux') {
          const result = await stage(() => promisify(execFile)('systemctl', ['--user', 'show', `${identity}.service`, '-p', 'Environment', '--value'], { timeout: 10000, ...(options.signal ? { signal: options.signal } : {}) }));
          const installed = serviceEnvironment(result.stdout);
          if (gruntEnv('CONFIG_DIR', installed) !== env.GRUNT_CONFIG_DIR) throw new Error('The existing Grunt service uses a different configuration directory; its configuration was not changed');
          port = gruntEnv('PORT', installed);
          serviceSources = gruntEnv('SOURCES', installed)?.split(',').map(id => id.trim()).filter(Boolean);
        } else {
          const value = async (setting: string) => stage(() => promisify(execFile)('plutil', ['-extract', `EnvironmentVariables.${setting}`, 'raw', '-o', '-', file], { timeout: 10000, ...(options.signal ? { signal: options.signal } : {}) })).then(result => result.stdout.replace(/\r?\n$/, ''));
          const directory = await value('GRUNT_CONFIG_DIR').catch(() => value('MILO_CONFIG_DIR'));
          if (directory !== env.GRUNT_CONFIG_DIR) throw new Error('The existing Grunt service uses a different configuration directory; its configuration was not changed');
          port = await value('GRUNT_PORT').catch(() => value('MILO_PORT'));
          serviceSources = (await value('GRUNT_SOURCES').catch(() => value('MILO_SOURCES')).catch(() => ''))?.split(',').map(id => id.trim()).filter(Boolean);
        }
        if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Could not determine the installed Grunt port safely');
      }
      if (name === 'grunt' && options.automaticPool && serviceSources?.length) await stage(() => writeAutomaticPool(env.GRUNT_CONFIG_DIR!, [...new Set(serviceSources)], options.selectedSources));
      if (next !== contents) {
        const temporary = file + '-' + randomUUID();
        try {
          await stage(() => writeFile(temporary, next, { mode, flag: 'wx' }));
          await stage(() => rename(temporary, file));
        } finally { await rm(temporary, { force: true }); }
        if (linux) await run('systemctl', ['--user', 'daemon-reload']);
      }
      if (process.platform === 'linux') {
        await run('systemctl', ['--user', 'enable', `${identity}.service`]);
        await stage(() => enableLinger(options.signal));
        await run('systemctl', ['--user', 'restart', `${identity}.service`]);
      } else {
        const domain = `gui/${process.getuid!()}`;
        await run('launchctl', ['bootout', `${domain}/ai.${identity}.service`]).catch(() => {});
        options.signal?.throwIfAborted();
        await run('launchctl', ['bootstrap', domain, file]);
      }
      return port;
    }
  }
  const declaredSources = env.GRUNT_SOURCES;
  if (name === 'grunt' && options.automaticPool && declaredSources) await stage(() => writeAutomaticPool(env.GRUNT_CONFIG_DIR!, declaredSources.split(','), options.selectedSources));
  if (process.platform === 'linux') {
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    await stage(() => mkdir(units, { recursive: true }));
    await stage(() => writeFile(join(units, `${name}.service`), `[Unit]\nDescription=grunt model service\nAfter=network-online.target\n\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(entry)}\n${Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 }));
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', `${name}.service`]);
    await stage(() => enableLinger(options.signal));
    await run('systemctl', ['--user', 'restart', `${name}.service`]);
  } else {
    const agents = join(homedir(), 'Library', 'LaunchAgents');
    await stage(() => mkdir(agents, { recursive: true }));
    const plist = join(agents, `ai.${name}.service.plist`), domain = `gui/${process.getuid!()}`;
    await stage(() => writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.${name}.service</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>`, { mode: 0o600 }));
    await run('launchctl', ['bootout', `${domain}/ai.${name}.service`]).catch(() => {});
    await run('launchctl', ['bootstrap', domain, plist]);
  }
  return env.GRUNT_PORT;
}
// /v1/models asks every source whether it is available. Bound the combined probe
// so a hung native CLI cannot leave the installer waiting forever.
const SERVICE_PROBE_TIMEOUT_MS = 35000;
export async function checkService(port = 8788, totalMs = 90000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const timeout = Math.max(1, Math.min(SERVICE_PROBE_TIMEOUT_MS, deadline - Date.now()));
    try { const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(timeout) }); if (response.ok) return; } catch { /* Wait for the service manager. */ }
    await delay(Math.max(0, Math.min(1000, deadline - Date.now())));
  }
  throw new Error('grunt service did not start; inspect its service status');
}
type Systemctl = (args: string[]) => Promise<string>;
const systemctl: Systemctl = async args => (await promisify(execFile)('systemctl', ['--user', ...args], { timeout: 10000 })).stdout;
// Read the effective primary or compatibility source setting and its origin.
export async function serviceSources(run: Systemctl = systemctl, name?: string): Promise<{ sources: string[]; origin: string; variable: string } | undefined> {
  if (run === systemctl && process.platform !== 'linux') return;
  if (!name) {
    for (const identity of ['grunt', 'milo']) { const unit = await serviceSources(run, identity); if (unit) return unit; }
    return;
  }
  let environment: string, dropIns: string;
  try { [environment, dropIns] = await Promise.all(['Environment', 'DropInPaths'].map(property => run(['show', `${name}.service`, '-p', property, '--value']))) as [string, string]; }
  catch { return; }
  const effective = serviceEnvironment(environment), variable = effective.GRUNT_SOURCES !== undefined ? 'GRUNT_SOURCES' : 'MILO_SOURCES';
  const value = effective[variable];
  if (value === undefined) return;
  let origin = `${name}.service`;
  for (const path of dropIns.trim().split(/\s+/).filter(Boolean)) {
    try { if (new RegExp(`^\\s*Environment=.*${variable}=`,'m').test(await readFile(path, 'utf8'))) origin = path; }
    catch { /* An unreadable drop-in cannot be named. */ }
  }
  return { sources: value.split(',').map(id => id.trim()), origin, variable };
}
async function setupPort() {
  try {
    const saved: unknown = JSON.parse(await readFile(join(configDir(), 'installed-port.json'), 'utf8'));
    if (typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 && saved <= 65535) return saved;
  } catch { /* A new installation uses its requested port until service admission. */ }
  return Number(gruntEnv('PORT') || '8788');
}
export async function checkServiceSources(unavailable: string[], notify = console.log, adapters = ['opencode'], read = serviceSources) {
  const unit = await read();
  if (!unit) return;
  for (const id of adapters) {
    if (unit.sources.includes(id)) continue;
    if (!unavailable.includes(id)) unavailable.push(id);
    notify(`${id}: FAIL — ${unit.origin} sets ${unit.variable}=${unit.sources.join(',')}, which lacks ${id}. Setup does not edit it; add ${id} there or remove that setting.`);
  }
}
export async function checkFallbackServices(unavailable: string[], port = 8788, notify = console.log, adapters = ['opencode'], wait: { limit: number; interval: number; signal?: AbortSignal; retryPreparing?: boolean } = { limit: 180000, interval: 2000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-free-check-'));
  try {
    for (const source of adapters) {
      wait.signal?.throwIfAborted();
      if (unavailable.includes(source)) { notify(`${source}: FAIL — setup incomplete`); continue; }
      const deadline = Date.now() + wait.limit;
      let failure: string | undefined, waiting = false;
      for (let attempt = 1; ; attempt++) {
        wait.signal?.throwIfAborted();
        let preparing = false;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(['goedel', 'freepi'].includes(source) ? { 'X-Grunt-Context': 'public' } : {}) },
            body: JSON.stringify({ model: source, cwd: directory, messages: [{ role: 'user', content: `Reply only: grunt is ready (${source}). Do not use tools or change files. Check ${attempt}.` }], stream: false, max_tokens: 256 }),
            signal: AbortSignal.any([AbortSignal.timeout(120000), ...(wait.signal ? [wait.signal] : [])])
          });
          preparing = response.headers.get('x-grunt-preparing')?.split(',').includes(source) ?? false;
          const answered = response.headers.get('x-grunt-source');
          const result = await response.json().catch(() => ({})) as { error?: { code?: string }; choices?: { message?: { content?: string } }[] };
          if (!response.ok) failure = result.error?.code === 'quota' || response.status === 429 ? 'quota exhausted' : `grunt returned HTTP ${response.status}`;
          else if (answered !== source) failure = `${answered ?? 'an unnamed source'} answered instead of ${source}`;
          else if (!result.choices?.[0]?.message?.content?.trim()) failure = 'no text returned';
          else failure = undefined;
        } catch { failure = 'grunt did not answer'; }
        // Retry only while grunt still runs this adapter's background setup. Each attempt
        // is a new prompt, so the router does not keep a fallback source from an earlier try.
        if (!failure || wait.retryPreparing === false || !preparing || Date.now() + wait.interval > deadline) break;
        if (!waiting) { waiting = true; notify(`${source}: grunt is still preparing this adapter; waiting`); }
        await delay(wait.interval, undefined, wait.signal ? { signal: wait.signal } : {});
      }
      if (failure) { unavailable.push(source); notify(`${source}: FAIL — ${failure}`); }
      else notify(`${source}: PASS — ${source} answered through the grunt service`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export { configurePi };
export type RegistryOrigin = 'remote' | 'cache' | 'bundled';
// Same URL and validation as the daemon's RegistrySync; says where the list came from.
export async function loadRegistry(options: { url?: string; fetcher?: typeof fetch } = {}) {
  let offline = false, cached = false;
  const registry = new RegistrySync({ directory: configDir(), ...options, notify: () => { offline = true; } });
  try {
    await registry.load();
    cached = registry.current.published !== bundledRegistry.published || JSON.stringify(registry.current) !== JSON.stringify(bundledRegistry);
    await registry.sync();
    return { registry: registry.current, origin: (offline ? cached ? 'cache' : 'bundled' : 'remote') as RegistryOrigin };
  } finally { await registry.close(); }
}
export async function chooseSetupHarness(): Promise<Harness | undefined> {
  const installed = await detectHarnesses();
  if (!process.stdin.isTTY || gruntEnv('SETUP_NO_HUMAN') === '1') return installed[0];
  const missingPi = !installed.some(tool => tool.id === 'pi');
  const selected = await withTerminal(() => select({
    message: 'Choose a coding harness for setup',
    options: [
      ...installed.map(tool => ({ value: tool.id as string, label: tool.name })),
      ...(missingPi ? [{ value: 'install-pi', label: 'Install Pi' }] : []),
      { value: 'jev', label: 'Use Squire alone' }
    ]
  }));
  if (isCancel(selected)) throw new Error('Setup cancelled');
  if (selected === 'install-pi') {
    await command('npm', ['install', '--global', '@earendil-works/pi-coding-agent']);
    return HARNESSES.find(tool => tool.id === 'pi');
  }
  return installed.find(tool => tool.id === selected);
}
// A text reply can pass on a source that cannot drive an MCP tool. Require
// an actual, correctly formed tool call from the exact newly admitted source.
// Fixed probe outcomes. Model text and upstream bodies are never copied.
export class OperatorProbeFailure extends Error {}
// Resolves true when the source answers the tool-call probe itself; throws
// with the reason otherwise, so setup can say why a source cannot drive.
export async function probeSetupOperator(port: number, source: string, signal: AbortSignal) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(['goedel', 'freepi'].includes(source) ? { 'X-Grunt-Context': 'public' } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    body: JSON.stringify({ model: source, max_tokens: 256, messages: [
      { role: 'user', content: `Call the setup_ready tool once with no arguments. Check ${randomUUID()}.` }
    ], tools: [{ type: 'function', function: { name: 'setup_ready', parameters: { type: 'object', properties: {}, additionalProperties: false } } }] })
  });
  if (response.status === 429) throw new OperatorProbeFailure('quota exhausted');
  if (!response.ok) throw new OperatorProbeFailure(`tool-call probe returned HTTP ${response.status}`);
  const answered = response.headers.get('x-grunt-source');
  if (answered !== source) throw new OperatorProbeFailure(`tool-call probe was answered by ${answered && /^[a-z0-9-]{1,40}$/.test(answered) ? answered : 'another source'}`);
  const result = await response.json() as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
  const calls = result.choices?.[0]?.message?.tool_calls;
  if (calls?.length === 1 && calls[0]?.function?.name === 'setup_ready' && /^\{\s*\}$/.test(calls[0].function.arguments ?? '')) return true;
  throw new OperatorProbeFailure(calls?.length ? 'model made the wrong tool call' : 'model answered without a tool call');
}
// One real completion through model grunt: the router picks the route, as it
// will for the person's own requests. Fixed outcomes; model text is never copied.
export async function smokeTest(port: number, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-smoke-'));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: 'grunt', cwd: directory, stream: false, max_tokens: 256,
        messages: [{ role: 'user', content: `Reply only: grunt is ready. Do not use tools or change files. Check ${randomUUID()}.` }] })
    });
    if (response.status === 429) throw new Error('quota exhausted');
    if (!response.ok) throw new Error(`grunt returned HTTP ${response.status}`);
    const result = await response.json().catch(() => ({})) as { choices?: { message?: { content?: string } }[] };
    if (!result.choices?.[0]?.message?.content?.trim()) throw new Error('grunt printed no answer');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
// The daemon re-reads the setup session on every request. One status read after
// setup releases it starts the daemon's route pass for the remaining signups.
export async function resumeBackground(port: number) {
  await fetchStatus({ port }).catch(() => {});
}
type HarnessOptions = { harnesses?: Harness[]; choose?: (found: Harness[]) => Promise<Harness[]>; run?: typeof runHarness; table?: SetupTable };
type HarnessPlan = (() => Promise<Harness[]>) & { discoverLater?: true };
export async function prepareHarnesses(port: number, options: HarnessOptions = {}): Promise<HarnessPlan> {
  const found = await detectHarnesses(options.harnesses);
  if (!found.length) return Object.assign(async () => [] as Harness[], { discoverLater: true as const });
  const table = options.table ?? new SetupTable();
  for (const harness of found) table.set('tool', harness.name, 'connecting');
  return async () => {
    const connected: Harness[] = [];
    for (const harness of found) {
      try {
        await connectHarness(harness, port, options.run);
        table.set('tool', harness.name, '✓ connected');
        connected.push(harness);
      } catch (error) {
        table.set('tool', harness.name, `✗ connection failed (${setupFailureReason(error)})`);
      }
    }
    return connected;
  };
}
export async function connectHarnesses(port: number, options: HarnessOptions = {}) {
  return (await prepareHarnesses(port, options))();
}
const wizardActions = { smokeTest, resumeBackground, probeOperator: probeSetupOperator, chooseHarness: chooseSetupHarness, connectHarness, signupHarness, listFreeModels, installedSources, createSquire: () => new BrowserSquire(), banner, preflight, connectSquire, setup, setupFallbacks, installService, configurePi, checkService, checkFallbackServices, loadRegistry, checkServiceSources, connectHarnesses, prepareHarnesses, approveDataSharing };
type Optional = 'probeOperator' | 'chooseHarness' | 'connectHarness' | 'signupHarness' | 'listFreeModels' | 'installedSources' | 'createSquire' | 'banner' | 'loadRegistry' | 'checkServiceSources' | 'connectHarnesses' | 'prepareHarnesses' | 'configurePi' | 'approveDataSharing';
export async function wizard(add?: string, actions: Omit<typeof wizardActions, Optional> & Partial<Pick<typeof wizardActions, Optional>> = wizardActions) {
  if (add === '') throw new Error('Specify a provider name or base URL');
  if (add && disabledAdapters.has(add)) throw new Error(`${add} routing is disabled`);
  if (add && !providerURL(add) && !Object.hasOwn(PROVIDERS, add)) throw new Error(`Choose a supported provider: ${Object.keys(PROVIDERS).join(', ')}, or paste an OpenAI-compatible base URL`);
  // Preliminary steps print as plain lines. The table appears once, for the
  // signups, and stays in place until setup ends.
  const table = new SetupTable(process.stdout, { live: false });
  const squire = actions.createSquire?.();
  let session: Awaited<ReturnType<typeof beginSetupSession>> | undefined;
  let connection: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const closeSquire = () => closing ??= (async () => { await squire?.close(); })();
  const abortSetup = () => { void closeSquire().catch(() => {}); };
  const connectState = () => connection ??= actions.connectSquire({ ...(squire ? { squire } : {}), ...(session ? { signal: session.signal } : {}) });
  const connect = async () => { await connectState(); };
  // The setup table prints only the classified outcome for each provider.
  const notify = (_line: string) => {};
  try {
    await actions.banner?.();
    await actions.preflight();
    const revised = !add && Boolean(actions.chooseHarness);
    if (revised) squire?.useBatchSignup();
    const harness = revised ? await actions.chooseHarness?.() : undefined;
    // Keys pressed from here on are ignored rather than echoed into the output.
    table.captureKeys();
    if (revised) console.log(harness ? `✓ harness: ${harness.id}` : '… harness: Squire alone');
    const previous = ((await actions.installedSources?.())?.split(',') ?? []).filter(id => id && !disabledAdapters.has(id));
    const { registry } = actions.loadRegistry ? await actions.loadRegistry() : { registry: bundledRegistry };
    squire?.useRegistry?.(() => registry);
    const requested = add ? [add] : registry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)).map(adapter => adapter.id);
    const defaults = bundledRegistry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)).map(adapter => adapter.id);
    const sources = add ? knownAdapters.has(add) || add === 'nvidia'
      ? [...new Set([...(previous.length ? previous : defaults), add])]
      : [...new Set(['freellmapi', ...previous, ...defaults])] : requested;
    let sharingNotice: string | undefined;
    const consent = await (actions.approveDataSharing ?? approveDataSharing)({ directory: configDir(), providers: [...new Set([...sources, 'opencode'])], notice: line => { sharingNotice = line; } });
    const manualOff = consent.skipped.filter(requiresManualDataSharing);
    console.log(consent.skipped.length ? `– data sharing: off for ${consent.skipped.join(', ')} (${manualOff.length ? `${DATA_SHARING_MANUAL_APPROVAL}=${manualOff.join(',')} approves after you read its notice` : DATA_SHARING_OPT_OUT})`
      : sharingNotice ? `✓ ${sharingNotice.replace(/^Data sharing on: /, 'data sharing: on for ')}` : '✓ data sharing: on, no new sources');
    squire?.approveDataSharing?.(consent.approved);
    const skipped = new Set(consent.skipped);
    const ids = requested.filter(id => !skipped.has(id));
    for (const id of requested) if (skipped.has(id)) table.set('source', id, 'off (data sharing not approved)');
    // Sources queue behind setup workers (one at a time with a harness), so a
    // row says waiting until its own setup starts.
    for (const id of ids) table.set('source', id, 'waiting');
    if (!ids.length) return;
    const port = await setupPort();
    if (add) {
      table.set('source', add, 'connecting');
      if (!['nous', 'reflection-beam', 'antseed-vikey'].includes(add)) { await connect(); console.log('✓ Trusty Squire: signed in'); }
      table.start();
      try {
        await actions.setup(notify, [add], { ...(squire ? { squire } : {}), dataSharingApproved: consent.approved,
          ...(add === 'beatapi' ? { upgradeBeatAPI: true } : {}) });
        await actions.installService(sources.filter(id => !skipped.has(id)));
        await actions.checkService(port);
        const unavailable: string[] = [];
        await actions.checkFallbackServices(unavailable, port, notify, [add]);
        table.set('source', add, unavailable.includes(add) ? 'skipped (key test failed)' : '✓ ready');
      } catch (error) { table.set('source', add, `skipped (${squire?.signupFailure(add) ?? setupFailureReason(error)})`); throw error; }
      table.finish();
      console.log('Ready');
      return;
    }
    const plan = revised ? undefined : await actions.prepareHarnesses?.(port, { table });
    const applyHarnesses = plan ?? (async () => {
      if (actions.connectHarnesses) await actions.connectHarnesses(port, { table });
      else await actions.configurePi?.(port);
    });
    const pool = [...new Set([...previous.filter(id => id === 'freellmapi'), ...ids])];
    const skipAnonymous = gruntEnv('SETUP_NO_ANONYMOUS') === '1';
    session = await beginSetupSession(configDir(), revised ? pool : ids, { anonymousKilo: revised && !skipAnonymous });
    session.signal.addEventListener('abort', abortSetup, { once: true });
    session.signal.throwIfAborted();
    await actions.installService(pool, { signal: session.signal });
    await actions.checkService(port);
    console.log(`✓ local service: running on port ${port}`);
    const unavailable: string[] = [];
    let activeChecks = 0;
    const queuedChecks: (() => void)[] = [];
    const check = async (task: () => Promise<void>) => {
      if (activeChecks < 3) activeChecks++;
      else await new Promise<void>(resolve => queuedChecks.push(resolve));
      try { await task(); }
      finally { const next = queuedChecks.shift(); if (next) next(); else activeChecks--; }
    };
    const settled = new Map<string, Promise<void>>();
    let firstReady: Promise<Harness[] | void> | undefined;
    // Harnesses setup configured and checked: each gets its opt-in launch line before Ready.
    const configured = new Map<string, Harness>();
    let readyCount = 0;
    let harnessReady = false;
    // Foreground setup ends at the first ready route that also answers a real
    // request through model grunt. The daemon's route pass opens the rest.
    let smoked = false, passes = 0, smokedAt = 0;
    const smoke = async () => {
      if (smoked || !readyCount || passes <= smokedAt) return smoked;
      smokedAt = passes;
      try {
        await actions.smokeTest(port, session!.signal);
        smoked = true;
        table.step('✓ smoke test: grunt answered');
      } catch (error) {
        session!.signal.throwIfAborted();
        table.step(`… smoke test: ${setupFailureReason(error)}; continuing setup`);
      }
      return smoked;
    };
    const onSettled = (id: string, available: boolean, reason?: string): Promise<void> => {
      if (!ids.includes(id)) return Promise.reject(new Error('Unexpected provider setup result'));
      const existing = settled.get(id);
      if (existing) return existing;
      const task = (async () => {
        let passed = false;
        if (available) {
          try {
            await check(async () => {
              session!.signal.throwIfAborted();
              await session!.verify(id);
              await actions.checkServiceSources?.(unavailable, notify, [id]);
              if (!unavailable.includes(id)) await actions.checkFallbackServices(unavailable, port, line => { if (line.endsWith('FAIL — quota exhausted')) reason = 'quota exhausted'; }, [id], { limit: 180000, interval: 2000, signal: session!.signal, retryPreparing: false });
              session!.signal.throwIfAborted();
              passed = !unavailable.includes(id);
            });
          } catch { passed = false; }
        }
        if (passed) {
          await session!.release(id);
          readyCount++;
          passes++;
          table.set('source', id, '✓ ready');
          if (!revised) {
            firstReady ??= applyHarnesses();
            await firstReady;
          }
        } else {
          if (!unavailable.includes(id)) unavailable.push(id);
          await session!.hold(id);
          const why = reason ?? (available ? 'key test failed' : 'setup failed');
          table.set('source', id, `skipped (${why})`);
        }
      })();
      settled.set(id, task);
      return task;
    };
    squire?.onBrowserQueue?.((id, state) => {
      if (ids.includes(id) && !settled.has(id)) table.set('source', id, state === 'waiting' ? 'waiting' : 'connecting');
    });
    const provision = async (adapters: string[], kiloAccount = false) => {
      const outcome = await actions.setupFallbacks({ directory: configDir(), run: command, adapters, notify, onSettled, connect,
        onStarted: (id: string) => { if (!settled.has(id)) table.set('source', id, 'connecting'); },
        signal: session!.signal, dataSharingApproved: consent.approved, ...(squire ? { squire } : {}), ...(kiloAccount ? { kiloAccount } : {}) });
      await parallelMap(adapters, id => onSettled(id, !outcome.unavailable.includes(id)));
    };
    if (!revised) { table.start(); await provision(ids); }
    else {
      // Anonymous OpenCode first: it needs no signup, so its row shows what the
      // free-model check already knows. In this loop Kilo is an account signup.
      const ordered = ['opencode', 'kilo', 'pollinations', 'beatapi', 'zro', 'tokenharbor', 'runcrate', ...ids];
      const remaining = [...new Set(ordered)].filter(id => ids.includes(id));
      let driving = false;
      // Anonymous OpenCode drives only until an account route can: it bypasses
      // grunt routing, so it would never move to a better route by itself.
      let anonymousDriver = false;
      let operator: string | undefined;
      let operatorFailure: string | undefined;
      const deferred: string[] = [];
      const configure = () => (actions.connectHarness ?? connectHarness)(harness!, port,
        (binary, args, env) => runHarness(binary, args, env, 45000, { signal: session!.signal }));
      // OpenCode runs its own tools, so the router cannot reach it from another
      // harness. It and Pi's own providers drive through their own CLIs on free
      // models, whichever harness was chosen. The first that answers drives; the
      // rest follow it in order when it cannot run (docs/router.md).
      let freeAgent: SignupAgent | undefined;
      let freeLabel = '';
      const freeDriver = async () => {
        if (!harness || skipAnonymous) return false;
        if (freeAgent) return true;
        const reach = { openCode: consent.approved.includes('opencode') && await onPath('opencode'), pi: await onPath('pi') };
        if (!reach.openCode && !reach.pi) return false;
        const models = await (actions.listFreeModels ?? listFreeModels)(reach, undefined, session!.signal);
        for (const [index, model] of models.entries()) {
          try { await probeFreeModel(model, session!.signal); }
          catch { session!.signal.throwIfAborted(); continue; }
          const [first, ...rest] = models.slice(index).map(each => (actions.signupHarness ?? signupHarness)(HARNESSES.find(item => item.id === each.harness)!, port, undefined, each.model));
          freeAgent = nextDriver(first!, ...rest);
          freeLabel = model.model;
          return true;
        }
        return false;
      };
      const useOperator = (free = false) => {
        const agent = free ? freeAgent! : (actions.signupHarness ?? signupHarness)(harness!, port);
        squire?.useSignupAgent(async input => {
          try { await agent(input); }
          catch (error) {
            const reason = setupFailureReason(error);
            if (signupOperatorUnavailable(reason)) {
              operatorFailure = reason;
              if (free) freeAgent = undefined;
            }
            throw error;
          }
        });
      };
      const useFree = () => {
        useOperator(true);
        driving = Boolean(squire);
        anonymousDriver = driving;
        table.step(`✓ model: ${freeLabel} (free)`);
      };
      const activate = async (source: string, bootstrap: boolean) => {
        if (!harness || !squire || unavailable.includes(source)) return false;
        try {
          if (!await (actions.probeOperator ?? probeSetupOperator)(port, source, session!.signal)) throw new OperatorProbeFailure('tool-call probe failed');
        } catch (error) {
          session!.signal.throwIfAborted();
          console.log(`… operator: ${source} cannot drive signups (${error instanceof OperatorProbeFailure ? error.message : setupFailureReason(error)})`);
          return false;
        }
        try {
          await configure();
          harnessReady = true;
          useOperator();
        } catch (error) {
          session!.signal.throwIfAborted();
          console.log(`… operator: ${source} cannot drive signups (${harness.id} setup failed: ${setupFailureReason(error)})`);
          return false;
        }
        table.step(bootstrap ? `✓ operator: ${source} via ${harness.id}` : '✓ model: grunt (kilo anonymous)');
        operator = source;
        anonymousDriver = false;
        table.set('source', source, '✓ ready · operator');
        return true;
      };
      if (ids.includes('kilo') && !skipAnonymous) {
        table.set('source', 'kilo', 'connecting');
        await onSettled('kilo', true);
        const anonymousKilo = () => { remaining.splice(remaining.indexOf('kilo'), 1); };
        if (!unavailable.includes('kilo') && await smoke()) anonymousKilo();
        else if (!unavailable.includes('kilo') && ((driving = await activate('kilo', false)) || !harness)) anonymousKilo();
        else {
          settled.delete('kilo');
          table.set('source', 'kilo', 'waiting');
          const failed = unavailable.indexOf('kilo');
          if (failed !== -1) unavailable.splice(failed, 1);
          else readyCount--;
          await session.hold('kilo');
          await session.useKiloAccount();
        }
      }
      if (!smoked && !driving && await freeDriver()) useFree();
      if (!smoked && !driving && harness) console.log(skipAnonymous ? `– operator: anonymous Kilo off (GRUNT_SETUP_NO_ANONYMOUS=1); using Squire`
        : '… operator: no working anonymous model; using Squire');
      table.start();
      const checkOperator = async () => {
        if (!operatorFailure) return;
        driving = false;
        squire?.useSignupAgent(undefined);
        if (operator && !unavailable.includes(operator)) table.set('source', operator, '✓ ready');
        operator = undefined;
        const failure = operatorFailure;
        operatorFailure = undefined;
        if (await freeDriver()) { table.step(`… operator: ${failure}; using ${freeLabel} (free)`); useFree(); }
        else table.step(`… operator: ${failure}; using Squire`);
      };
      for (const id of remaining) {
        if (smoked) break;
        await checkOperator();
        if (!driving && harness && id !== 'opencode') table.step(`… bootstrap: ${id} via Squire`);
        table.set('source', id, 'connecting');
        await provision([id], id === 'kilo');
        if (!driving && id === 'opencode' && !unavailable.includes(id) && await freeDriver()) useFree();
        if (await smoke()) break;
        if ((!driving || anonymousDriver) && id !== 'opencode') driving = await activate(id, true) || driving;
        // The operator stopped mid-signup: retry this one with the next driver.
        if (harness && operatorFailure) {
          deferred.push(id);
          table.set('source', id, 'waiting (retry)');
        }
      }
      for (const id of deferred) {
        if (smoked) break;
        await checkOperator();
        settled.delete(id);
        const failed = unavailable.indexOf(id);
        if (failed !== -1) unavailable.splice(failed, 1);
        table.set('source', id, 'connecting');
        await provision([id], id === 'kilo');
        if (!driving && id === 'opencode' && !unavailable.includes(id) && await freeDriver()) useFree();
        if (await smoke()) break;
        if ((!driving || anonymousDriver) && id !== 'opencode') driving = await activate(id, true) || driving;
      }
      // Setup ended before a route drove signups: point the chosen coding tool at grunt now.
      if (smoked && harness && !harnessReady) {
        try { await configure(); harnessReady = true; table.step(`✓ ${harness.id}: uses grunt`); }
        catch (error) {
          session.signal.throwIfAborted();
          table.step(`… ${harness.id} setup failed: ${setupFailureReason(error)}; rerun usegrunt setup`);
        }
      }
    }
    await Promise.all(settled.values());
    session.signal.throwIfAborted();
    if (!readyCount) throw new Error('No adapters passed verification. Run usegrunt setup to resume.');
    if (revised && !smoked) throw new Error('Grunt did not answer a request through model grunt. Run usegrunt status, then usegrunt setup to resume.');
    if (plan?.discoverLater && actions.connectHarnesses) firstReady = actions.connectHarnesses(port, { table });
    for (const connected of (await firstReady) ?? []) configured.set(connected.id, connected);
    if (harnessReady && harness) configured.set(harness.id, harness);
    // Sources setup did not reach, or left for a retry, continue in the daemon's route pass.
    const background = [...new Set([...ids.filter(id => !settled.has(id)), ...table.rowsWith('waiting (retry)')])];
    if (revised && (connection || background.length)) {
      try {
        const state = await connectState();
        console.log(state === 'installed' ? '✓ Trusty Squire: installed and signed in' : '✓ Trusty Squire: already set up and signed in, skipped');
      } catch (error) { console.log(`✗ Trusty Squire: ${setupFailureReason(error)}`); }
    }
    for (const id of background) table.set('source', id, 'background');
    table.finish();
    console.log(`${readyCount} ready${background.length ? `; ${background.length} more continue in the background (usegrunt status)` : ''}`);
    if (revised) {
      await closeSquire();
      await session.close();
      await actions.resumeBackground(port);
    }
    for (const line of launchLines([...configured.values()], port)) console.log(line);
    console.log('Ready');
  } finally {
    table.finish();
    session?.signal.removeEventListener('abort', abortSetup);
    try { await closeSquire(); }
    finally { await session?.close(); }
  }
}
