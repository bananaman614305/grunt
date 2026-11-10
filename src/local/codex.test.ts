import { copyFile, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Codex } from './codex.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof promises>();
  return Object.fromEntries(Object.entries(original).map(([key, value]) => [key, typeof value === 'function' ? vi.fn(value) : value]));
});
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return Object.fromEntries(Object.entries(original).map(([key, value]) => [key, key.endsWith('Sync') && typeof value === 'function' ? vi.fn(value) : value]));
});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-codex-'));
  await copyFile(new URL('./fixtures/fake-codex.cjs', import.meta.url), join(dir, 'codex'));
  await chmod(join(dir, 'codex'), 0o755);
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  vi.stubEnv('FAKE_CODEX_CALLS', join(dir, 'calls'));
  vi.stubEnv('FAKE_CODEX_MODE', '');
  vi.stubEnv('FAKE_CODEX_LOGIN', '');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const request = () => ({ model: 'codex', messages: [{ role: 'user', content: '  exact prompt\n' }], tools: [], cwd: dir, stream: false });
const calls = async () => (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

it.each(['Logged in using ChatGPT', 'Logged in using an API key', 'Not logged in'])('advertises only ChatGPT logins (%s)', async login => {
  vi.stubEnv('FAKE_CODEX_LOGIN', login);
  const source = new Codex();
  expect(await source.available()).toBe(login === 'Logged in using ChatGPT');
  const res = await createLocalApp(new Sources([source])).request('http://localhost:8788/v1/models');
  const body = await res.json();
  expect(body.data.some((m: { id: string }) => m.id === 'codex')).toBe(login === 'Logged in using ChatGPT');
  if (login !== 'Logged in using ChatGPT') await expect(source.complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
});
it('handles a missing binary without changing the free source chain', async () => {
  vi.stubEnv('PATH', dir + '/missing');
  expect(await new Codex().available()).toBe(false);
  await expect(new Codex().complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'not_installed' });
  expect(configure({}).sources.map(s => s.id)).toEqual(['codex', 'freellmapi', 'opencode', 'kilo']);
});
it('passes exact text and cwd, parses only the final agent text, and resumes through the API', async () => {
  const source = new Codex({ model: 'custom' });
  const app = createLocalApp(new Sources([source]));
  const req = request();
  const send = async () => {
    const res = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-milo-cwd': dir }, body: JSON.stringify(req) });
    expect(res.status).toBe(200);
    return (await res.json()).choices[0].message.content;
  };
  expect(await send()).toBe('  exact prompt\n');
  req.messages.push({ role: 'assistant', content: '  exact prompt\n' }, { role: 'user', content: '-- exact follow-up\n' });
  expect(await send()).toBe('-- exact follow-up\n');
  const invocations = await calls();
  expect(invocations.map(c => c.args)).toEqual([
    ['exec', '--json', '--sandbox', 'workspace-write', '-m', 'custom', '-'],
    ['exec', '--json', '--sandbox', 'workspace-write', '-m', 'custom', 'resume', 'thread-one', '-']
  ]);
  expect(invocations.every(c => c.cwd === dir)).toBe(true);
});
it('maps usage limits to quota and falls through only for milo', async () => {
  vi.stubEnv('FAKE_CODEX_MODE', 'quota');
  const source = new Codex(), free = vi.fn(async () => ({ text: 'free answer' }));
  await expect(source.complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota' });
  const sources = new Sources([source, { id: 'free', available: async () => true, complete: free }]);
  expect(await sources.complete({ ...request(), model: 'milo' }, AbortSignal.timeout(5000))).toEqual({ text: 'free answer' });
  await expect(sources.complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota' });
  expect(free).toHaveBeenCalledTimes(1);
});
it('kills the child on cancellation', async () => {
  vi.stubEnv('FAKE_CODEX_MODE', 'wait');
  const controller = new AbortController();
  const pending = new Codex().complete(request(), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.waitFor(async () => expect((await calls()).length).toBe(1));
  const pid = (await calls())[0].pid;
  controller.abort(); await rejected;
  expect(() => process.kill(pid, 0)).toThrow();
});
it('does not open files in Codex home from the Milo process', async () => {
  vi.stubEnv('CODEX_HOME', join(dir, 'codex-home'));
  const watched = ['readFile', 'open', 'readdir', 'realpath', 'access', 'stat'] as const;
  const spies = watched.flatMap(name => [vi.mocked(promises[name]), vi.mocked(fs[`${name}Sync`])]);
  expect(await new Codex().available()).toBe(true);
  expect(await new Codex().complete(request(), AbortSignal.timeout(5000))).toEqual({ text: '  exact prompt\n' });
  for (const spy of spies) for (const args of spy.mock.calls) expect(String(args[0])).not.toContain('codex-home');
});
