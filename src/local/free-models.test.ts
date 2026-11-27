import { idleEvents } from './fixtures/opencode-events.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp, decode } from './api.js';
import { Sources } from './source.js';
import { OpenCode } from './opencode.js';
import { BrowserSquire, setupProviders } from './setup.js';
import type * as Prompts from '@clack/prompts';
import type { SetupSquire } from './setup.js';

vi.mock('@clack/prompts', async importOriginal => ({ ...await importOriginal<typeof Prompts>(), confirm: vi.fn(async () => true) }));

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'grunt-approval-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', stateDir);
  vi.stubEnv('GRUNT_CONFIG_DIR', '');
  vi.stubEnv('GRUNT_SQUIRE_XDG_CONFIG_HOME', '');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(stateDir, { recursive: true, force: true }); });
const request = { model: 'opencode', cwd: '/tmp', stream: false, tools: [], messages: [{ role: 'user', content: 'hello' }] };

it('types the exact latest OpenCode fixture message and reuses the session for follow-ups', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/opencode.json', import.meta.url), 'utf8'));
  const calls: { path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/event') return idleEvents();
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(path === '/session' ? { id: 'session_one' } : { info: { role: 'assistant', finish: 'length' }, parts: [{ type: 'text', text: 'bridge works 42' }] });
  };
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher, model: 'big-pickle' });
  const app = createLocalApp(new Sources([driver]));
  fixture.cwd = '/tmp'; fixture.model = 'opencode'; fixture.stream = false; fixture.tools = [];
  expect((await (await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture) })).json()).choices[0]).toMatchObject({ finish_reason: 'length', message: { content: 'bridge works 42' } });
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

it('provisions a free provider through the user Squire grant', async () => {
  const squire = fakeSquire(), imported: unknown[] = [], output: string[] = [];
  await setupProviders(squire, { addGrant: async (platform, grant) => { imported.push({ platform, grant }); } }, { providers: ['groq'], notify: line => output.push(line) });
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

it.each([
  { reason: 'Provider denied automated account creation.', remaining: '' },
  { reason: 'Provider denied automated account creation.', remaining: 'API key: synthetic-private-value; password=short-secret; token https://example.test/?token=private; gsk_syntheticprivatevalue1234567890' },
  { reason: 'Provider denied automated account creation. password is SyntheticPass!42.', remaining: '' },
  { reason: 'Provider denied automated account creation. your token was "SyntheticToken!42".', remaining: '' },
  { reason: "Provider denied automated account creation. secret = 'Synthetic Secret!42'", remaining: '' },
  { reason: 'Provider denied automated account creation. api key: "SyntheticKey!42"', remaining: '' },
  { reason: 'Provider denied automated account creation. passcode is SyntheticCode!42', remaining: '' },
  { reason: 'Provider denied automated account creation. credential SyntheticCredential!42', remaining: '' },
  { reason: 'Provider denied automated account creation. key might be SyntheticKey!42', remaining: '' }
])('reports only safe refusal details and drops only the refusing provider ($reason)', async ({ reason, remaining }) => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({
    status: 'stuck', session_id: 'signup', reason, remaining
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  const addGrant = vi.fn(), notify = vi.fn();
  const result = await setupProviders(squire, { addGrant }, { providers: ['groq', 'nvidia'], notify });
  // Each provider's refusal drops that provider; setup goes on to the next one.
  expect(result.dropped).toEqual(['groq', 'nvidia']);
  const message = [squire.signupFailureDetail('groq') ?? '', ...notify.mock.calls.map(([line]) => String(line))].join('\n');
  expect(message).toContain('Provider denied automated account creation.');
  for (const secret of ['synthetic-private-value', 'short-secret', 'https://example.test', 'gsk_syntheticprivatevalue', 'SyntheticPass!42', 'SyntheticToken!42', 'Synthetic Secret!42', 'SyntheticKey!42', 'SyntheticCode!42', 'SyntheticCredential!42']) expect(message).not.toContain(secret);
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(2);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'signup', outcome: 'none' });
  expect(addGrant).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('groq: dropped; Squire cannot complete signup automatically: provider refused; the page says: Provider denied automated account creation.'));
});

it('preserves refusal details from rejected setup runs', async () => {
  const squire = fakeSquire();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'reject', reason: 'Free API access is unavailable in this region.', run: { id: 'groq', state: 'rejected' } });
  await expect(setupProviders(squire, { addGrant: vi.fn() }, { providers: ['groq'], notify: vi.fn() })).rejects.toThrow('Free API access is unavailable in this region.');
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
