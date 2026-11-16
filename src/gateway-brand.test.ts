import { createClient } from '@libsql/client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GruntAgent, MiloAgent, defaultAgentDb } from './agent.js';
import { DotsStore, hash } from './dots-store.js';
import { DotsEvents } from './dots-events.js';
import { dotsRelay } from './dots-relay.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const json = (body: unknown, token?: string) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
async function fixture() {
  const db = createClient({ url: 'file::memory:' });
  cleanup.push(() => db.close());
  const store = new DotsStore(db); await store.init();
  const origin = 'https://relay.example';
  const relay = dotsRelay(store, { origin });
  await db.execute({ sql: 'INSERT INTO dots_pairs(id,device_hash,code_expires,linked) VALUES(?,?,0,1)', args: ['pair', hash('device')] });
  await db.execute({ sql: 'INSERT INTO dots_tokens VALUES(?,?,?,?,?,?)', args: [hash('synthetic-access'), 'pair', 'client', 'access', Date.now() + 60000, origin + '/join'] });
  const rpc = async (method: string, params: unknown = {}) => (await relay.app.request('/mcp', json({ jsonrpc: '2.0', id: 1, method, params }, 'synthetic-access'))).json();
  return { db, store, relay, rpc, origin };
}

it('exports GruntAgent and retains the old public class alias without abandoning gateway data', async () => {
  expect(MiloAgent).toBe(GruntAgent);
  const directory = await mkdtemp(join(tmpdir(), 'grunt-db-brand-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  expect(defaultAgentDb(directory)).toBe(`file:${join(directory, 'grunt.db')}`);
  await writeFile(join(directory, 'milo.db'), 'existing conversations');
  expect(defaultAgentDb(directory)).toBe(`file:${join(directory, 'milo.db')}`);
  await writeFile(join(directory, 'grunt.db'), 'current conversations');
  expect(defaultAgentDb(directory)).toBe(`file:${join(directory, 'grunt.db')}`);
});

it('advertises Grunt MCP names while cached legacy tool calls still access the same scoped requests', async () => {
  const f = await fixture();
  const initialized = (await f.rpc('initialize')).result;
  expect(initialized.serverInfo.name).toBe('grunt-dots');
  for (const name of ['grunt.request', 'grunt_get_request', 'grunt_submit_reply', 'grunt_fail_request']) expect(initialized.instructions).toContain(name);
  expect((await f.rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['grunt_get_request', 'grunt_submit_reply', 'grunt_fail_request']);
  expect((await f.rpc('events/list')).result.events.map((event: { name: string }) => event.name)).toEqual(['grunt.request']);
  for (const prefix of ['grunt', 'milo']) {
    const id = `${prefix}-request`;
    await f.db.execute({ sql: 'INSERT INTO dots_requests(id,pair,messages,expires) VALUES(?,?,?,?)', args: [id, 'pair', JSON.stringify([{ role: 'user', content: 'Hello' }]), Date.now() + 60000] });
    const read = await f.rpc('tools/call', { name: `${prefix}_get_request`, arguments: { requestId: id } });
    expect(JSON.parse(read.result.content[0].text)).toMatchObject({ requestId: id, messages: [{ content: 'Hello' }] });
    const reply = await f.rpc('tools/call', { name: `${prefix}_submit_reply`, arguments: { requestId: id, text: 'Hello back' } });
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ accepted: true });
    expect((await f.store.pending('pair', id))?.reply).toBe('Hello back');
  }
});

it('keeps both new and legacy event subscription identities through delivery and restart', async () => {
  const f = await fixture();
  const received: { name?: string; challenge?: string }[] = [];
  const sender = async (_url: string, body: string) => {
    const event = JSON.parse(body); received.push(event);
    return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
  };
  const events = new DotsEvents(f.store, sender);
  for (const name of ['grunt.request', 'milo.request']) await events.subscribe('pair', { name, delivery: { mode: 'webhook', url: 'https://receiver.example/events', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
  await f.store.enqueue('pair', [{ role: 'user', content: 'Hello' }], 60000);
  await new DotsStore(f.db).init();
  await new DotsEvents(new DotsStore(f.db), sender).flush();
  expect(received.filter(event => event.name).map(event => event.name).sort()).toEqual(['grunt.request', 'milo.request']);
});

it('migrates legacy persisted event subscriptions without changing their signing or expiry state', async () => {
  const db = createClient({ url: 'file::memory:' }); cleanup.push(() => db.close());
  await db.execute('CREATE TABLE dots_subscriptions(id TEXT PRIMARY KEY,pair TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,previous TEXT,rotation_until INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,verified_until INTEGER NOT NULL)');
  await db.execute({ sql: 'INSERT INTO dots_subscriptions VALUES(?,?,?,?,?,?,?,?)', args: ['old-id', 'pair', 'https://receiver.example/events', 'saved-signing-key', null, 0, 9999999999999, 8888888888888] });
  const store = new DotsStore(db); await store.init(); await store.init();
  expect(await store.rows('SELECT * FROM dots_subscriptions')).toEqual([{ id: 'old-id', pair: 'pair', url: 'https://receiver.example/events', secret: 'saved-signing-key', previous: null, rotation_until: 0, expires: 9999999999999, verified_until: 8888888888888, event_name: 'milo.request' }]);
});

it.each(['grunt', 'milo'])('accepts %s OAuth names and the configured 8792 port while advertising Grunt', async prefix => {
  const f = await fixture();
  const metadata = await (await f.relay.app.request('/.well-known/oauth-authorization-server')).json();
  expect(metadata.scopes_supported).toEqual(['grunt:dots']);
  const client = await (await f.relay.app.request('/oauth/register', json({ redirect_uris: ['https://client.example/callback'] }))).json();
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: `${prefix}:dots`, [`${prefix}_port`]: '8792' });
  const consent = await f.relay.app.request('/oauth/authorize?' + params);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const cookie = consent.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie).toMatch(/^grunt_oauth=/);
  // An authorization already opened before upgrade may still carry the old cookie.
  const browserCookie = prefix === 'milo' ? cookie.replace('grunt_oauth=', 'milo_oauth=') : cookie;
  const allow = await f.relay.app.request('/oauth/authorize', form({ flow: html.match(/name="flow" value="([^"]+)"/)![1]!, csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!, decision: 'allow' }, { Cookie: browserCookie }));
  expect(allow.status).toBe(303);
  expect(new URL(allow.headers.get('location')!).port).toBe('8792');
});
