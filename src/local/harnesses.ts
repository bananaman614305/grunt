import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { signupMcp } from './signup-mcp.js';
import type { SignupAgent } from './signup-mcp.js';
import { setupFailureReason } from './setup-failure.js';

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

const piProvider = (port: number) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
  models: [{ id: 'grunt', name: 'grunt', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });

export async function configurePi(port = 8788): Promise<Change> {
  const path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'models.json');
  const saved = await readJson(path, 'Pi models config');
  const providers = objectOrEmpty(saved.providers, 'Pi models config');
  providers.grunt = piProvider(port);
  return writeConfig(path, JSON.stringify({ ...saved, providers }, null, 2) + '\n');
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
export async function runHarness(binary: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 240000, options: { cwd?: string; signal?: AbortSignal } = {}) {
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), 'grunt-harness-check-'));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'], signal });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65536); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
      child.once('error', error => reject(new Error(error.name === 'AbortError' ? `${binary} did not answer within ${Math.round(timeoutMs / 1000)} seconds` : `Could not run ${binary}`)));
      child.once('close', code => {
        const reason = setupFailureReason(new Error(stdout + '\n' + stderr));
        if (code !== 0 || /^\s*(?:error|api error).*?(?:quota|429)/im.test(stdout)) reject(new Error(reason === 'setup failed' ? `${binary} exited with code ${code}` : reason));
        else if (!stdout.trim()) reject(new Error(`${binary} printed no answer`));
        else resolve(stdout.trim());
      });
    });
  } finally { if (!options.cwd) await rm(cwd, { recursive: true, force: true }); }
}
export async function connectHarness(harness: Harness, port: number, run = runHarness) {
  const change = await harness.configure(port);
  const check = harness.check(port);
  const answer = await run(harness.binary, check.args, check.env);
  return { change, answer };
}

export const signupHarness = (harness: Harness, port: number, run = runHarness, openCodeAnonymous = false): SignupAgent => async input => {
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
      'Use only the existing Squire-connected identity. Never type secrets or select payment, an upgrade, billing changes, another account, or unrequested consent.',
      'Accept required provider Terms of Service for this free signup. Stop if a terms control also selects a paid plan, payment, upgrade, billing change, or another account. Leave optional consent unchecked.',
      'Stop on refusal or SMS. For verification only the person can do, call operate_share, then resume operate_drive if the person finishes.',
      'Capture any requested key directly into the Squire vault. Never read or return a raw secret. Report only whether Squire completed.'
    ].join('\n');
    const write = (name: string, content: unknown) => writeFile(join(directory, name), JSON.stringify(content), { mode: 0o600 });
    let args: string[];
    switch (harness.id) {
      case 'pi':
        await write('models.json', { providers: { grunt: piProvider(port) } });
        await write('mcp.json', { mcpServers: { squire: { ...config, exposure: 'direct' } } });
        env.PI_CODING_AGENT_DIR = directory;
        args = ['-p', '--provider', 'grunt', '--model', 'grunt', '--no-session', '--no-builtin-tools', '--no-skills', '--no-context-files', prompt];
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
          permission: { '*': 'deny', 'squire_*': 'allow' }, share: 'disabled' });
        env.OPENCODE_CONFIG = join(directory, 'opencode.json');
        env.OPENCODE_CONFIG_CONTENT = undefined;
        env.XDG_CONFIG_HOME = directory;
        env.XDG_DATA_HOME = directory;
        env.XDG_STATE_HOME = directory;
        args = ['run', '--pure', '-m', openCodeAnonymous ? 'opencode/big-pickle' : 'grunt/grunt', prompt];
        break;
    }
    await run(harness.binary, args, env, 240000, { cwd: directory, signal: input.signal });
  } finally {
    endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
};
