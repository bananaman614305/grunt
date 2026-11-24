import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HARNESSES, claudeProfilePath, configureClaude, configureCodex, configureOpenCode, configurePi, connectHarness, detectHarnesses, migrateManagedPiWorkingContext, opencodeProfilePath, runHarness } from './harnesses.js';

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
  expect(written.providers.grunt.models[0]).toMatchObject({ contextWindow: 65536, maxTokens: 65536 });
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(settings);
  expect((await stat(join(dir, 'models.json'))).mode & 0o777).toBe(0o600);
});

it('Pi setup merges managed fields while keeping extra models, provider fields and custom model settings', async () => {
  const f = await piFixture();
  const extra = { id: 'other-grunt-model', contextWindow: 222222, maxTokens: 1000 };
  const saved = { ...f.saved, providers: { ...f.saved.providers, grunt: { ...f.saved.providers.grunt,
    headers: { 'X-Custom': 'keep' }, models: [{ ...f.saved.providers.grunt.models[0], contextWindow: 131072, maxTokens: 8192, custom: 'keep' }, extra] } } };
  await writeFile(f.path, JSON.stringify(saved), { mode: 0o600 });
  await configurePi(19879, { env: f.env });
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result).toMatchObject({ defaultProvider: 'other', defaultModel: 'keep', providers: { other: saved.providers.other,
    grunt: { baseUrl: 'http://127.0.0.1:19879/v1', headers: { 'X-Custom': 'keep' }, models: saved.providers.grunt.models } } });
  expect(await configurePi(19879, { env: f.env })).toEqual({ changed: false });
  expect(await backups(dir)).toHaveLength(1);
});

it('Pi migration updates the managed legacy working window and output budget and backs up privately once', async () => {
  const f = await piFixture();
  const first = await migrateManagedPiWorkingContext(19878, f.env);
  expect(first.changed).toBe(true);
  const result = JSON.parse(await readFile(f.path, 'utf8'));
  expect(result).toEqual({ ...f.saved, providers: { ...f.saved.providers, grunt: { ...f.saved.providers.grunt,
    models: [{ ...f.saved.providers.grunt.models[0], contextWindow: 65536, maxTokens: 65536 }] } } });
  expect(first.changed && first.backup && JSON.parse(await readFile(first.backup, 'utf8'))).toEqual(f.saved);
  expect(first.changed && first.backup && (await stat(first.backup)).mode & 0o777).toBe(0o600);
  expect(await migrateManagedPiWorkingContext(19878, f.env)).toEqual({ changed: false });
  expect(await backups(dir)).toHaveLength(1);
});

it.each([65536, 200000])('Pi migration replaces the old output budget while keeping the working window (%s)', async contextWindow => {
  const f = await piFixture(managedPi(19878, contextWindow));
  expect((await migrateManagedPiWorkingContext(19878, f.env)).changed).toBe(true);
  const written = JSON.parse(await readFile(f.path, 'utf8'));
  expect(written.providers.grunt.models[0]).toMatchObject({ contextWindow, maxTokens: 65536 });
  expect(await migrateManagedPiWorkingContext(19878, f.env)).toEqual({ changed: false });
});

it.each([
  ['different port', 19879, managedPi()],
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
  const provider = managedPi(8793, 200000);
  provider.models[0]!.maxTokens = 65536;
  const f = await piFixture(provider);
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
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
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
  expect(profile).toContain('web_search = "disabled"');
  expect(profile).toMatch(/^model = "grunt"$/m);
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
it('Codex: the profile root sets grunt, disables hosted web search and keeps the provider in its own table', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-codex-test-'));
  vi.stubEnv('CODEX_HOME', dir);
  await configureCodex(19878);
  const profile = await readFile(join(dir, 'grunt.config.toml'), 'utf8');
  const root = profile.slice(0, profile.indexOf('[model_providers.grunt]'));
  expect(root).toContain('model_provider = "grunt"');
  expect(root).toContain('web_search = "disabled"');
  expect(profile.slice(root.length)).not.toContain('web_search');
});
it('OpenCode: the provider declares tool calls and limits, and a separate profile selects grunt for model and small_model', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-opencode-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  const saved = { model: 'anthropic/claude', small_model: 'anthropic/haiku', provider: { anthropic: { options: {} } } };
  const folder = join(dir, 'opencode');
  await mkdir(folder);
  await writeFile(join(folder, 'opencode.json'), JSON.stringify(saved));
  expect((await configureOpenCode(19878)).changed).toBe(true);
  const main = JSON.parse(await readFile(join(folder, 'opencode.json'), 'utf8'));
  // The user's defaults, including small_model, are untouched.
  expect(main).toMatchObject(saved);
  expect(main.provider.grunt).toEqual({ name: 'grunt', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:19878/v1', apiKey: 'local' },
    models: { grunt: { name: 'grunt', tool_call: true, limit: { context: 128000, output: 8192 } } } });
  expect(JSON.parse(await readFile(opencodeProfilePath(), 'utf8'))).toEqual({ $schema: 'https://opencode.ai/config.json', model: 'grunt/grunt', small_model: 'grunt/grunt' });
  expect(opencodeProfilePath()).toBe(join(folder, 'grunt.opencode.json'));
  expect(await configureOpenCode(19878)).toEqual({ changed: false });
  expect(await backups(folder)).toHaveLength(1);
});
it('OpenCode: writes the profile even when a JSONC config already has the current provider, and leaves a JSONC default alone', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-opencode-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  const folder = join(dir, 'opencode'), path = join(folder, 'opencode.jsonc');
  await mkdir(folder);
  await writeFile(path, '{ "model": "mine/default" }');
  await configureOpenCode(19878);
  const once = await readFile(path, 'utf8');
  await rm(opencodeProfilePath());
  expect((await configureOpenCode(19878)).changed).toBe(true);
  expect(await readFile(path, 'utf8')).toBe(once);
  expect(JSON.parse(once).model).toBe('mine/default');
  expect(JSON.parse(await readFile(opencodeProfilePath(), 'utf8')).small_model).toBe('grunt/grunt');
  expect(await backups(folder)).toHaveLength(1);
});
it('Claude Code: writes only its own settings file mapping every model alias to grunt, never settings.json', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-claude-test-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  const user = '{"model":"opus","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}';
  await writeFile(join(dir, 'settings.json'), user);
  expect((await configureClaude(19878)).changed).toBe(true);
  expect(await configureClaude(19878)).toEqual({ changed: false });
  const profile = JSON.parse(await readFile(claudeProfilePath(), 'utf8'));
  expect(claudeProfilePath()).toBe(join(dir, 'grunt.settings.json'));
  expect(profile).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:19878', ANTHROPIC_AUTH_TOKEN: 'local',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'grunt', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grunt', ANTHROPIC_DEFAULT_OPUS_MODEL: 'grunt', CLAUDE_CODE_SUBAGENT_MODEL: 'grunt' } });
  expect((await stat(claudeProfilePath())).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(user);
  expect(await backups(dir)).toEqual([]);
  expect((await configureClaude(19879)).changed).toBe(true);
  expect(await backups(dir)).toHaveLength(1);
});
it('opt-in launch lines point each harness at its Grunt-owned profile, with the subagent models on grunt', () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/c');
  vi.stubEnv('XDG_CONFIG_HOME', '/x y');
  const launch = (id: string) => HARNESSES.find(h => h.id === id)!.launch(19878);
  expect(launch('claude')).toContain('claude --settings /c/grunt.settings.json --model grunt');
  expect(launch('codex')).toContain('codex --profile grunt');
  expect(launch('opencode')).toContain('OPENCODE_CONFIG="/x y/opencode/grunt.opencode.json" opencode');
  const claude = HARNESSES.find(h => h.id === 'claude')!.check(19878).env!;
  expect(claude).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:19878', CLAUDE_CODE_SUBAGENT_MODEL: 'grunt', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grunt' });
});
it('detects harnesses on PATH and checks one with a real non-interactive run', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-path-test-'));
  const claude = join(dir, 'claude');
  await writeFile(claude, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN }));\n`);
  await chmod(claude, 0o755);
  vi.stubEnv('PATH', dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'claude-config'));
  expect((await detectHarnesses()).map(h => h.id)).toEqual(['claude']);
  const { change, answer } = await connectHarness(HARNESSES.find(h => h.id === 'claude')!, 19878);
  expect(change).toMatchObject({ changed: true });
  expect(await readFile(join(dir, 'claude-config', 'grunt.settings.json'), 'utf8')).toContain('CLAUDE_CODE_SUBAGENT_MODEL');
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

it('reaps a CLI that ignores termination before returning cancellation', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-harness-cancel-'));
  const pidFile = join(dir, 'child.pid');
  const controller = new AbortController();
  const running = runHarness(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidFile
  ], {}, 10000, { cwd: dir, signal: controller.signal });
  // Attach before aborting so the runner's rejection is always observed.
  const rejected = expect(running).rejects.toThrow('did not answer');
  await vi.waitFor(async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0));
  const pid = Number(await readFile(pidFile, 'utf8'));
  controller.abort();
  await rejected;
  expect(() => process.kill(pid, 0)).toThrow();
});

it('drives a signup through the OpenCode CLI on its free model, and hands over only when a driver has no model', async () => {
  const { nextDriver, signupHarness } = await import('./harnesses.js');
  const input = { service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal, tools: [], call: vi.fn(async () => ({})) };
  const runs: string[][] = [];
  let permission: unknown;
  await signupHarness(HARNESSES.find(harness => harness.id === 'opencode')!, 19878, async (binary, args, env) => {
    runs.push([binary, ...args]);
    permission = JSON.parse(await readFile(env.OPENCODE_CONFIG!, 'utf8')).permission;
    return 'done';
  }, 'opencode/big-pickle')(input);
  expect(runs[0]!.slice(0, 6)).toEqual(['opencode', 'run', '--pure', '--print-logs', '-m', 'opencode/big-pickle']);
  // OpenCode's free tier refuses a request with none of its own tools; read stays inside the signup directory.
  expect(permission).toEqual({ '*': 'deny', read: 'allow', 'squire_*': 'allow' });
  const next = vi.fn(async () => {});
  await nextDriver(async () => { throw new Error('No tool-capable adapter is available'); }, next)(input);
  expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ service: input.service, goal: input.goal, signal: input.signal }));
  next.mockClear();
  await expect(nextDriver(async () => { throw new Error('provider refused'); }, next)(input)).rejects.toThrow('provider refused');
  expect(next).not.toHaveBeenCalled();
});

it('stops driver handoff on explicit cancellation even when the CLI reports a timeout', async () => {
  const { nextDriver } = await import('./harnesses.js');
  const controller = new AbortController();
  const input = { service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: controller.signal, tools: [], call: vi.fn(async () => ({})) };
  const next = vi.fn(async () => {});
  const driver = nextDriver(async () => {
    controller.abort(new Error('signup cancelled'));
    throw new Error('opencode did not answer within 240 seconds');
  }, next);
  await expect(driver(input)).rejects.toThrow('signup cancelled');
  expect(next).not.toHaveBeenCalled();
});

it('hands off when OpenCode logs a failed main-model request instead of waiting through its retries', async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-stream-error-'));
  const opencode = join(dir, 'opencode');
  await writeFile(opencode, `#!${process.execPath}\nconsole.error('level=ERROR message="stream error" providerID=opencode small=true agent=title error.error="title failed"');\nsetTimeout(() => console.error('level=ERROR message="stream error" providerID=opencode small=false agent=build error.error.code=504'), 50);\nsetTimeout(() => {}, 60000);\n`);
  await chmod(opencode, 0o755);
  const started = Date.now();
  const { setupFailureReason } = await import('./setup-failure.js');
  const failure = await runHarness(opencode, [], {}, 30000).catch((error: unknown) => error);
  expect(setupFailureReason(failure)).toBe('provider request failed');
  expect(Date.now() - started).toBeLessThan(5000);
});

it.each([
  ['402 Payment Required', 'quota exhausted', true], ['Error: rate limited, retry later', 'quota exhausted', true],
  ['ModelNotFoundError', 'model pool unavailable', true], ['ProviderModelNotFoundError', 'model pool unavailable', true],
  ['model_not_found', 'model pool unavailable', true],
  ['503 Service Unavailable', 'provider request failed', true], ['TypeError: cannot read properties', 'CLI request failed', false]
])('names the model error a failed CLI exit reports: %s', async (text, reason, switches) => {
  const { setupFailureReason, signupOperatorUnavailable } = await import('./setup-failure.js');
  const failure = await runHarness(process.execPath, ['-e', `console.error(${JSON.stringify(text)}); process.exit(1)`], {}, 10000).catch((error: unknown) => error);
  expect(setupFailureReason(failure)).toBe(reason);
  // Only an error the model reports switches drivers; a crash or a timeout does not.
  expect(signupOperatorUnavailable(setupFailureReason(failure))).toBe(switches);
  expect(signupOperatorUnavailable('timed out')).toBe(false);
});

it('starts the next driver fresh only when the failed one made no tool call, otherwise continues the same session', async () => {
  const { nextDriver } = await import('./harnesses.js');
  const call = vi.fn(async () => ({ status: 'low_confidence' }));
  const input = { service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal, tools: [], call };
  const goals: string[] = [];
  const idle = async (turn: typeof input) => { goals.push(turn.goal); throw new Error('quota exhausted'); };
  const acted = async (turn: typeof input) => { goals.push(turn.goal); await turn.call('operate_drive', {}); throw new Error('No tool-capable adapter is available'); };
  const last = async (turn: typeof input) => { goals.push(turn.goal); };
  await nextDriver(idle, acted, last)(input);
  expect(goals.slice(0, 2)).toEqual(['Free access', 'Free access']);
  expect(goals[2]).toMatch(/^Free access\n.*same Squire browser session.*never start the signup over/);
  expect(call).toHaveBeenCalledExactlyOnceWith('operate_drive', {});
});

it('lists free models and excludes Google models from both harnesses, from private copies of Pi config', async () => {
  const { listFreeModels } = await import('./harnesses.js');
  const { path } = await piFixture({ ...managedPi(), apiKey: 'local' });
  await writeFile(path, JSON.stringify({ providers: { grunt: managedPi(), openrouter: { baseUrl: 'https://openrouter.test/api/v1', apiKey: 'synthetic-router-key' } } }), { mode: 0o600 });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ keyed: { type: 'api_key', key: 'synthetic-keyed' }, signed: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }), { mode: 0o600 });
  const copies: { models: unknown; auth: unknown }[] = [];
  const models = await listFreeModels({ openCode: true, pi: true }, async (binary, args, env) => {
    if (binary === 'opencode') {
      expect(args).toEqual(['models', 'opencode']);
      expect(env).toMatchObject({ OPENCODE_CONFIG: undefined, XDG_CONFIG_HOME: expect.any(String) });
      return 'opencode/glm-5.3-flash-free\nopencode/big-pickle\nopencode/gemini-free\nopencode/google/model-free\nopencode/gemma-free\nnot a model line';
    }
    const agent = env.PI_CODING_AGENT_DIR!;
    expect(agent).not.toBe(dir);
    copies.push({ models: JSON.parse(await readFile(join(agent, 'models.json'), 'utf8')), auth: JSON.parse(await readFile(join(agent, 'auth.json'), 'utf8')) });
    expect((await stat(join(agent, 'auth.json'))).mode & 0o777).toBe(0o600);
    return ['provider    model                 context', 'grunt       grunt-free            65K', 'openrouter  vendor/model:free     128K',
      'openrouter  vendor/paid           128K', 'keyed       coder-free            32K',
      'openrouter  google/gemma-3-27b-it:free 128K', 'google  custom-free 128K',
      'google-vertex  custom-free 128K', 'keyed  gemini-2.5-flash-free 128K', 'keyed  gemma-3-free 128K'].join('\n');
  });
  expect(models).toEqual([
    { harness: 'opencode', model: 'opencode/big-pickle' }, { harness: 'opencode', model: 'opencode/glm-5.3-flash-free' },
    { harness: 'pi', model: 'openrouter/vendor/model:free' }, { harness: 'pi', model: 'keyed/coder-free' }
  ]);
  // OAuth entries stay in the person's own file, where Pi may rotate them.
  expect(copies).toEqual([{ models: JSON.parse(await readFile(path, 'utf8')), auth: { keyed: { type: 'api_key', key: 'synthetic-keyed' } } }]);
  // A CLI that cannot list its catalog still leaves OpenCode's anonymous model.
  expect(await listFreeModels({ openCode: true, pi: false }, async () => { throw new Error('Could not run opencode'); })).toEqual([{ harness: 'opencode', model: 'opencode/big-pickle' }]);
});

it('keeps inherited OpenCode credentials out of anonymous discovery, probes and signups', async () => {
  const { listFreeModels, probeFreeModel, signupHarness } = await import('./harnesses.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-anonymous-key-'));
  const binary = join(dir, 'opencode');
  await writeFile(binary, `#!${process.execPath}\nif (process.env.OPENCODE_API_KEY !== undefined) { console.error('credential inherited'); process.exit(1); }\nconsole.log(process.argv[2] === 'models' ? 'opencode/anonymous-free' : 'anonymous ready');\n`, { mode: 0o755 });
  vi.stubEnv('OPENCODE_API_KEY', 'synthetic-paid-key');
  const run: typeof runHarness = (_binary, args, env, timeout, options) => runHarness(binary, args, env, timeout, options);
  expect(await listFreeModels({ openCode: true, pi: false }, run)).toEqual([
    { harness: 'opencode', model: 'opencode/big-pickle' }, { harness: 'opencode', model: 'opencode/anonymous-free' }
  ]);
  const model = { harness: 'opencode' as const, model: 'opencode/big-pickle' };
  await expect(probeFreeModel(model, undefined, run)).resolves.toBe('anonymous ready');
  await expect(signupHarness(HARNESSES.find(harness => harness.id === 'opencode')!, 19878, run, model.model)({
    service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal, tools: [], call: async () => ({})
  })).resolves.toBeUndefined();
  expect(process.env.OPENCODE_API_KEY).toBe('synthetic-paid-key');
});

it.each(['before discovery', 'opencode resolves', 'opencode rejects', 'pi resolves', 'pi rejects'])('catalog discovery preserves cancellation: %s', async stage => {
  const { listFreeModels } = await import('./harnesses.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-catalog-cancel-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'pi-agent'));
  const controller = new AbortController(), cancelled = new Error('signup cancelled');
  const called: string[] = [];
  if (stage === 'before discovery') controller.abort(cancelled);
  const run: typeof runHarness = async (binary, _args, _env, _timeout, options) => {
    called.push(binary);
    expect(options?.signal).toBe(controller.signal);
    if (stage.startsWith(binary)) {
      controller.abort(cancelled);
      if (stage.endsWith('rejects')) throw new Error('CLI aborted');
    }
    return binary === 'opencode' ? 'opencode/big-pickle' : 'provider model context\nkeyed coder-free 32K';
  };
  await expect(listFreeModels({ openCode: true, pi: true }, run, controller.signal)).rejects.toBe(cancelled);
  expect(called).toEqual(stage === 'before discovery' ? [] : stage.startsWith('opencode') ? ['opencode'] : ['opencode', 'pi']);
});

it.each([
  [true, 'quota exhausted: free usage limit reached'], [false, 'quota exhausted: free usage limit reached'],
  [true, 'opencode did not answer within 240 seconds']
] as const)('daemon driver: Pi answers %s after %s, but a timeout never switches drivers', async (piAnswers, failure) => {
  const { signupDriver } = await import('./harnesses.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-driver-walk-'));
  for (const binary of ['pi', 'opencode']) await writeFile(join(dir, binary), '#!/bin/sh\n', { mode: 0o755 });
  vi.stubEnv('PATH', dir);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'pi-agent'));
  const input = { service: 'zro', url: 'https://zro.test', goal: 'Free access', signal: new AbortController().signal, tools: [], call: vi.fn(async () => ({})) };
  const tried: string[] = [];
  const list = vi.fn(async () => [{ harness: 'opencode' as const, model: 'opencode/big-pickle' }, { harness: 'opencode' as const, model: 'opencode/glm-free' },
    { harness: 'pi' as const, model: 'openrouter/vendor/model:free' }]);
  const driver = await signupDriver(19878, { routed: true, openCode: true, list, run: async (binary, args) => {
    const model = binary === 'pi' ? `${args[2]}/${args[4]}` : args[4]!;
    tried.push(`${binary}:${model}`);
    if (model === 'grunt/grunt') throw new Error('No tool-capable adapter is available');
    if (binary === 'opencode') throw new Error(failure);
    if (!piAnswers) throw new Error('pi exited with code 1');
    return 'done';
  } });
  const run = driver!(input);
  const timeout = failure.includes('did not answer');
  if (timeout) await expect(run).rejects.toThrow(failure);
  else if (piAnswers) await run;
  else await expect(run).rejects.toThrow('pi exited with code 1');
  expect(tried).toEqual(timeout ? ['pi:grunt/grunt', 'opencode:opencode/big-pickle']
    : ['pi:grunt/grunt', 'opencode:opencode/big-pickle', 'opencode:opencode/glm-free', 'pi:openrouter/vendor/model:free']);
  expect(list).toHaveBeenCalledExactlyOnceWith({ openCode: true, pi: true }, expect.any(Function), input.signal);
});

it('daemon driver: Squire drives alone when no harness CLI can drive', async () => {
  const { signupDriver } = await import('./harnesses.js');
  dir = await mkdtemp(join(tmpdir(), 'grunt-driver-none-'));
  vi.stubEnv('PATH', dir);
  const list = vi.fn(async () => []);
  expect(await signupDriver(19878, { routed: false, openCode: true, list })).toBeUndefined();
  await writeFile(join(dir, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  // OpenCode without its data-sharing approval is not a candidate.
  expect(await signupDriver(19878, { routed: false, openCode: false, list })).toBeUndefined();
  expect(list).not.toHaveBeenCalled();
});
