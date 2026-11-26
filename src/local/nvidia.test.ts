import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { Nvidia, NVIDIA_DEEPSEEK, readNvidiaGrant, writeNvidiaGrant } from './nvidia.js';
import { BrowserSquire, setup } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { bundledRegistry, validateRegistry } from '../registry.js';

const directories: string[] = [];
const grant = { base_url: 'https://grant.test/nvidia', token: 'synthetic-grant' };
const request = { model: 'nvidia', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-nvidia-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('pins NVIDIA capabilities and configures its dedicated source', async () => {
  const adapter = { id: 'nvidia', kind: 'model', tier: 'stable', weight: 0.2, modalities: ['text'], install: 'builtin:nvidia', model: NVIDIA_DEEPSEEK };
  expect(bundledRegistry.adapters.some(a => a.id === 'nvidia')).toBe(false);
  expect(adapter).toMatchObject({ kind: 'model', install: 'builtin:nvidia', model: NVIDIA_DEEPSEEK });
  for (const change of [{ install: 'npm:untrusted' }, { install: 'builtin:other' }, { kind: 'agent' }, { modalities: ['image'] }]) {
    expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...adapter, ...change }] })).toThrow();
  }
  const sources = configure({ GRUNT_SOURCES: 'nvidia' });
  expect(sources.sources[0]).toBeInstanceOf(Nvidia);
  await sources.close();
});

it.each([undefined, 100000])('sends the exact DeepSeek model directly through the NVIDIA-scoped grant with budget %s', async maxTokens => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: NVIDIA_DEEPSEEK, choices: [{ message: { content: 'Hello from NVIDIA' } }], usage: { prompt_tokens: 4, completion_tokens: 8 } }));
  const source = new Nvidia({ loadGrant: async () => grant, fetcher });
  const response = await createLocalApp(new Sources([source])).request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, max_tokens: maxTokens, tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] })
  });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('nvidia');
  expect((await response.json()).choices[0].message.content).toBe('Hello from NVIDIA');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe('https://grant.test/nvidia/v1/chat/completions');
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).max_tokens).toBe(maxTokens);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: NVIDIA_DEEPSEEK, tools: [{ function: { name: 'read' } }] });
});

it.each([[401, 'logged_out'], [402, 'quota'], [403, 'refused'], [429, 'quota'], [503, 'upstream']] as const)('stops after NVIDIA HTTP %s without contacting another backend', async (status, code) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('secret upstream payload', { status, headers: { 'Retry-After': '27' } }));
  const source = new Nvidia({ loadGrant: async () => grant, fetcher });
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code, message: `NVIDIA returned HTTP ${status}`, retryAfter: 27 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe('https://grant.test/nvidia/v1/chat/completions');
});

it('stores only a private grant and rejects an unsafe grant file', async () => {
  const path = await directory();
  await writeNvidiaGrant(grant, path);
  expect(await readNvidiaGrant(path)).toEqual(grant);
  expect((await stat(join(path, 'nvidia.json'))).mode & 0o777).toBe(0o600);
  expect(await readdir(path)).toEqual(['nvidia.json']);
  await rm(join(path, 'nvidia.json'));
  await writeFile(join(path, 'nvidia.json'), JSON.stringify(grant), { mode: 0o644 });
  await expect(readNvidiaGrant(path)).rejects.toThrow('Unsafe');
  expect(await new Nvidia({ directory: path }).available()).toBe(false);
});

it.each(['http://grant.test', 'https://user:pass@grant.test', 'https://grant.test/?token=private'])('rejects unsafe grant endpoints (%s)', async base_url => {
  await expect(writeNvidiaGrant({ ...grant, base_url }, await directory())).rejects.toThrow('endpoint');
});

it('provisions NVIDIA without a local aggregator and reuses valid access', async () => {
  const path = await directory(); vi.stubEnv('GRUNT_CONFIG_DIR', path);
  const output: string[] = [];
  const squire = {
    credentials: { list: vi.fn(async () => [{ service: 'nvidia', reference: 'vault://nvidia', field_names: ['NVIDIA_API_KEY'] }]), grant: vi.fn(async () => grant) },
    runs: { start: vi.fn(), get: vi.fn() }
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: NVIDIA_DEEPSEEK }] })); vi.stubGlobal('fetch', fetcher);
  for (let i = 0; i < 2; i++) await setup(line => output.push(line), ['nvidia'], { squire });
  expect(squire.runs.start).not.toHaveBeenCalled(); expect(squire.credentials.grant).toHaveBeenCalledOnce();
  expect(await readNvidiaGrant(path)).toEqual(grant); expect(await readdir(path)).toEqual(['nvidia.json']);
  expect(JSON.stringify(output)).not.toContain('synthetic-grant');
  expect(output.some(line => line.startsWith('kilo:'))).toBe(false);
  expect(JSON.parse(await readFile(join(path, 'nvidia.json'), 'utf8'))).toEqual(grant);
});

it('requests free NVIDIA signup with Google reuse and host-scoped vault capture', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: 'nvidia-session' } : {});
  await squire.runs.start({ service: 'nvidia', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ url: 'https://build.nvidia.com/settings/api-keys', goal: expect.stringContaining('Prefer Google OAuth') }));
  const goal = String(call.mock.calls.find(([name]) => name === 'operate_drive')![1].goal);
  expect(goal).toContain('api_hosts ["integrate.api.nvidia.com"]'); expect(goal).toContain('Never reset or rotate'); expect(goal).not.toMatch(/free model|free inference endpoint/);
});

it('continues other setup jobs when NVIDIA needs attention', async () => {
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const verify = vi.fn(async () => {});
  const result = await setupFallbacks({ dataSharingApproved: ['freebuff', 'opencode', 'kilo', 'tokenharbor'], directory: await directory(), adapters: ['nvidia', 'opencode'], squire, run: async () => {}, verify, notify: () => {},
    setupProvider: async () => { throw new Error('verification needed'); } });
  expect(result).toEqual({ unavailable: ['nvidia'] }); expect(verify).toHaveBeenCalledOnce();
});
