import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp, decode } from './api.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { FreeLLMAPI, freeConfig } from './freellmapi.js';
import { OpenCode } from './opencode.js';
import { BrowserSquire, setupProviders, SetupPending } from './setup.js';
import type { SetupSquire } from './setup.js';

afterEach(() => vi.restoreAllMocks());
const request = { model: 'freellmapi', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };

it('routes the daemon free API through loopback FreeLLMAPI, preserves tools and caps tokens', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'routed reply' } }] }));
  const app = createLocalApp(new Sources([new FreeLLMAPI({ key: 'synthetic', fetcher })]));
  const response = await app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...request, max_tokens: 100000, tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] }) });
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
    { baseUrl: 'https://ai-gateway.kilo.ai/api/v1', label: 'Kilo Free', models: [{ model: 'kilo-auto/free', supportsTools: true }] },
    { baseUrl: 'http://127.0.0.1:8789/v1', label: 'Freebuff', models: [{ model: 'freebuff', supportsTools: false }] }
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
  expect((await (await app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify(fixture) })).json()).choices[0].message.content).toBe('bridge works 42');
  fixture.messages.push({ role: 'assistant', content: 'bridge works 42' }, { role: 'user', content: '  Repeat it.\n' });
  await app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify(fixture) });
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
  expect(vi.mocked(squire.runs.start).mock.calls.map(([input]) => input.service)).toEqual(['groq', 'mistral', 'nvidia']);
  expect(imported).toEqual(['groq', 'mistral', 'nvidia'].map(platform => ({ platform, key: `synthetic-${platform}` })));
  expect(JSON.stringify(output)).not.toContain('synthetic-');
  expect(output.filter(o => o.includes('https://squire.test/approve'))).toHaveLength(3);
  expect(vi.mocked(squire.runs.start).mock.calls.every(([i]) => i.cost_cents === 0)).toBe(true);
});

it('returns human signup approvals promptly and resumes existing vault keys without duplicate signup', async () => {
  const squire = fakeSquire(), output: string[] = [], addKey = vi.fn();
  vi.mocked(squire.runs.start).mockResolvedValue({ decision: 'needs_approval', approval_url: 'https://squire.test/sms', run: { id: 'sms', state: 'awaiting_approval' } });
  expect(await setupProviders(squire, { addKey }, { providers: ['mistral'], notify: line => output.push(line) })).toMatchObject({ pending: ['mistral'] });
  expect(output.join('\n')).toContain('https://squire.test/sms');
  expect(addKey).not.toHaveBeenCalled();
  vi.mocked(squire.credentials.list).mockResolvedValue([{ service: 'mistral', reference: 'existing', field_names: ['api_key'] }]);
  await setupProviders(squire, { addKey }, { providers: ['mistral'], notify: () => {} });
  expect(squire.runs.start).toHaveBeenCalledTimes(1);
  expect(addKey).toHaveBeenCalledWith('mistral', 'synthetic-existing');
});

it('uses the local Squire browser driver, vault capture and its human approval links', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'pending_approval', session_id: 'signup', approval_url: 'https://squire.test/passkey' });
  const result = await squire.runs.start({ service: 'mistral', plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none' });
  expect(result).toMatchObject({ decision: 'needs_approval', approval_url: 'https://squire.test/passkey' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ url: 'https://console.mistral.ai/api-keys', goal: expect.stringContaining('operate_extract') }));
  call.mockResolvedValue({ status: 'approval_pending', approval_id: 'load', approval_url: 'https://squire.test/load' });
  await squire.credentials.requestReveal({ reference: 'vault://synthetic', field: 'api_key' });
  await expect(squire.credentials.claimReveal('load')).rejects.toBeInstanceOf(SetupPending);
  call.mockResolvedValue({ status: 'credential_fetch_refused', reason: 'denied' });
  await expect(squire.credentials.claimReveal('load')).rejects.toThrow('refused');
});

it('hands SMS and captcha walls back as approval links and resumes the same browser session', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'needs_value', field: 'sms', session_id: 'signup' });
  const handoff = vi.spyOn(squire, 'humanHandoff').mockResolvedValue('http://127.0.0.1:9876/approval');
  expect(await squire.runs.start({ service: 'mistral', plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none' })).toMatchObject({ approval_url: 'http://127.0.0.1:9876/approval' });
  expect(handoff).toHaveBeenCalledWith('signup');
  call.mockResolvedValue({ status: 'complete', session_id: 'signup' });
  await squire.runs.get('mistral');
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'signup' }));
});
