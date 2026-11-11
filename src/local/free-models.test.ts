import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp, decode } from './api.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { FreeLLMAPI, freeConfig } from './freellmapi.js';
import { OpenCode } from './opencode.js';
import { BrowserSquire, ensureRouter, FreeLLMAdmin, setupProviders } from './setup.js';
import type * as Prompts from '@clack/prompts';
import type { SetupSquire } from './setup.js';

vi.mock('@clack/prompts', async importOriginal => ({ ...await importOriginal<typeof Prompts>(), confirm: vi.fn(async () => true) }));

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'milo-approval-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', stateDir);
  vi.stubEnv('MILO_CONFIG_DIR', '');
  vi.stubEnv('MILO_SQUIRE_XDG_CONFIG_HOME', '');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(stateDir, { recursive: true, force: true }); });
const request = { model: 'freellmapi', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };

it('routes the daemon free API through loopback FreeLLMAPI, preserves tools and caps tokens', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'routed reply' } }] }));
  const app = createLocalApp(new Sources([new FreeLLMAPI({ key: 'synthetic', fetcher })]));
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, max_tokens: 100000, tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] }) });
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe('routed reply');
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:3001/v1/chat/completions');
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: 'auto', max_tokens: 4096, tools: [{ function: { name: 'read' } }] });
  expect(configure({ MILO_GATEWAY_URL: 'https://openrouter.ai/api/v1' }).sources.map(s => s.id)).not.toContain('gateway');
  for (const url of ['https://openrouter.ai/api/v1', 'http://example.com/v1', 'http://localhost:3001/v1']) {
    expect(() => new FreeLLMAPI({ url })).toThrow('loopback');
  }
});

it('keeps upstream failures and credentials out of error text', async () => {
  const api = new FreeLLMAPI({ key: 'synthetic', fetcher: async () => new Response('secret upstream payload', { status: 403 }) });
  await expect(api.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused', message: 'FreeLLMAPI returned HTTP 403' });
});

it('registers anonymous Kilo and the separate Freebuff bridge last in the ordered chain', () => {
  const config = freeConfig();
  expect(config.customProviders).toEqual([
    { baseUrl: 'https://ai-gateway.kilo.ai/api/v1', apiKey: 'no-key', label: 'Kilo Free', models: [{ model: 'kilo-auto/free', supportsTools: true }] },
    { baseUrl: 'http://127.0.0.1:8789/v1', apiKey: 'no-key', label: 'Freebuff', models: [{ model: 'freebuff', supportsTools: true }] }
  ]);
  expect(config.routing.strategy).toBe('priority');
  expect(config.fallback.at(-1)).toMatchObject({ modelId: 'freebuff', priority: 1000000 });
  expect(config.fallback.map(f => f.platform)).not.toContain('openrouter');
});

it('types the exact latest OpenCode fixture message and reuses the session for follow-ups', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/opencode.json', import.meta.url), 'utf8'));
  const calls: { path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(path === '/session' ? { id: 'session_one' } : { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'bridge works 42' }] });
  };
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher });
  const app = createLocalApp(new Sources([driver]));
  fixture.cwd = '/tmp'; fixture.model = 'opencode'; fixture.stream = false;
  expect((await (await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture) })).json()).choices[0].message.content).toBe('bridge works 42');
  fixture.messages.push({ role: 'assistant', content: 'bridge works 42' }, { role: 'user', content: '  Repeat it.\n' });
  await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture) });
  expect(calls.filter(c => c.path === '/session')).toHaveLength(1);
  const prompts = calls.filter(c => c.path.endsWith('/message'));
  expect(prompts.map(p => p.path)).toEqual(['/session/session_one/message', '/session/session_one/message']);
  expect(prompts.map(p => p.body)).toEqual([
    { model: { providerID: 'opencode', modelID: 'big-pickle' }, parts: [{ type: 'text', text: fixture.messages[1].content }] },
    { model: { providerID: 'opencode', modelID: 'big-pickle' }, parts: [{ type: 'text', text: '  Repeat it.\n' }] }
  ]);
  await driver.close();
});

it('does not swallow OpenCode provider refusals or return upstream secrets', async () => {
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: async url => Response.json(String(url).includes('/message') ? { info: { error: { name: 'ProviderAuthError', data: { message: 'secret' } } }, parts: [] } : { id: 'session_one' }) });
  await expect(driver.complete(decode({ messages: request.messages }, 'chat', '/tmp'), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused', message: 'OpenCode provider refused the request' });
});

function fakeSquire() {
  const credentials: { service: string; reference: string; field_names: string[] }[] = [];
  const squire: SetupSquire = {
    credentials: {
      list: vi.fn(async () => credentials),
      grant: vi.fn(async reference => ({ base_url: 'https://egress.squire.test/v1', token: `synthetic-${reference}` }))
    },
    runs: {
      start: vi.fn(async input => {
        credentials.push({ service: input.service, reference: input.service, field_names: ['api_key'] });
        return { run: { id: input.service, state: 'completed' }, decision: 'silent' as const };
      }),
      get: vi.fn(async () => ({ state: 'completed' }))
    }
  };
  return squire;
}

it('sets up every free provider through the user Squire and imports keys only into FreeLLMAPI', async () => {
  const squire = fakeSquire(), imported: unknown[] = [], output: string[] = [];
  await setupProviders(squire, { addGrant: async (platform, grant) => { imported.push({ platform, grant }); } }, { notify: line => output.push(line) });
  expect(vi.mocked(squire.runs.start).mock.calls.map(([input]) => input.service)).toEqual(['groq']);
  expect(imported).toEqual(['groq'].map(platform => ({ platform, grant: { base_url: 'https://egress.squire.test/v1', token: `synthetic-${platform}` } })));
  expect(JSON.stringify(output)).not.toContain('synthetic-');
  expect(output.filter(o => o.includes('https://squire.test/approve'))).toHaveLength(0);
  expect(vi.mocked(squire.runs.start).mock.calls.every(([i]) => i.cost_cents === 0)).toBe(true);
});

it.each([
  { provider: 'groq' as const, service: ' Groq ', field: 'api_key', initiallyKnown: false },
  { provider: 'groq' as const, service: 'Groq', field: 'value', initiallyKnown: true },
  { provider: 'groq' as const, service: 'groq', field: 'apiKey', initiallyKnown: false },
  { provider: 'groq' as const, service: 'GROQ', field: 'GROQ_API_KEY', initiallyKnown: false }
])('reuses $service/$field without starting unnecessary provisioning', async ({ provider, service, field, initiallyKnown }) => {
  const squire = fakeSquire(), output: string[] = [], addGrant = vi.fn();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'needs_approval', approval_url: 'https://squire.test/sms', run: { id: 'sms', state: 'awaiting_approval' } });
  if (!initiallyKnown) {
    expect(await setupProviders(squire, { addGrant }, { providers: [provider], notify: line => output.push(line) })).toMatchObject({ pending: [] });
    expect(output.join('\n')).not.toContain('https://squire.test/sms');
    expect(addGrant).not.toHaveBeenCalled();
  }
  vi.mocked(squire.credentials.list).mockResolvedValue([{ service, reference: 'existing', field_names: [field] }]);
  await setupProviders(squire, { addGrant }, { providers: [provider], notify: () => {} });
  expect(squire.runs.start).toHaveBeenCalledTimes(initiallyKnown ? 0 : 1);
  expect(squire.credentials.grant).toHaveBeenCalledWith('existing');
  expect(addGrant).toHaveBeenCalledWith(provider, { base_url: 'https://egress.squire.test/v1', token: 'synthetic-existing' });
});

it('uses the local Squire browser driver and approved vault capture', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'complete', session_id: 'signup' });
  await squire.runs.start({ service: 'groq', plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ url: 'https://console.groq.com/keys', goal: expect.stringContaining('operate_extract') }));
  call.mockResolvedValue({ base_url: 'https://egress.squire.test/v1', token: 'synthetic-grant' });
  await expect(squire.credentials.grant('vault://synthetic')).resolves.toEqual({ base_url: 'https://egress.squire.test/v1', token: 'synthetic-grant' });
  expect(call).toHaveBeenLastCalledWith('grant_app_access', { reference: 'vault://synthetic' });
});

it('disables removed SMS providers and a newly dropped provider in the router chain', async () => {
  const admin = new FreeLLMAdmin();
  const call = vi.spyOn(admin, 'call').mockResolvedValue([
    { modelDbId: 1, platform: 'groq', modelId: 'groq', priority: 1 },
    { modelDbId: 2, platform: 'mistral', modelId: 'mistral', priority: 2 },
    { modelDbId: 3, platform: 'nvidia', modelId: 'nvidia', priority: 3 },
    { modelDbId: 4, platform: 'custom', modelId: 'kilo-auto/free', priority: 4 }
  ]);
  await admin.configureChain(['groq']);
  expect(call).toHaveBeenCalledWith('/fallback', [
    { modelDbId: 1, enabled: false, priority: 1 },
    { modelDbId: 2, enabled: false, priority: 2 },
    { modelDbId: 3, enabled: false, priority: 3 },
    { modelDbId: 4, enabled: true, priority: 999999 }
  ], 'PUT');
});

it.each([
  { reason: 'Provider denied automated account creation.', remaining: '', detail: true },
  { reason: 'Provider denied automated account creation.', remaining: 'API key: synthetic-private-value; password=short-secret; token https://example.test/?token=private; gsk_syntheticprivatevalue1234567890', detail: true },
  { reason: 'Provider denied automated account creation. password is SyntheticPass!42.', remaining: '', detail: false },
  { reason: 'Provider denied automated account creation. your token was "SyntheticToken!42".', remaining: '', detail: false },
  { reason: "Provider denied automated account creation. secret = 'Synthetic Secret!42'", remaining: '', detail: false },
  { reason: 'Provider denied automated account creation. api key: "SyntheticKey!42"', remaining: '', detail: false },
  { reason: 'Provider denied automated account creation. passcode is SyntheticCode!42', remaining: '', detail: false },
  { reason: 'Provider denied automated account creation. credential SyntheticCredential!42', remaining: '', detail: false },
  { reason: 'Provider denied automated account creation. key might be SyntheticKey!42', remaining: '', detail: false }
])('reports only safe refusal details and stops before another provider ($reason)', async ({ reason, remaining, detail }) => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({
    status: 'stuck', session_id: 'signup', reason, remaining
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  const addGrant = vi.fn(), notify = vi.fn();
  let message = '';
  try { await setupProviders(squire, { addGrant }, { notify }); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('Provider refused groq signup; setup stopped' + (detail ? ': Provider denied automated account creation.' : ''));
  for (const secret of ['synthetic-private-value', 'short-secret', 'https://example.test', 'gsk_syntheticprivatevalue', 'SyntheticPass!42', 'SyntheticToken!42', 'Synthetic Secret!42', 'SyntheticKey!42', 'SyntheticCode!42', 'SyntheticCredential!42']) expect(message).not.toContain(secret);
  expect(call).toHaveBeenCalledTimes(1);
  expect(addGrant).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it('preserves refusal details from rejected setup runs', async () => {
  const squire = fakeSquire();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'reject', reason: 'Free API access is unavailable in this region.', run: { id: 'groq', state: 'rejected' } });
  await expect(setupProviders(squire, { addGrant: vi.fn() }, { notify: vi.fn() })).rejects.toThrow('Free API access is unavailable in this region.');
});

it('recovers an interrupted router installation using the supplied local admin credentials', async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'inspect') throw Object.assign(new Error('missing'), { code: 1, stderr: 'Error: No such object: milo-freellmapi' });
    return { stdout: '' };
  });
  await ensureRouter('synthetic-password', 'synthetic-encryption', run);
  expect(run.mock.calls.map(([args]) => args[0])).toEqual(['inspect', 'pull', 'run']);
  expect(run.mock.calls[2]![0]).toContain('io.milo.router=1');
  expect(JSON.stringify(run.mock.calls.map(([args]) => args))).not.toContain('synthetic-');
  const unrelated = vi.fn(async () => ({ stdout: 'not-Milo' }));
  await expect(ensureRouter('synthetic-password', 'synthetic-encryption', unrelated)).rejects.toThrow('belongs to another installation');
  expect(unrelated).toHaveBeenCalledTimes(1);
});

it('shares a human verification step and resumes signup in the same browser session', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValueOnce({ status: 'needs_value', field: 'captcha', session_id: 'signup', remaining: 'Complete a captcha' })
    .mockResolvedValue({ status: 'complete', session_id: 'signup' });
  const handoff = vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.example.test');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await squire.runs.start({ service: 'groq', plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none' })).toMatchObject({ run: { state: 'running' } });
  expect(handoff).toHaveBeenCalledWith('signup');
  expect(await squire.runs.get('groq')).toMatchObject({ state: 'completed' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'signup' }));
  expect(output).toHaveBeenCalledWith(expect.stringContaining('https://handoff.example.test'));
});
