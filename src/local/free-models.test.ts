import { idleEvents } from './fixtures/opencode-events.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    { baseUrl: 'http://127.0.0.1:8789/v1', apiKey: 'no-key', label: 'Freebuff', models: [{ model: 'freebuff', supportsTools: false }] }
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
    if (path === '/event') return idleEvents();
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(path === '/session' ? { id: 'session_one' } : { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'bridge works 42' }] });
  };
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher });
  const app = createLocalApp(new Sources([driver]));
  fixture.cwd = '/tmp'; fixture.model = 'opencode'; fixture.stream = false; fixture.tools = [];
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

it.each(['ProviderAuthError', 'UnknownError'])('types OpenCode %s without returning upstream secrets', async name => {
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: async url => String(url).endsWith('/event') ? idleEvents() : Response.json(String(url).includes('/message') ? { info: { error: { name, data: { message: 'secret' } } }, parts: [] } : { id: 'session_one' }) });
  await expect(driver.complete(decode({ messages: request.messages }, 'chat', '/tmp'), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: name === 'ProviderAuthError' ? 'logged_out' : 'refused', message: name === 'ProviderAuthError' ? 'OpenCode free model requires sign-in' : 'OpenCode provider refused the request' });
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
  await squire.runs.start({ service: 'groq', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ url: 'https://console.groq.com/keys', goal: expect.stringContaining('operate_extract') }));
  call.mockResolvedValue({ base_url: 'https://egress.squire.test/v1', token: 'synthetic-grant' });
  await expect(squire.credentials.grant('vault://synthetic')).resolves.toEqual({ base_url: 'https://egress.squire.test/v1', token: 'synthetic-grant' });
  expect(call).toHaveBeenLastCalledWith('grant_app_access', { reference: 'vault://synthetic' });
});

it('preserves disabled providers and enables Kilo in the router chain', async () => {
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
  expect(run.mock.calls[2]![0]).toContain('PROVIDER_TIMEOUT_CUSTOM=600000');
  expect(JSON.stringify(run.mock.calls.map(([args]) => args))).not.toContain('synthetic-');
  const unrelated = vi.fn(async () => ({ stdout: 'not-grunt' }));
  await expect(ensureRouter('synthetic-password', 'synthetic-encryption', unrelated)).rejects.toThrow('belongs to another installation');
  expect(unrelated).toHaveBeenCalledTimes(1);
});

it.each(['captcha', 'email confirmation'])('shares %s and resumes signup in the same browser session', async field => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValueOnce({ status: 'needs_value', field, session_id: 'signup', remaining: `Complete ${field}` })
    .mockResolvedValue({ status: 'complete', session_id: 'signup' });
  const handoff = vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.example.test');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await squire.runs.start({ service: 'groq', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' })).toMatchObject({ run: { state: 'running' } });
  expect(handoff).toHaveBeenCalledWith('signup');
  expect(await squire.runs.get('groq')).toMatchObject({ state: 'completed' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'signup' }));
  expect(output).toHaveBeenCalledWith(expect.stringContaining('https://handoff.example.test'));
});

it('registers the provider API path beneath a Squire egress root and rejects legacy bare-root entries', async () => {
  const admin = new FreeLLMAdmin();
  const call = vi.spyOn(admin, 'call').mockImplementation(async path => path === '/keys/custom/discover-models' ? { models: [{ id: 'openai/gpt-oss-120b' }] } : [{ id: 1, platform: 'custom', label: 'Milo groq (Squire)', baseUrl: 'https://egress.test/g_123' }]);
  expect(await admin.hasKey('groq')).toBe(false);
  await admin.addGrant('groq', { base_url: 'https://egress.test/g_123', token: 'synthetic-grant' });
  expect(call).toHaveBeenCalledWith('/keys/custom', expect.objectContaining({ baseUrl: 'https://egress.test/g_123/openai/v1', apiKey: 'synthetic-grant', models: [{ model: 'openai/gpt-oss-120b', supportsTools: true }] }));
  call.mockImplementation(async path => path === '/keys/custom/discover-models' ? { models: [{ id: 'openai/gpt-oss-120b' }] } : [{ id: 1, platform: 'custom', label: 'Milo groq (Squire)', baseUrl: 'https://egress.test/g_123/openai/v1', models: [{ modelId: 'openai/gpt-oss-120b' }] }]);
  expect(await admin.hasKey('groq')).toBe(true);
});

it.each(['freebuff', 'opencode'])('shares %s human verification and resumes the same signup session', async service => {
  const squire = new BrowserSquire();
  const handoff = vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/verify');
  const call = vi.spyOn(squire, 'call')
    .mockResolvedValueOnce({ status: 'needs_value', session_id: 'signup-session', field: 'verification_code', remaining: 'Email verification needs a human' })
    .mockResolvedValueOnce({ status: 'complete', session_id: 'signup-session' })
    .mockResolvedValue({});
  await squire.signup(service, `https://${service}.test/login`, 'Sign in to the free plan');
  expect(handoff).toHaveBeenCalledWith('signup-session');
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => args)).toEqual([
    expect.objectContaining({ url: `https://${service}.test/login` }),
    expect.objectContaining({ session_id: 'signup-session' })
  ]);
});


it.each(['allow', { edit: 'ask', external_directory: { '*': 'allow' } }])('preserves inline permissions %j while denying outside access and closing the probe', async permission => {
  const pidFile = join(stateDir, 'probe.pid');
  const configFile = join(stateDir, 'spawn-config.json');
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'synthetic/model', permission }));
  await writeFile(join(stateDir, 'opencode'), '#!' + process.execPath + '\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require('node:fs').writeFileSync(${JSON.stringify(configFile)}, process.env.OPENCODE_CONFIG_CONTENT); process.on('SIGTERM', () => {}); console.log('http://127.0.0.1:19778'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  vi.stubEnv('PATH', stateDir + ':' + process.env.PATH);
  const source = new OpenCode({ fetcher: async url => String(url).endsWith('/event') ? idleEvents() : Response.json(String(url).includes('/message') ? { parts: [{ type: 'text', text: 'ready' }] } : { id: 'probe' }) });
  let pid: number | undefined;
  try {
    await source.complete(request, AbortSignal.timeout(5000));
    pid = Number(await readFile(pidFile, 'utf8'));
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({
      model: 'synthetic/model', permission: { ...(typeof permission === 'string' ? { '*': permission } : { edit: 'ask' }), external_directory: 'deny' }
    });
    await source.close();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already closed. */ } } }
});


it.each([{ saved: [] }, { saved: ['kilo'] }])('adds only saved optional providers ($saved) without signup', async ({ saved }) => {
  const squire = fakeSquire();
  vi.mocked(squire.credentials.list).mockResolvedValue(saved.map(service => ({ service, reference: service, field_names: ['value'] })));
  const addGrant = vi.fn();
  await setupProviders(squire, { addGrant }, { providers: [], notify: vi.fn() });
  expect(addGrant.mock.calls.map(([provider]) => provider)).toEqual(saved);
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it.each([true, false])('explicit Kilo setup connects once, provisioning only when missing (%s)', async saved => {
  const squire = fakeSquire(), addGrant = vi.fn();
  if (saved) vi.mocked(squire.credentials.list).mockResolvedValue([{ service: 'kilo', reference: 'saved-kilo', field_names: ['value'] }]);
  await setupProviders(squire, { addGrant }, { providers: ['kilo'], notify: vi.fn() });
  expect(addGrant).toHaveBeenCalledTimes(1);
  expect(addGrant).toHaveBeenCalledWith('kilo', expect.any(Object));
  expect(squire.runs.start).toHaveBeenCalledTimes(saved ? 0 : 1);
});

it('uses the Kilo profile and gateway grant metadata for explicit signup', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'complete', session_id: 'signup' });
  await squire.runs.start({ service: 'kilo', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({
    url: 'https://app.kilo.ai/profile', goal: expect.stringContaining('api_hosts ["api.kilo.ai", "ai-gateway.kilo.ai"]')
  }));
});

it.each([true, false])('registers only vetted Kilo models, falling back when Nemotron is absent (%s)', async nemotron => {
  const admin = new FreeLLMAdmin();
  const ids = [...(nemotron ? ['nvidia/nemotron-3-ultra-550b-a55b:free'] : []), 'kilo-auto/free', 'stealth/glyph-cluster'];
  const call = vi.spyOn(admin, 'call').mockImplementation(async path => path.includes('discover-models') ? { models: ids.map(id => ({ id })) } : []);
  await admin.addGrant('kilo', { base_url: 'https://egress.test/kilo', token: 'synthetic-grant' });
  expect(call).toHaveBeenCalledWith('/keys/custom', {
    baseUrl: 'https://egress.test/kilo/api/gateway', apiKey: 'synthetic-grant', label: 'Milo kilo (Squire)',
    models: ids.filter(id => id !== 'stealth/glyph-cluster').map(model => ({ model, supportsTools: true }))
  });
});

it('orders keyed Kilo sources and disables unvetted models', async () => {
  const admin = new FreeLLMAdmin();
  const call = vi.spyOn(admin, 'call');
  call.mockResolvedValue([
    { modelDbId: 1, platform: 'custom', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', keyLabel: 'Milo kilo (Squire)', priority: 0 },
    { modelDbId: 2, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'Milo kilo (Squire)', priority: 0 },
    { modelDbId: 4, platform: 'custom', modelId: 'stealth/glyph-cluster', keyLabel: 'Milo kilo (Squire)', priority: 0 }
  ]);
  await admin.configureChain();
  expect(call).toHaveBeenCalledWith('/fallback', [
    { modelDbId: 1, enabled: true, priority: 999996 }, { modelDbId: 2, enabled: true, priority: 999997 },
    { modelDbId: 4, enabled: false, priority: 999997 }
  ], 'PUT');
});


it('refreshes a Kilo grant missing Nemotron and reuses complete saved providers', async () => {
  const admin = new FreeLLMAdmin();
  let models = [{ modelId: 'kilo-auto/free' }];
  vi.spyOn(admin, 'call').mockImplementation(async path => path.includes('discover-models')
    ? { models: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, { id: 'kilo-auto/free' }] }
    : [{ id: 1, platform: 'custom', label: 'Milo kilo (Squire)', baseUrl: 'https://egress.test/kilo/api/gateway', models }]);
  expect(await admin.hasKey('kilo')).toBe(false);
  models = [...models, { modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free' }];
  expect(await admin.hasKey('kilo')).toBe(true);
  const squire = fakeSquire(), addGrant = vi.fn();
  await setupProviders(squire, { addGrant, hasKey: async () => true }, { providers: [], notify: vi.fn() });
  expect(addGrant).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('batches concurrent provider handoffs and resumes each correct browser session', async () => {
  const { confirm } = await import('@clack/prompts');
  vi.mocked(confirm).mockClear();
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'humanHandoff').mockImplementation(async session => `https://handoff.test/${session}`);
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_finish') return {};
    if (name !== 'operate_drive') throw new Error('unexpected');
    if (args.url) return { status: 'needs_value', session_id: new URL(String(args.url)).hostname, field: 'verification_code', remaining: 'Email verification needs a human' };
    return { status: 'complete', session_id: args.session_id };
  });
  await Promise.all(['kilo', 'opencode'].map(service => squire.signup(service, `https://${service}.test/login`, 'Sign in to the free plan')));
  expect(confirm).toHaveBeenCalledOnce();
  const resumed = call.mock.calls.filter(([name, args]) => name === 'operate_drive' && args.session_id).map(([, args]) => args.session_id);
  expect(resumed.sort()).toEqual(['kilo.test', 'opencode.test']);
  expect(call.mock.calls.filter(([name]) => name === 'operate_finish').map(([, args]) => args.session_id).sort()).toEqual(['kilo.test', 'opencode.test']);
});
