import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDataSharingConsent } from './data-sharing.js';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenCode, DEFAULT_OPENCODE_MODELS } from './opencode.js';
import type { ModelRequest } from './source.js';
import { idleEvents } from './fixtures/opencode-events.js';
import { configure } from './main.js';
import { bundledRegistry } from '../registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request = (text: string, first?: string): ModelRequest => ({ model: 'opencode', messages: [...(first ? [{ role: 'user', content: first }, { role: 'assistant', content: 'hello' }] : []), { role: 'user', content: text }], tools: [], cwd: '/tmp', stream: false });
const signal = () => AbortSignal.timeout(2000);
function backend(reply: (model: string) => Response = model => Response.json({ parts: [{ type: 'text', text: model }] })) {
  const calls: { session: string; model: string; text: string }[] = [];
  const histories = new Map<string, { info: { id: string; role: string }; parts: { id: string; type: string; text?: string }[] }[]>();
  let sessions = 0;
  let users = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/event') return idleEvents();
    if (path === '/session') return Response.json({ id: `ses_${++sessions}` });
    if (path.startsWith('/session/') && path.endsWith('/message') && init?.method !== 'POST') return Response.json(histories.get(path.split('/')[2]!) ?? []);
    if (path.endsWith('/message')) {
      const body = JSON.parse(String(init?.body));
      const session = path.split('/')[2]!, history = histories.get(session) ?? [];
      const id = body.messageID ?? `msg_${++users}`, partID = body.parts[0].id ?? `prt_${users}`;
      const user = { info: { id, role: 'user' }, parts: [{ ...body.parts[0], id: partID }] };
      const existing = history.findIndex(message => message.info.id === id);
      if (existing < 0) history.push(user); else history[existing] = user;
      histories.set(session, history);
      calls.push({ session, model: body.model.modelID, text: body.parts[0].text });
      const response = reply(body.model.modelID);
      if (response.ok) {
        const data = await response.json();
        history.push({ info: { id: `msg_assistant_${calls.length}`, role: 'assistant' }, parts: data.parts ?? [] });
        return Response.json({ ...data, info: { ...data.info, parentID: id } });
      }
      return response;
    }
    throw new Error('Unexpected OpenCode call');
  };
  return { calls, fetcher, histories };
}

it('distributes new conversations across exactly the vetted pool and keeps follow-ups on their session and model', async () => {
  const fake = backend(), driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    await driver.complete(request('one'), signal());
    await driver.complete(request('follow-up', 'one'), signal());
    for (const text of ['two', 'three', 'four']) await driver.complete(request(text), signal());
    expect(fake.calls.map(call => call.model)).toEqual([DEFAULT_OPENCODE_MODELS[0], DEFAULT_OPENCODE_MODELS[0], DEFAULT_OPENCODE_MODELS[1], DEFAULT_OPENCODE_MODELS[2], DEFAULT_OPENCODE_MODELS[0]]);
    expect(fake.calls[1]?.session).toBe(fake.calls[0]?.session);
    expect(new Set(fake.calls.slice(2).map(call => call.session)).size).toBe(3);
  } finally { await driver.close(); }
});

it('fails over an exhausted model, honors Retry-After, and preserves an existing conversation during model failover', async () => {
  let glmExhausted = false;
  const fake = backend(model => model === DEFAULT_OPENCODE_MODELS[0]
    ? new Response(null, { status: 429, headers: { 'Retry-After': '15' } })
    : model === DEFAULT_OPENCODE_MODELS[1] && glmExhausted
      ? Response.json({ info: { error: { data: { statusCode: 429 } } } })
      : Response.json({ parts: [{ type: 'text', text: model }] }));
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    expect((await driver.complete(request('first'), signal())).text).toBe(DEFAULT_OPENCODE_MODELS[1]);
    glmExhausted = true;
    expect((await driver.complete(request('continue', 'first'), signal())).text).toBe(DEFAULT_OPENCODE_MODELS[2]);
    expect(fake.calls.map(call => call.model)).toEqual([...DEFAULT_OPENCODE_MODELS.slice(0, 2), ...DEFAULT_OPENCODE_MODELS.slice(1)]);
    expect(fake.calls[2]?.session).toBe(fake.calls[1]?.session);
    expect(fake.calls[3]?.session).toBe(fake.calls[1]?.session);
    // Retried model requests update the existing user turn rather than adding
    // another copy to the agent's conversation history.
    expect([...fake.histories.values()].flat().filter(message => message.info.role === 'user')).toHaveLength(2);
    await driver.complete(request('new conversation'), signal());
    expect(fake.calls.at(-1)?.model).toBe(DEFAULT_OPENCODE_MODELS[2]);
  } finally { await driver.close(); }
});

it('does not replay a quota failure after the agent has run native tools', async () => {
  const fake = backend(() => Response.json({ info: { error: { data: { statusCode: 429 } } }, parts: [{ id: 'prt_tool', type: 'tool' }] }));
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    await expect(driver.complete(request('change a file'), signal())).rejects.toMatchObject({ code: 'quota' });
    expect(fake.calls).toHaveLength(1);
  } finally { await driver.close(); }
});

it('does not replay a quota failure when the persisted prompt cannot be inspected', async () => {
  const fake = backend(() => new Response(null, { status: 429 }));
  const fetcher: typeof fetch = (url, init) => String(url).endsWith('/message') && init?.method !== 'POST' ? Promise.resolve(new Response(null, { status: 503 })) : fake.fetcher(url, init);
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher });
  try {
    await expect(driver.complete(request('hello'), signal())).rejects.toMatchObject({ code: 'quota' });
    expect(fake.calls).toHaveLength(1);
  } finally { await driver.close(); }
});

it('stops after all free models exhaust, skips them during cooldown, and retries after the earliest quota resets', async () => {
  let now = Date.now(), exhausted = true;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fake = backend(model => exhausted ? new Response(null, { status: 429, headers: { 'Retry-After': model === DEFAULT_OPENCODE_MODELS[0] ? '5' : '20' } }) : Response.json({ parts: [{ type: 'text', text: 'recovered' }] }));
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    await expect(driver.complete(request('first'), signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 5 });
    expect(fake.calls).toHaveLength(3);
    await expect(driver.complete(request('second'), signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 5 });
    expect(fake.calls).toHaveLength(3);
    exhausted = false; now += 5001;
    await expect(driver.complete(request('third'), signal())).resolves.toMatchObject({ text: 'recovered' });
    expect(fake.calls.at(-1)?.model).toBe(DEFAULT_OPENCODE_MODELS[0]);
  } finally { await driver.close(); }
});

it.each([401, 403, 404, 500])('does not retry provider authentication, refusal, or server errors (%i) across the model pool', async status => {
  const fake = backend(() => new Response(null, { status })), driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    await expect(driver.complete(request('hello'), signal())).rejects.toMatchObject({ code: status === 401 ? 'logged_out' : status === 403 ? 'refused' : 'upstream' });
    expect(fake.calls).toHaveLength(1);
  } finally { await driver.close(); }
});

it.each([{ statusCode: 404 }, { code: 'model_not_found' }])('skips a provider-declared missing free model without duplicating its user turn (%j)', async data => {
  const fake = backend(model => model === DEFAULT_OPENCODE_MODELS[0]
    ? Response.json({ info: { error: { name: 'APIError', data } } })
    : Response.json({ parts: [{ type: 'text', text: model }] }));
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    await expect(driver.complete(request('hello'), signal())).resolves.toMatchObject({ text: DEFAULT_OPENCODE_MODELS[1] });
    expect(fake.calls.map(call => call.model)).toEqual(DEFAULT_OPENCODE_MODELS.slice(0, 2));
    expect([...fake.histories.values()].flat().filter(message => message.info.role === 'user')).toHaveLength(1);
  } finally { await driver.close(); }
});

it('distributes new work evenly across the healthy models while another model cools down', async () => {
  const fake = backend(model => model === DEFAULT_OPENCODE_MODELS[0] ? new Response(null, { status: 429 }) : Response.json({ parts: [{ type: 'text', text: model }] }));
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: fake.fetcher });
  try {
    const answers = [];
    for (const text of ['one', 'two', 'three', 'four']) answers.push((await driver.complete(request(text), signal())).text);
    expect(answers).toEqual([DEFAULT_OPENCODE_MODELS[1], DEFAULT_OPENCODE_MODELS[2], DEFAULT_OPENCODE_MODELS[1], DEFAULT_OPENCODE_MODELS[2]]);
  } finally { await driver.close(); }
});

it('retains scalar model overrides and applies model-pool changes to later requests', async () => {
  const scalar = backend(), explicit = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: scalar.fetcher, model: 'custom', models: DEFAULT_OPENCODE_MODELS });
  const pool = backend(); let models: readonly string[] = DEFAULT_OPENCODE_MODELS;
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: pool.fetcher, models: () => models });
  try {
    for (const text of ['one', 'two']) await explicit.complete(request(text), signal());
    expect(scalar.calls.map(call => call.model)).toEqual(['custom', 'custom']);
    await driver.complete(request('first'), signal());
    models = ['big-pickle'];
    await driver.complete(request('follow-up', 'first'), signal());
    expect(pool.calls.map(call => call.model)).toEqual([DEFAULT_OPENCODE_MODELS[0], 'big-pickle']);
    expect(pool.calls[0]?.session).toBe(pool.calls[1]?.session);
  } finally { await explicit.close(); await driver.close(); }
});

it('upgrades a cached Big Pickle default to the pool and retains an explicit daemon model override', async () => {
  const fake = backend(); vi.stubGlobal('fetch', fake.fetcher);
  const registry = structuredClone(bundledRegistry), adapter = registry.adapters.find(adapter => adapter.id === 'opencode')!;
  delete adapter.models; adapter.model = 'big-pickle';
  const directory = await mkdtemp(join(tmpdir(), 'grunt-opencode-consent-'));
  await recordDataSharingConsent(directory, ['opencode']);
  const env = { MILO_CONFIG_DIR: directory, MILO_SOURCES: 'opencode', MILO_OPENCODE_URL: 'http://127.0.0.1:4096' };
  const pool = configure(env, () => registry), explicit = configure({ ...env, MILO_OPENCODE_MODEL: 'big-pickle' }, () => registry);
  try {
    await pool.sources[0]!.complete(request('pool'), signal());
    await explicit.sources[0]!.complete(request('explicit'), signal());
    expect(fake.calls.map(call => call.model)).toEqual([DEFAULT_OPENCODE_MODELS[0], 'big-pickle']);
  } finally { await pool.close(); await explicit.close(); await rm(directory, { recursive: true, force: true }); }
});
