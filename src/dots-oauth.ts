import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { DotsStore } from './dots-store.js';
import { hash, secret, equal } from './dots-store.js';

type Flow = { id: string; client: string; redirect: string; state: string; challenge: string; browser_hash: string; csrf_hash: string; expires: number; attempts: number; resource: string; port: number; approved: number; ticket_hash: string | null; fallback_hash: string | null; ticket_expires: number | null; pair: string | null };
const escape = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Milo</title><style>body{background:#111;color:#eee;font:17px/1.55 system-ui;margin:0;padding:8vh 24px}main{max-width:480px;margin:auto}small{color:#c1a770}h1{font-size:32px;line-height:1.15}p{color:#bbb}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;background:#222;color:#fff;border:1px solid #666;border-radius:3px;padding:14px;font:inherit}button{padding:12px 24px;margin:24px 12px 0 0;border:0;border-radius:3px;background:#d7af5f;color:#111;font:inherit;cursor:pointer}button[value=deny]{background:#333;color:#eee}a{color:#d7af5f}code{color:#eee}input:focus,button:focus{outline:2px solid #eee;outline-offset:3px}</style><main><small>MILO · DOTS CONNECTOR</small><h1>${escape(title)}</h1>${body}</main></html>`;
}
function consent(flow: string, csrf: string, client: string) {
  return page('Connect your dot to Milo', `<p>${escape(client)} will be able to read requests from Milo on this computer and send answers back.</p><p>Only allow a connection you started. Milo must be running on this computer with the dots source enabled.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="flow" value="${escape(flow)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Cancel</button><p>Approving on a phone, or Milo cannot be reached?</p><button name="decision" value="fallback">Connect another computer</button></form><p>Requests may include conversation history. Milo deletes request text when answered or expired.</p>`);
}
function fallback(flow: string, code: string) {
  return page('Connect Milo on your computer', `<p>On the computer running Milo, run this fallback command:</p><p><code>milo dots link ${escape(code)}</code></p><p>The code is private, works once, and expires in ten minutes. After the command succeeds, return here.</p><p><a href="/oauth/complete?flow=${encodeURIComponent(flow)}">Continue to ChatGPT</a></p>`);
}
function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return !url.hash && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))); }
  catch { return false; }
}
export function oauthRoutes(store: DotsStore, origin: string) {
  const app = new Hono();
  const resources = [origin + '/join', origin + '/mcp'];
  const metadata = (resource: string) => ({ resource, authorization_servers: [origin], scopes_supported: ['milo:dots'], bearer_methods_supported: ['header'] });
  app.get('/.well-known/oauth-protected-resource', c => c.json(metadata(resources[0]!)));
  for (const name of ['join', 'mcp']) app.get('/.well-known/oauth-protected-resource/' + name, c => c.json(metadata(origin + '/' + name)));
  app.get('/.well-known/oauth-authorization-server', c => c.json({ issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', registration_endpoint: origin + '/oauth/register', revocation_endpoint: origin + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['milo:dots'] }));
  app.post('/oauth/register', async c => {
    const body = await c.req.json();
    if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 5 || !body.redirect_uris.every(validRedirect) || (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')) return c.json({ error: 'invalid_client_metadata' }, 400);
    const id = secret(), name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'ChatGPT';
    await store.db.execute({ sql: 'INSERT INTO dots_clients VALUES(?,?,?)', args: [id, JSON.stringify(body.redirect_uris), name] });
    return c.json({ client_id: id, client_name: name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  });
  app.get('/oauth/authorize', async c => {
    const q = c.req.query();
    const client = (await store.rows<{ redirects: string; name: string }>('SELECT redirects,name FROM dots_clients WHERE id=?', [q.client_id ?? '']))[0];
    if (!client || !JSON.parse(client.redirects).includes(q.redirect_uri) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '') || (q.resource !== undefined && !resources.includes(q.resource)) || (q.scope !== undefined && q.scope !== 'milo:dots') || (q.state?.length ?? 0) > 2048) return c.json({ error: 'invalid_request' }, 400);
    const port = Number(q.milo_port ?? 8788);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return c.json({ error: 'invalid_request' }, 400);
    const id = secret(), browser = secret(), csrf = secret();
    await store.db.execute({ sql: 'INSERT INTO dots_flows(id,client,redirect,state,challenge,browser_hash,csrf_hash,expires,resource,port) VALUES(?,?,?,?,?,?,?,?,?,?)', args: [id, q.client_id!, q.redirect_uri!, q.state ?? '', q.code_challenge!, hash(browser), hash(csrf), Date.now() + 600000, q.resource ?? resources[0]!, port] });
    setCookie(c, 'milo_oauth', browser, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'Lax', path: '/oauth', maxAge: 600 });
    // Preserve a same-origin form POST Origin; no-referrer makes browsers send null.
    c.header('Referrer-Policy', 'same-origin');
    return c.html(consent(id, csrf, client.name));
  });
  app.post('/oauth/authorize', async c => {
    const body = await c.req.parseBody();
    const flow = (await store.rows<Flow>('SELECT * FROM dots_flows WHERE id=? AND expires>? AND attempts<5', [String(body.flow ?? ''), Date.now()]))[0];
    if (!flow || !equal(flow.browser_hash, hash(getCookie(c, 'milo_oauth') ?? '')) || !equal(flow.csrf_hash, hash(String(body.csrf ?? ''))) || (c.req.header('origin') && c.req.header('origin') !== origin)) return c.html(page('Authorization expired', '<p>Restart the connector setup to try again.</p>'), 400);
    const target = new URL(flow.redirect); target.searchParams.set('state', flow.state);
    if (body.decision === 'deny') {
      await store.db.execute({ sql: 'DELETE FROM dots_flows WHERE id=?', args: [flow.id] });
      target.searchParams.set('error', 'access_denied'); return c.redirect(target.href, 303);
    }
    if (!['allow', 'fallback'].includes(String(body.decision))) return c.json({ error: 'invalid_request' }, 400);
    const ticket = secret(), code = secret().slice(0, 16).toUpperCase();
    const approved = await store.db.execute({ sql: 'UPDATE dots_flows SET approved=1,ticket_hash=?,fallback_hash=?,ticket_expires=? WHERE id=? AND pair IS NULL RETURNING id', args: [hash(ticket), hash(code), Date.now() + 600000, flow.id] });
    if (!approved.rows.length) return c.json({ error: 'invalid_request' }, 400);
    if (body.decision === 'fallback') return c.html(fallback(flow.id, code));
    const local = new URL(`http://127.0.0.1:${flow.port}/dots/pair`);
    local.searchParams.set('ticket', ticket);
    local.searchParams.set('return', `${origin}/oauth/complete?flow=${flow.id}`);
    // Top-level navigation carries only our origin, including the HTTPS-to-loopback hop.
    c.header('Referrer-Policy', 'origin');
    return c.redirect(local.href, 303);
  });
  app.post('/dots/redeem', async c => {
    const body = await c.req.json();
    if (typeof body.deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceSecret)) return c.json({ error: 'invalid_pairing' }, 400);
    const ticket = typeof body.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.ticket) ? body.ticket : undefined;
    const code = typeof body.code === 'string' && /^[A-Z0-9_-]{16}$/.test(body.code) ? body.code : undefined;
    if ((!ticket && !code) || (ticket && code)) return c.json({ error: 'invalid_pairing' }, 400);
    const tx = await store.db.transaction('write');
    try {
      const flow = (await tx.execute({ sql: `SELECT * FROM dots_flows WHERE ${ticket ? 'ticket_hash' : 'fallback_hash'}=? AND approved=1 AND pair IS NULL AND expires>? AND ticket_expires>?`, args: [hash(ticket ?? code!), Date.now(), Date.now()] })).rows[0];
      if (!flow) { await tx.rollback(); return c.json({ error: 'invalid_pairing' }, 400); }
      await tx.execute({ sql: 'INSERT OR IGNORE INTO dots_pairs(id,device_hash,code_expires,linked) VALUES(?,?,0,1)', args: [secret(), hash(body.deviceSecret)] });
      const pair = (await tx.execute({ sql: 'SELECT id FROM dots_pairs WHERE device_hash=?', args: [hash(body.deviceSecret)] })).rows[0]!;
      await tx.execute({ sql: 'UPDATE dots_flows SET pair=?,ticket_hash=NULL,fallback_hash=NULL WHERE id=?', args: [String(pair.id), String(flow.id)] });
      await tx.commit();
      return c.json({ paired: true, return: `${origin}/oauth/complete?flow=${flow.id}` });
    } finally { tx.close(); }
  });
  app.get('/oauth/complete', async c => {
    const tx = await store.db.transaction('write');
    try {
      const flow = (await tx.execute({ sql: 'SELECT * FROM dots_flows WHERE id=? AND approved=1 AND pair IS NOT NULL AND expires>?', args: [c.req.query('flow') ?? '', Date.now()] })).rows[0];
      if (!flow || !equal(String(flow.browser_hash), hash(getCookie(c, 'milo_oauth') ?? ''))) {
        await tx.rollback(); return c.html(page('Pairing is not complete', '<p>Return to the Allow page and connect Milo on this computer, or use its fallback command.</p>'), 400);
      }
      const code = secret();
      await tx.execute({ sql: 'DELETE FROM dots_flows WHERE id=?', args: [String(flow.id)] });
      await tx.execute({ sql: 'INSERT INTO dots_codes VALUES(?,?,?,?,?,?,?)', args: [hash(code), String(flow.pair), String(flow.client), String(flow.redirect), String(flow.challenge), Date.now() + 60000, String(flow.resource)] });
      await tx.commit();
      const target = new URL(String(flow.redirect)); target.searchParams.set('state', String(flow.state)); target.searchParams.set('code', code);
      return c.redirect(target.href, 303);
    } finally { tx.close(); }
  });
  app.post('/oauth/token', async c => {
    const body = await c.req.parseBody();
    const client = String(body.client_id ?? ''), grant = String(body.grant_type ?? '');
    if ((body.resource !== undefined && !resources.includes(String(body.resource))) || (body.scope !== undefined && body.scope !== 'milo:dots')) return c.json({ error: 'invalid_target' }, 400);
    const tx = await store.db.transaction('write');
    try {
      let pair: string | undefined, resource: string | undefined;
      if (grant === 'authorization_code') {
        const code = (await tx.execute({ sql: 'SELECT * FROM dots_codes WHERE hash=? AND client=? AND redirect=? AND expires>?', args: [hash(String(body.code ?? '')), client, String(body.redirect_uri ?? ''), Date.now()] })).rows[0];
        const verifier = String(body.code_verifier ?? '');
        const challenge = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ? Buffer.from(hash(verifier), 'hex').toString('base64url') : '';
        if (code && equal(String(code.challenge), challenge) && (body.resource === undefined || body.resource === code.resource)) { pair = String(code.pair); resource = String(code.resource); await tx.execute({ sql: 'DELETE FROM dots_codes WHERE hash=?', args: [String(code.hash)] }); }
      } else if (grant === 'refresh_token') {
        const token = (await tx.execute({ sql: "DELETE FROM dots_tokens WHERE hash=? AND client=? AND kind='refresh' AND expires>? RETURNING pair,resource", args: [hash(String(body.refresh_token ?? '')), client, Date.now()] })).rows[0];
        if (token && (body.resource === undefined || body.resource === token.resource)) { pair = String(token.pair); resource = String(token.resource); }
      }
      if (!pair || !resource) { await tx.rollback(); return c.json({ error: 'invalid_grant' }, 400); }
      const access = secret(), refresh = secret();
      await tx.execute({ sql: 'INSERT INTO dots_tokens VALUES(?,?,?,?,?,?)', args: [hash(access), pair, client, 'access', Date.now() + 3600000, resource] });
      await tx.execute({ sql: 'INSERT INTO dots_tokens VALUES(?,?,?,?,?,?)', args: [hash(refresh), pair, client, 'refresh', Date.now() + 30 * 86400000, resource] });
      await tx.commit();
      return c.json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'milo:dots' });
    } finally { tx.close(); }
  });
  app.post('/oauth/revoke', async c => {
    const body = await c.req.parseBody();
    const token = (await store.rows<{ pair: string; client: string }>('SELECT pair,client FROM dots_tokens WHERE hash=? AND client=?', [hash(String(body.token ?? '')), String(body.client_id ?? '')]))[0];
    if (token) await store.db.batch([
      { sql: 'DELETE FROM dots_tokens WHERE pair=? AND client=?', args: [token.pair, token.client] },
      { sql: 'DELETE FROM dots_subscriptions WHERE pair=?', args: [token.pair] }
    ], 'write');
    return c.body(null, 200);
  });
  return app;
}
