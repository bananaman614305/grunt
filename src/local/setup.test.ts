import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as ChildProcess from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire, FreeLLMAdmin, setup, setupURL, providerURL, providerLabel } from './setup.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';

vi.mock('@clack/prompts', () => ({ confirm: vi.fn(async () => true), password: vi.fn(async () => 'synthetic-provider-key'), select: vi.fn(async () => 'unlisted-model'), isCancel: (value: unknown) => typeof value === 'symbol' }));

const { docker, question } = vi.hoisted(() => ({ docker: vi.fn(), question: vi.fn(async () => '') }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: docker }) };
});
vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question, close: vi.fn() }) }));

// Matches @trusty-squire/mcp 1.1.39: z.string().trim().min(1).max(60).
const credentialLabelSchema = { parse(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw new Error('Invalid vault label');
  return value.trim();
} };
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

it('stops native setup without replacing the missing key of an existing database', async () => {
  vi.stubEnv('MILO_ROUTER_RUNTIME', 'native');
  await mkdir(join(stateDir, 'freellmapi'));
  const database = join(stateDir, 'freellmapi', 'router.db');
  await writeFile(database, 'existing encrypted provider state');
  await expect(setup(() => {})).rejects.toThrow(/existing.*database.*restore/i);
  expect(await readFile(database, 'utf8')).toBe('existing encrypted provider state');
  expect(await readdir(stateDir)).toEqual(['freellmapi']);
  expect(logins).toEqual([]);
});

it('keeps Freebuff and Kilo enabled last on repeat setup without changing other backups', async () => {
  const chain = [
    { modelDbId: 1, platform: 'custom', modelId: 'freebuff', priority: 3, keyLabel: 'Freebuff', enabled: false },
    { modelDbId: 2, platform: 'custom', modelId: 'kilo-auto/free', priority: 4, keyLabel: 'Kilo Free', enabled: false },
    { modelDbId: 3, platform: 'custom', modelId: 'other', priority: 17, keyLabel: 'My backup', enabled: true },
    { modelDbId: 4, platform: 'groq', modelId: 'disabled', priority: 19, keyLabel: null, enabled: false },
    { modelDbId: 5, platform: 'custom', modelId: 'gpt-oss-120b', priority: 0, keyLabel: 'Milo groq (Squire)', enabled: false }
  ];
  const updates: unknown[] = [];
  vi.mocked(FreeLLMAdmin.prototype.call).mockImplementation(async (path, body, method) => {
    if (path === '/fallback' && method === 'GET') return chain;
    if (path === '/fallback' && method === 'PUT') { updates.push(body); for (const row of body as typeof chain) Object.assign(chain.find(saved => saved.modelDbId === row.modelDbId)!, row); }
    return {};
  });
  const router = new FreeLLMAdmin();
  await router.configureChain(); await router.configureChain();
  expect(updates).toEqual([1, 2].map(() => [
    { modelDbId: 1, enabled: true, priority: 1000000 },
    { modelDbId: 2, enabled: true, priority: 999999 },
    { modelDbId: 3, enabled: true, priority: 17 },
    { modelDbId: 4, enabled: false, priority: 19 },
    { modelDbId: 5, enabled: true, priority: 0 }
  ]));
});

it.each(['https://example.test/api/v1', 'http://localhost:1234/v1', 'http://127.0.0.1:1234', 'http://[::1]:1234/v1'])('accepts safe base URL %s', value => {
  expect(providerURL(value)?.host).toBe(new URL(value).host);
});
it.each(['http://example.test/v1', 'https://user:pass@example.test', 'https://example.test/v1?token=secret', 'https://example.test/#x'])('rejects unsafe URL %s', value => {
  expect(() => providerURL(value)).toThrow();
});
it.each(['https://example.test/api/v1', 'https://my-company-production-resource.openai.azure.com/openai/v1', 'http://[::1]:1234/v1'])('vaults and replaces the same URL: %s', async base => {
  const records: { id: number; platform: string; label: string; baseUrl: string; models: { modelId: string }[] }[] = [];
  let next = 0;
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'store_credential') { credentialLabelSchema.parse(args.label); return { reference: 'vault://example' }; }
    return { base_url: 'https://egress.test/grant', token: 'synthetic-grant' };
  });
  const router = new FreeLLMAdmin();
  const admin = vi.spyOn(router, 'call').mockImplementation(async (path, body, method) => {
    if (path.endsWith('discover-models')) return { models: [{ id: 'unlisted-model' }] };
    if (path === '/keys') return [...records];
    if (method === 'DELETE') { records.splice(records.findIndex(row => path === `/keys/${row.id}`), 1); return {}; }
    if (path === '/keys/custom') { const row = body as { baseUrl: string; label: string; models: { model: string }[] }; records.push({ ...row, id: ++next, platform: 'custom', models: row.models.map(m => ({ modelId: m.model })) }); return { keyId: next }; }
    if (path === '/fallback' && method === 'GET') return records.map(row => ({ modelDbId: row.id, platform: row.platform, modelId: 'unlisted-model', keyLabel: row.label, enabled: false, priority: 0 }));
    return {};
  });
  await setupURL(squire, router, base, () => {});
  await setupURL(squire, router, base, () => {});
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ baseUrl: 'https://egress.test/grant' + new URL(base).pathname, label: `Milo ${providerLabel(base)} (Squire)`, models: [{ modelId: 'unlisted-model' }] });
  expect(call).toHaveBeenCalledWith('store_credential', { service: new URL(base).host, label: providerLabel(base), value: 'synthetic-provider-key', auth_shape: 'bearer', api_hosts: [new URL(base).host] });
  expect(await router.hasKey(base)).toBe(true);
  await router.configureChain();
  expect(admin).toHaveBeenCalledWith('/fallback', [{ modelDbId: 2, enabled: true, priority: 0 }], 'PUT');
});
it('cancels before reading or sending a key when the host is not confirmed', async () => {
  const { confirm, password } = await import('@clack/prompts');
  vi.mocked(confirm).mockResolvedValueOnce(false);
  vi.mocked(password).mockClear();
  await expect(setupURL(new BrowserSquire(), new FreeLLMAdmin(), 'https://example.test/v1', () => {})).rejects.toThrow('cancelled');
  expect(password).not.toHaveBeenCalled();
  expect(squireCall).not.toHaveBeenCalled();
});
it.each([[[]], [[{ id: 'unlisted-model' }]]])('fails clearly when discovery is empty or rejected', async models => {
  const router = new FreeLLMAdmin();
  vi.spyOn(router, 'call').mockImplementation(async () => { if (models.length) throw new Error('synthetic-provider-key'); return { models }; });
  await expect(router.addGrant('https://example.test/v1', { base_url: 'https://egress.test/v1', token: 'synthetic' })).rejects.toThrow(models.length ? 'Model discovery failed' : 'no models');
});

it('distinguishes long URLs sharing a prefix and normalizes identity', () => {
  const base = 'https://my-company-production-resource.openai.azure.com/openai/v1';
  const label = providerLabel(base);
  expect(credentialLabelSchema.parse(label)).toBe(label);
  expect(label).toMatch(/^custom-[a-z0-9.-]+-[a-f0-9]{12}$/);
  expect(providerLabel(base + '/other')).not.toBe(label);
  expect(providerLabel(base.replace('https://my-company', 'https://MY-COMPANY'))).toBe(label);
});
