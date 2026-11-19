import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, cp, mkdtemp, rm, access, lstat, open, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupFallbacks } from './fallback-setup.js';
import { parallelMap } from './parallel.js';
import { withTerminal } from './terminal.js';
import { DOCTOR_TIMEOUT_MS } from './freebuff.js';
import { BrowserSquire, PROVIDERS, providerURL, setup, squireEnvironment } from './setup.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry, disabledAdapters, knownAdapters } from '../registry.js';
import { banner } from './banner.js';
import { approveDataSharing } from './data-sharing.js';
import { configurePi, connectHarness, detectHarnesses, HARNESSES, signupHarness, runHarness } from './harnesses.js';
import type { Harness } from './harnesses.js';
import { beginSetupSession } from './setup-session.js';
import { startSetupDashboard, watchSetupDashboard } from './setup-dashboard.js';
import { configRoot, gruntEnv } from '../brand.js';
import { SetupTable } from './setup-table.js';
import { setupAttention, setupFailureReason, signupOperatorUnavailable } from './setup-failure.js';
import { select, isCancel } from '@clack/prompts';
import { serviceEnvironment } from './service-environment.js';

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
  if (gruntEnv('SETUP_NO_HUMAN') === '1') throw new Error('Squire login needs human verification; stopped before onboarding');
  // Only a machine without a broker may enter the installer.
  const bin = options.installer || join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
  const env = await squireBootstrapEnvironment(options.signal);
  options.signal?.throwIfAborted();
  await (options.run || command)(process.execPath, [bin, 'connect', '--target=opencode', '--json'], false, options.signal, env);
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
  if (gruntEnv('ROUTER_RUNTIME') === 'docker') {
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
  await stage(() => writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'grunt-runtime', private: true, type: 'module', dependencies: pkg.dependencies }), { mode: 0o600 }));
  await stage(() => command('npm', ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], false, options.signal));
  const entry = join(runtime, 'dist', 'local', 'main.js');
  const port = gruntEnv('PORT') || '8788';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid grunt service port');
  const env: Record<string, string> = { GRUNT_DAEMON: '1', GRUNT_CONFIG_DIR: directory, GRUNT_PORT: port, GRUNT_SOURCES: selected.join(','), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  const routerURL = gruntEnv('FREELLMAPI_URL');
  if (routerURL) env.GRUNT_FREELLMAPI_URL = routerURL;
  const opencodeConfig = join(directory, 'opencode-free.json');
  try { await stage(() => readFile(opencodeConfig)); env.OPENCODE_CONFIG = opencodeConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const effectivePort = await stage(() => installBackgroundService('grunt', entry, env, options)) ?? port;
  await stage(() => writeFile(join(directory, 'installed-sources.json'), JSON.stringify(selected), { mode: 0o600 }));
  const portStage = join(directory, `.installed-port-${randomUUID()}`);
  try {
    await stage(() => writeFile(portStage, JSON.stringify(Number(effectivePort)), { flag: 'wx', mode: 0o600 }));
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
  // Existing service files can contain custom ports, endpoints and drop-ins.
  // Keep either installed identity and its configuration intact on reruns.
  const legacy = name === 'grunt' ? 'milo' : name === 'grunt-router' ? 'milo-router' : undefined;
  if (legacy) {
    const existing: { identity: string; file: string; contents: string }[] = [];
    for (const identity of [name, legacy]) {
      const file = process.platform === 'linux'
        ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${identity}.service`)
        : join(homedir(), 'Library', 'LaunchAgents', `ai.${identity}.service.plist`);
      try {
        const info = await stage(() => lstat(file));
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > 262144) throw new Error('The existing Grunt service file is unsafe');
        existing.push({ identity, file, contents: await stage(() => readFile(file, 'utf8')) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (existing.length > 1) throw new Error('Multiple Grunt service identities are installed; resolve the duplicate before setup');
    const installedService = existing[0];
    if (installedService) {
      const { identity, file, contents } = installedService;
      if (!contents.includes(process.platform === 'linux' ? systemdQuote(entry) : xml(entry))) throw new Error('The existing Grunt service uses a different runtime; its configuration was not changed');
      let port: string | undefined;
      if (name === 'grunt') {
        if (process.platform === 'linux') {
          const result = await stage(() => promisify(execFile)('systemctl', ['--user', 'show', `${identity}.service`, '-p', 'Environment', '--value'], { timeout: 10000, ...(options.signal ? { signal: options.signal } : {}) }));
          const installed = serviceEnvironment(result.stdout);
          if (gruntEnv('CONFIG_DIR', installed) !== env.GRUNT_CONFIG_DIR) throw new Error('The existing Grunt service uses a different configuration directory; its configuration was not changed');
          port = gruntEnv('PORT', installed);
        } else {
          const value = async (setting: string) => stage(() => promisify(execFile)('plutil', ['-extract', `EnvironmentVariables.${setting}`, 'raw', '-o', '-', file], { timeout: 10000, ...(options.signal ? { signal: options.signal } : {}) })).then(result => result.stdout.replace(/\r?\n$/, ''));
          const directory = await value('GRUNT_CONFIG_DIR').catch(() => value('MILO_CONFIG_DIR'));
          if (directory !== env.GRUNT_CONFIG_DIR) throw new Error('The existing Grunt service uses a different configuration directory; its configuration was not changed');
          port = await value('GRUNT_PORT').catch(() => value('MILO_PORT'));
        }
        if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Could not determine the installed Grunt port safely');
      }
      if (process.platform === 'linux') await run('systemctl', ['--user', 'restart', `${identity}.service`]);
      else {
        const domain = `gui/${process.getuid!()}`;
        await run('launchctl', ['bootout', `${domain}/ai.${identity}.service`]).catch(() => {});
        options.signal?.throwIfAborted();
        await run('launchctl', ['bootstrap', domain, file]);
      }
      return port;
    }
  }
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
  return env.GRUNT_PORT;
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
export async function checkServiceSources(unavailable: string[], notify = console.log, adapters = ['freebuff', 'opencode'], read = serviceSources) {
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      { value: 'jev', label: 'Use Squire with human handoff' }
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
export async function probeSetupOperator(port: number, source: string, signal: AbortSignal) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    body: JSON.stringify({ model: source, max_tokens: 256, messages: [
      { role: 'user', content: `Call the setup_ready tool once with no arguments. Check ${randomUUID()}.` }
    ], tools: [{ type: 'function', function: { name: 'setup_ready', parameters: { type: 'object', properties: {}, additionalProperties: false } } }] })
  });
  if (!response.ok || response.headers.get('x-grunt-source') !== source) return false;
  const result = await response.json() as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
  const calls = result.choices?.[0]?.message?.tool_calls;
  return calls?.length === 1 && calls[0]?.function?.name === 'setup_ready' && /^\{\s*\}$/.test(calls[0].function.arguments ?? '');
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
const wizardActions = { probeOperator: probeSetupOperator, chooseHarness: chooseSetupHarness, connectHarness, signupHarness, installedSources, createSquire: () => new BrowserSquire(), banner, preflight, connectSquire, setup, setupFallbacks, installService, configurePi, checkService, checkFallbackServices, loadRegistry, checkServiceSources, connectHarnesses, prepareHarnesses, approveDataSharing, startDashboard: startSetupDashboard, watchDashboard: watchSetupDashboard };
type Optional = 'probeOperator' | 'chooseHarness' | 'connectHarness' | 'signupHarness' | 'installedSources' | 'createSquire' | 'banner' | 'loadRegistry' | 'checkServiceSources' | 'connectHarnesses' | 'prepareHarnesses' | 'configurePi' | 'approveDataSharing' | 'startDashboard' | 'watchDashboard';
export async function wizard(add?: string, actions: Omit<typeof wizardActions, Optional> & Partial<Pick<typeof wizardActions, Optional>> = wizardActions) {
  if (add === '') throw new Error('Specify a provider name or base URL');
  if (add && disabledAdapters.has(add)) throw new Error(`${add} routing is disabled`);
  if (add && !providerURL(add) && !Object.hasOwn(PROVIDERS, add)) throw new Error(`Choose a supported provider: ${Object.keys(PROVIDERS).join(', ')}, or paste an OpenAI-compatible base URL`);
  const table = new SetupTable();
  const squire = actions.createSquire?.();
  let session: Awaited<ReturnType<typeof beginSetupSession>> | undefined;
  let connection: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const closeSquire = () => closing ??= (async () => { await squire?.close(); })();
  const abortSetup = () => { void closeSquire().catch(() => {}); };
  const connect = () => connection ??= actions.connectSquire({ ...(squire ? { squire } : {}), ...(session ? { signal: session.signal } : {}) });
  // The setup table prints only the classified outcome for each provider.
  const notify = (_line: string) => {};
  try {
    await actions.banner?.();
    await actions.preflight();
    const revised = !add && Boolean(actions.chooseHarness);
    if (revised) squire?.useBatchSignup();
    const harness = revised ? await actions.chooseHarness?.() : undefined;
    if (revised) console.log(harness ? `✓ harness: ${harness.id}` : '… harness: Squire with human handoff');
    const previous = ((await actions.installedSources?.())?.split(',') ?? []).filter(id => id && !disabledAdapters.has(id));
    const { registry } = !add && actions.loadRegistry ? await actions.loadRegistry() : { registry: bundledRegistry };
    const requested = add ? [add] : registry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)).map(adapter => adapter.id);
    const defaults = bundledRegistry.adapters.filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)).map(adapter => adapter.id);
    const sources = add ? knownAdapters.has(add) || add === 'nvidia'
      ? [...new Set([...(previous.length ? previous : defaults), add])]
      : [...new Set(['freellmapi', ...previous, ...defaults])] : requested;
    const consent = await (actions.approveDataSharing ?? approveDataSharing)({ directory: configDir(), providers: sources });
    squire?.approveDataSharing?.(consent.approved);
    const skipped = new Set(consent.skipped);
    const ids = requested.filter(id => !skipped.has(id));
    for (const id of requested) if (skipped.has(id)) table.set('source', id, 'skipped (approval required)');
    for (const id of ids) table.set('source', id, 'connecting');
    if (!ids.length) return;
    const port = await setupPort();
    if (add) {
      if (add !== 'nous') await connect();
      try {
        await actions.setup(notify, [add], { ...(squire ? { squire } : {}), dataSharingApproved: consent.approved });
        await actions.installService(sources.filter(id => !skipped.has(id)));
        await actions.checkService(port);
        const unavailable: string[] = [];
        await actions.checkFallbackServices(unavailable, port, notify, [add]);
        table.set('source', add, unavailable.includes(add) ? 'skipped (key test failed)' : '✓ ready');
      } catch (error) { table.set('source', add, `skipped (${squire?.signupFailure(add) ?? setupFailureReason(error)})`); throw error; }
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
    const failedReasons = new Map<string, string>();
    let firstReady: Promise<unknown> | undefined;
    let readyCount = 0;
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
          table.set('source', id, '✓ ready');
          if (!revised) {
            firstReady ??= applyHarnesses();
            await firstReady;
          }
        } else {
          if (!unavailable.includes(id)) unavailable.push(id);
          await session!.hold(id);
          const why = reason ?? (available ? 'key test failed' : 'setup failed');
          failedReasons.set(id, why);
          const attention = revised && setupAttention(why);
          table.set('source', id, attention ? `needs you (${attention})` : `skipped (${why})`);
        }
      })();
      settled.set(id, task);
      return task;
    };
    const provision = async (adapters: string[], kiloAccount = false) => {
      const outcome = await actions.setupFallbacks({ directory: configDir(), run: command, adapters, notify, onSettled, connect,
        signal: session!.signal, dataSharingApproved: consent.approved, ...(squire ? { squire } : {}), ...(kiloAccount ? { kiloAccount } : {}) });
      await parallelMap(adapters, id => onSettled(id, !outcome.unavailable.includes(id)));
    };
    if (!revised) await provision(ids);
    else {
      const ordered = ['kilo', 'pollinations', 'beatapi', 'zro', 'tokenharbor', 'runcrate', ...ids];
      const remaining = [...new Set(ordered)].filter(id => ids.includes(id));
      let driving = false;
      let operatorFailure: string | undefined;
      const deferred: string[] = [];
      const configure = () => (actions.connectHarness ?? connectHarness)(harness!, port,
        (binary, args, env) => runHarness(binary, args, env, 45000, { signal: session!.signal }));
      const useOperator = (anonymousOpenCode = false) => {
        const agent = (actions.signupHarness ?? signupHarness)(harness!, port, undefined, anonymousOpenCode);
        squire?.useSignupAgent(async input => {
          try { await agent(input); }
          catch (error) {
            const reason = setupFailureReason(error);
            if (signupOperatorUnavailable(reason)) operatorFailure = reason;
            throw error;
          }
        });
      };
      const activate = async (source: string, bootstrap: boolean) => {
        if (!harness || !squire || unavailable.includes(source)) return false;
        try {
          if (!await (actions.probeOperator ?? probeSetupOperator)(port, source, session!.signal)) return false;
          await configure();
          useOperator();
          console.log(bootstrap ? `✓ operator: ${source} via ${harness.id}` : '✓ model: grunt (kilo anonymous)');
          return true;
        } catch { session!.signal.throwIfAborted(); return false; }
      };
      if (ids.includes('kilo') && !skipAnonymous) {
        await onSettled('kilo', true);
        driving = await activate('kilo', false);
        if (!unavailable.includes('kilo') && (driving || !harness)) remaining.shift();
        else {
          settled.delete('kilo');
          const failed = unavailable.indexOf('kilo');
          if (failed !== -1) unavailable.splice(failed, 1);
          else readyCount--;
          await session.hold('kilo');
          await session.useKiloAccount();
        }
      }
      if (harness?.id === 'opencode' && !driving && !skipAnonymous) {
        try {
          await runHarness('opencode', ['run', '--pure', '-m', 'opencode/big-pickle', 'Reply only: grunt is ready.'], { OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined }, 45000);
          useOperator(true);
          driving = Boolean(squire);
          console.log('✓ model: OpenCode free');
        } catch { session.signal.throwIfAborted(); }
      }
      if (!driving && harness) console.log('… operator: no working anonymous model; using Squire');
      if (remaining.length) {
        try { await connect(); console.log('✓ squire: signed in'); }
        catch (error) { console.log(`✗ squire: ${setupFailureReason(error)}`); }
      }
      const checkOperator = () => {
        if (!operatorFailure) return;
        driving = false;
        squire?.useSignupAgent(undefined);
        console.log(`… operator: ${operatorFailure}; using Squire`);
        operatorFailure = undefined;
      };
      // With a harness, a Jev-only bootstrap tries every provider before it
      // hands a browser to the person; the second pass allows that handoff.
      const retryable = new Set(['browser could not continue', 'needs human verification', 'needs Terms of Service acceptance']);
      if (harness) squire?.deferHandoff?.(true);
      for (const id of remaining) {
        checkOperator();
        if (!driving && harness && id !== 'opencode') console.log(`… bootstrap: ${id} via Squire`);
        await provision([id], id === 'kilo');
        if (!driving && id !== 'opencode') driving = await activate(id, true);
        if (harness && (operatorFailure || (!driving && retryable.has(failedReasons.get(id) ?? '')))) deferred.push(id);
      }
      squire?.deferHandoff?.(false);
      for (const id of deferred) {
        checkOperator();
        settled.delete(id);
        failedReasons.delete(id);
        const failed = unavailable.indexOf(id);
        if (failed !== -1) unavailable.splice(failed, 1);
        await provision([id], id === 'kilo');
        if (!driving && id !== 'opencode') driving = await activate(id, true);
      }
    }
    await Promise.all(settled.values());
    session.signal.throwIfAborted();
    if (!readyCount) throw new Error('No adapters passed verification. Run usegrunt setup to resume.');
    if (plan?.discoverLater && actions.connectHarnesses) await actions.connectHarnesses(port, { table });
    console.log('Ready');
  } finally {
    session?.signal.removeEventListener('abort', abortSetup);
    try { await closeSquire(); }
    finally { await session?.close(); }
  }
}
