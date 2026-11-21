import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { OpenCode } from './opencode.js';
import { idleEvents } from './fixtures/opencode-events.js';

let directory: string;
const sources: OpenCode[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-opencode-idle-'));
  const script = '#!' + process.execPath + '\n' + `
const fs=require('node:fs'), {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>{fs.appendFileSync(process.env.GRUNT_TEST_PID_LOG,JSON.stringify({pid:process.pid,child:child.pid})+'\\n');console.log('http://127.0.0.1:19777')});
setInterval(()=>{},1000);
`;
  await writeFile(join(directory, 'opencode'), script, { mode: 0o700 });
  vi.stubEnv('PATH', directory + ':' + process.env.PATH);
  vi.stubEnv('GRUNT_TEST_PID_LOG', join(directory, 'pids'));
});
afterEach(async () => {
  const rows = await pids().catch(() => []);
  await Promise.all(sources.splice(0).map(source => source.close()));
  // Keep the inert fixture contained even when testing the unfixed lifecycle.
  for (const row of rows) for (const pid of [row.child, row.pid]) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
  }
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const request = { model: 'opencode', cwd: '/tmp', messages: [{ role: 'user', content: 'First.' }], tools: [], stream: false };
const fetcher: typeof fetch = async url => {
  const path = new URL(String(url)).pathname;
  if (path === '/mcp') return Response.json({});
  if (path === '/event') return idleEvents();
  return Response.json({ id: 'persisted_session', parts: [{ type: 'text', text: 'OK' }] });
};
function source(options: ConstructorParameters<typeof OpenCode>[0] = {}) {
  const result = new OpenCode({ fetcher, idleTimeoutMs: 30, ...options }); sources.push(result); return result;
}
function complete(value: OpenCode, signal = AbortSignal.timeout(5000), messages = request.messages) {
  return value.complete({ ...request, messages }, signal);
}
async function pids(): Promise<{ pid: number; child: number }[]> {
  return (await readFile(join(directory, 'pids'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
function running(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopped(pid: number) {
  // A killed orphan can briefly remain a zombie until its subreaper reaps it.
  if (!running(pid)) return true;
  if (process.platform === 'linux') {
    try { return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
  }
  return false;
}

it.skipIf(process.platform === 'win32')('reclaims the idle owned server and MCP children, then restores its persisted session', async () => {
  const paths: string[] = [];
  const value = source({ fetcher: async (url, init) => { paths.push(new URL(String(url)).pathname); return fetcher(url, init); } });
  await complete(value);
  const [first] = await pids();
  const deadline = Date.now() + 60000;
  (value as unknown as { modelCooldowns: Map<string, number> }).modelCooldowns.set('unrelated-model', deadline);
  await vi.waitFor(async () => expect(await stopped(first.pid)).toBe(true));
  await vi.waitFor(async () => expect(await stopped(first.child)).toBe(true));
  await complete(value, AbortSignal.timeout(5000), [...request.messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Again.' }]);
  expect(await pids()).toHaveLength(2);
  expect(paths.filter(path => path === '/mcp')).toHaveLength(2);
  expect(paths.filter(path => path === '/session')).toHaveLength(1);
  expect((value as unknown as { modelCooldowns: Map<string, number> }).modelCooldowns.get('unrelated-model')).toBe(deadline);
});

it.skipIf(process.platform === 'win32')('does not reclaim a server while a prompt is active, including before any session exists', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const value = source({ fetcher: async (url, init) => {
    if (new URL(String(url)).pathname === '/mcp') { entered(); await gate; }
    return fetcher(url, init);
  } });
  const pending = complete(value);
  try {
    await ready;
    const [first] = await pids();
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(running(first.pid)).toBe(true);
    expect(running(first.child)).toBe(true);
    release(); await pending;
    await vi.waitFor(async () => expect(await stopped(first.pid)).toBe(true));
  } finally { release(); await pending; }
});

it.skipIf(process.platform === 'win32')('does not clear a replacement generation when an old process reports a late error', async () => {
  const value = source();
  await complete(value);
  const old = (value as unknown as { child: ChildProcess }).child;
  const [first] = await pids();
  await vi.waitFor(async () => expect(await stopped(first.pid)).toBe(true));
  await complete(value);
  old.emit('error', new Error('late old process event'));
  await complete(value);
  expect(await pids()).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('close clears idle reclamation and also releases TERM-resistant owned descendants', async () => {
  const value = source({ idleTimeoutMs: 500 });
  await complete(value);
  const [first] = await pids();
  await value.close();
  await vi.waitFor(async () => expect(await stopped(first.pid)).toBe(true));
  await vi.waitFor(async () => expect(await stopped(first.child)).toBe(true));
  await expect(complete(value)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await pids()).toHaveLength(1);
});

it('never starts or reclaims a user-owned server', async () => {
  const value = source({ url: 'http://127.0.0.1:19777', idleTimeoutMs: 0 });
  await complete(value);
  await new Promise(resolve => setTimeout(resolve, 20));
  await complete(value);
  await value.close();
  await expect(readFile(join(directory, 'pids'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('escalates a TERM-resistant owned server and waits for its exit', async () => {
  const executable = join(directory, 'opencode');
  await writeFile(executable, (await readFile(executable, 'utf8')) + '\nprocess.on("SIGTERM",()=>{});\n', { mode: 0o700 });
  const value = source({ idleTimeoutMs: 5000 });
  await complete(value);
  const child = (value as unknown as { child: ChildProcess }).child;
  const [first] = await pids();
  await value.close();
  expect(child.signalCode).toBe('SIGKILL');
  await vi.waitFor(async () => expect(await stopped(first.child)).toBe(true));
});

it.skipIf(process.platform === 'win32')('cancels a previous idle deadline when another request starts', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let messages = 0;
  const value = source({ fetcher: async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/message') && ++messages === 2) await gate;
    return fetcher(url, init);
  } });
  await complete(value);
  const [first] = await pids();
  const pending = complete(value);
  try {
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(running(first.pid)).toBe(true);
    release(); await pending;
    await vi.waitFor(async () => expect(await stopped(first.pid)).toBe(true));
    expect(await pids()).toHaveLength(1);
  } finally { release(); await pending; }
});
