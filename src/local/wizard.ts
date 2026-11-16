import { text } from '@clack/prompts';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, cp, mkdtemp, rm, access, lstat, open, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { intro, outro, spinner, log, note, multiselect, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { setupFallbacks } from './fallback-setup.js';
import { parallelMap, SETUP_CONCURRENCY } from './parallel.js';
import { withTerminal, terminalBusy } from './terminal.js';
import { DOCTOR_TIMEOUT_MS } from './freebuff.js';
import { BrowserSquire, PROVIDERS, providerURL, setup, squireEnvironment } from './setup.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry, disabledAdapters, knownAdapters } from '../registry.js';
import type { Adapter } from '../registry.js';
import { banner } from './banner.js';
import { approveDataSharing, requiresDataSharing } from './data-sharing.js';
import { configurePi, connectHarness, detectHarnesses } from './harnesses.js';
import type { Harness, runHarness } from './harnesses.js';
import { beginSetupSession } from './setup-session.js';
import { startSetupDashboard, watchSetupDashboard } from './setup-dashboard.js';
import type { SetupDashboard } from './setup-dashboard.js';

export const configDir = (env = process.env) => env.MILO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo');
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
async function step<T>(label: string, task: () => Promise<T>, done: (result: T) => string = () => label): Promise<T> {
  const progress = spinner(); progress.start(label);
  try { const result = await task(); progress.stop(done(result)); return result; }
  catch (error) { progress.error(`${label} failed`); throw error; }
}
export async function squireBrokerExists() {
  const service = process.platform === 'darwin'
    ? ['launchctl', ['print', `gui/${process.getuid!()}/ai.trustysquire.trusty-squire-broker`]] as const
    : ['systemctl', ['--user', 'is-active', 'trusty-squire-broker']] as const;
  try { await promisify(execFile)(service[0], [...service[1]], { timeout: 10000 }); return true; }
  catch { /* An inactive service can still own the broker installation. */ }
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
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) {
    throw new Error('Squire setup requires a private grunt configuration directory');
  }
  const path = join(directory, 'squire-opencode.json');
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 262144) {
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
  try { await probe(); return; }
  catch (error) {
    options.signal?.throwIfAborted();
    const exists = await (options.hasBroker || squireBrokerExists)();
    options.signal?.throwIfAborted();
    if (exists) {
      throw new Error(`Existing trusty-squire-broker failed its connection probe: ${error instanceof Error ? error.message : String(error)}. Repair the broker, then rerun usegrunt setup.`, { cause: error });
    }
  }
  if (process.env.MILO_SETUP_NO_HUMAN === '1') throw new Error('Squire login needs human verification; stopped before onboarding');
  // Only a machine without a broker may enter the installer.
  const bin = options.installer || join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
  const env = await squireBootstrapEnvironment(options.signal);
  options.signal?.throwIfAborted();
  await (options.run || command)(process.execPath, [bin, 'connect', '--target=opencode', '--json'], true, options.signal, env);
  await probe();
}
export async function preflight(run = command) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || major >= 25) throw new Error('Install Node.js 22 or 24 LTS, then run npx usegrunt setup.');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Run setup on Linux with systemd or macOS with launchd.');
  for (const [binary, args, fix] of [
    ['npm', ['--version'], 'Install Node.js 22 or 24 LTS including npm.'],
    ['tar', ['--version'], 'Install tar using your system package manager.']
  ] as const) {
    try { await run(binary, [...args]); } catch { throw new Error(fix + ' Then run npx usegrunt setup.'); }
  }
  if (process.env.MILO_ROUTER_RUNTIME === 'docker') {
    try { await run('docker', ['info']); } catch { throw new Error('Install and start Docker Desktop, then run npx usegrunt setup.'); }
  }
  try {
    if (process.platform === 'linux') await run('systemctl', ['--user', 'show-environment']);
    else await run('launchctl', ['print', `gui/${process.getuid!()}`]);
  } catch { throw new Error('Start a normal user login with its systemd/launchd service manager, then run npx usegrunt setup.'); }
}
const systemdQuote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\n', '\\n') + '"';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
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
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('grunt background service requires systemd or launchd');
  const selected = [...new Set(adapters ?? (await stage(() => installedSources())).split(','))].filter(id => id && !disabledAdapters.has(id));
  if (selected.some(id => !knownAdapters.has(id) && id !== 'freellmapi')) throw new Error('Invalid grunt service selection');
  const directory = configDir(), runtime = join(directory, 'runtime');
  // npx cache entries can disappear. Keep a backend runtime outside that cache.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await stage(() => mkdir(runtime, { recursive: true, mode: 0o700 }));
  await stage(() => cp(join(root, 'dist'), join(runtime, 'dist'), { recursive: true }));
  const pkg = JSON.parse(await stage(() => readFile(join(root, 'package.json'), 'utf8')));
  await stage(() => writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'milo-runtime', private: true, type: 'module', dependencies: pkg.dependencies }), { mode: 0o600 }));
  await stage(() => command('npm', ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], false, options.signal));
  const entry = join(runtime, 'dist', 'local', 'main.js');
  const port = process.env.MILO_PORT || '8788';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid grunt service port');
  const env: Record<string, string> = { GRUNT_DAEMON: '1', MILO_CONFIG_DIR: directory, MILO_PORT: port, MILO_SOURCES: selected.join(','), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  if (process.env.MILO_FREELLMAPI_URL) env.MILO_FREELLMAPI_URL = process.env.MILO_FREELLMAPI_URL;
  const opencodeConfig = join(directory, 'opencode-free.json');
  try { await stage(() => readFile(opencodeConfig)); env.OPENCODE_CONFIG = opencodeConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await stage(() => installBackgroundService('milo', entry, env, options));
  await stage(() => writeFile(join(directory, 'installed-sources.json'), JSON.stringify(selected), { mode: 0o600 }));
  const portStage = join(directory, `.installed-port-${randomUUID()}`);
  try {
    await stage(() => writeFile(portStage, JSON.stringify(Number(port)), { flag: 'wx', mode: 0o600 }));
    await stage(() => rename(portStage, join(directory, 'installed-port.json')));
  } finally { await rm(portStage, { force: true }); }
}
export async function installBackgroundService(name: string, entry: string, env: Record<string, string>, options: { signal?: AbortSignal } = {}) {
  const stage = async <T>(operation: () => Promise<T>) => {
    options.signal?.throwIfAborted();
    const result = await operation();
    options.signal?.throwIfAborted();
    return result;
  };
  const run = (binary: string, args: string[]) => stage(() => command(binary, args, false, options.signal));
  options.signal?.throwIfAborted();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid service name');
  if (process.platform === 'linux') {
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    await stage(() => mkdir(units, { recursive: true }));
    await stage(() => writeFile(join(units, `${name}.service`), `[Unit]\nDescription=grunt model service\nAfter=network-online.target\n\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(entry)}\n${Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 }));
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', `${name}.service`]);
    await run('systemctl', ['--user', 'restart', `${name}.service`]);
  } else {
    const agents = join(homedir(), 'Library', 'LaunchAgents');
    await stage(() => mkdir(agents, { recursive: true }));
    const plist = join(agents, `ai.${name}.service.plist`), domain = `gui/${process.getuid!()}`;
    await stage(() => writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.${name}.service</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>`, { mode: 0o600 }));
    await run('launchctl', ['bootout', `${domain}/ai.${name}.service`]).catch(() => {});
    await run('launchctl', ['bootstrap', domain, plist]);
  }
}
// /v1/models asks every source whether it is available. Bound the combined probe
// so a hung native CLI cannot leave the installer waiting forever.
export async function checkService(port = 8788, totalMs = 90000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const timeout = Math.max(1, Math.min(DOCTOR_TIMEOUT_MS + 5000, deadline - Date.now()));
    try { const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(timeout) }); if (response.ok) return; } catch { /* Wait for the service manager. */ }
    await delay(Math.max(0, Math.min(1000, deadline - Date.now())));
  }
  throw new Error('grunt service did not start; inspect its service status');
}
type Systemctl = (args: string[]) => Promise<string>;
const systemctl: Systemctl = async args => (await promisify(execFile)('systemctl', ['--user', ...args], { timeout: 10000 })).stdout;
// Read MILO_SOURCES as systemd applies it, including drop-ins, and name the file that set it.
export async function serviceSources(run: Systemctl = systemctl, name = 'milo') {
  if (run === systemctl && process.platform !== 'linux') return;
  let environment: string, dropIns: string;
  try { [environment, dropIns] = await Promise.all(['Environment', 'DropInPaths'].map(property => run(['show', `${name}.service`, '-p', property, '--value']))) as [string, string]; }
  catch { return; }
  const value = environment.match(/(?:^|\s)"?MILO_SOURCES=([^\s"]*)/)?.[1];
  if (value === undefined) return;
  let origin = `${name}.service`;
  for (const path of dropIns.trim().split(/\s+/).filter(Boolean)) {
    try { if (/^\s*Environment=.*MILO_SOURCES=/m.test(await readFile(path, 'utf8'))) origin = path; }
    catch { /* An unreadable drop-in cannot be named. */ }
  }
  return { sources: value.split(',').map(id => id.trim()), origin };
}
export async function checkServiceSources(unavailable: string[], notify = console.log, adapters = ['freebuff', 'opencode'], read = serviceSources) {
  const unit = await read();
  if (!unit) return;
  for (const id of adapters) {
    if (unit.sources.includes(id)) continue;
    if (!unavailable.includes(id)) unavailable.push(id);
    notify(`${id}: FAIL — ${unit.origin} sets MILO_SOURCES=${unit.sources.join(',')}, which lacks ${id}. Setup does not edit it; add ${id} there or remove that setting.`);
  }
}
export async function checkFallbackServices(unavailable: string[], port = 8788, notify = console.log, adapters = ['opencode'], wait: { limit: number; interval: number; signal?: AbortSignal; retryPreparing?: boolean } = { limit: 180000, interval: 2000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'milo-free-check-'));
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: source, cwd: directory, messages: [{ role: 'user', content: `Reply only: grunt is ready (${source}). Do not use tools or change files. Check ${attempt}.` }], stream: false, max_tokens: 256 }),
            signal: AbortSignal.any([AbortSignal.timeout(120000), ...(wait.signal ? [wait.signal] : [])])
          });
          preparing = response.headers.get('x-grunt-preparing')?.split(',').includes(source) ?? false;
          const answered = response.headers.get('x-grunt-source');
          const result = await response.json().catch(() => ({})) as { choices?: { message?: { content?: string } }[] };
          if (!response.ok) failure = `grunt returned HTTP ${response.status}`;
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
const PREAMBLE = [
  'usegrunt installs grunt, a small daemon that runs on this machine.',
  'It pools the free AI inference quota offered by many services and serves',
  'it as one agent at a local address. Your coding tools talk to grunt; grunt',
  'sends each request to a free service that can answer it.',
  '',
  'Setup will:',
  '  1. Pull the free service list and ask for grouped sharing approval',
  '  2. Start grunt and connect your coding tools when a source answers',
  '  3. Connect Trusty Squire when an account-based source needs it',
  '  4. Continue remaining signups and browser confirmations alongside use'
].join('\n');
const SQUIRE_NOTICE = [
  'Some free services only work with an account. Trusty Squire is a local',
  'browser helper that signs up for them using their supported sign-in.',
  'Most use Google; Runcrate’s card-free access needs GitHub sign-in.',
  '',
  'Account-based setup may open a browser for Google sign-in. An existing',
  'Squire connection is reused. Anonymous sources can start first. A captcha',
  'or email check pauses only its source while other setup jobs continue.'
].join('\n');
type Status = 'pass' | 'fail' | 'skip';
const mark = (status: Status | undefined) => status === 'pass' ? chalk.green('✔') : status === 'fail' ? chalk.red('✘') : chalk.dim('–');
const describe = (adapter: Adapter) => [adapter.kind === 'agent' ? 'coding agent' : 'model API', adapter.model ? `free model ${adapter.model}` : undefined,
  adapter.signup ? `account at ${new URL(adapter.signup).host}` : 'no account needed until it asks'].filter(Boolean).join(' · ');
// Service lines name their result, so show PASS and FAIL as success and error.
const report = (shown = new Set<string>()) => (line: string) => {
  if (shown.has(line)) return; shown.add(line);
  if (/: PASS\b/.test(line)) log.success(line); else if (/: FAIL\b/.test(line)) log.error(line); else log.info(line);
};
// Only short UI writes enter this queue. Provider probes and coding-tool
// configuration keep running while a browser confirmation owns stdin.
const pendingUi = new Set<Promise<void>>();
function queueUi(write: () => void) {
  const task = withTerminal(async () => { write(); }).catch(() => {});
  pendingUi.add(task);
  void task.then(() => { pendingUi.delete(task); });
}
async function drainUi() {
  while (pendingUi.size) await Promise.all([...pendingUi]);
}
type HarnessOptions = { harnesses?: Harness[]; choose?: (found: Harness[]) => Promise<Harness[]>; run?: typeof runHarness };
type HarnessPlan = (() => Promise<Harness[]>) & { discoverLater?: true };
export async function prepareHarnesses(port: number, options: HarnessOptions = {}): Promise<HarnessPlan> {
  queueUi(() => log.step('Connect grunt to your coding tools'));
  const found = await detectHarnesses(options.harnesses);
  if (!found.length) {
    queueUi(() => log.info('No supported coding tool is currently installed. Grunt will become usable through its local API.'));
    return Object.assign(async () => [] as Harness[], { discoverLater: true as const });
  }
  queueUi(() => log.info(`Found: ${found.map(h => h.name).join(', ')}. grunt is added as an extra, named option; your default model and provider stay as they are.`));
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.env.MILO_SETUP_NO_HUMAN !== '1';
  const choose = options.choose ?? (async (list: Harness[]) => {
    if (!interactive) return list.filter(h => h.id === 'pi');
    const picked = await multiselect({ message: 'Connect grunt to which tools? (space toggles, enter confirms)', required: false,
      options: list.map(h => ({ value: h.id, label: h.name, hint: h.launch(port) })), initialValues: list.filter(h => h.id === 'pi').map(h => h.id) });
    return isCancel(picked) ? [] : list.filter(h => picked.includes(h.id));
  });
  // Choose once before provider jobs can request browser confirmations. Applying
  // the saved choices later never reads stdin or waits for a Squire prompt.
  const selected = await withTerminal(() => choose(found));
  return async () => {
    const connected: Harness[] = [];
    for (const harness of selected) {
      queueUi(() => log.step(`${harness.name}: adding grunt and sending a test request through it`));
      try {
        const { change } = await connectHarness(harness, port, options.run);
        queueUi(() => {
          log.success(`${harness.name}: PASS — answered through grunt`);
          if (change?.backup) log.info(`${harness.name}: previous config saved as ${change.backup}`);
        });
        connected.push(harness);
      } catch (error) {
        queueUi(() => log.error(`${harness.name}: FAIL — ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (connected.length) queueUi(() => note(connected.map(h => `${chalk.bold(h.name)}\n  ${h.launch(port)}`).join('\n'), 'Start coding with grunt'));
    return connected;
  };
}
export async function connectHarnesses(port: number, options: HarnessOptions = {}) {
  return (await prepareHarnesses(port, options))();
}
const wizardActions = { installedSources, createSquire: () => new BrowserSquire(), banner, preflight, connectSquire, setup, setupFallbacks, installService, configurePi, checkService, checkFallbackServices, loadRegistry, checkServiceSources, connectHarnesses, prepareHarnesses, approveDataSharing, startDashboard: startSetupDashboard, watchDashboard: watchSetupDashboard };
type Optional = 'installedSources' | 'createSquire' | 'banner' | 'loadRegistry' | 'checkServiceSources' | 'connectHarnesses' | 'prepareHarnesses' | 'configurePi' | 'approveDataSharing' | 'startDashboard' | 'watchDashboard';
export async function wizard(add?: string, actions: Omit<typeof wizardActions, Optional> & Partial<Pick<typeof wizardActions, Optional>> = wizardActions) {
  if (add === '') {
    const answer = await text({ message: 'Provider name or base URL' });
    if (isCancel(answer)) throw new Error('Provider setup cancelled');
    add = answer.trim();
    if (!add) throw new Error('Enter a provider name or base URL');
  }
  if (add && disabledAdapters.has(add)) throw new Error(`${add} routing is disabled`);
  if (add && !providerURL(add) && !Object.hasOwn(PROVIDERS, add)) throw new Error(`Choose a supported provider: ${Object.keys(PROVIDERS).join(', ')}, or paste an OpenAI-compatible base URL`);
  const squire = actions.createSquire?.();
  let session: Awaited<ReturnType<typeof beginSetupSession>> | undefined;
  let connection: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let abortSetup: (() => void) | undefined;
  let dashboard: SetupDashboard | undefined;
  let watchPort: number | undefined;
  let stopVerificationStatus: (() => void) | undefined;
  let verificationStatus: Promise<unknown> = Promise.resolve();
  const queuedReports: string[] = [];
  const showReport = report();
  const notify = (line: string) => {
    // Redraws and background progress must never overwrite a foreground
    // confirmation. Preserve routine messages for the final normal screen.
    if (dashboard || terminalBusy()) { if (queuedReports.length < 512) queuedReports.push(line); }
    else showReport(line);
  };
  const stopDashboard = async () => {
    const display = dashboard; dashboard = undefined;
    await display?.stop().catch(() => {});
    const lines = queuedReports.splice(0);
    if (lines.length) queueUi(() => { for (const line of lines) showReport(line); });
  };
  const closeSquire = () => closing ??= (async () => { await squire?.close(); })();
  const connect = () => connection ??= (async () => {
    // A long-running spinner would compete with the live source dashboard.
    notify('Connecting Trusty Squire');
    await actions.connectSquire({ ...(squire ? { squire } : {}), ...(session ? { signal: session.signal } : {}) });
  })();
  try {
    await actions.banner?.();
    intro(chalk.hex('#f4b41a').bold('grunt') + chalk.dim(' — npx usegrunt setup'));
    note(PREAMBLE, 'What grunt does');
    await step('Checking prerequisites', () => actions.preflight());
    note(SQUIRE_NOTICE, 'Google sign-in for Trusty Squire');
    // Capture legacy API routing before default Kilo setup creates its admin file.
    const previous = ((await actions.installedSources?.())?.split(',') ?? []).filter(id => id && !disabledAdapters.has(id));
    if (add) {
      await connect();
      const defaults = bundledRegistry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)).map(adapter => adapter.id);
      const sources = ['kilo', 'nvidia', 'zro', 'tokenharbor', 'runcrate', 'apinex', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'clixad', 'perch'].includes(add)
        ? [...new Set([...(previous.length ? previous : defaults), add])]
        : [...new Set(['freellmapi', ...previous, ...defaults])];
      const consent = await (actions.approveDataSharing ?? approveDataSharing)({ directory: configDir(), providers: sources });
      if (consent.skipped.includes(add)) {
        // A declined addition still needs to replace a previously installed
        // runtime that predates consent enforcement. Keep only prior choices.
        await step('Updating the grunt background service', () => actions.installService(previous));
        await step('Waiting for grunt to answer', () => actions.checkService(Number(process.env.MILO_PORT || '8788')));
        outro(`${add} skipped; data sharing was not approved`);
        return;
      }
      squire?.approveDataSharing?.(consent.approved);
      const consentOptions = consent.approved.length ? { dataSharingApproved: consent.approved } : {};
      await step('Connecting free provider access', () => actions.setup(line => log.info(line), [add], { ...(squire ? { squire } : {}), ...consentOptions }));
      // Explicit additions must survive the saved source list from an older
      // install. Keep its routing choices rather than enabling every adapter.
      const approved = new Set(consent.approved);
      const enabled = sources.filter(id => !requiresDataSharing(id) || approved.has(id));
      await step('Starting the grunt background service', () => actions.installService(enabled));
      await step('Waiting for grunt to answer', () => actions.checkService(Number(process.env.MILO_PORT || '8788')));
      outro(`${add} connected`); return;
    }
    const pulled = actions.loadRegistry ? await step('Pulling the free service list from the registry', () => actions.loadRegistry!()) : { registry: bundledRegistry, origin: 'bundled' as RegistryOrigin };
    const { registry } = pulled;
    const published = registry.published.slice(0, 10);
    if (pulled.origin === 'remote') log.info(`Registry: ${registry.adapters.length} free services, published ${published}`);
    else log.warn(`Registry unreachable; using the ${pulled.origin === 'cache' ? 'list saved by an earlier setup' : 'list bundled with this version'} (published ${published})`);
    const adapters = registry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id));
    log.message(registry.adapters.map(adapter => knownAdapters.has(adapter.id)
      ? `${chalk.bold(adapter.id.padEnd(10))} ${chalk.dim(disabledAdapters.has(adapter.id) ? 'disabled pending integration review' : describe(adapter))}`
      : `${chalk.dim(adapter.id.padEnd(10))} ${chalk.dim('skipped: needs a newer usegrunt')}`).join('\n'));
    const requested = adapters.map(adapter => adapter.id);
    const consent = await (actions.approveDataSharing ?? approveDataSharing)({ directory: configDir(), providers: requested });
    squire?.approveDataSharing?.(consent.approved);
    const ids = requested.filter(id => !consent.skipped.includes(id));
    const results = new Map<string, { signup?: Status; daemon?: Status; check?: Status }>(requested.map(id => [id, consent.skipped.includes(id) ? { signup: 'skip', daemon: 'skip', check: 'skip' } : {}]));
    const unavailable: string[] = [];
    if (consent.skipped.length) log.info(`Skipped data-sharing services: ${consent.skipped.join(', ')}. Other free services continue.`);
    if (!ids.length) {
      // Upgrade older runtimes even after a declined batch: otherwise their
      // existing provider sessions could keep routing without consent guards.
      // Honor registry removals, while retaining a user's custom API routing.
      const retained = previous.filter(id => id === 'freellmapi' || requested.includes(id));
      await step('Updating the grunt background service', () => actions.installService(retained.length ? retained : requested));
      await step('Waiting for grunt to answer', () => actions.checkService(Number(process.env.MILO_PORT || '8788')));
      outro('No approved free services are available; the background service now enforces your data-sharing choices');
      return;
    }

    const port = Number(process.env.MILO_PORT || '8788');
    const harnessPlan = actions.prepareHarnesses ? await actions.prepareHarnesses(port) : undefined;
    if (harnessPlan?.discoverLater) log.info('Setup will check again for coding tools after provider installations finish.');
    const applyHarnesses = harnessPlan ?? (async () => {
      if (actions.connectHarnesses) await actions.connectHarnesses(port);
      else if (actions.configurePi) {
        queueUi(() => log.step('Pi provider'));
        await actions.configurePi(port);
        queueUi(() => log.success('Pi provider configured'));
      }
    });
    session = await beginSetupSession(configDir(), ids);
    const activeSession = session;
    stopVerificationStatus = squire?.onVerificationChange?.(services => {
      const selected = services.filter(id => ids.includes(id));
      verificationStatus = verificationStatus.then(() => activeSession.setApprovals?.(selected)).catch(() => {
        // Lease writes enforce ownership independently; never echo exception
        // payloads or interfere with the human's confirmation terminal.
      });
    });
    abortSetup = () => { void closeSquire().catch(() => {}); };
    session.signal.addEventListener('abort', abortSetup, { once: true });
    session.signal.throwIfAborted();
    await step('Starting the grunt background service', () => actions.installService([...new Set([...previous.filter(id => id === 'freellmapi'), ...ids])], { signal: session!.signal }));
    await step(`Waiting for grunt to answer at http://127.0.0.1:${port}`, () => actions.checkService(port));

    // Keep at most three real verification requests in flight without holding a
    // provider-install worker. A queued check receives the released slot directly.
    let activeChecks = 0;
    const queuedChecks: (() => void)[] = [];
    const check = async <T>(task: () => Promise<T>) => {
      if (activeChecks < 3) activeChecks++;
      else await new Promise<void>(resolve => queuedChecks.push(resolve));
      try { return await task(); }
      finally { const next = queuedChecks.shift(); if (next) next(); else activeChecks--; }
    };
    const settled = new Map<string, Promise<void>>();
    let firstReady: Promise<void> | undefined;
    let readyCount = 0;
    const firstAnswer = () => firstReady ??= (async () => {
      queueUi(() => {
        log.success(`grunt is ready at http://127.0.0.1:${port}; a free provider answered`);
        log.info('Start using grunt now. Keep this setup terminal open for remaining signups and browser confirmations; working requests do not wait for them.');
      });
      try { await applyHarnesses(); }
      catch { queueUi(() => log.warn('grunt is ready; coding-tool configuration needs attention. Rerun setup to finish connecting your tool.')); }
      queueUi(() => log.info(`Source dashboard: npx usegrunt status --watch --port ${port}`));
      try {
        dashboard = actions.startDashboard?.({ port, signal: session!.signal, approvals: () => squire?.pendingVerificationServices() ?? [] });
      } catch { queueUi(() => log.info('Live source view unavailable; setup continues. Reopen it with the status command above.')); }
    })();
    const onSettled = (id: string, available: boolean): Promise<void> => {
      if (!ids.includes(id)) return Promise.reject(new Error('Unexpected provider setup result'));
      const previousResult = settled.get(id);
      if (previousResult) return previousResult;
      const task = (async () => {
        const result = results.get(id)!;
        result.signup = available ? 'pass' : 'fail';
        if (!available) {
          if (!unavailable.includes(id)) unavailable.push(id);
          result.daemon = result.check = 'skip';
          notify(`${id}: FAIL — setup incomplete`);
          return;
        }
        const passed = await check(async () => {
          try {
            session!.signal.throwIfAborted();
            await session!.verify(id);
            if (actions.checkServiceSources) await actions.checkServiceSources(unavailable, notify, [id]);
            result.daemon = unavailable.includes(id) ? 'fail' : 'pass';
            if (result.daemon === 'fail') { result.check = 'skip'; await session!.hold(id); return false; }
            await actions.checkFallbackServices(unavailable, port, notify, [id], { limit: 180000, interval: 2000, signal: session!.signal, retryPreparing: false });
            session!.signal.throwIfAborted();
            result.check = unavailable.includes(id) ? 'fail' : 'pass';
            if (result.check === 'pass') await session!.release(id);
            else await session!.hold(id);
            session!.signal.throwIfAborted();
            return result.check === 'pass';
          } catch {
            await session!.hold(id).catch(() => {});
            if (!unavailable.includes(id)) unavailable.push(id);
            result.check = 'fail';
            result.daemon ??= 'fail';
            notify(`${id}: FAIL — verification incomplete; other ready sources continue`);
            return false;
          }
        });
        if (passed) { readyCount++; await firstAnswer(); }
      })();
      settled.set(id, task);
      return task;
    };
    log.step(`Installing and connecting ${ids.length} vetted free services (up to ${SETUP_CONCURRENCY} at once)`);
    log.info('Trusty Squire reuses existing accounts and grants. Only free access is requested. Sources become usable independently; verification prompts are queued.');
    const outcome = await actions.setupFallbacks({ directory: configDir(), run: command, adapters: ids, notify, onSettled, connect,
      signal: session.signal, ...(consent.approved.length ? { dataSharingApproved: consent.approved } : {}), ...(squire ? { squire } : {}) });
    // Compatibility for injected setup implementations that return only a final
    // result. Production emits settlement events as soon as each source finishes.
    await parallelMap(ids, id => onSettled(id, !outcome.unavailable.includes(id)));
    await Promise.all(settled.values());
    session.signal.throwIfAborted();
    await stopDashboard();
    await drainUi();
    await withTerminal(async () => note([`${'service'.padEnd(10)}  sign-in  daemon  test`, ...requested.map(id => {
      const r = results.get(id)!;
      return `${id.padEnd(10)}  ${mark(r.signup)}        ${mark(r.daemon)}       ${mark(r.check)}`;
    })].join('\n'), 'Free services'));

    if (!readyCount) throw new Error('No adapters passed verification. Run usegrunt setup to resume.');
    // OpenCode may have been installed by its provider job. Only rediscover
    // when no tool existed initially, never after the user selected none.
    if (harnessPlan?.discoverLater && actions.connectHarnesses) await actions.connectHarnesses(port);
    await drainUi();
    await withTerminal(async () => outro(unavailable.length ? `grunt is ready; incomplete fallbacks: ${unavailable.join(', ')}. Rerun setup to finish them.` : 'grunt is ready'));
    watchPort = port;
  } finally {
    await stopDashboard();
    stopVerificationStatus?.();
    await verificationStatus;
    if (session && abortSetup) session.signal.removeEventListener('abort', abortSetup);
    try { await closeSquire(); }
    finally { await session?.close(); await stopDashboard(); await drainUi(); }
  }
  // Only the standalone view reads keys, after all signups, browser clients,
  // and the setup lease have been released. Noninteractive setup still exits.
  if (watchPort !== undefined) await actions.watchDashboard?.(watchPort);
}
