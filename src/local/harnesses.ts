import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

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

export async function configurePi(port = 8788): Promise<Change> {
  const path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'models.json');
  const saved = await readJson(path, 'Pi models config');
  const providers = objectOrEmpty(saved.providers, 'Pi models config');
  providers.grunt = { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
    models: [{ id: 'grunt', name: 'grunt', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] };
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
export const opencodeConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
// Adds a grunt provider and leaves OpenCode's default model alone; pick it with /models.
export async function configureOpenCode(port = 8788): Promise<Change> {
  const directory = opencodeConfigDir(), path = join(directory, 'opencode.json');
  try { await access(path); }
  catch {
    try { await access(join(directory, 'opencode.jsonc')); throw new Error(`OpenCode uses ${join(directory, 'opencode.jsonc')}, which setup does not edit. Add the grunt provider by hand: see the README`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const saved = await readJson(path, 'OpenCode config');
  const provider = objectOrEmpty(saved.provider, 'OpenCode config');
  provider.grunt = { name: 'grunt', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local' }, models: { grunt: { name: 'grunt' } } };
  return writeConfig(path, JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...saved, provider }, null, 2) + '\n');
}

const PROMPT = 'Reply only: grunt is ready. Do not use tools or change files.';
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
    check: () => ({ args: ['-p', '--provider', 'grunt', '--model', 'grunt', '--no-session', PROMPT] }),
    launch: () => 'pi --provider grunt --model grunt   (or open /model in pi and choose grunt)' },
  { id: 'codex', name: 'Codex', binary: 'codex', configure: configureCodex,
    check: () => ({ args: ['exec', '--profile', 'grunt', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', PROMPT] }),
    launch: () => 'codex --profile grunt' },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', configure: configureOpenCode,
    // grunt's own OpenCode source sets OPENCODE_CONFIG; check the user's config without it.
    check: () => ({ args: ['run', '-m', 'grunt/grunt', PROMPT], env: { OPENCODE_CONFIG: undefined } }),
    launch: () => 'opencode -m grunt/grunt   (or pick grunt with /models)' },
  { id: 'claude', name: 'Claude Code', binary: 'claude', configure: async () => undefined,
    check: port => ({ args: ['-p', '--model', 'grunt', PROMPT], env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'local' } }),
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
export async function runHarness(binary: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 240000) {
  const cwd = await mkdtemp(join(tmpdir(), 'grunt-harness-check-'));
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(timeoutMs) });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65536); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
      child.once('error', error => reject(new Error(error.name === 'AbortError' ? `${binary} did not answer within ${Math.round(timeoutMs / 1000)} seconds` : `Could not run ${binary}`)));
      child.once('close', code => {
        const lastLine = (text: string) => text.trim().split('\n').at(-1)?.slice(0, 200);
        if (code !== 0) reject(new Error(`${binary} exited with code ${code}${lastLine(stderr) ? `: ${lastLine(stderr)}` : ''}`));
        else if (!stdout.trim()) reject(new Error(`${binary} printed no answer`));
        else resolve(stdout.trim());
      });
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
export async function connectHarness(harness: Harness, port: number, run = runHarness) {
  const change = await harness.configure(port);
  const check = harness.check(port);
  const answer = await run(harness.binary, check.args, check.env);
  return { change, answer };
}
