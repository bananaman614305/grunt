import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { intro, outro, multiselect, isCancel, spinner, log } from '@clack/prompts';
import chalk from 'chalk';
import { BrowserSquire, PROVIDERS, setup, squireEnvironment } from './setup.js';

export const configDir = () => process.env.MILO_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo');
export async function command(binary: string, args: string[], interactive = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: interactive ? 'inherit' : 'ignore' });
    child.once('error', () => reject(new Error(`Could not run ${binary}`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} failed; inspect its service status before retrying`)));
  });
}
async function step<T>(label: string, task: () => Promise<T>): Promise<T> {
  const progress = spinner(); progress.start(label);
  try { const result = await task(); progress.stop(label); return result; }
  catch (error) { progress.stop(`${label} failed`); throw error; }
}
export async function squireSessionExists() {
  const sessionModule = join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'session.js');
  const program = `const {openSessionStorage} = await import(${JSON.stringify(pathToFileURL(sessionModule).href)}); process.stdout.write((await (await openSessionStorage()).read()) ? 'present' : 'missing');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { env: squireEnvironment(), timeout: 10000 });
  return result.stdout === 'present';
}
export async function connectSquire(options: { hasSession?: () => Promise<boolean>; run?: typeof command; installer?: string } = {}) {
  const run = options.run || command;
  if (!await (options.hasSession || squireSessionExists)()) {
    if (process.env.MILO_SETUP_NO_HUMAN === '1') throw new Error('Squire login needs human verification; stopped before onboarding');
    // The bundled installer owns account creation and broker service installation.
    const bin = options.installer || join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
    await run(process.execPath, [bin, 'connect', '--target=opencode', '--json'], true);
  }
  const squire = new BrowserSquire();
  try { await squire.connect(); } finally { await squire.close(); }
}
export async function preflight(run = command) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || major >= 25) throw new Error('Install Node.js 22 or 24 LTS, then run npx usemilo setup.');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Run setup on Linux with systemd or macOS with launchd.');
  for (const [binary, args, fix] of [
    ['npm', ['--version'], 'Install Node.js 22 or 24 LTS including npm.'],
    ['pi', ['--version'], 'Run npm install --global @mariozechner/pi-coding-agent.'],
    ['tar', ['--version'], 'Install tar using your system package manager.']
  ] as const) {
    try { await run(binary, [...args]); } catch { throw new Error(fix + ' Then run npx usemilo setup.'); }
  }
  if (process.env.MILO_ROUTER_RUNTIME === 'docker') {
    try { await run('docker', ['info']); } catch { throw new Error('Install and start Docker Desktop, then run npx usemilo setup.'); }
  }
  try {
    if (process.platform === 'linux') await run('systemctl', ['--user', 'show-environment']);
    else await run('launchctl', ['print', `gui/${process.getuid!()}`]);
  } catch { throw new Error('Start a normal user login with its systemd/launchd service manager, then run npx usemilo setup.'); }
}
export async function configurePi(port = 8788) {
  const directory = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const path = join(directory, 'models.json');
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Pi models config; repair it before retrying setup'); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || (saved.providers !== undefined && (!saved.providers || typeof saved.providers !== 'object' || Array.isArray(saved.providers)))) throw new Error('Invalid Pi models config');
  const providers = (saved.providers ?? {}) as Record<string, unknown>;
  providers.milo = { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
    models: [{ id: 'milo', name: 'Milo', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...saved, providers }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
const systemdQuote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\n', '\\n') + '"';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export async function installService() {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Milo background service requires systemd or launchd');
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
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid Milo service port');
  const env: Record<string, string> = { MILO_FREELLMAPI_URL: process.env.MILO_FREELLMAPI_URL || 'http://127.0.0.1:3001/v1', MILO_CONFIG_DIR: directory, MILO_PORT: port, MILO_SOURCES: 'freellmapi,opencode', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  await installBackgroundService('milo', entry, env);
}
export async function installBackgroundService(name: string, entry: string, env: Record<string, string>) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid service name');
  if (process.platform === 'linux') {
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    await mkdir(units, { recursive: true });
    await writeFile(join(units, `${name}.service`), `[Unit]\nDescription=Milo model service\nAfter=network-online.target\n\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(entry)}\n${Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
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
export async function checkService(port = 8788) {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Wait for the service manager. */ }
    await delay(1000);
  }
  if (!ready) throw new Error('Milo service did not start; inspect its service status');
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freellmapi', messages: [{ role: 'user', content: 'Reply with Milo is ready.' }], stream: false, max_tokens: 256 }), signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Milo service live check failed (HTTP ${response.status})`);
  const result = await response.json() as { choices?: { message?: { content?: string } }[] };
  if (!result.choices?.[0]?.message?.content?.trim()) throw new Error('Milo service returned no answer');
}
export async function wizard(add?: string) {
  if (add && !Object.hasOwn(PROVIDERS, add)) throw new Error(`Choose a supported provider: ${Object.keys(PROVIDERS).join(', ')}`);
  intro(chalk.hex('#cf3a52').bold('Milo') + chalk.dim(' — npx usemilo setup'));
  await step('Prerequisites', () => preflight());
  await step('Trusty Squire', () => connectSquire());
  let providers = add ? [add] : undefined;
  if (!providers) {
    const selected = await multiselect({ message: 'Choose your providers', options: Object.keys(PROVIDERS).map(value => ({ value, label: value === 'groq' ? 'Groq' : 'Cerebras' })), initialValues: ['groq'], required: true });
    if (isCancel(selected)) throw new Error('Milo setup cancelled');
    providers = selected;
  }
  await step('FreeLLMAPI and provider grants', () => setup(line => log.info(line), providers));
  if (add) { outro(`${add} connected`); return; }
  await step('OpenCode fallback', async () => {
    try { await command('opencode', ['--version']); }
    catch { await command('npm', ['install', '--global', 'opencode-ai'], true); }
  });
  await step('Milo background service', installService);
  const port = Number(process.env.MILO_PORT || '8788');
  await step('Pi provider', () => configurePi(port));
  await step('Live request through Milo service', () => checkService(port));
  outro('Milo is ready');
  log.info('Run pi, open /model, and choose milo.');
}
