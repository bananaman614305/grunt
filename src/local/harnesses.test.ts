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
it('OpenCode: adds Grunt to JSONC and preserves comments and settings', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-opencode-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  await mkdir(join(dir, 'opencode'));
  const path = join(dir, 'opencode', 'opencode.jsonc');
  const existing = '// mine\n{ "default_agent": "build", }';
  await writeFile(path, existing);
  const change = await configureOpenCode(19878);
  expect(change.changed).toBe(true);
  expect(await readFile(path, 'utf8')).toMatch(/\/\/ mine[\s\S]*default_agent[\s\S]*19878/);
  expect(change.changed && change.backup && await readFile(change.backup, 'utf8')).toBe(existing);
  await expect(configureOpenCode(19878)).resolves.toEqual({ changed: false });
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
  await expect(runHarness('claude', [])).rejects.toThrow('claude exited with code 3');
});

it('mounts Squire for a headless harness using only its temporary configuration', async () => {
  const { signupHarness } = await import('./harnesses.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { Ajv } = await import('ajv');
  const { stat } = await import('node:fs/promises');
  const harness = HARNESSES.find(h => h.id === 'pi')!;
  const invoke = vi.fn(async () => ({ status: 'low_confidence' }));
  let directory = '';
  await signupHarness(harness, 19878, async (_binary, args, env) => {
    directory = env.PI_CODING_AGENT_DIR!;
    expect(args).toContain('--no-builtin-tools');
    expect(args.at(-1)).toContain('Accept required provider Terms of Service');
    expect(args.at(-1)).toContain('terms control also selects a paid plan');
    const config = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
    const { url, headers } = config.mcpServers.squire;
    expect((await stat(join(directory, 'mcp.json'))).mode & 0o777).toBe(0o600);
    const client = new Client({ name: 'fake-harness', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual(['operate_drive', 'operate_click']);
      // Kilo validates every schema before it sends even the first drive call.
      const ajv = new Ajv({ strict: true });
      const click = ajv.compile(tools[1]!.inputSchema);
      expect(click({ ref: 'observed-control' })).toBe(true);
      expect(click({ screenshot: { screenshot_id: 'synthetic' } })).toBe(false);
      expect(await client.callTool({ name: 'operate_drive', arguments: {} })).toMatchObject({ content: [{ text: '{"status":"low_confidence"}' }] });
    } finally { await client.close(); }
    return 'untrusted harness text';
  })({ service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal,
    tools: [
      { name: 'operate_drive', inputSchema: { type: 'object' } },
      { name: 'operate_click', inputSchema: { type: 'object', properties: {
        session_id: { type: 'string' }, ref: { type: 'string' },
        screenshot: { type: 'object', properties: { screenshot_id: { type: 'string', format: 'uuid' } } }
      }, required: ['session_id'] } }
    ], call: invoke });
  expect(invoke).toHaveBeenCalledWith('operate_drive', {});
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
