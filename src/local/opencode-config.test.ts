import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenCode } from './opencode.js';
import { idleEvents } from './fixtures/opencode-events.js';

let directory: string;
const workers: OpenCode[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-opencode-config-'));
  const script = '#!' + process.execPath + '\n' +
    'require("node:fs").appendFileSync(process.env.GRUNT_TEST_CONFIG_CAPTURE, JSON.stringify({configFile:process.env.OPENCODE_CONFIG??null,content:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)})+"\\n",{mode:0o600});\n' +
    'console.log("http://127.0.0.1:19779");setInterval(()=>{},1000);\n';
  await writeFile(join(directory, 'opencode'), script, { mode: 0o700 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('GRUNT_TEST_CONFIG_CAPTURE', join(directory, 'child-env.jsonl'));
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ permission: { edit: 'allow' }, test: 'preserved' }));
  vi.stubEnv('OPENCODE_CONFIG', undefined);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const fetcher: typeof fetch = async url => {
  const path = new URL(String(url)).pathname;
  if (path === '/mcp') return Response.json({});
  if (path === '/event') return idleEvents();
  return Response.json({ id: 'config_session', parts: [{ type: 'text', text: 'OK' }] });
};
function worker(options: ConstructorParameters<typeof OpenCode>[0] = {}) {
  const source = new OpenCode({ fetcher, ...options }); workers.push(source); return source;
}
function complete(source: OpenCode, text = 'Reply OK.') {
  return source.complete({ model: 'opencode', cwd: directory, messages: [{ role: 'user', content: text }], tools: [], stream: false }, AbortSignal.timeout(5000));
}
async function captured() {
  return (await readFile(join(directory, 'child-env.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

it('uses a private config created after the daemon source was constructed', async () => {
  const configFile = join(directory, 'opencode-free.json');
  const source = worker({ configFile });
  await writeFile(configFile, '{}', { mode: 0o600 });
  expect((await complete(source)).text).toBe('OK');
  expect(await captured()).toEqual([{ configFile, content: { permission: { edit: 'allow', external_directory: 'deny' }, test: 'preserved' } }]);
});

it.each([undefined, '/inherited/opencode.json'])('preserves anonymous or inherited config when the private file is absent (%s)', async inherited => {
  if (inherited) vi.stubEnv('OPENCODE_CONFIG', inherited);
  expect((await complete(worker({ configFile: join(directory, 'absent.json') }))).text).toBe('OK');
  expect((await captured())[0].configFile).toBe(inherited ?? null);
});

it.each(['symlink', 'public', 'directory'] as const)('rejects unsafe private configuration metadata before CLI startup (%s)', async type => {
  const configFile = join(directory, 'private.json');
  if (type === 'symlink') { await writeFile(join(directory, 'target.json'), '{}', { mode: 0o600 }); await symlink(join(directory, 'target.json'), configFile); }
  else if (type === 'directory') await mkdir(configFile, { mode: 0o700 });
  else { await writeFile(configFile, '{}', { mode: 0o600 }); await chmod(configFile, 0o644); }
  await expect(complete(worker({ configFile }))).rejects.toMatchObject({ code: 'logged_out', message: 'OpenCode private configuration is unavailable; rerun usegrunt setup' });
  await expect(readFile(join(directory, 'child-env.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retries startup after private configuration permissions are repaired', async () => {
  const configFile = join(directory, 'private.json'); await writeFile(configFile, '{}', { mode: 0o644 });
  const source = worker({ configFile });
  await expect(complete(source)).rejects.toMatchObject({ code: 'logged_out' });
  await chmod(configFile, 0o600);
  expect((await complete(source)).text).toBe('OK');
  expect(await captured()).toHaveLength(1);
});

it('shares asynchronous config resolution across simultaneous first requests', async () => {
  const configFile = join(directory, 'private.json'); await writeFile(configFile, '{}', { mode: 0o600 });
  const source = worker({ configFile });
  expect((await Promise.all([complete(source, 'First request.'), complete(source, 'Other request.')])).map(result => result.text)).toEqual(['OK', 'OK']);
  expect(await captured()).toHaveLength(1);
});

it('does not spawn a late private worker after shutdown during startup discovery', async () => {
  const module = await import('./multiplexer.js');
  const original = module.executable;
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(module, 'executable').mockImplementation(async name => { entered(); await gate; return original(name); });
  const source = worker({ configFile: join(directory, 'absent.json') });
  const outcome = complete(source).catch(error => error);
  await observed;
  await source.close();
  release();
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  await expect(readFile(join(directory, 'child-env.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves external server mode independent of local private config and CLI discovery', async () => {
  const source = worker({ url: 'http://127.0.0.1:19779', configFile: directory });
  await rm(join(directory, 'opencode'));
  expect((await complete(source)).text).toBe('OK');
  await expect(readFile(join(directory, 'child-env.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});
