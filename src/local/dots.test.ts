import { createClient } from '@libsql/client';
import { serve } from '@hono/node-server';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DotsStore } from '../dots-store.js';
import { dotsRelay } from '../dots-relay.js';
import { callbackURL, publicAddress, webhookPost } from '../dots-events.js';
import type { Sender } from '../dots-events.js';
import { dotsLink, readDotsLink, pairDots, dotsGateway } from './dots-link.js';
import { Dots, DOTS_INSTRUCTION } from './dots.js';
import { configure } from './main.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const json = (body: unknown, token?: string) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
const request = { model: 'milo', messages: [{ role: 'user', content: 'Hello exactly!' }], tools: [], cwd: '/tmp', stream: false };
async function fixture() {
  const db = createClient({ url: 'file::memory:' });
  cleanup.push(async () => db.close());
  const store = new DotsStore(db); await store.init();
  const config = await mkdtemp(join(tmpdir(), 'milo-mcp-')); cleanup.push(() => rm(config, { recursive: true, force: true }));
  let receiver: Sender = async (_url, raw) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(raw).challenge }) });
  const server = serve({ fetch: req => relay.app.fetch(req), hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', () => resolve()));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const relay = dotsRelay(store, { origin, sender: (...args) => receiver(...args), poll: 5 });
  const env = { MILO_CONFIG_DIR: config, MILO_DOTS_URL: origin, MILO_SOURCES: 'dots' };
  const client = await (await relay.app.request('/oauth/register', json({ redirect_uris: ['https://chatgpt.com/connector/callback'], client_name: 'ChatGPT dot', token_endpoint_auth_method: 'none' }))).json();
  const verifier = randomBytes(32).toString('base64url');
  const query = { response_type: 'code', client_id: client.client_id, redirect_uri: 'https://chatgpt.com/connector/callback', state: 'state123', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: origin + '/join', scope: 'milo:dots' };
  async function allow(decision = 'allow') {
    const consent = await relay.app.request('/oauth/authorize?' + new URLSearchParams(query));
    const html = await consent.text();
    const cookie = consent.headers.get('set-cookie')!.split(';')[0]!;
    const fields = { flow: html.match(/name="flow" value="([^"]+)"/)![1]!, csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!, decision };
    const response = await relay.app.request('/oauth/authorize', form(fields, { Cookie: cookie }));
    return { response, fields, cookie, html };
  }
  async function authorize(pairEnv = env, fallback = false) {
    const allowed = await allow(fallback ? 'fallback' : 'allow');
    let complete: string;
    if (fallback) {
      const html = await allowed.response.text();
      const code = html.match(/usegrunt dots link ([A-Z0-9_-]{16})/)![1]!;
      complete = await dotsLink(code, pairEnv, fetch, () => {});
    } else {
      const app = createLocalApp(new Sources([{ id: 'fixture', available: async () => false, complete: async () => ({ text: '' }) }]), { dotsEnv: pairEnv });
      const response = await app.request(allowed.response.headers.get('location')!, { headers: { Referer: origin + '/', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
      expect(response.status).toBe(303); complete = response.headers.get('location')!;
    }
    return { ...allowed, response: await relay.app.request(complete, { headers: { Cookie: allowed.cookie } }) };
  }
  const granted = await authorize();
  expect(granted.response.status).toBe(303);
  expect(granted.html).not.toContain('name="code"');
  const callback = new URL(granted.response.headers.get('location')!);
  expect(callback.searchParams.get('state')).toBe('state123');
  const tokenBody = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: query.redirect_uri, code: callback.searchParams.get('code')!, code_verifier: verifier, resource: query.resource };
  const bad = await relay.app.request('/oauth/token', form({ ...tokenBody, code_verifier: 'x'.repeat(43) })); expect(bad.status).toBe(400);
  const tokens = await (await relay.app.request('/oauth/token', form(tokenBody))).json();
  expect(typeof tokens.access_token).toBe('string');
  const rpc = async (method: string, params: unknown = {}, token = tokens.access_token, path = '/join') => (await (await relay.app.request(path, json({ jsonrpc: '2.0', id: 1, method, params }, token))).json());
  const tool = async (name: string, args: unknown = {}, token?: string) => { const response = await rpc('tools/call', { name, arguments: args }, token); return { ...response.result, value: response.result?.content?.[0]?.text ? JSON.parse(response.result.content[0].text.startsWith('{') ? response.result.content[0].text : '{}') : undefined }; };
  const signingKey = 'whsec_' + randomBytes(32).toString('base64');
  const subscription = { name: 'milo.request', arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example/events', secret: signingKey } };
  const link = (await readDotsLink(env))!;
  return { db, store, relay, env, device: { Authorization: `Bearer ${link.deviceSecret}` }, link, client, tokens, tokenBody, authorize, allow, rpc, tool, subscription, signingKey, set receiver(fn: Sender) { receiver = fn; } };
}
it('stays off by default and makes no gateway call without explicit opt-in or setup', async () => {
  const fetcher = vi.fn();
  const source = new Dots({ env: { MILO_DOTS_URL: 'https://api.grunt.run' }, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'not_installed' });
  const sources = configure({}); expect(sources.sources.map(s => s.id)).toEqual(['freebuff', 'opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'apinex', 'mistral-vibe', 'livekit']);
  const app = createLocalApp(new Sources([source]));
  expect((await (await app.request('http://127.0.0.1:8788/v1/models')).json()).data.map((m: { id: string }) => m.id)).toEqual(['milo']);
  expect(fetcher).not.toHaveBeenCalled();
  await sources.close();
});
it('supports metadata, PKCE, single-use pairing and codes, refresh rotation and explicit consent', async () => {
  const f = await fixture();
  expect(await (await f.relay.app.request('/.well-known/oauth-protected-resource')).json()).toMatchObject({ resource: f.env.MILO_DOTS_URL + '/join' });
  expect(await (await f.relay.app.request('/.well-known/oauth-authorization-server')).json()).toMatchObject({ code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] });
  expect((await f.relay.app.request('/mcp')).headers.get('content-type')).toContain('text/html');
  expect((await f.relay.app.request('/mcp', json({}))).status).toBe(401);
  expect((await f.relay.app.request('/oauth/token', form(f.tokenBody))).status).toBe(400);
  const repeated = await f.allow();
  const csrf = await f.relay.app.request('/oauth/authorize', form(repeated.fields)); expect(csrf.status).toBe(400);
  const refresh = { grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: f.tokens.refresh_token };
  expect((await f.relay.app.request('/oauth/token', form(refresh))).status).toBe(200);
  expect((await f.relay.app.request('/oauth/token', form(refresh))).status).toBe(400);
  const disk = await stat(join(f.env.MILO_CONFIG_DIR, 'dots.json')); expect(disk.mode & 0o777).toBe(0o600);
  const rows = await f.store.rows<{ device_hash: string }>('SELECT device_hash FROM dots_pairs'); expect(rows[0]!.device_hash).not.toBe(f.link.deviceSecret);
});
it('verifies signed callbacks, persists idempotent subscriptions, rotates keys and unsubscribes', async () => {
  const f = await fixture(); let verifications = 0;
  f.receiver = async (_url, raw, headers) => {
    new Webhook(f.signingKey).verify(raw, headers); verifications++;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(raw).challenge }) };
  };
  const first = await f.rpc('events/subscribe', f.subscription); expect(first.result.id).toMatch(/^sub_/);
  const again = await f.rpc('events/subscribe', f.subscription); expect(again.result.id).toBe(first.result.id); expect(verifications).toBe(1);
  expect(await new DotsStore(f.db).subscriptions((await f.store.device(f.link.deviceSecret))!.id)).toHaveLength(1);
  const replacement = 'whsec_' + randomBytes(32).toString('base64');
  f.receiver = async (_url, raw, headers) => { new Webhook(replacement).verify(raw, headers); return { status: 200, body: JSON.stringify({ challenge: JSON.parse(raw).challenge }) }; };
  const rotated = await f.rpc('events/subscribe', { ...f.subscription, delivery: { ...f.subscription.delivery, secret: replacement } }); expect(rotated.result.id).toBe(first.result.id);
  expect((await f.store.rows<{ previous: string }>('SELECT previous FROM dots_subscriptions'))[0]!.previous).toBe(f.signingKey);
  await f.rpc('events/unsubscribe', f.subscription); await f.rpc('events/unsubscribe', f.subscription);
  expect((await (await f.relay.app.request('/dots/status', { headers: f.device })).json()).subscribed).toBe(false);
});
it('rejects unsafe callbacks and failed verification without activating a subscription', async () => {
  const f = await fixture();
  for (const url of ['http://receiver.example/events', 'https://localhost/events', 'https://127.0.0.1/events', 'https://[::1]/events', 'https://169.254.169.254/latest', 'https://10.0.0.1/events']) {
    expect(() => callbackURL(url)).toThrow();
    expect((await f.rpc('events/subscribe', { ...f.subscription, delivery: { ...f.subscription.delivery, url } })).error).toBeDefined();
  }
  for (const ip of ['0.0.0.0', '192.168.1.1', '100.64.0.1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) expect(publicAddress(ip)).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);
  await expect(webhookPost('https://127.0.0.1/', '{}', {})).rejects.toThrow();
  f.receiver = async () => ({ status: 200, body: '{"challenge":"wrong"}' });
  expect((await f.rpc('events/subscribe', f.subscription)).error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
  expect(await f.store.rows('SELECT * FROM dots_subscriptions')).toHaveLength(0);
});
it('carries a local API request through a signed event and scoped MCP tools back to the caller with full follow-up history', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetched: { requestId: string; messages: { role: string; content: string }[] }[] = [];
  f.receiver = async (_url, raw, headers) => {
    const event = new Webhook(f.signingKey).verify(raw, headers) as { type?: string; challenge?: string; name?: string; data?: { requestId: string } };
    if (event.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
    expect(event.name).toBe('milo.request'); expect(raw).not.toContain(request.messages[0]!.content);
    const item = (await f.tool('milo_get_request', { requestId: event.data!.requestId })).value; fetched.push(item);
    expect(await f.tool('milo_submit_reply', { requestId: item.requestId, text: 'These chats do not count toward your weekly usage limit.' })).toMatchObject({ value: { accepted: true } });
    return { status: 200, body: '{}' };
  };
  const initialized = (await f.rpc('initialize', { protocolVersion: '2025-03-26' })).result;
  expect(initialized.capabilities).toHaveProperty('events');
  for (const term of ['Immediately subscribe', 'milo.request', 'milo_get_request', 'milo_submit_reply', 'milo_fail_request', 'without starting Codex or Work tasks']) expect(initialized.instructions).toContain(term);
  expect((await f.rpc('events/list')).result.events[0].name).toBe('milo.request');
  await f.rpc('events/subscribe', f.subscription);
  const source = new Dots({ env: f.env, timeout: 2000 });
  expect(await source.available()).toBe(true);
  const app = createLocalApp(new Sources([source]));
  const call = async (body: unknown) => (await (await app.request('http://127.0.0.1:8788/v1/chat/completions', json(body))).json()).choices[0].message.content;
  const answer = await call({ ...request, model: 'dots' }); expect(answer).toContain('do not count toward your weekly usage limit');
  const messages = [...request.messages, { role: 'assistant', content: answer }, { role: 'user', content: 'Follow up' }];
  expect(await call({ ...request, messages })).toBe(answer);
  expect(fetched[1]!.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
  expect(fetched[1]!.messages[2]!.content).toBe('Follow up\n\n' + DOTS_INSTRUCTION);
  expect(await f.store.rows('SELECT * FROM dots_requests')).toHaveLength(0);
  expect(JSON.stringify(log.mock.calls)).not.toContain(answer); expect(JSON.stringify(log.mock.calls)).not.toContain(f.link.deviceSecret);
  await source.close();
});
it('isolates both daemon and MCP credentials between pairings and deletes prompt text as soon as a reply arrives', async () => {
  const f = await fixture(); await f.rpc('events/subscribe', f.subscription);
  const pair = (await f.store.device(f.link.deviceSecret))!;
  const id = (await f.store.enqueue(pair.id, request.messages, 10000))!;
  const otherConfig = await mkdtemp(join(tmpdir(), 'milo-other-')); cleanup.push(() => rm(otherConfig, { recursive: true, force: true }));
  const otherEnv = { ...f.env, MILO_CONFIG_DIR: otherConfig };
  const wrong = await f.authorize(otherEnv); expect(wrong.response.status).toBe(303);
  const otherDevice = (await readDotsLink(otherEnv))!.deviceSecret;
  const code = new URL(wrong.response.headers.get('location')!).searchParams.get('code')!;
  const token = await (await f.relay.app.request('/oauth/token', form({ ...f.tokenBody, code }))).json();
  expect((await f.relay.app.request('/dots/requests/' + id, { headers: { Authorization: `Bearer ${otherDevice}` } })).status).toBe(410);
  await f.relay.app.request('/dots/requests/' + id, { method: 'DELETE', headers: { Authorization: `Bearer ${otherDevice}` } });
  expect(await f.store.pending(pair.id, id)).toBeDefined();
  expect((await f.tool('milo_get_request', { requestId: id }, token.access_token)).value).toEqual({ request: null });
  expect((await f.tool('milo_submit_reply', { requestId: id, text: 'stolen' }, token.access_token)).isError).toBe(true);
  expect((await f.relay.app.request('/dots/requests/' + id, { headers: { Authorization: `Bearer ${token.access_token}` } })).status).toBe(401);
  await f.tool('milo_submit_reply', { requestId: id, text: 'First answer' });
  expect((await f.store.pending(pair.id, id))!.messages).toBeNull();
  await f.tool('milo_submit_reply', { requestId: id, text: 'Second answer' });
  expect((await f.store.pending(pair.id, id))!.reply).toBe('First answer');
});
it.each(['timeout', 'quota', 'no_subscription', 'logged_out'])('falls back on %s while explicit dots stays exclusive', async mode => {
  const f = await fixture();
  const fallback = { id: 'fallback', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  if (mode !== 'no_subscription') await f.rpc('events/subscribe', f.subscription);
  if (mode === 'logged_out') await f.db.execute('DELETE FROM dots_pairs');
  if (mode === 'quota') f.receiver = async (_url, raw) => { const event = JSON.parse(raw); await f.tool('milo_fail_request', { requestId: event.data.requestId, reason: 'quota' }); return { status: 200, body: '{}' }; };
  const driver = new Dots({ env: f.env, timeout: 120 });
  const sources = new Sources([driver, fallback]);
  expect(await sources.complete(request, new AbortController().signal)).toEqual({ text: 'fallback' });
  await expect(sources.complete({ ...request, model: 'dots' }, new AbortController().signal)).rejects.toMatchObject({ code: mode === 'no_subscription' ? 'not_installed' : mode });
  expect(fallback.complete).toHaveBeenCalledTimes(1);
  expect(await f.store.rows('SELECT * FROM dots_requests')).toHaveLength(0);
  await driver.close();
});
it('preserves event IDs on retry, stops on 410/413, expires prompt text, and revokes subscriptions', async () => {
  const f = await fixture(); await f.rpc('events/subscribe', f.subscription);
  const pair = (await f.store.device(f.link.deviceSecret))!.id;
  const seen: string[] = []; let status = 503;
  f.receiver = async (_url, raw, headers) => { new Webhook(f.signingKey).verify(raw, headers); seen.push(headers['webhook-id']!); return { status, body: '{}' }; };
  const id = (await f.store.enqueue(pair, request.messages, 10000))!;
  await f.relay.events.flush(); await f.db.execute('UPDATE dots_deliveries SET next_at=0'); status = 413; await f.relay.events.flush(); await f.relay.events.flush();
  expect(seen).toHaveLength(2); expect(seen[1]).toBe(seen[0]);
  expect(await f.store.rows('SELECT * FROM dots_deliveries')).toHaveLength(0);
  await f.db.execute({ sql: 'UPDATE dots_requests SET expires=0 WHERE id=?', args: [id] }); await f.store.clean(); expect(await f.store.rows('SELECT * FROM dots_requests')).toHaveLength(0);
  await f.store.enqueue(pair, request.messages, 10000); status = 410; await f.relay.events.flush(); expect(await f.store.subscriptions(pair)).toHaveLength(0);
  await f.rpc('events/subscribe', f.subscription);
  await f.relay.app.request('/oauth/revoke', form({ client_id: f.client.client_id, token: f.tokens.access_token }));
  expect(await f.store.subscriptions(pair)).toHaveLength(0);
  expect((await f.relay.app.request('/mcp', json({}, f.tokens.access_token))).status).toBe(401);
});

it('works with the standard MCP Streamable HTTP client', async () => {
  const f = await fixture();
  const client = new Client({ name: 'fixture-dot', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.env.MILO_DOTS_URL + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.tokens.access_token}` } } });
  try { await client.connect(transport); expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['milo_get_request', 'milo_submit_reply', 'milo_fail_request']); }
  finally { await client.close(); }
});

it('caller cancellation stops the chain and removes the queued request', async () => {
  const f = await fixture(); await f.rpc('events/subscribe', f.subscription);
  const driver = new Dots({ env: f.env, timeout: 3000 });
  const fallback = { id: 'fallback', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  await expect(new Sources([driver, fallback]).complete(request, AbortSignal.timeout(100))).rejects.toThrow();
  expect(fallback.complete).not.toHaveBeenCalled();
  expect(await f.store.rows('SELECT * FROM dots_requests')).toHaveLength(0);
  await driver.close();
});
it('retains subscriptions across a SQLite reopen', async () => {
  const f = await fixture(); await f.rpc('events/subscribe', f.subscription);
  const directory = await mkdtemp(join(tmpdir(), 'milo-subscription-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const url = 'file:' + join(directory, 'relay.db');
  const db = createClient({ url }); const store = new DotsStore(db); await store.init();
  const sub = (await f.store.rows<{ id: string; pair: string; url: string; secret: string; expires: number; verified_until: number }>('SELECT * FROM dots_subscriptions'))[0]!;
  await db.execute({ sql: 'INSERT INTO dots_subscriptions(id,pair,url,secret,expires,verified_until) VALUES(?,?,?,?,?,?)', args: [sub.id, sub.pair, sub.url, sub.secret, sub.expires, sub.verified_until] });
  db.close();
  const reopened = createClient({ url });
  try { const persisted = new DotsStore(reopened); await persisted.init(); expect((await persisted.subscriptions(sub.pair))[0]!.id).toBe(sub.id); }
  finally { reopened.close(); }
});
it('pairs after Allow without typing, refuses reused/expired/unconfirmed tickets, and keeps the device secret', async () => {
  const f = await fixture();
  const local = createLocalApp(new Sources([{ id: 'fixture', available: async () => false, complete: async () => ({ text: '' }) }]), { dotsEnv: f.env });
  const headers = { Referer: f.env.MILO_DOTS_URL + '/', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const allowed = await f.allow(); const target = allowed.response.headers.get('location')!;
  expect(target).toContain('http://127.0.0.1:8788/dots/pair?ticket=');
  expect(allowed.response.headers.get('referrer-policy')).toBe('origin');
  expect((await local.request(target, { headers: { ...headers, Referer: 'https://hostile.example/' } })).status).toBe(403);
  const paired = await local.request(target, { headers }); expect(paired.status).toBe(303);
  expect((await readDotsLink(f.env))!.deviceSecret).toBe(f.link.deviceSecret);
  expect((await local.request(target, { headers })).status).toBe(403);
  const complete = await f.relay.app.request(paired.headers.get('location')!, { headers: { Cookie: allowed.cookie } }); expect(complete.status).toBe(303);
  expect((await f.relay.app.request(paired.headers.get('location')!, { headers: { Cookie: allowed.cookie } })).status).toBe(400);
  const expired = await f.allow();
  await f.db.execute({ sql: 'UPDATE dots_flows SET ticket_expires=0 WHERE id=?', args: [expired.fields.flow] });
  expect((await local.request(expired.response.headers.get('location')!, { headers })).status).toBe(403);
  const unconfirmed = await f.allow();
  await f.db.execute({ sql: 'UPDATE dots_flows SET approved=0 WHERE id=?', args: [unconfirmed.fields.flow] });
  expect((await local.request(unconfirmed.response.headers.get('location')!, { headers })).status).toBe(403);
  expect((await readDotsLink(f.env))!.deviceSecret).toBe(f.link.deviceSecret);
});
it('redeems the fallback code only once and completes the same pending browser authorization', async () => {
  const f = await fixture(); const allowed = await f.allow('fallback');
  const html = await allowed.response.text(); const code = html.match(/usegrunt dots link ([A-Z0-9_-]{16})/)![1]!;
  const complete = await dotsLink(code, f.env, fetch, () => {});
  expect((await readDotsLink(f.env))!.deviceSecret).toBe(f.link.deviceSecret);
  await expect(dotsLink(code, f.env, fetch, () => {})).rejects.toMatchObject({ code: 'upstream' });
  expect((await f.relay.app.request(complete, { headers: { Cookie: allowed.cookie } })).status).toBe(303);
});
it('rejects hostile or disabled local pairing and unconfirmed gateway results before saving a device secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'milo-unpaired-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const env = { MILO_CONFIG_DIR: directory, MILO_DOTS_URL: 'https://api.grunt.run', MILO_SOURCES: 'dots' };
  const target = 'https://api.grunt.run/oauth/complete?flow=' + 'f'.repeat(43);
  const url = 'http://127.0.0.1:8788/dots/pair?' + new URLSearchParams({ ticket: 't'.repeat(43), return: target });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ paired: false, return: target })));
  const request = new Request(url, { headers: { Referer: 'https://api.grunt.run/' } });
  expect((await pairDots(request, { ...env, MILO_SOURCES: 'kilo' }, fetcher)).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  expect((await pairDots(new Request(url, { headers: { Referer: 'https://hostile.example/' } }), env, fetcher)).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  expect((await pairDots(request, env, fetcher)).status).toBe(403);
  expect(await readDotsLink(env)).toBeUndefined();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ paired: true, return: 'https://api.grunt.run/oauth/complete?flow=' + 'x'.repeat(43) })));
  expect((await pairDots(request, env, fetcher)).status).toBe(403); expect(await readDotsLink(env)).toBeUndefined();
  await expect(dotsLink(undefined, env, fetcher, () => {})).rejects.toThrow('fallback');
});
it('publishes canonical join metadata and the mcp alias with matching resource challenges', async () => {
  const f = await fixture();
  for (const path of ['/join', '/mcp']) {
    const metadata = await (await f.relay.app.request('/.well-known/oauth-protected-resource' + path)).json(); expect(metadata.resource).toBe(f.env.MILO_DOTS_URL + path);
    const unauthenticated = await f.relay.app.request(path, json({})); expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource' + path);
    expect((await f.rpc('initialize', {}, undefined, path)).result.capabilities).toHaveProperty('events');
  }
  const setup = await (await f.relay.app.request('/join')).text();
  expect(setup).toContain('Join grunt:'); expect(setup).not.toContain('usegrunt dots link'); expect(setup).not.toContain('Settings');
});

it('defaults new installs to grunt while paired devices keep their stored relay origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-legacy-link-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const env = { MILO_CONFIG_DIR: directory, MILO_SOURCES: 'dots' };
  expect(dotsGateway(env)).toBe('https://api.grunt.run');
  const link = { gateway: 'https://usemilo.dev', deviceSecret: 'a'.repeat(43) };
  await writeFile(join(directory, 'dots.json'), JSON.stringify(link));
  expect(await readDotsLink(env)).toEqual(link);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ linked: true, subscribed: true }));
  const dots = new Dots({ env, fetcher });
  expect(await dots.available()).toBe(true);
  expect(fetcher.mock.calls[0]![0]).toBe('https://usemilo.dev/dots/status');
  expect(await readDotsLink({ ...env, MILO_DOTS_URL: 'https://api.grunt.run' })).toBeUndefined();
  await dots.close();
});
