import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp, decode } from './api.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { FreeLLMAPI, freeConfig } from './freellmapi.js';
import { OpenCode } from './opencode.js';
import { BrowserSquire, ensureRouter, FreeLLMAdmin, setupProviders, SetupPending } from './setup.js';
import type { SetupSquire } from './setup.js';

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
      requestReveal: vi.fn(async ({ reference }) => ({ approval: { id: reference!, approveUrl: 'https://squire.test/approve' } })),
      claimReveal: vi.fn(async id => ({ value: `synthetic-${id}`, fields: {} }))
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
  await setupProviders(squire, { addKey: async (platform, key) => { imported.push({ platform, key }); } }, { notify: line => output.push(line) });
  expect(vi.mocked(squire.runs.start).mock.calls.map(([input]) => input.service)).toEqual(['groq']);
  expect(imported).toEqual(['groq'].map(platform => ({ platform, key: `synthetic-${platform}` })));
  expect(JSON.stringify(output)).not.toContain('synthetic-');
  expect(output.filter(o => o.includes('https://squire.test/approve'))).toHaveLength(1);
  expect(vi.mocked(squire.runs.start).mock.calls.every(([i]) => i.cost_cents === 0)).toBe(true);
});

it.each([
  { provider: 'groq' as const, service: ' Groq ', field: 'api_key', initiallyKnown: false },
  { provider: 'groq' as const, service: 'Groq', field: 'value', initiallyKnown: true },
  { provider: 'groq' as const, service: 'groq', field: 'apiKey', initiallyKnown: false },
  { provider: 'groq' as const, service: 'GROQ', field: 'GROQ_API_KEY', initiallyKnown: false }
])('reuses $service/$field without starting unnecessary provisioning', async ({ provider, service, field, initiallyKnown }) => {
  const squire = fakeSquire(), output: string[] = [], addKey = vi.fn();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'needs_approval', approval_url: 'https://squire.test/sms', run: { id: 'sms', state: 'awaiting_approval' } });
  if (!initiallyKnown) {
    expect(await setupProviders(squire, { addKey }, { providers: [provider], notify: line => output.push(line) })).toMatchObject({ pending: [] });
    expect(output.join('\n')).not.toContain('https://squire.test/sms');
    expect(addKey).not.toHaveBeenCalled();
  }
  vi.mocked(squire.credentials.list).mockResolvedValue([{ service, reference: 'existing', field_names: [field] }]);
  await setupProviders(squire, { addKey }, { providers: [provider], notify: () => {} });
  expect(squire.runs.start).toHaveBeenCalledTimes(initiallyKnown ? 0 : 1);
  expect(squire.credentials.requestReveal).toHaveBeenCalledWith({ reference: 'existing', field });
  expect(addKey).toHaveBeenCalledWith(provider, 'synthetic-existing');
});

it('uses the local Squire browser driver and approved vault capture', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'complete', session_id: 'signup' });
  await squire.runs.start({ service: 'groq', plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ url: 'https://console.groq.com/keys', goal: expect.stringContaining('operate_extract') }));
  call.mockResolvedValue({ status: 'approval_pending', approval_id: 'load', approval_url: 'https://squire.test/load' });
  await squire.credentials.requestReveal({ reference: 'vault://synthetic', field: 'api_key' });
  await expect(squire.credentials.claimReveal('load')).rejects.toBeInstanceOf(SetupPending);
  call.mockResolvedValue({ status: 'credential_fetch_refused', reason: 'denied' });
  await expect(squire.credentials.claimReveal('load')).rejects.toThrow('refused');
});

it.each(['default', 'custom', 'legacy'].flatMap(config =>
  ['approval_pending', 'credential_fetched', 'approval_expired', 'approval_denied', 'approval_unknown'].map(status => ({ config, status }))))(
  'recovers a pending vault approval after restart ($config, $status)', async ({ config, status }) => {
    const customDir = join(stateDir, 'persistent-milo');
    if (config === 'custom') vi.stubEnv('MILO_CONFIG_DIR', customDir);
    const first = new BrowserSquire();
    const start = vi.spyOn(first, 'call').mockResolvedValue({ status: 'approval_pending', approval_id: 'saved', approval_url: 'https://squire.test/saved' });
    await first.credentials.requestReveal({ reference: 'vault://existing', field: 'value' });
    expect(start).toHaveBeenCalledTimes(1);
    const path = join(config === 'custom' ? customDir : join(stateDir, 'milo'), 'approvals.json');
    const saved = await readFile(path, 'utf8');
    expect(saved).toContain('vault://existing');
    expect(saved).toContain('createdAt');
    expect(Object.keys(JSON.parse(saved)[0]).sort()).toEqual(['approveUrl', 'createdAt', 'expiresAt', 'field', 'id', 'reference']);
    if (config === 'legacy') vi.stubEnv('MILO_CONFIG_DIR', customDir);
    const second = new BrowserSquire();
    const call = vi.spyOn(second, 'call').mockImplementation(async (_name, args) => args.action === 'start'
      ? { status: 'approval_pending', approval_id: 'fresh', approval_url: 'https://squire.test/fresh' }
      : { status: status.startsWith('approval_') && status !== 'approval_pending' ? 'credential_fetch_refused' : status, reason: status, fields: { value: 'SyntheticRecovered!42' } });
    const { approval } = await second.credentials.requestReveal({ reference: 'vault://existing', field: 'value' });
    expect(call.mock.calls[0]?.[1]).toEqual({ action: 'resume', approval_id: 'saved' });
    const refresh = !['approval_pending', 'credential_fetched'].includes(status);
    expect(approval.id).toBe(refresh ? 'fresh' : 'saved');
    expect(call).toHaveBeenCalledTimes(refresh ? 2 : 1);
    if (!refresh) expect(call).not.toHaveBeenCalledWith('fetch_credential', expect.objectContaining({ action: 'start' }));
    if (status === 'credential_fetched') {
      expect(await second.credentials.claimReveal(approval.id)).toMatchObject({ value: 'SyntheticRecovered!42' });
      expect(call).toHaveBeenCalledTimes(1);
      const destination = config === 'default' ? path : join(customDir, 'approvals.json');
      expect(await readFile(destination, 'utf8')).not.toContain('saved');
      const third = new BrowserSquire();
      const fresh = vi.spyOn(third, 'call').mockResolvedValue({ approval_id: 'next', approval_url: 'https://squire.test/next' });
      await third.credentials.requestReveal({ reference: 'vault://existing', field: 'value' });
      expect(fresh.mock.calls[0]?.[1]).toMatchObject({ action: 'start' });
    }
    expect(await readFile(path, 'utf8')).not.toContain('SyntheticRecovered!42');
  }
);

it.each(['the saved timestamp is expired', 'Squire reports credential_fetch_approval_not_pending'])(
  'starts a fresh vault approval when %s', async reason => {
    const first = new BrowserSquire();
    vi.spyOn(first, 'call').mockResolvedValue({ approval_id: 'old', approval_url: 'https://squire.test/old' });
    await first.credentials.requestReveal({ reference: 'vault://existing' });
    const path = join(stateDir, 'milo', 'approvals.json');
    const entries = JSON.parse(await readFile(path, 'utf8'));
    if (reason === 'the saved timestamp is expired') {
      for (const entry of entries) { entry.createdAt = 0; entry.expiresAt = 0; }
    } else {
      expect(entries[0].expiresAt).toBeGreaterThan(Date.now());
    }
    await writeFile(path, JSON.stringify(entries));
    const second = new BrowserSquire();
    const call = vi.spyOn(second, 'call').mockImplementation(async (_name, args) => args.action === 'start'
      ? { approval_id: 'new', approval_url: 'https://squire.test/new' }
      : { status: 'credential_fetch_refused', reason: 'credential_fetch_approval_not_pending' });
    expect((await second.credentials.requestReveal({ reference: 'vault://existing' })).approval.id).toBe('new');
    expect(call).toHaveBeenCalledTimes(reason === 'the saved timestamp is expired' ? 1 : 2);
    if (reason !== 'the saved timestamp is expired') expect(call.mock.calls[0]?.[1]).toEqual({ action: 'resume', approval_id: 'old' });
    expect(call).toHaveBeenLastCalledWith('fetch_credential', expect.objectContaining({ action: 'start', reference: 'vault://existing' }));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
      expect.objectContaining({ id: 'new', approveUrl: 'https://squire.test/new', reference: 'vault://existing' })
    ]);
  }
);

it('keeps the saved approval during transient Squire errors instead of requesting a new one', async () => {
  const first = new BrowserSquire();
  vi.spyOn(first, 'call').mockResolvedValue({ approval_id: 'saved', approval_url: 'https://squire.test/saved' });
  await first.credentials.requestReveal({ reference: 'vault://existing' });
  const second = new BrowserSquire();
  const call = vi.spyOn(second, 'call').mockRejectedValue(new Error('Squire unavailable'));
  await expect(second.credentials.requestReveal({ reference: 'vault://existing' })).rejects.toThrow('Squire unavailable');
  expect(call).toHaveBeenCalledTimes(1);
  expect(await readFile(join(stateDir, 'milo', 'approvals.json'), 'utf8')).toContain('saved');
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
  const addKey = vi.fn(), notify = vi.fn();
  let message = '';
  try { await setupProviders(squire, { addKey }, { notify }); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('Provider refused groq signup; setup stopped' + (detail ? ': Provider denied automated account creation.' : ''));
  for (const secret of ['synthetic-private-value', 'short-secret', 'https://example.test', 'gsk_syntheticprivatevalue', 'SyntheticPass!42', 'SyntheticToken!42', 'Synthetic Secret!42', 'SyntheticKey!42', 'SyntheticCode!42', 'SyntheticCredential!42']) expect(message).not.toContain(secret);
  expect(call).toHaveBeenCalledTimes(1);
  expect(addKey).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it('preserves refusal details from rejected setup runs', async () => {
  const squire = fakeSquire();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'reject', reason: 'Free API access is unavailable in this region.', run: { id: 'groq', state: 'rejected' } });
  await expect(setupProviders(squire, { addKey: vi.fn() }, { notify: vi.fn() })).rejects.toThrow('Free API access is unavailable in this region.');
});

it.each([
  ...['SMS verification required', 'Phone verification required', 'Complete a captcha', 'Review the privacy policy and enter the SMS code.'].map(remaining => ({ status: 'needs_value', remaining })),
  { status: 'budget', remaining: 'SMS verification required' },
  { status: 'evaluate_timeout', remaining: 'Human assistance required' }
])(
  'drops a signup requiring human input and continues ($status, $remaining)', async ({ status, remaining }) => {
    const squire = new BrowserSquire();
    const call = vi.spyOn(squire, 'call').mockResolvedValue({ status, field: 'sms', session_id: 'signup', remaining, approval_url: 'https://squire.test/skip-me' });
    vi.spyOn(squire.credentials, 'list').mockResolvedValueOnce([]).mockResolvedValue([{ service: 'next', reference: 'next', field_names: ['value'] }]);
    vi.spyOn(squire.credentials, 'requestReveal').mockResolvedValue({ approval: { id: 'next', approveUrl: 'https://squire.test/vault' } });
    vi.spyOn(squire.credentials, 'claimReveal').mockResolvedValue({ value: 'synthetic-next', fields: {} });
    const notify = vi.fn(), addKey = vi.fn();
    const result = await setupProviders(squire, { addKey }, { providers: ['groq', 'next'], notify });
    expect(result).toMatchObject({ pending: [], dropped: ['groq'] });
    expect(addKey).toHaveBeenCalledWith('next', 'synthetic-next');
    const output = notify.mock.calls.flat().join(' ');
    expect(output).toContain(remaining);
    expect(output).not.toContain('skip-me');
    expect(call).not.toHaveBeenCalledWith('operate_share', expect.anything());
    expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  }
);

it('recovers an interrupted router installation using the existing vault secrets', async () => {
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
