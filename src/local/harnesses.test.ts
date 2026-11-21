import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HARNESSES, configureCodex, configureOpenCode, configurePi, connectHarness, detectHarnesses, migrateManagedPiWorkingContext, runHarness } from './harnesses.js';

let dir: string;
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
const backups = async (directory: string) => (await readdir(directory)).filter(name => name.includes('.grunt-backup-'));
const managedPi = (port = 19878, contextWindow = 128000) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
  models: [{ id: 'grunt', name: 'grunt', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4096 }] });
async function piFixture(provider = managedPi()) {
  dir = await mkdtemp(join(tmpdir(), 'grunt-pi-context-test-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const path = join(dir, 'models.json'), env = { PI_CODING_AGENT_DIR: dir };
  const saved = { defaultProvider: 'other', defaultModel: 'keep', providers: { other: { apiKey: 'synthetic-other-key' }, grunt: provider } };
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  return { path, env, saved };
}

it('Pi: uses an efficient working window without changing global compaction settings', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-pi-context-default-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const env = { PI_CODING_AGENT_DIR: dir }, settings = '{"defaultProvider":"other","compaction":{"keepRecentTokens":12000}}';
  await writeFile(join(dir, 'settings.json'), settings, { mode: 0o600 });
  await configurePi(19878, { env });
  const written = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'));
  expect(written.providers.grunt.models[0]).toMatchObject({ contextWindow: 65536, maxTokens: 4096 });
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(settings);
  expect((await stat(join(dir, 'models.json'))).mode & 0o777).toBe(0o600);
});

it('Pi setup merges managed fields while keeping extra models, provider fields and custom model settings', async () => {
  const f = await piFixture();
  const extra = { id: 'other-grunt-model', contextWindow: 222222, maxTokens: 1000 };
  const saved = { ...f.saved, providers: { ...f.saved.providers, grunt: { ...f.saved.providers.grunt,
    headers: { 'X-Custom': 'keep' }, models: [{ ...f.saved.providers.grunt.models[0], contextWindow: 131072, custom: 'keep' }, extra] } } };
  await writeFile(f.path, JSON.stringify(saved), { mode: 0o600 });
  await configurePi(19879, { env: f.env });
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result).toMatchObject({ defaultProvider: 'other', defaultModel: 'keep', providers: { other: saved.providers.other,
    grunt: { baseUrl: 'http://127.0.0.1:19879/v1', headers: { 'X-Custom': 'keep' }, models: saved.providers.grunt.models } } });
  expect(await configurePi(19879, { env: f.env })).toEqual({ changed: false });
  expect(await backups(dir)).toHaveLength(1);
});

it('Pi migration updates only the managed legacy working window and backs up privately once', async () => {
  const f = await piFixture();
  const first = await migrateManagedPiWorkingContext(19878, f.env);
  expect(first.changed).toBe(true);
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result).toEqual({ ...f.saved, providers: { ...f.saved.providers, grunt: { ...f.saved.providers.grunt,
    models: [{ ...f.saved.providers.grunt.models[0], contextWindow: 65536 }] } } });
  expect(first.changed && first.backup && JSON.parse(await readFile(first.backup, 'utf8'))).toEqual(f.saved);
  expect(first.changed && first.backup && (await stat(first.backup)).mode & 0o777).toBe(0o600);
  expect(await migrateManagedPiWorkingContext(19878, f.env)).toEqual({ changed: false });
  expect(await backups(dir)).toHaveLength(1);
});

it.each([
  ['different port', 19879, managedPi()],
  ['custom window', 19878, managedPi(19878, 200000)],
  ['custom model', 19878, { ...managedPi(), models: [{ ...managedPi().models[0], name: 'my-custom-grunt' }] }],
  ['custom token budget', 19878, { ...managedPi(), models: [{ ...managedPi().models[0], maxTokens: 8192 }] }],
  ['remote provider', 19878, { ...managedPi(), baseUrl: 'https://example.invalid/v1' }],
] as const)('Pi migration leaves %s unchanged', async (_name, port, provider) => {
  const f = await piFixture(provider as ReturnType<typeof managedPi>), original = await readFile(f.path, 'utf8');
  expect(await migrateManagedPiWorkingContext(port, f.env)).toEqual({ changed: false });
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect(await backups(dir)).toEqual([]);
});

it('Pi setup refuses an unmanaged remote Grunt provider without overwriting it or its key', async () => {
  const f = await piFixture({ ...managedPi(), baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-custom-key' });
  const original = await readFile(f.path, 'utf8');
  await expect(configurePi(19878, { env: f.env })).rejects.toThrow('unmanaged Grunt Pi provider');
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect(await backups(dir)).toEqual([]);
});

it('Pi setup refuses an unrecognized local Grunt model before changing its endpoint', async () => {
  const f = await piFixture({ ...managedPi(), models: [{ ...managedPi().models[0], name: 'my-custom-grunt' }] });
  const original = await readFile(f.path, 'utf8');
  await expect(configurePi(19879, { env: f.env })).rejects.toThrow('unmanaged Grunt Pi model');
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect(await backups(dir)).toEqual([]);
});

it('Pi migration can explicitly change an authorized owner window while preserving its separate endpoint', async () => {
  const f = await piFixture(managedPi(8793, 200000));
  expect(await migrateManagedPiWorkingContext(8792, f.env, { fromContextWindows: [200000] })).toEqual({ changed: false });
  expect(await migrateManagedPiWorkingContext(8793, f.env)).toEqual({ changed: false });
  expect((await migrateManagedPiWorkingContext(8793, f.env, { workingContextTokens: 65536, fromContextWindows: [200000] })).changed).toBe(true);
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result.providers.grunt.baseUrl).toBe('http://127.0.0.1:8793/v1');
  expect(result.providers.grunt.models[0].contextWindow).toBe(65536);
});

it('Pi migration does not create a missing profile or configuration directory', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-pi-context-missing-'));
  const location = join(dir, 'absent');
  expect(await migrateManagedPiWorkingContext(19878, { PI_CODING_AGENT_DIR: location })).toEqual({ changed: false });
  expect(await readdir(dir)).toEqual([]);
});

it('Pi rejects malformed configuration without leaking the contents or creating a backup', async () => {
  const f = await piFixture(), invalid = '{"private":"synthetic-private-value",';
  await writeFile(f.path, invalid, { mode: 0o600 });
  const error = await migrateManagedPiWorkingContext(19878, f.env).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain('synthetic-private-value');
  expect(await readFile(f.path, 'utf8')).toBe(invalid);
  expect(await backups(dir)).toEqual([]);
});

it('Pi refuses symlinked configuration files and parent directories', async () => {
  const f = await piFixture(), original = await readFile(f.path, 'utf8'), target = join(dir, 'target.json');
  await writeFile(target, original, { mode: 0o600 }); await rm(f.path); await symlink(target, f.path);
  await expect(migrateManagedPiWorkingContext(19878, f.env)).rejects.toThrow('Cannot safely update');
  expect(await readFile(target, 'utf8')).toBe(original);
  const actual = join(dir, 'actual'), linked = join(dir, 'linked');
  await mkdir(join(actual, 'nested'), { recursive: true, mode: 0o700 });
  await writeFile(join(actual, 'nested', 'models.json'), original, { mode: 0o600 }); await symlink(actual, linked, 'dir');
  await expect(configurePi(19878, { env: { PI_CODING_AGENT_DIR: join(linked, 'nested') } })).rejects.toThrow('Cannot safely update');
  expect(await readFile(join(actual, 'nested', 'models.json'), 'utf8')).toBe(original);
});

(process.platform === 'win32' ? it.skip : it)('Pi refuses writable-by-others profile files and directories', async () => {
  const f = await piFixture(); await chmod(f.path, 0o666);
  await expect(migrateManagedPiWorkingContext(19878, f.env)).rejects.toThrow('Cannot safely update');
  await chmod(f.path, 0o600); await chmod(dir, 0o777);
  try { await expect(configurePi(19878, { env: f.env })).rejects.toThrow('Cannot safely update'); }
  finally { await chmod(dir, 0o700); }
});

it.each(['', 'nonsense', '1', '65535', '200001', '1.5'])('Pi validates the explicit working window (%s) before writing', async value => {
  const f = await piFixture(), original = await readFile(f.path, 'utf8');
  await expect(configurePi(19878, { env: { ...f.env, GRUNT_WORKING_CONTEXT_TOKENS: value } })).rejects.toThrow('GRUNT_WORKING_CONTEXT_TOKENS');
  expect(await readFile(f.path, 'utf8')).toBe(original);
});

it('Pi honors an explicit supported working window without changing unrelated providers', async () => {
  const f = await piFixture();
  await configurePi(19878, { env: { ...f.env, GRUNT_WORKING_CONTEXT_TOKENS: '100000' } });
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result.providers.grunt.models[0].contextWindow).toBe(100000);
  expect(result.providers.other).toEqual(f.saved.providers.other);
});

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

it('stops a harness at once when OpenCode logs its free usage limit', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-free-limit-'));
  const opencode = join(dir, 'opencode');
  await writeFile(opencode, `#!${process.execPath}\nconsole.error('level=ERROR message="stream error" error.error="AI_APICallError: Free usage limit reached"');\nsetTimeout(() => {}, 60000);\n`);
  await chmod(opencode, 0o755);
  const started = Date.now();
  await expect(runHarness(opencode, [], {}, 30000)).rejects.toThrow(/quota exhausted/);
  expect(Date.now() - started).toBeLessThan(5000);
});

it('drives a signup through the OpenCode CLI on its free model, and hands over only when a driver has no model', async () => {
  const { nextDriver, openCodeSignup } = await import('./harnesses.js');
  const input = { service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal, tools: [], call: vi.fn(async () => ({})) };
  const runs: string[][] = [];
  await openCodeSignup(19878, async (binary, args) => { runs.push([binary, ...args]); return 'done'; })(input);
  expect(runs[0]!.slice(0, 6)).toEqual(['opencode', 'run', '--pure', '--print-logs', '-m', 'opencode/big-pickle']);
  const next = vi.fn(async () => {});
  await nextDriver(async () => { throw new Error('No tool-capable adapter is available'); }, next)(input);
  expect(next).toHaveBeenCalledExactlyOnceWith(input);
  next.mockClear();
  await expect(nextDriver(async () => { throw new Error('provider refused'); }, next)(input)).rejects.toThrow('provider refused');
  expect(next).not.toHaveBeenCalled();
});
