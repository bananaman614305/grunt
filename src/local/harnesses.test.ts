import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HARNESSES, configureCodex, configureOpenCode, configurePi, connectHarness, detectHarnesses, runHarness } from './harnesses.js';

let dir: string;
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
const backups = async (directory: string) => (await readdir(directory)).filter(name => name.includes('.grunt-backup-'));

it.each([
  ['Pi', 'PI_CODING_AGENT_DIR', '', 'models.json', configurePi, { defaultProvider: 'anthropic', providers: { anthropic: { apiKey: 'keep' } } }],
  ['OpenCode', 'XDG_CONFIG_HOME', 'opencode', 'opencode.json', configureOpenCode, { model: 'anthropic/claude', provider: { anthropic: { options: {} } } }]
] as const)('%s: adds grunt once, backs up the old file and keeps the default model and provider', async (_name, variable, sub, file, configure, saved) => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-harness-test-'));
  vi.stubEnv(variable, dir);
  const folder = join(dir, sub), path = join(folder, file);
  await mkdir(folder, { recursive: true });
  await writeFile(path, JSON.stringify(saved));
  const first = await configure(19878);
  expect(first.changed).toBe(true);
  expect(JSON.parse(await readFile(first.changed ? first.backup! : '', 'utf8'))).toEqual(saved);
  const written = JSON.parse(await readFile(path, 'utf8'));
  expect(written).toMatchObject(saved);
  expect(JSON.stringify(written)).toContain('http://127.0.0.1:19878/v1');
  expect(await configure(19878)).toEqual({ changed: false });
  expect(await backups(folder)).toHaveLength(1);
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(written, null, 2) + '\n');
});
it('Codex: writes only its own grunt profile file and never edits config.toml', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-codex-test-'));
  vi.stubEnv('CODEX_HOME', dir);
  const user = 'model = "gpt-5"\nmodel_provider = "openai"\n';
  await writeFile(join(dir, 'config.toml'), user);
  expect((await configureCodex(19878)).changed).toBe(true);
  expect(await configureCodex(19878)).toEqual({ changed: false });
  const profile = await readFile(join(dir, 'grunt.config.toml'), 'utf8');
  expect(profile).toContain('base_url = "http://127.0.0.1:19878/v1"');
  expect(profile).toContain('wire_api = "responses"');
  expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(user);
  expect(await backups(dir)).toEqual([]);
  expect((await configureCodex(19879)).changed).toBe(true);
  expect(await backups(dir)).toHaveLength(1);
});
it('OpenCode: leaves an opencode.jsonc config untouched', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-opencode-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  await mkdir(join(dir, 'opencode'));
  await writeFile(join(dir, 'opencode', 'opencode.jsonc'), '// mine\n{}');
  await expect(configureOpenCode()).rejects.toThrow('which setup does not edit');
  expect(await readdir(join(dir, 'opencode'))).toEqual(['opencode.jsonc']);
});
it('detects harnesses on PATH and checks one with a real non-interactive run', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-path-test-'));
  const claude = join(dir, 'claude');
  await writeFile(claude, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN }));\n`);
  await chmod(claude, 0o755);
  vi.stubEnv('PATH', dir);
  expect((await detectHarnesses()).map(h => h.id)).toEqual(['claude']);
  const { change, answer } = await connectHarness(HARNESSES.find(h => h.id === 'claude')!, 19878);
  expect(change).toBeUndefined();
  expect(JSON.parse(answer)).toMatchObject({ args: ['-p', '--model', 'grunt', expect.any(String)], base: 'http://127.0.0.1:19878', token: 'local' });
  await writeFile(claude, `#!${process.execPath}\nconsole.error('no route'); process.exit(3);\n`);
  await expect(runHarness('claude', [])).rejects.toThrow('claude exited with code 3: no route');
});
