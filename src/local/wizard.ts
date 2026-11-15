import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, mkdtemp, rm, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { intro, outro, spinner, log, note, multiselect, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { setupFallbacks } from './fallback-setup.js';
import { parallelMap, SETUP_CONCURRENCY } from './parallel.js';
import { withTerminal } from './terminal.js';
import { DOCTOR_TIMEOUT_MS } from './freebuff.js';
import { BrowserSquire, PROVIDERS, setup, squireEnvironment } from './setup.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry, disabledAdapters, knownAdapters } from '../registry.js';
import type { Adapter } from '../registry.js';
import { banner } from './banner.js';
import { approveDataSharing, requiresDataSharing } from './data-sharing.js';
import { HARNESSES, configurePi, connectHarness, detectHarnesses } from './harnesses.js';
import type { Harness, runHarness } from './harnesses.js';

export const configDir = (env = process.env) => env.MILO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo');
export async function command(binary: string, args: string[], interactive = false, signal?: AbortSignal) {
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: interactive ? 'inherit' : 'ignore', ...(signal ? { signal } : {}) });
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
export async function connectSquire(options: { hasBroker?: () => Promise<boolean>; run?: typeof command; installer?: string; squire?: BrowserSquire } = {}) {
  const probe = async () => { const squire = options.squire ?? new BrowserSquire(); try { await squire.connect(); } finally { if (!options.squire) await squire.close(); } };
  try { await probe(); return; }
  catch (error) {
    if (await (options.hasBroker || squireBrokerExists)()) {
      throw new Error(`Existing trusty-squire-broker failed its connection probe: ${error instanceof Error ? error.message : String(error)}. Repair the broker, then rerun usegrunt setup.`, { cause: error });
    }
  }
  if (process.env.MILO_SETUP_NO_HUMAN === '1') throw new Error('Squire login needs human verification; stopped before onboarding');
  // Only a machine without a broker may enter the installer.
  const bin = options.installer || join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
  await (options.run || command)(process.execPath, [bin, 'connect', '--target=opencode', '--json'], true);
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
export async function installService(adapters?: string[]) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('grunt background service requires systemd or launchd');
  const selected = [...new Set(adapters ?? (await installedSources()).split(','))].filter(id => id && !disabledAdapters.has(id));
  if (selected.some(id => !knownAdapters.has(id) && id !== 'freellmapi')) throw new Error('Invalid grunt service selection');
  const directory = configDir(), runtime = join(directory, 'runtime');
  // npx cache entries can disappear. Keep a backend runtime outside that cache.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(join(root, 'dist'), join(runtime, 'dist'), { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'milo-runtime', private: true, type: 'module', dependencies: pkg.dependencies }), { mode: 0o600 });
  await command('npm', ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  const entry = join(runtime, 'dist', 'local', 'main.js');
  const port = process.env.MILO_PORT || '8788';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid grunt service port');
  const env: Record<string, string> = { GRUNT_DAEMON: '1', MILO_CONFIG_DIR: directory, MILO_PORT: port, MILO_SOURCES: selected.join(','), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  if (process.env.MILO_FREELLMAPI_URL) env.MILO_FREELLMAPI_URL = process.env.MILO_FREELLMAPI_URL;
  const opencodeConfig = join(directory, 'opencode-free.json');
  try { await readFile(opencodeConfig); env.OPENCODE_CONFIG = opencodeConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await installBackgroundService('milo', entry, env);
  await writeFile(join(directory, 'installed-sources.json'), JSON.stringify(selected), { mode: 0o600 });
}
export async function installBackgroundService(name: string, entry: string, env: Record<string, string>) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid service name');
  if (process.platform === 'linux') {
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    await mkdir(units, { recursive: true });
    await writeFile(join(units, `${name}.service`), `[Unit]\nDescription=grunt model service\nAfter=network-online.target\n\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(entry)}\n${Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    await command('systemctl', ['--user', 'daemon-reload']);
    await command('systemctl', ['--user', 'enable', `${name}.service`]);
    await command('systemctl', ['--user', 'restart', `${name}.service`]);
  } else {
    const agents = join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    const plist = join(agents, `ai.${name}.service.plist`), domain = `gui/${process.getuid!()}`;
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.${name}.service</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>`, { mode: 0o600 });
    await command('launchctl', ['bootout', `${domain}/ai.${name}.service`]).catch(() => {});
    await command('launchctl', ['bootstrap', domain, plist]);
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
export async function checkFallbackServices(unavailable: string[], port = 8788, notify = console.log, adapters = ['opencode'], wait = { limit: 180000, interval: 2000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'milo-free-check-'));
  try {
    for (const source of adapters) {
      if (unavailable.includes(source)) { notify(`${source}: FAIL — setup incomplete`); continue; }
      const deadline = Date.now() + wait.limit;
      let failure: string | undefined, waiting = false;
      for (let attempt = 1; ; attempt++) {
        let preparing = false;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: source, cwd: directory, messages: [{ role: 'user', content: `Reply only: grunt is ready (${source}). Do not use tools or change files. Check ${attempt}.` }], stream: false, max_tokens: 256 }),
            signal: AbortSignal.timeout(120000)
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
        if (!failure || !preparing || Date.now() + wait.interval > deadline) break;
        if (!waiting) { waiting = true; notify(`${source}: grunt is still preparing this adapter; waiting`); }
        await delay(wait.interval);
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
  '  1. Connect Trusty Squire (one Google sign-in)',
  '  2. Pull the current list of free services from the grunt registry',
  '  3. Sign up for each service, connect it to grunt and test it',
  '  4. Connect grunt to the coding tools installed here'
].join('\n');
const SQUIRE_NOTICE = [
  'Some free services only work with an account. Trusty Squire is a local',
  'browser helper that signs up for them using their supported sign-in.',
  'Most use Google; Runcrate’s card-free access needs GitHub sign-in.',
  '',
  'Next, a browser may open and ask you to sign in to Google once. If Trusty',
  'Squire is already connected on this machine, setup reuses it. A captcha or',
  'email check pauses setup until you finish it in the browser.'
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
export async function connectHarnesses(port: number, options: { harnesses?: Harness[]; choose?: (found: Harness[]) => Promise<Harness[]>; run?: typeof runHarness } = {}) {
  log.step('Connect grunt to your coding tools');
  const found = await detectHarnesses(options.harnesses);
  if (!found.length) { log.warn(`No supported coding tool found on PATH (${HARNESSES.map(h => h.binary).join(', ')}). Install one, then rerun usegrunt setup.`); return []; }
  log.info(`Found: ${found.map(h => h.name).join(', ')}. grunt is added as an extra, named option; your default model and provider stay as they are.`);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.env.MILO_SETUP_NO_HUMAN !== '1';
  const choose = options.choose ?? (async (list: Harness[]) => {
    if (!interactive) return list.filter(h => h.id === 'pi');
    const picked = await multiselect({ message: 'Connect grunt to which tools? (space toggles, enter confirms)', required: false,
      options: list.map(h => ({ value: h.id, label: h.name, hint: h.launch(port) })), initialValues: list.filter(h => h.id === 'pi').map(h => h.id) });
    return isCancel(picked) ? [] : list.filter(h => picked.includes(h.id));
  });
  const connected: Harness[] = [];
  for (const harness of await choose(found)) {
    const progress = spinner(); progress.start(`${harness.name}: adding grunt and sending a test request through it`);
    try {
      const { change } = await connectHarness(harness, port, options.run);
      progress.stop(`${harness.name}: PASS — answered through grunt`);
      if (change?.backup) log.info(`${harness.name}: previous config saved as ${change.backup}`);
      connected.push(harness);
    } catch (error) {
      progress.error(`${harness.name}: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (connected.length) note(connected.map(h => `${chalk.bold(h.name)}\n  ${h.launch(port)}`).join('\n'), 'Start coding with grunt');
  return connected;
}
const wizardActions = { installedSources, createSquire: () => new BrowserSquire(), banner, preflight, connectSquire, setup, setupFallbacks, installService, configurePi, checkService, checkFallbackServices, loadRegistry, checkServiceSources, connectHarnesses, approveDataSharing };
type Optional = 'installedSources' | 'createSquire' | 'banner' | 'loadRegistry' | 'checkServiceSources' | 'connectHarnesses' | 'configurePi' | 'approveDataSharing';
export async function wizard(add?: string, actions: Omit<typeof wizardActions, Optional> & Partial<Pick<typeof wizardActions, Optional>> = wizardActions) {
  if (add && disabledAdapters.has(add)) throw new Error(`${add} routing is disabled`);
  if (add && !Object.hasOwn(PROVIDERS, add)) throw new Error(`Choose a supported provider: ${Object.keys(PROVIDERS).join(', ')}`);
  const squire = actions.createSquire?.();
  try {
    await actions.banner?.();
    intro(chalk.hex('#f4b41a').bold('grunt') + chalk.dim(' — npx usegrunt setup'));
    note(PREAMBLE, 'What grunt does');
    await step('Checking prerequisites', () => actions.preflight());
    note(SQUIRE_NOTICE, 'Google sign-in for Trusty Squire');
    await step('Connecting Trusty Squire', () => actions.connectSquire(squire ? { squire } : {}));
    // Capture legacy API routing before default Kilo setup creates its admin file.
    const previous = ((await actions.installedSources?.())?.split(',') ?? []).filter(id => id && !disabledAdapters.has(id));
    if (add) {
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
    const notify = report();
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

    log.step(`Installing and connecting ${ids.length} vetted free services (up to ${SETUP_CONCURRENCY} at once)`);
    log.info('Trusty Squire reuses existing accounts and grants. Only free access is requested. Provider verification may still need your browser; verification prompts are queued.');
    const outcome = await actions.setupFallbacks({ directory: configDir(), run: command, adapters: ids, notify,
      ...(consent.approved.length ? { dataSharingApproved: consent.approved } : {}),
      ...(squire ? { squire, connect: () => squire.connect() } : {}) });
    unavailable.push(...outcome.unavailable);
    for (const id of ids) results.get(id)!.signup = unavailable.includes(id) ? 'fail' : 'pass';

    log.step('Connecting the services to the grunt daemon');
    await step('Starting the grunt background service', () => actions.installService([...new Set([...previous.filter(id => id === 'freellmapi'), ...ids])]));
    const port = Number(process.env.MILO_PORT || '8788');
    await step(`Waiting for grunt to answer at http://127.0.0.1:${port}`, () => actions.checkService(port));
    const beforeSources = new Set(unavailable);
    if (actions.checkServiceSources) await step('Checking which services the daemon runs', () => actions.checkServiceSources!(unavailable, notify, ids));
    for (const id of ids) results.get(id)!.daemon = beforeSources.has(id) ? 'skip' : unavailable.includes(id) ? 'fail' : 'pass';

    log.step('Testing each service with a real request through grunt');
    await parallelMap(ids, async id => {
      const before = unavailable.includes(id);
      await actions.checkFallbackServices(unavailable, port, notify, [id]);
      results.get(id)!.check = before ? 'skip' : unavailable.includes(id) ? 'fail' : 'pass';
    });
    note([`${'service'.padEnd(10)}  sign-in  daemon  test`, ...requested.map(id => {
      const r = results.get(id)!;
      return `${id.padEnd(10)}  ${mark(r.signup)}        ${mark(r.daemon)}       ${mark(r.check)}`;
    })].join('\n'), 'Free services');

    if (actions.connectHarnesses) await actions.connectHarnesses(port);
    else if (actions.configurePi) await step('Pi provider', () => actions.configurePi!(port));
    outro(unavailable.length ? `grunt is ready; incomplete fallbacks: ${unavailable.join(', ')}. Rerun setup to finish them.` : 'grunt is ready');
    if (unavailable.length) throw new Error('Some adapters failed verification. Run usegrunt setup to resume.');
  } finally { await squire?.close(); }
}
