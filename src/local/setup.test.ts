import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as ChildProcess from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire, FreeLLMAdmin, setup } from './setup.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';

const { docker, question } = vi.hoisted(() => ({ docker: vi.fn(), question: vi.fn(async () => '') }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: docker }) };
});
vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question, close: vi.fn() }) }));

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let stateDir: string;
let installed: boolean, volume: boolean, storedKeys: boolean, legacyAdmin: boolean;
let keys: { id: number; platform: string; label: string; baseUrl?: string }[];
let logins: string[];
let squireCall: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'milo-setup-test-'));
  vi.stubEnv('MILO_CONFIG_DIR', stateDir);
  vi.stubEnv('MILO_ROUTER_RUNTIME', 'docker');
  vi.stubEnv('XDG_CONFIG_HOME', stateDir);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  installed = false; volume = false; storedKeys = false; legacyAdmin = true; keys = []; logins = [];
  docker.mockReset(); question.mockClear();
  docker.mockImplementation(async (_command, args) => {
    if (args[0] === 'inspect') {
      if (!installed) throw Object.assign(new Error('missing'), { stderr: 'No such container: milo-freellmapi' });
      return { stdout: '1' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (!volume) throw Object.assign(new Error('missing'), { stderr: 'No such volume: milo-freellmapi-data' });
      return { stdout: 'milo-freellmapi-data' };
    }
    if (args[0] === 'run' && args.includes('--rm')) return { stdout: storedKeys ? 'keys' : 'empty' };
    if (args[0] === 'run') { installed = true; volume = true; }
    if (args[0] === 'rm') installed = false;
    if (args[0] === 'volume' && args[1] === 'rm') volume = false;
    return { stdout: '' };
  });
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  squireCall = vi.spyOn(BrowserSquire.prototype, 'call').mockImplementation(async (name, _args) => {
    if (name === 'list_credentials') return { credentials: [
      ...(legacyAdmin ? [{ service: 'milo-freellmapi-admin', reference: 'vault://admin', field_names: ['password', 'encryption_key'] }] : []),
      { service: 'groq', reference: 'vault://groq', field_names: ['api_key'] }
    ] };
    if (name === 'store_credential') return {};
    if (name === 'grant_app_access') return { base_url: 'https://egress.squire.test/groq/v1', token: 'synthetic-grant-token' };
    throw new Error(`Unexpected Squire call: ${name}`);
  });
  vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (path, body, method) => {
    if (path === '/auth/login') { logins.push((body as { password: string }).password); return { token: 'synthetic-login' }; }
    if (path === '/keys' && method === 'GET') return keys;
    if (path === '/keys/custom/discover-models') return { models: [{ id: 'openai/gpt-oss-120b' }] };
    if (path === '/keys/custom') { keys.push({ id: 1, platform: 'custom', label: (body as { label: string }).label, baseUrl: (body as { baseUrl: string }).baseUrl }); return {}; }
    if (path.startsWith('/keys/')) return {};
    if (path === '/fallback' && method === 'GET') return [];
    if (path === '/settings/api-key') return { apiKey: 'synthetic-router-key' };
    return {};
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  await rm(stateDir, { recursive: true, force: true });
});

it.each([true, false])('never fetches or stores local admin credentials and reuses its private local file across setup runs (legacy vault entry: %s)', async exists => {
  legacyAdmin = exists;
  await expect(setup(() => {})).resolves.toEqual({ key: 'synthetic-router-key' });
  await expect(setup(() => {})).resolves.toEqual({ key: 'synthetic-router-key' });
  expect(squireCall.mock.calls.filter(([name, args]) => name === 'store_credential'
    || (name === 'fetch_credential' && (args.reference === 'vault://admin' || args.approval_id === 'vault://admin')))).toEqual([]);
  const files = await readdir(stateDir);
  const admin = files.find(file => file !== 'approvals.json');
  expect(admin).toBeDefined();
  const path = join(stateDir, admin!);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved).toMatchObject({ password: logins[0], encryption: expect.any(String) });
  expect(logins).toEqual([saved.password, saved.password]);
});

it('mints a provider grant once and reuses the grant-backed router entry without revealing keys', async () => {
  const output: string[] = [];
  await setup(line => output.push(line));
  expect(squireCall.mock.calls.filter(([name]) => name === 'grant_app_access')).toEqual([['grant_app_access', { reference: 'vault://groq' }]]);
  expect(squireCall.mock.calls.some(([name]) => name === 'fetch_credential')).toBe(false);
  expect(JSON.stringify(output)).not.toContain('synthetic-grant-token');
  squireCall.mockClear(); question.mockClear(); output.length = 0;
  await setup(line => output.push(line));
  expect(squireCall.mock.calls.filter(([name]) => name === 'fetch_credential')).toEqual([]);
  expect(output.some(line => line.includes('approve'))).toBe(false);
  expect(question).toHaveBeenCalledTimes(0);
});

it.each(['environment', 'saved login', 'router recovers'])('answers daemon requests using %s without rerunning setup', async mode => {
  await setup(() => {});
  logins.length = 0;
  docker.mockClear(); squireCall.mockClear();
  let online = mode !== 'router recovers';
  const authorizations: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (!online) throw new Error('router down');
    const path = new URL(String(url)).pathname;
    if (path === '/v1/models') return Response.json({ data: [] });
    authorizations.push(String((init?.headers as Record<string, string>).Authorization));
    return Response.json({ choices: [{ message: { content: 'router answered' } }] });
  }));
  const adminCall = vi.spyOn(FreeLLMAdmin.prototype, 'call');
  const original = adminCall.getMockImplementation()!;
  adminCall.mockImplementation(async (...args) => {
    if (!online) throw new Error('router down');
    return original(...args);
  });
  const sources = configure({ MILO_SOURCES: 'freellmapi,kilo', ...(mode === 'environment' ? { MILO_FREELLMAPI_KEY: 'synthetic-env-key' } : {}) });
  const app = createLocalApp(sources);
  const send = () => app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'milo', messages: [{ role: 'user', content: 'hi' }] })
  });
  try {
    if (!online) {
      expect(await sources.sources[0]!.available()).toBe(false);
      expect((await send()).status).toBeGreaterThanOrEqual(400);
      online = true;
    }
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await sources.sources[1]!.available()).toBe(true);
    expect(authorizations).toEqual(Array(2).fill(`Bearer ${mode === 'environment' ? 'synthetic-env-key' : 'synthetic-router-key'}`));
    expect(logins).toHaveLength(mode === 'environment' ? 0 : 1);
    expect(docker).not.toHaveBeenCalled();
    expect(squireCall).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); await sources.close(); }
});

it.each([true, false])('recreates a keyless old router when local admin state is missing (container: %s)', async container => {
  installed = container; volume = true;
  await setup(() => {});
  const commands = docker.mock.calls.map(([, args]) => args);
  expect(commands).toContainEqual(['volume', 'rm', 'milo-freellmapi-data']);
  expect(commands.some(args => args[0] === 'run' && args.includes('--rm'))).toBe(true);
  expect(commands.some(args => args[0] === 'run' && args.includes('-d'))).toBe(true);
  if (container) expect(commands).toContainEqual(['rm', '-f', 'milo-freellmapi']);
});

it.each([true, false])('preserves an old router containing provider keys when local admin state is missing (container: %s)', async container => {
  installed = container; volume = true; storedKeys = true;
  await expect(setup(() => {})).rejects.toThrow(/provider keys.*preserv/i);
  expect(docker.mock.calls.some(([, args]) => args[0] === 'rm' || args[0] === 'volume' && args[1] === 'rm')).toBe(false);
  expect(squireCall.mock.calls.filter(([name]) => name === 'fetch_credential' || name === 'store_credential')).toEqual([]);
});
