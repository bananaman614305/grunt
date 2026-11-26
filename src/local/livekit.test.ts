import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveKit, LIVEKIT_DEEPSEEK, LIVEKIT_GATEWAY, LIVEKIT_RECEIPT_MAX_AGE_MS, LIVEKIT_TOKEN_TTL_MS, livekitEnvironment, livekitPaths, parseLiveKitProjects, readLiveKitFreeBuildReceipt, validateLiveKitNativeConfig, writeLiveKitFreeBuildReceipt } from './livekit.js';
import type { LiveKitFreeBuildReceipt } from './livekit.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';

const directories: string[] = [];
const sources: LiveKit[] = [];
const request = { model: 'livekit', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: process.cwd(), stream: false };
const syntheticToken = 'synthetic.header.signature';
const receipt = (): LiveKitFreeBuildReceipt => ({ version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0,
  projectSelector: 'test-free-project', projectId: 'p_synthetic', projectURL: 'wss://test-free-project.livekit.cloud', checkedAt: new Date().toISOString() });
const reply = (model: unknown = LIVEKIT_DEEPSEEK) => Response.json({ model, choices: [{ message: { content: 'Hello from LiveKit' } }], usage: { prompt_tokens: 23, completion_tokens: 5 } });

const projectTable = '| * test-free-project | p_synthetic | wss://test-free-project.livekit.cloud | synthetic-key-column |';
async function fixture(script = `process.stdout.write(${JSON.stringify(syntheticToken)});`, table = projectTable) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-livekit-')); directories.push(directory);
  const nativeDirectory = join(directory, 'native'); await mkdir(nativeDirectory, { mode: 0o700 });
  await writeFile(join(nativeDirectory, 'cli-config.yaml'), 'synthetic native fixture only', { mode: 0o600 });
  await writeLiveKitFreeBuildReceipt(directory, receipt());
  const binary = join(directory, 'fake-lk.mjs');
  await writeFile(binary, `#!${process.execPath}\nif (process.argv.slice(-2).join(' ') === 'project list') { process.stdout.write(${JSON.stringify(table)}); } else {\n${script.replace(/import \{([^}]+)\} from 'node:fs';/, "const {$1} = await import('node:fs');")}\n}\n`, { mode: 0o700 });
  return { directory, nativeDirectory, binary };
}
function source(options: ConstructorParameters<typeof LiveKit>[0]) {
  const item = new LiveKit(options); sources.push(item); return item;
}
afterEach(async () => {
  await Promise.all(sources.splice(0).map(item => item.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('persists only private public project/free-plan metadata and checks availability without token minting or network', async () => {
  const options = await fixture('process.exit(99);'), fetcher = vi.fn<typeof fetch>();
  const verified = receipt();
  await writeLiveKitFreeBuildReceipt(options.directory, { ...verified, unwanted: 'discard' } as LiveKitFreeBuildReceipt);
  const paths = livekitPaths(options.directory, options.nativeDirectory);
  expect(await readLiveKitFreeBuildReceipt(options.directory)).toEqual(verified);
  expect(JSON.parse(await readFile(paths.receipt, 'utf8'))).not.toHaveProperty('unwanted');
  expect((await stat(paths.receipt)).mode & 0o777).toBe(0o600);
  expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
  expect(await source({ ...options, fetcher }).available()).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(paths.home)).toEqual(['free-build.json']);
});

it('runs the CLI with an explicit verified project in an isolated empty config, scrubbing ambient credentials', async () => {
  const options = await fixture(`import {writeFileSync,readFileSync,statSync} from 'node:fs';
    const args = process.argv.slice(2), config = args[args.indexOf('--config')+1];
    writeFileSync(new URL('./capture.json', import.meta.url), JSON.stringify({args,cwd:process.cwd(),home:process.env.HOME,
      ambient:Object.keys(process.env).filter(key=>/^(?:livekit_|lk_)/i.test(key)),config:readFileSync(config,'utf8'),mode:statSync(config).mode&511}));
    process.stdout.write(${JSON.stringify(syntheticToken)});`);
  vi.stubEnv('LIVEKIT_URL', 'https://paid.example'); vi.stubEnv('LIVEKIT_API_SECRET', 'synthetic-secret');
  vi.stubEnv('LK_PROJECT', 'paid-project'); vi.stubEnv('livekit_api_key', 'synthetic-key');
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  const result = await source({ ...options, fetcher }).complete({ ...request, maxTokens: 100000 }, AbortSignal.timeout(5000));
  expect(result).toEqual({ text: 'Hello from LiveKit', inputTokens: 23, outputTokens: 5 });
  const capture = JSON.parse(await readFile(join(options.directory, 'capture.json'), 'utf8'));
  expect(capture.args.slice(0, 2)).toEqual(['--project', 'test-free-project']);
  expect(capture.args.slice(4)).toEqual(['token', 'create', '--inference', '--token-only', '--valid-for', '10m', '--identity', 'agent']);
  expect(capture.ambient).toEqual([]); expect(capture.home).toBe(process.env.HOME); expect(capture.config).toBe(''); expect(capture.mode).toBe(0o600);
  const work = await realpath(livekitPaths(options.directory).work);
  expect(capture.cwd.startsWith(join(work, '.token-'))).toBe(true);
  expect(await readdir(livekitPaths(options.directory).work)).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe(`${LIVEKIT_GATEWAY}/v1/chat/completions`);
  expect(init?.headers).toMatchObject({ Authorization: `Bearer ${syntheticToken}` });
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: LIVEKIT_DEEPSEEK, max_tokens: 100000,
    stream: true, stream_options: { include_usage: true } });
  expect(init?.redirect).toBe('error');
});

it('projects only public native CLI metadata, retaining valid custom aliases and discarding key columns', () => {
  const projects = parseLiveKitProjects(`\x1b[32m│ * Personal.Default Project │ p_personal │ wss://personal.livekit.cloud/ │ synthetic-secret-key │\x1b[0m\r\n${projectTable}\n| broken | bad-id | wss://project.livekit.cloud.evil.test | secret |`);
  expect(projects).toEqual([
    { selector: 'Personal.Default Project', id: 'p_personal', url: 'wss://personal.livekit.cloud', default: true },
    { selector: 'test-free-project', id: 'p_synthetic', url: 'wss://test-free-project.livekit.cloud', default: true }
  ]);
  expect(JSON.stringify(projects)).not.toContain('secret'); expect(JSON.stringify(projects)).not.toContain('key-column');
});

it.each([
  '| test-free-project | p_paid | wss://test-free-project.livekit.cloud | synthetic-key |',
  '| test-free-project | p_synthetic | wss://paid-project.livekit.cloud | synthetic-key |',
  '| another-project | p_synthetic | wss://test-free-project.livekit.cloud | synthetic-key |',
  `${projectTable}\n${projectTable}`,
  'malformed or empty native project output'
])('fails closed before token minting when native project alias identity changed or is ambiguous', async table => {
  const options = await fixture('throw new Error("token mint must never run");', table), fetcher = vi.fn<typeof fetch>();
  await expect(source({ ...options, fetcher }).complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out', message: expect.stringContaining('differs from its verified free Build project') });
  expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(livekitPaths(options.directory).work)).toEqual([]);
});

it('routes a Grunt request and returns function calls through only the pinned LiveKit source', async () => {
  const options = await fixture(), calls = [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: LIVEKIT_DEEPSEEK, choices: [{ message: { content: null, tool_calls: calls } }] }));
  const pool = new Sources([source({ ...options, fetcher })]);
  const response = await createLocalApp(pool).request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'livekit', messages: request.messages,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], stream: false })
  });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('livekit');
  expect((await response.json() as { choices: { message: { tool_calls: unknown } }[] }).choices[0]!.message.tool_calls).toEqual(calls);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).tools[0].function.name).toBe('read_file');
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['deepseek-v4-flash', 'deepseek-v3.2', undefined])('rejects a different or unidentified returned model %s without retry', async model => {
  const options = await fixture(), fetcher = vi.fn<typeof fetch>(async () => reply(model));
  if (model === undefined) fetcher.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'Hello' } }] }));
  await expect(source({ ...options, fetcher }).complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([[401, 'logged_out'], [402, 'quota'], [429, 'quota']] as const)('fails closed on HTTP %s and hides upstream payloads', async (status, code) => {
  const options = await fixture(), fetcher = vi.fn<typeof fetch>(async () => new Response('synthetic-upstream-secret', { status }));
  await expect(source({ ...options, fetcher }).complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code, message: `livekit returned HTTP ${status}` });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  { payAsYouGo: true }, { paymentMethodPresent: true }, { purchasedCredits: 1 }, { plan: 'Scale' },
  { checkedAt: new Date(Date.now() - LIVEKIT_RECEIPT_MAX_AGE_MS - 10000).toISOString() },
  { checkedAt: new Date(Date.now() + 120000).toISOString() },
  { projectSelector: '--api-secret=unsafe' }, { projectURL: 'wss://project.livekit.cloud.evil.example' },
  { projectURL: 'wss://user:password@project.livekit.cloud' }, { projectURL: 'wss://project.livekit.cloud/?secret=x' },
  { projectURL: 'https://project.livekit.cloud' }, { projectURL: 'wss://project.livekit.cloud:1234' }
])('refuses unverified billing/project receipt %j', async patch => {
  const options = await fixture();
  await expect(writeLiveKitFreeBuildReceipt(options.directory, { ...receipt(), ...patch } as LiveKitFreeBuildReceipt)).rejects.toMatchObject({ code: 'logged_out' });
  await writeFile(livekitPaths(options.directory).receipt, JSON.stringify({ ...receipt(), ...patch }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(), item = source({ ...options, fetcher });
  expect(await item.available()).toBe(false);
  await expect(item.complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects unsafe permissions, symlinks, missing native login, and writable token working directories', async () => {
  const options = await fixture(), paths = livekitPaths(options.directory, options.nativeDirectory);
  const fetcher = vi.fn<typeof fetch>(), item = source({ ...options, fetcher });
  await chmod(paths.receipt, 0o644); expect(await item.available()).toBe(false); await chmod(paths.receipt, 0o600);
  const target = join(options.directory, 'target'); await writeFile(target, JSON.stringify(receipt()), { mode: 0o600 });
  await rm(paths.receipt); await symlink(target, paths.receipt); expect(await item.available()).toBe(false);
  await writeLiveKitFreeBuildReceipt(options.directory, receipt());
  await chmod(paths.nativeConfig, 0o644); await expect(validateLiveKitNativeConfig(options.nativeDirectory)).rejects.toThrow('Unsafe');
  await chmod(paths.nativeConfig, 0o600); await chmod(paths.nativeHome, 0o755); expect(await item.available()).toBe(false);
  await chmod(paths.nativeHome, 0o700); await rm(paths.nativeConfig); await symlink(target, paths.nativeConfig); expect(await item.available()).toBe(false);
  await rm(paths.nativeConfig); await writeFile(paths.nativeConfig, 'synthetic', { mode: 0o600 });
  await mkdir(paths.work);
  await chmod(paths.work, 0o755);
  await expect(item.complete(request, AbortSignal.timeout(5000))).rejects.toThrow('Unsafe LiveKit private directory');
  expect(fetcher).not.toHaveBeenCalled();
  await rm(paths.nativeConfig); expect(await item.available()).toBe(false);
});

it('scrubs CLI failures and malformed stdout without making any inference request', async () => {
  for (const script of ['process.stderr.write("synthetic-private-secret"); process.exit(1);', 'process.stdout.write("not-a-jwt synthetic-private-secret");']) {
    const options = await fixture(script), fetcher = vi.fn<typeof fetch>();
    await expect(source({ ...options, fetcher }).complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
    try { await source({ ...options, fetcher }).complete(request, AbortSignal.timeout(5000)); }
    catch (error) { expect(String(error)).not.toContain('synthetic-private-secret'); }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(livekitPaths(options.directory).work)).toEqual([]);
  }
});

it('rejects native tools before invoking the CLI', async () => {
  const options = await fixture('process.exit(99);'), fetcher = vi.fn<typeof fetch>();
  await expect(source({ ...options, fetcher }).complete({ ...request, tools: [{ type: 'web_search' }] }, AbortSignal.timeout(5000))).rejects.toThrow('function tools');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(livekitPaths(options.directory).home)).toEqual(['free-build.json']);
});

it('rejects image input before invoking the CLI rather than silently discarding it', async () => {
  const options = await fixture('process.exit(99);'), fetcher = vi.fn<typeof fetch>();
  await expect(source({ ...options, fetcher }).complete({ ...request, imageInput: true }, AbortSignal.timeout(5000))).rejects.toThrow('text input');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(livekitPaths(options.directory).home)).toEqual(['free-build.json']);
});

it('cancels a running CLI on caller abort and cleans private temporary files', async () => {
  const options = await fixture('setInterval(()=>{}, 1000);'), caller = new AbortController(), fetcher = vi.fn<typeof fetch>(), item = source({ ...options, fetcher });
  const pending = item.complete(request, caller.signal), rejected = expect(pending).rejects.toThrow('caller cancelled');
  await vi.waitFor(async () => expect((await readdir(livekitPaths(options.directory).work)).length).toBe(1));
  caller.abort(new Error('caller cancelled')); await rejected;
  expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(livekitPaths(options.directory).work)).toEqual([]);
});

it('distinguishes request timeout and shutdown cancellation while the CLI is running', async () => {
  const options = await fixture('setInterval(()=>{}, 1000);'), fetcher = vi.fn<typeof fetch>();
  const timed = source({ ...options, fetcher, timeout: 30 });
  await expect(timed.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
  const closing = source({ ...options, fetcher }), pending = closing.complete(request, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(async () => expect((await readdir(livekitPaths(options.directory).work)).length).toBe(1));
  await closing.close(); await rejected;
  expect(await closing.available()).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(livekitPaths(options.directory).work)).toEqual([]);
});

it('preserves request timeout during an inference response without exposing network errors', async () => {
  const options = await fixture(), fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-network-secret')), { once: true });
  }));
  await expect(source({ ...options, fetcher, timeout: 500 }).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps unrelated environment and HOME while removing all case variants of LiveKit overrides', () => {
  vi.stubEnv('lK_Url', 'synthetic'); vi.stubEnv('LIVEKIT_CONFIG', '/unsafe'); vi.stubEnv('UNRELATED_SETTING', 'preserved');
  const env = livekitEnvironment(); expect(env.lK_Url).toBeUndefined(); expect(env.LIVEKIT_CONFIG).toBeUndefined();
  expect(env.HOME).toBe(process.env.HOME); expect(env.UNRELATED_SETTING).toBe('preserved');
});

it('caches the minted 10-minute JWT for ~8 minutes and invalidates on expiry, 401, and close', async () => {
  const options = await fixture(`import {appendFileSync} from 'node:fs';
    appendFileSync(new URL('./mints.log', import.meta.url), 'mint\\n');
    process.stdout.write(${JSON.stringify(syntheticToken)});`);
  let now = 1_000_000;
  let status = 200;
  const fetcher = vi.fn<typeof fetch>(async () => status === 200 ? reply() : new Response(null, { status }));
  const item = source({ ...options, fetcher, now: () => now });
  const mintCount = async () => (await readFile(join(options.directory, 'mints.log'), 'utf8')).trim().split('\n').filter(Boolean).length;

  await item.complete(request, AbortSignal.timeout(5000));
  expect(await mintCount()).toBe(1);
  // Reuse cached JWT across subsequent requests within TTL.
  now += LIVEKIT_TOKEN_TTL_MS - 1000;
  await item.complete(request, AbortSignal.timeout(5000));
  expect(await mintCount()).toBe(1);
  // Expiry triggers a fresh mint.
  now += 2000;
  await item.complete(request, AbortSignal.timeout(5000));
  expect(await mintCount()).toBe(2);
  // HTTP 401 invalidates the cached token so the next request mints fresh.
  status = 401;
  await expect(item.complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
  status = 200;
  await item.complete(request, AbortSignal.timeout(5000));
  expect(await mintCount()).toBe(3);
  expect(fetcher).toHaveBeenCalledTimes(5);
});
