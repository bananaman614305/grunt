import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { signupMcp } from './signup-mcp.js';
import type { SignupAgent } from './signup-mcp.js';
import { setupFailureReason, signupOperatorUnavailable } from './setup-failure.js';
import { SourceError } from './source.js';

// Writes a whole config file only when its text changes, after copying the old
// file aside. Repeated setup runs therefore leave files and backups untouched.
export async function writeConfig(path: string, text: string, mode = 0o600) {
  let old: string | undefined;
  try { old = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (old === text) return { changed: false } as const;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let backup: string | undefined;
  if (old !== undefined) {
    backup = `${path}.grunt-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(path, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary, text, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return { changed: true, backup } as const;
}
type Change = Awaited<ReturnType<typeof writeConfig>>;
const objectOrEmpty = (value: unknown, what: string) => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
};
async function readJson(path: string, what: string) {
  try { return objectOrEmpty(JSON.parse(await readFile(path, 'utf8')), what); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${what}; repair it before retrying setup`, { cause: error });
  }
}

export const PI_WORKING_CONTEXT_TOKENS = 65536;
const piProvider = (port: number, contextWindow = PI_WORKING_CONTEXT_TOKENS) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
  models: [{ id: 'grunt', name: 'grunt', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4096 }] });
interface PiContextOptions { workingContextTokens?: number; fromContextWindows?: readonly number[] }
interface PiConfigureOptions extends PiContextOptions { env?: NodeJS.ProcessEnv }
const piFailure = () => new Error('Cannot safely update Pi models config; repair its ownership, permissions or JSON before retrying setup');
const privatePiMode = (mode: number) => process.platform === 'win32' || (mode & 0o022) === 0;
function piContext(env: NodeJS.ProcessEnv, explicit?: number) {
  const setting = explicit ?? (env.GRUNT_WORKING_CONTEXT_TOKENS === undefined ? PI_WORKING_CONTEXT_TOKENS
    : /^\d+$/.test(env.GRUNT_WORKING_CONTEXT_TOKENS) ? Number(env.GRUNT_WORKING_CONTEXT_TOKENS) : NaN);
  if (!Number.isSafeInteger(setting) || setting < PI_WORKING_CONTEXT_TOKENS || setting > 200000) {
    throw new Error('GRUNT_WORKING_CONTEXT_TOKENS must be an integer from 65536 to 200000');
  }
  return setting;
}
async function piDirectory(path: string, create: boolean): Promise<boolean> {
  let current = path, missing = false;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw piFailure();
      if (current === path && ((process.getuid && info.uid !== process.getuid()) || !privatePiMode(info.mode))) throw piFailure();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw piFailure();
      if (current === path) missing = true;
    }
    const parent = dirname(current);
    if (current === parent) break;
    current = parent;
  }
  if (missing && create) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return piDirectory(path, false);
  }
  return !missing;
}
async function readPiConfig(env: NodeJS.ProcessEnv) {
  const directory = resolve(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')), path = join(directory, 'models.json');
  if (!await piDirectory(directory, false)) return { directory, path, saved: {} as Record<string, unknown>, text: undefined as string | undefined };
  let file;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw piFailure();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || !privatePiMode(info.mode) || info.size > 2 * 1024 * 1024) throw piFailure();
    const text = await file.readFile('utf8');
    return { directory, path, saved: objectOrEmpty(JSON.parse(text), 'Pi models config'), text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory, path, saved: {} as Record<string, unknown>, text: undefined as string | undefined };
    throw piFailure();
  } finally { await file?.close(); }
}
async function writePiConfig(current: Awaited<ReturnType<typeof readPiConfig>>, saved: Record<string, unknown>): Promise<Change> {
  const text = JSON.stringify(saved, null, 2) + '\n';
  if (current.text === text) return { changed: false };
  await piDirectory(current.directory, true);
  // Re-read without following links before either backing up or replacing a
  // profile. Backups use the bytes already read, never a second symlink-following copy.
  const before = await readPiConfig({ PI_CODING_AGENT_DIR: current.directory });
  if (before.text !== current.text) throw new Error('Pi models config changed during setup; retry without overwriting it');
  const suffix = `${process.pid}-${randomInt(100000, 1000000)}`;
  const temporary = `${current.path}.${suffix}.tmp`;
  let backup: string | undefined;
  try {
    if (current.text !== undefined) {
      backup = `${current.path}.grunt-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
      await writeFile(backup, current.text, { mode: 0o600, flag: 'wx' });
    }
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    const latest = await readPiConfig({ PI_CODING_AGENT_DIR: current.directory });
    if (latest.text !== current.text) throw new Error('Pi models config changed during setup; retry without overwriting it');
    await rename(temporary, current.path);
    return { changed: true, backup };
  } finally { await rm(temporary, { force: true }); }
}
function localPiProvider(value: unknown, port?: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const provider = value as Record<string, unknown>;
  if (provider.api !== 'openai-completions' || provider.apiKey !== 'local' || typeof provider.baseUrl !== 'string') return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash
      && /^\/v1\/?$/.test(url.pathname) && /^\d+$/.test(url.port) && Number(url.port) >= 1 && Number(url.port) <= 65535 && (port === undefined || Number(url.port) === port);
  } catch { return false; }
}
function managedPiModel(model: Record<string, unknown>) {
  const cost = model.cost && typeof model.cost === 'object' && !Array.isArray(model.cost) ? model.cost as Record<string, unknown> : {};
  return model.id === 'grunt' && model.name === 'grunt' && model.reasoning === false && model.maxTokens === 4096
    && Array.isArray(model.input) && model.input.length === 1 && model.input[0] === 'text'
    && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => cost[key] === 0);
}
function piModels(provider: Record<string, unknown>) {
  if (provider.models === undefined) return [] as Record<string, unknown>[];
  if (!Array.isArray(provider.models) || provider.models.some(model => !model || typeof model !== 'object' || Array.isArray(model))) throw piFailure();
  return provider.models as Record<string, unknown>[];
}
export async function configurePi(port = 8788, options: PiConfigureOptions = {}): Promise<Change> {
  const env = options.env ?? process.env, current = await readPiConfig(env), providers = objectOrEmpty(current.saved.providers, 'Pi models config');
  const previous = providers.grunt;
  if (previous !== undefined && !localPiProvider(previous)) throw new Error('An unmanaged Grunt Pi provider already exists; preserve it under another provider name before running Grunt setup');
  const provider = objectOrEmpty(previous, 'Grunt Pi provider'), models = piModels(provider), primary = models.filter(model => model.id === 'grunt');
  if (primary.length > 1) throw piFailure();
  if (previous !== undefined && (primary.length !== 1 || primary[0]!.name !== 'grunt')) {
    throw new Error('An unmanaged Grunt Pi model already exists; preserve it under another provider name before running Grunt setup');
  }
  const explicit = options.workingContextTokens !== undefined || env.GRUNT_WORKING_CONTEXT_TOKENS !== undefined;
  const contextWindow = piContext(env, options.workingContextTokens), generated = piProvider(port, contextWindow);
  const merged = models.map(model => model.id !== 'grunt' ? model : { ...model,
    ...(explicit || managedPiModel(model) && model.contextWindow === 128000 ? { contextWindow } : {}) });
  if (!primary.length) merged.push(generated.models[0]!);
  return writePiConfig(current, { ...current.saved, providers: { ...providers, grunt: { ...provider, ...generated, models: merged } } });
}
/** Update only an existing managed profile on this daemon's endpoint. */
export async function migrateManagedPiWorkingContext(port: number, env: NodeJS.ProcessEnv = process.env, options: PiContextOptions = {}): Promise<Change> {
  const target = piContext(env, options.workingContextTokens), current = await readPiConfig(env);
  if (current.text === undefined) return { changed: false };
  const providers = objectOrEmpty(current.saved.providers, 'Pi models config'), provider = providers.grunt;
  if (!localPiProvider(provider, port)) return { changed: false };
  const selected = provider as Record<string, unknown>, models = piModels(selected), primary = models.filter(model => model.id === 'grunt');
  if (primary.length !== 1) return { changed: false };
  const model = primary[0]!, from = options.fromContextWindows ?? [128000];
  if (!managedPiModel(model) || typeof model.contextWindow !== 'number' || !from.includes(model.contextWindow) || model.contextWindow === target) return { changed: false };
  return writePiConfig(current, { ...current.saved, providers: { ...providers, grunt: { ...selected,
    models: models.map(item => item === model ? { ...item, contextWindow: target } : item) } } });
}
// Codex layers $CODEX_HOME/<name>.config.toml over config.toml for `codex --profile <name>`,
// so grunt gets its own file and the user's config.toml is never edited.
export const codexProfilePath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'grunt.config.toml');
export async function configureCodex(port = 8788): Promise<Change> {
  return writeConfig(codexProfilePath(), `# Written by usegrunt setup for \`codex --profile grunt\`. Your config.toml is unchanged.
model = "grunt"
model_provider = "grunt"

[model_providers.grunt]
name = "grunt"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
`);
}
const openCodeProvider = (port: number) => ({ name: 'grunt', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local' }, models: { grunt: { name: 'grunt' } } });
export const opencodeConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
// Adds a grunt provider and leaves OpenCode's default model alone; pick it with /models.
export async function configureOpenCode(port = 8788): Promise<Change> {
  const directory = opencodeConfigDir();
  const path = join(directory, 'opencode.jsonc');
  let jsonc: string | undefined;
  try { jsonc = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (jsonc !== undefined) {
    const errors: Parameters<typeof parse>[1] = [];
    const saved = parse(jsonc, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Cannot read OpenCode JSONC config');
    const providers = objectOrEmpty(objectOrEmpty(saved, 'OpenCode JSONC config').provider, 'OpenCode JSONC providers');
    if (JSON.stringify(providers.grunt) === JSON.stringify(openCodeProvider(port))) return { changed: false };
    return writeConfig(path, applyEdits(jsonc, modify(jsonc, ['provider', 'grunt'], openCodeProvider(port), { formattingOptions: { insertSpaces: true, tabSize: 2 } })));
  }
  const json = join(directory, 'opencode.json');
  const saved = await readJson(json, 'OpenCode config');
  const provider = objectOrEmpty(saved.provider, 'OpenCode config');
  provider.grunt = openCodeProvider(port);
  return writeConfig(json, JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...saved, provider }, null, 2) + '\n');
}

// Free services refuse a message repeated word for word as automated use, so each check differs.
const prompt = (tool: string) => `Reply only: grunt is ready for ${tool} (check ${randomInt(1000, 10000)}). Do not use tools or change files.`;
export interface Harness {
  id: 'pi' | 'codex' | 'opencode' | 'claude';
  name: string;
  binary: string;
  configure(port: number): Promise<Change | undefined>;
  // One non-interactive request through the harness itself.
  check(port: number): { args: string[]; env?: Record<string, string | undefined> };
  launch(port: number): string;
}
export const HARNESSES: Harness[] = [
  { id: 'pi', name: 'Pi', binary: 'pi', configure: configurePi,
    check: () => ({ args: ['-p', '--provider', 'grunt', '--model', 'grunt', '--no-session', prompt('Pi')] }),
    launch: () => 'pi --provider grunt --model grunt   (or open /model in pi and choose grunt)' },
  { id: 'codex', name: 'Codex', binary: 'codex', configure: configureCodex,
    check: port => ({ args: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-c', 'model="grunt"',
      '-c', 'model_provider="grunt"', '-c', 'model_providers.grunt.name="grunt"', '-c', 'model_providers.grunt.wire_api="responses"',
      '-c', `model_providers.grunt.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.grunt.request_max_retries=0', prompt('Codex')] }),
    launch: () => 'codex --profile grunt' },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', configure: configureOpenCode,
    // grunt's own OpenCode source sets OPENCODE_CONFIG; check the user's config without it.
    check: () => ({ args: ['run', '--pure', '-m', 'grunt/grunt', prompt('OpenCode')], env: { OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined } }),
    launch: () => 'opencode -m grunt/grunt   (or pick grunt with /models)' },
  { id: 'claude', name: 'Claude Code', binary: 'claude', configure: async () => undefined,
    check: port => ({ args: ['-p', '--model', 'grunt', prompt('Claude Code')], env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'local' } }),
    launch: port => `ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_AUTH_TOKEN=local claude --model grunt` }
];

export async function onPath(binary: string, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try { await access(join(directory, binary), constants.X_OK); return true; } catch { /* Try the next PATH entry. */ }
  }
  return false;
}
export async function detectHarnesses(harnesses = HARNESSES) {
  const found = await Promise.all(harnesses.map(harness => onPath(harness.binary)));
  return harnesses.filter((_, index) => found[index]);
}
const FREE_LIMIT = /FreeUsageLimitError|Free usage limit reached|free_tier_limit/;
// OpenCode's --print-logs line for a failed main-model request, which it then
// retries: the driver has stopped making progress, so hand off now.
const STREAM_ERROR = /level=ERROR\b(?![^\n]*\bsmall=true)[^\n]*message="stream error"/;
export async function runHarness(binary: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 240000, options: { cwd?: string; signal?: AbortSignal } = {}) {
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), 'grunt-harness-check-'));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const running = spawn(binary, args, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'], signal });
      child = running;
      closed = new Promise<void>(done => running.once('close', () => done()));
      let stdout = '', stderr = '', limited = false;
      // OpenCode retries its free limit until the next UTC day, and other failed
      // model requests with backoff; fail fast instead.
      const watch = (text: string) => {
        const quota = FREE_LIMIT.test(text);
        if (limited || (!quota && !STREAM_ERROR.test(text))) return;
        limited = true;
        running.kill();
        reject(quota ? new Error('quota exhausted: free usage limit reached') : new SourceError('upstream', `${binary} model request failed`));
      };
      running.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65536); watch(stdout); });
      running.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); watch(stderr); });
      running.once('error', error => reject(new Error(error.name === 'AbortError' ? `${binary} did not answer within ${Math.round(timeoutMs / 1000)} seconds` : `Could not run ${binary}`)));
      running.once('close', code => {
        const reason = setupFailureReason(new Error(stdout + '\n' + stderr));
        // A failed exit that prints the model's own error names it: a rate limit
        // or payment wall is quota, and a provider 5xx is a failed request.
        const reported = reason !== 'setup failed' ? reason
          : /\b(?:ModelNotFoundError|ProviderModelNotFoundError|model_not_found)\b/.test(stderr + stdout) ? 'model pool unavailable'
          : /\b(?:402|payment required|rate.?limit(?:ed)?|too many requests)\b/i.test(stderr + stdout) ? 'quota exhausted'
            : /\b(?:50[0-4]|bad gateway|service unavailable|internal server error|overloaded)\b/i.test(stderr + stdout) ? 'provider request failed' : undefined;
        if (code !== 0 || /^\s*(?:error|api error).*?(?:quota|429)/im.test(stdout)) {
          reject(reported === 'provider request failed' ? new SourceError('upstream', `${binary} model request failed`) : new Error(reported ?? `${binary} exited with code ${code}`));
        }
        else if (!stdout.trim()) reject(new Error(`${binary} printed no answer`));
        else resolve(stdout.trim());
      });
    });
  } finally {
    // Abort and quota detection can reject before a CLI exits. OpenCode may
    // ignore SIGTERM; reap it before removing its temporary configuration.
    if (child && closed) {
      const running = child;
      const timer = setTimeout(() => running.kill('SIGKILL'), 2000);
      try {
        if (running.exitCode === null && running.signalCode === null) running.kill();
        await closed;
      } finally { clearTimeout(timer); }
    }
    if (!options.cwd) await rm(cwd, { recursive: true, force: true });
  }
}
export async function connectHarness(harness: Harness, port: number, run = runHarness) {
  const change = await harness.configure(port);
  const check = harness.check(port);
  const answer = await run(harness.binary, check.args, check.env);
  return { change, answer };
}

// A free model an installed harness CLI reaches on its own, as `provider/id`.
export interface FreeModel { harness: 'opencode' | 'pi'; model: string }
const splitModel = (model: string) => { const slash = model.indexOf('/'); return [model.slice(0, slash), model.slice(slash + 1)] as const; };
const loopbackURL = (value: unknown) => {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(value)).hostname); } catch { return false; }
};
// The person's own Pi providers, copied into a private temporary agent directory
// so Pi runs without their extensions, sessions or MCP servers. OAuth entries stay
// behind: Pi may rotate a refresh token, which must happen only in the real file.
// Read as Pi itself reads them; Grunt never writes these files here.
async function ownPiConfig(directory: string) {
  const agent = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  const read = async (name: string) => {
    try { return objectOrEmpty(JSON.parse(await readFile(join(agent, name), 'utf8')), `Pi ${name}`); } catch { return {}; }
  };
  const [models, auth] = await Promise.all([read('models.json'), read('auth.json')]);
  const keys = Object.fromEntries(Object.entries(auth).filter(([, value]) => (value as { type?: unknown } | null)?.type === 'api_key'));
  await writeFile(join(directory, 'models.json'), JSON.stringify(models), { mode: 0o600 });
  await writeFile(join(directory, 'auth.json'), JSON.stringify(keys), { mode: 0o600 });
  const providers = models.providers;
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers as Record<string, unknown> : {};
}
// Anonymous OpenCode: the signup driver's own config and data stay in this directory.
const openCodeAlone = (directory: string) => ({ OPENCODE_API_KEY: undefined, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, XDG_STATE_HOME: directory });
const piArgs = (model: string) => { const [provider, id] = splitModel(model); return ['-p', '--provider', provider, '--model', id, '--no-session', '--no-builtin-tools', '--no-skills', '--no-context-files']; };
async function inTemporary<T>(use: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-free-model-'));
  try { return await use(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
/**
 * Lists the free models installed harness CLIs reach on their own (docs/router.md):
 * OpenCode's anonymous free models, then the free models of the person's Pi providers.
 */
export async function listFreeModels(reach: { openCode: boolean; pi: boolean }, run = runHarness, signal?: AbortSignal): Promise<FreeModel[]> {
  signal?.throwIfAborted();
  const found: FreeModel[] = [];
  if (reach.openCode) {
    // Anonymous OpenCode lists only the free models it can reach.
    const text = await inTemporary(directory => {
      signal?.throwIfAborted();
      return run('opencode', ['models', 'opencode'], openCodeAlone(directory), 45000, { cwd: directory, ...(signal ? { signal } : {}) });
    }).catch(() => { signal?.throwIfAborted(); return ''; });
    const models = text.split('\n').map(line => line.trim()).filter(line => /^opencode\/\S+$/.test(line) && !/google|gemini|gemma/i.test(line));
    // Big Pickle is OpenCode's long-standing anonymous model: first, and the
    // fallback when the CLI cannot list its catalog.
    const ordered = ['opencode/big-pickle', ...models.filter(model => model !== 'opencode/big-pickle')];
    found.push(...ordered.map(model => ({ harness: 'opencode' as const, model })));
  }
  signal?.throwIfAborted();
  if (reach.pi) {
    await inTemporary(async directory => {
      const providers = await ownPiConfig(directory);
      signal?.throwIfAborted();
      const text = await run('pi', ['--offline', '--list-models'], { PI_CODING_AGENT_DIR: directory }, 45000, { cwd: directory, ...(signal ? { signal } : {}) });
      for (const line of text.split('\n').slice(1)) {
        const [provider, id] = line.trim().split(/\s+/);
        if (!provider || !id || !/[:-]free$/.test(id) || /google|gemini|gemma/i.test(`${provider}/${id}`)) continue;
        // A provider on this machine (Grunt itself) is not a model of Pi's own.
        if (loopbackURL((providers[provider] as { baseUrl?: unknown } | undefined)?.baseUrl)) continue;
        found.push({ harness: 'pi', model: `${provider}/${id}` });
      }
    }).catch(() => { signal?.throwIfAborted(); });
  }
  signal?.throwIfAborted();
  return found;
}
// One short request on a free model, in the same isolated configuration a signup uses.
export const probeFreeModel = (free: FreeModel, signal?: AbortSignal, run = runHarness) => inTemporary(async directory => {
  if (free.harness === 'opencode') return run('opencode', ['run', '--pure', '--print-logs', '-m', free.model, prompt('OpenCode')], openCodeAlone(directory), 45000, { cwd: directory, ...(signal ? { signal } : {}) });
  await ownPiConfig(directory);
  return run('pi', [...piArgs(free.model), prompt('Pi')], { PI_CODING_AGENT_DIR: directory }, 45000, { cwd: directory, ...(signal ? { signal } : {}) });
});

// `model` runs OpenCode or Pi on a free model it reaches on its own instead of on model grunt.
export const signupHarness = (harness: Harness, port: number, run = runHarness, model?: string): SignupAgent => async input => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-signup-'));
  const endpoint = await signupMcp(input);
  try {
    const headers = { Authorization: `Bearer ${endpoint.authorization}` };
    const config = { url: endpoint.url, headers };
    const env: Record<string, string | undefined> = {};
    const prompt = [
      `Set up the free ${input.service} provider at ${new URL(input.url).origin}.`, input.goal,
      'Call Squire operate_drive first. If Jev is unsure or needs a value, observe the current page and choose an offered answer or take one observed browser step. Resume operate_drive.',
      'On OAuth not_attempted or Retry oauth_login, wait and retry. Never repeat a dispatched OAuth click.',
      'Use only the existing Squire-connected identity. Never type secrets or select payment, an upgrade or billing changes.',
      'Accept required provider Terms of Service for this free signup. Stop if a terms control also selects a paid plan, payment, upgrade, billing change, or another account. Leave optional consent unchecked.',
      'Stop on refusal. For verification only the person can do, call operate_share, then resume operate_drive if the person finishes.',
      'Capture any requested key directly into the Squire vault with operate_extract store. If no value is found, pass capture {store, source: {role: "textbox" or "code", name}} for the revealed key field; if storage is unresolved, retry with the returned capture write_id. Never read or return a raw secret. Report only whether Squire completed.',
      'When operate_drive returns status complete, Squire has already stored any requested key in the vault: stop calling tools and report completion. Use operate_extract only when Squire says a key was not stored.'
    ].join('\n');
    const write = (name: string, content: unknown) => writeFile(join(directory, name), JSON.stringify(content), { mode: 0o600 });
    let args: string[];
    switch (harness.id) {
      case 'pi':
        if (model) await ownPiConfig(directory);
        else await write('models.json', { providers: { grunt: piProvider(port) } });
        await write('mcp.json', { mcpServers: { squire: { ...config, exposure: 'direct' } } });
        env.PI_CODING_AGENT_DIR = directory;
        args = [...piArgs(model ?? 'grunt/grunt'), prompt];
        break;
      case 'claude':
        await write('mcp.json', { mcpServers: { squire: { type: 'http', ...config } } });
        env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
        env.ANTHROPIC_AUTH_TOKEN = 'local';
        env.ANTHROPIC_API_KEY = undefined;
        args = ['-p', '--model', 'grunt', '--tools', '', '--strict-mcp-config', '--mcp-config', join(directory, 'mcp.json'), '--allowedTools', 'mcp__squire__*', '--no-session-persistence', '--', prompt];
        break;
      case 'codex':
        await writeFile(join(directory, 'config.toml'), [
          'model = "grunt"', 'model_provider = "grunt"', 'approval_policy = "never"', 'web_search = "disabled"',
          '[features]', 'shell_tool = false', 'multi_agent = false', 'goals = false', 'plugins = false', '[model_providers.grunt]', 'name = "grunt"', 'wire_api = "responses"',
          `base_url = "http://127.0.0.1:${port}/v1"`, '[mcp_servers.squire]', `url = "${endpoint.url}"`,
          'bearer_token_env_var = "GRUNT_SIGNUP_MCP_TOKEN"', 'default_tools_approval_mode = "approve"'
        ].join('\n'), { mode: 0o600 });
        env.GRUNT_SIGNUP_MCP_TOKEN = endpoint.authorization;
        env.CODEX_HOME = directory;
        args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', prompt];
        break;
      case 'opencode':
        await write('opencode.json', { provider: { grunt: openCodeProvider(port) }, mcp: { squire: { type: 'remote', ...config } },
          // OpenCode's free tier refuses requests that carry none of its own tools,
          // so keep read; outside this temporary directory it stays denied.
          permission: { '*': 'deny', read: 'allow', 'squire_*': 'allow' }, share: 'disabled' });
        Object.assign(env, openCodeAlone(directory));
        env.OPENCODE_CONFIG = join(directory, 'opencode.json');
        // --print-logs puts OpenCode's free-limit error on stderr, so runHarness can stop at once.
        args = ['run', '--pure', '--print-logs', '-m', model ?? 'grunt/grunt', prompt];
        break;
    }
    await run(harness.binary, args, env, 240000, { cwd: directory, signal: input.signal });
  } finally {
    endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
};
const freeModelSignup = (free: FreeModel, port: number, run = runHarness) => signupHarness(HARNESSES.find(harness => harness.id === free.harness)!, port, run, free.model);
// Hands the same signup to the next driver when one cannot run (no model, quota,
// upstream failure, unavailable CLI); the last driver's failure is returned.
// A driver that made no tool call is replaced by a fresh start. Once one has
// acted, the next continues the same Squire signup session and never starts over.
const SIGNUP_HANDOFF = 'Another driver already worked on this signup in the same Squire browser session. Continue it from the current page with operate_drive; never start the signup over or create another account.';
export const nextDriver = (first: SignupAgent, ...rest: SignupAgent[]): SignupAgent => async input => {
  let acted = false;
  const tracked = { ...input, call: (name: string, args: Parameters<typeof input.call>[1]) => { acted = true; return input.call(name, args); } };
  for (const [index, driver] of [first, ...rest].entries()) {
    try { return await driver(acted ? { ...tracked, goal: `${input.goal}\n${SIGNUP_HANDOFF}` } : tracked); }
    catch (error) {
      input.signal.throwIfAborted();
      if (index === rest.length || !signupOperatorUnavailable(setupFailureReason(error))) throw error;
    }
  }
};
/**
 * The daemon's signup driver (docs/router.md): the first harness on model grunt
 * while an open tool-capable route can take it, then every free model an
 * installed harness CLI reaches on its own. Undefined means Squire drives alone.
 */
export async function signupDriver(port: number, options: { routed: boolean; openCode: boolean; list?: typeof listFreeModels; run?: typeof runHarness }): Promise<SignupAgent | undefined> {
  const [harness] = options.routed ? await detectHarnesses() : [];
  const routed = harness ? signupHarness(harness, port, options.run) : undefined;
  const reach = { openCode: options.openCode && await onPath('opencode'), pi: await onPath('pi') };
  // Listed when a signup needs it, so a pass with a working route never runs the CLIs.
  const free: SignupAgent | undefined = reach.openCode || reach.pi ? async input => {
    const [first, ...rest] = (await (options.list ?? listFreeModels)(reach, options.run, input.signal)).map(model => freeModelSignup(model, port, options.run));
    if (!first) throw new Error('Free harness model pool unavailable');
    await nextDriver(first, ...rest)(input);
  } : undefined;
  return routed && free ? nextDriver(routed, free) : routed ?? free;
}
