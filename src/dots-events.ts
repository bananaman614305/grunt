import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import { equal, hash, secret } from './dots-store.js';
import type { Subscription , DotsStore} from './dots-store.js';

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
export function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function callbackURL(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 2048 || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host))) throw new Error('invalid_callback');
  return url;
}
// Resolve on every connection, pin the public address, and preserve the TLS hostname.
export const webhookPost: Sender = async (value, body, headers) => {
  const url = callbackURL(value), host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw new Error('private_callback');
  const address = addresses[0]!.address;
  return await new Promise((resolve, reject) => {
    const req = request({ hostname: address, port: url.port || 443, path: url.pathname + url.search, method: 'POST', servername: host, family: isIP(address), headers: { ...headers, Host: url.host, 'Content-Length': Buffer.byteLength(body) }, timeout: 10000, maxHeaderSize: 8192 }, res => {
      let text = '';
      res.on('data', chunk => { text += String(chunk); if (Buffer.byteLength(text) > 65536) req.destroy(new Error('callback_too_large')); });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('callback_timeout')));
    req.on('error', reject);
    req.end(body);
  });
};
export class EventError extends Error {
  constructor(readonly reason: string) { super('Callback verification failed'); }
}
export const eventDefinition = {
  name: 'milo.request', description: 'A request is waiting from your linked grunt daemon. Fetch it with milo_get_request and return text with milo_submit_reply.', delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { requestId: { type: 'string' }, summary: { type: 'string' } }, required: ['requestId', 'summary'], additionalProperties: false }
};
function identity(pair: string, input: Record<string, unknown>) {
  const delivery = input.delivery as Record<string, unknown> | undefined;
  if (input.name !== 'milo.request' || !delivery || delivery.mode !== 'webhook' || typeof delivery.url !== 'string' || (input.arguments !== undefined && (typeof input.arguments !== 'object' || input.arguments === null || Array.isArray(input.arguments) || Object.keys(input.arguments).length))) throw new Error('invalid_event_arguments');
  const url = callbackURL(delivery.url).href;
  return { id: `sub_${hash(JSON.stringify([pair, url, 'milo.request', {}]))}`, url, delivery };
}
export class DotsEvents {
  private flushing = false;
  constructor(readonly store: DotsStore, private sender: Sender = webhookPost) {}
  private async post(sub: Pick<Subscription, 'id' | 'url' | 'secret' | 'previous' | 'rotation_until'>, eventId: string, value: unknown) {
    const body = JSON.stringify(value), now = new Date();
    const signature = new Webhook(sub.secret).sign(eventId, now, body);
    const previous = sub.previous && sub.rotation_until > Date.now() ? ' ' + new Webhook(sub.previous).sign(eventId, now, body) : '';
    return this.sender(sub.url, body, { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(now.getTime() / 1000)), 'webhook-signature': signature + previous, 'X-MCP-Subscription-Id': sub.id });
  }
  async subscribe(pair: string, input: Record<string, unknown>) {
    const { id, url, delivery } = identity(pair, input);
    const key = delivery.secret;
    if (typeof key !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key.slice(6), 'base64').length < 24 || Buffer.from(key.slice(6), 'base64').length > 64) throw new Error('invalid_signing_secret');
    if (input.ttlMs !== undefined && input.ttlMs !== null && (typeof input.ttlMs !== 'number' || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)) throw new Error('invalid_ttl');
    const ttl = Math.max(60000, Math.min(typeof input.ttlMs === 'number' ? input.ttlMs : 86400000, 86400000));
    const now = Date.now(), expires = now + ttl;
    const existing = (await this.store.rows<Subscription>('SELECT * FROM dots_subscriptions WHERE id=? AND pair=?', [id, pair]))[0];
    const verify = !existing || !equal(existing.secret, key) || existing.verified_until < now;
    if (verify) {
      const challenge = secret();
      let result;
      try { result = await this.post({ id, url, secret: key, previous: null, rotation_until: 0 }, `verification_${randomUUID()}`, { type: 'verification', challenge }); }
      catch { throw new EventError('timeout'); }
      let echoed;
      try { echoed = JSON.parse(result.body).challenge; } catch { /* Fail closed. */ }
      if (result.status < 200 || result.status >= 300 || typeof echoed !== 'string' || !equal(challenge, echoed)) throw new EventError('challenge_failed');
    }
    const rotating = existing && !equal(existing.secret, key);
    await this.store.db.execute({ sql: `INSERT INTO dots_subscriptions(id,pair,url,secret,previous,rotation_until,expires,verified_until) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,previous=excluded.previous,rotation_until=excluded.rotation_until,expires=excluded.expires,verified_until=excluded.verified_until`,
    args: [id, pair, url, key, rotating ? existing.secret : existing?.previous ?? null, rotating ? now + 600000 : existing?.rotation_until ?? 0, expires, verify ? now + 600000 : existing!.verified_until] });
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
  }
  async unsubscribe(pair: string, input: Record<string, unknown>) {
    const { id } = identity(pair, input);
    await this.store.db.execute({ sql: 'DELETE FROM dots_subscriptions WHERE id=? AND pair=?', args: [id, pair] });
    return {};
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.store.clean();
      const deliveries = await this.store.rows<Subscription & { request: string; event_id: string; occurred: number; attempts: number }>(`SELECT s.*,d.request,d.event_id,d.occurred,d.attempts FROM dots_deliveries d JOIN dots_subscriptions s ON s.id=d.subscription JOIN dots_requests r ON r.id=d.request WHERE d.next_at<=? AND s.expires>? AND r.expires>? AND r.messages IS NOT NULL LIMIT 16`, [Date.now(), Date.now(), Date.now()]);
      for (const sub of deliveries) {
        let status = 503;
        try { status = (await this.post(sub, sub.event_id, { eventId: sub.event_id, name: 'milo.request', timestamp: new Date(sub.occurred).toISOString(), data: { requestId: sub.request, summary: 'A request is waiting from your linked grunt daemon.' }, cursor: null })).status; }
        catch { /* Network errors retry without storing diagnostics or user text. */ }
        if ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 429) || sub.attempts >= 4) {
          await this.store.db.execute({ sql: 'DELETE FROM dots_deliveries WHERE request=? AND subscription=?', args: [sub.request, sub.id] });
          if (status === 410) await this.store.db.execute({ sql: 'DELETE FROM dots_subscriptions WHERE id=?', args: [sub.id] });
        } else await this.store.db.execute({ sql: 'UPDATE dots_deliveries SET attempts=attempts+1,next_at=? WHERE request=? AND subscription=?', args: [Date.now() + 1000 * 2 ** sub.attempts, sub.request, sub.id] });
      }
    } finally { this.flushing = false; }
  }
}
