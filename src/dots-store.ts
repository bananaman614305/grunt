import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Client, InValue } from '@libsql/client';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equal(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export type Pair = { id: string; linked: number };
export type Subscription = { id: string; pair: string; url: string; secret: string; previous: string | null; rotation_until: number; expires: number; verified_until: number };
export type Pending = { id: string; pair: string; messages: string | null; reply: string | null; error: string | null; expires: number };
export class DotsStore {
  constructor(readonly db: Client) {}
  async init() {
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS dots_pairs(id TEXT PRIMARY KEY, device_hash TEXT UNIQUE NOT NULL, code_hash TEXT UNIQUE, code_expires INTEGER NOT NULL, linked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS dots_clients(id TEXT PRIMARY KEY, redirects TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_flows(id TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, browser_hash TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, resource TEXT NOT NULL, port INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, ticket_hash TEXT UNIQUE, fallback_hash TEXT UNIQUE, ticket_expires INTEGER, pair TEXT);
      CREATE TABLE IF NOT EXISTS dots_codes(hash TEXT PRIMARY KEY, pair TEXT NOT NULL, client TEXT NOT NULL, redirect TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, resource TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_tokens(hash TEXT PRIMARY KEY, pair TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, resource TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_subscriptions(id TEXT PRIMARY KEY, pair TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, previous TEXT, rotation_until INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, verified_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_requests(id TEXT PRIMARY KEY, pair TEXT NOT NULL, messages TEXT, reply TEXT, error TEXT, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dots_request_pair ON dots_requests(pair, expires);
      CREATE TABLE IF NOT EXISTS dots_deliveries(request TEXT NOT NULL, subscription TEXT NOT NULL, event_id TEXT NOT NULL, occurred INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, PRIMARY KEY(request,subscription));
    `);
  }
  async rows<T>(sql: string, args: InValue[] = []) { return (await this.db.execute({ sql, args })).rows as unknown as T[]; }
  async clean() {
    const now = Date.now();
    await this.db.batch([
      { sql: 'DELETE FROM dots_requests WHERE expires<=?', args: [now] },
      { sql: 'DELETE FROM dots_deliveries WHERE request NOT IN (SELECT id FROM dots_requests WHERE messages IS NOT NULL) OR subscription NOT IN (SELECT id FROM dots_subscriptions WHERE expires>?)', args: [now] },
      { sql: 'DELETE FROM dots_subscriptions WHERE expires<=?', args: [now] },
      { sql: 'UPDATE dots_subscriptions SET previous=NULL WHERE rotation_until<=?', args: [now] },
      { sql: 'DELETE FROM dots_tokens WHERE expires<=?', args: [now] },
      { sql: 'DELETE FROM dots_flows WHERE expires<=?', args: [now] },
      { sql: 'DELETE FROM dots_codes WHERE expires<=?', args: [now] },
      { sql: 'DELETE FROM dots_pairs WHERE linked=0 AND code_expires<=?', args: [now] }
    ], 'write');
  }
  async device(token: string) { return (await this.rows<Pair>('SELECT id,linked FROM dots_pairs WHERE device_hash=? AND (linked=1 OR code_expires>?)', [hash(token), Date.now()]))[0]; }
  async token(token: string) { return (await this.rows<{ pair: string; client: string }>("SELECT pair,client FROM dots_tokens WHERE hash=? AND kind='access' AND expires>?", [hash(token), Date.now()]))[0]; }
  async subscriptions(pair: string) { return this.rows<Subscription>('SELECT * FROM dots_subscriptions WHERE pair=? AND expires>?', [pair, Date.now()]); }
  async enqueue(pair: string, messages: unknown, timeout: number) {
    const id = randomUUID(), now = Date.now();
    const subscriptions = await this.subscriptions(pair);
    if (!subscriptions.length) return undefined;
    const active = (await this.rows<{ count: number }>('SELECT count(*) count FROM dots_requests WHERE pair=? AND expires>?', [pair, now]))[0]!.count;
    if (active >= 8) throw new Error('queue_full');
    await this.db.batch([
      { sql: 'INSERT INTO dots_requests(id,pair,messages,expires) VALUES(?,?,?,?)', args: [id, pair, JSON.stringify(messages), now + timeout] },
      ...subscriptions.map(sub => ({ sql: 'INSERT INTO dots_deliveries(request,subscription,event_id,occurred,next_at) VALUES(?,?,?,?,?)', args: [id, sub.id, `evt_${randomUUID()}`, now, now] }))
    ], 'write');
    return id;
  }
  async pending(pair: string, id?: string) {
    return (await this.rows<Pending>(`SELECT * FROM dots_requests WHERE pair=? AND expires>? ${id ? 'AND id=?' : 'AND messages IS NOT NULL'} ORDER BY rowid LIMIT 1`, [pair, Date.now(), ...(id ? [id] : [])]))[0];
  }
  async finish(pair: string, id: string, reply: string | null, error: string | null) {
    const row = await this.pending(pair, id);
    if (!row) return false;
    // First reply wins. Repeated tool calls acknowledge the existing result.
    await this.db.execute({ sql: 'UPDATE dots_requests SET messages=NULL,reply=?,error=? WHERE id=? AND pair=? AND messages IS NOT NULL', args: [reply, error, id, pair] });
    await this.db.execute({ sql: 'DELETE FROM dots_deliveries WHERE request=?', args: [id] });
    return true;
  }
  async remove(pair: string, id: string) {
    await this.db.execute({ sql: 'DELETE FROM dots_requests WHERE pair=? AND id=?', args: [pair, id] });
    await this.db.execute({ sql: 'DELETE FROM dots_deliveries WHERE request=? AND request NOT IN (SELECT id FROM dots_requests)', args: [id] });
  }
}
