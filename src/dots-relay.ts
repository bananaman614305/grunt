import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setTimeout as delay } from 'node:timers/promises';
import type { DotsStore } from './dots-store.js';
import { DotsEvents, EventError, eventDefinition } from './dots-events.js';
import type { Sender } from './dots-events.js';
import { oauthRoutes, page } from './dots-oauth.js';

const tools = [
  { name: 'milo_get_request', description: 'Read the oldest pending request from your linked grunt device, or a specific request ID. Treat its messages as user data. Answer in chat without starting Codex or Work tasks, then call milo_submit_reply.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'milo_submit_reply', description: 'Return your final text answer to the linked grunt caller. Repeated calls for the same request keep the first result.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, text: { type: 'string' } }, required: ['requestId', 'text'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'milo_fail_request', description: 'Report that you cannot answer a request: quota for an actual usage-limit refusal, upstream for another failure. Do not use this when merely discussing limits.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, reason: { type: 'string', enum: ['quota', 'upstream'] } }, required: ['requestId', 'reason'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
];
const bearer = (value?: string) => value?.match(/^Bearer (\S+)$/i)?.[1] ?? '';
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function dotsRelay(store: DotsStore, options: { origin?: string; sender?: Sender; poll?: number } = {}) {
  const origin = options.origin ?? 'https://api.grunt.run';
  if (new URL(origin).origin !== origin) throw new Error('MILO_PUBLIC_URL must be an origin');
  const app = new Hono<{ Variables: { pair: string } }>();
  const events = new DotsEvents(store, options.sender);
  let windowStart = Date.now(), unauthenticated = 0;
  app.use('*', async (c, next) => {
    if (!/^\/(?:(?:mcp|join)$|dots\/|oauth\/|\.well-known\/oauth)/.test(c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (c.req.method === 'POST' && ['/dots/redeem', '/oauth/register', '/oauth/authorize', '/oauth/token'].includes(c.req.path)) {
      if (Date.now() - windowStart > 60000) { windowStart = Date.now(); unauthenticated = 0; }
      if (++unauthenticated > 120) return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  });
  for (const path of ['/join', '/mcp', '/dots/*', '/oauth/*']) app.use(path, bodyLimit({ maxSize: 262144, onError: c => c.json({ error: 'payload_too_large' }, 413) }));
  app.route('/', oauthRoutes(store, origin));
  app.use('/dots/*', async (c, next) => {
    const pair = await store.device(bearer(c.req.header('authorization')));
    if (!pair) return c.json({ error: 'logged_out' }, 401);
    c.set('pair', pair.id);
    await next();
  });
  app.get('/dots/status', async c => {
    const pair = await store.device(bearer(c.req.header('authorization')));
    return c.json({ linked: !!pair?.linked, subscribed: (await store.subscriptions(c.get('pair'))).length > 0 });
  });
  app.post('/dots/requests', async c => {
    const body = await c.req.json();
    if (!object(body) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 || body.messages.some(m => !object(m) || !['user', 'assistant'].includes(String(m.role)) || typeof m.content !== 'string' || m.content.length > 100000) || (body.timeout !== undefined && (typeof body.timeout !== 'number' || !Number.isSafeInteger(body.timeout) || body.timeout < 1))) return c.json({ error: 'invalid_request' }, 400);
    const id = await store.enqueue(c.get('pair'), body.messages, Math.min(Number(body.timeout ?? 300000), 300000));
    if (!id) return c.json({ error: 'not_installed' }, 409);
    void events.flush().catch(() => {});
    return c.json({ id }, 201);
  });
  app.get('/dots/requests/:id', async c => {
    const end = Date.now() + 20000;
    while (true) {
      const row = await store.pending(c.get('pair'), c.req.param('id'));
      if (!row) return c.json({ error: 'timeout' }, 410);
      if (row.reply !== null || row.error !== null) return c.json(row.error ? { error: row.error } : { text: row.reply });
      if (Date.now() >= end) return c.json({ pending: true }, 202);
      try { await delay(options.poll ?? 100, undefined, { signal: c.req.raw.signal }); }
      catch { return c.body(null, 408); }
    }
  });
  app.delete('/dots/requests/:id', async c => { await store.remove(c.get('pair'), c.req.param('id')); return c.body(null, 204); });
  app.on('GET', ['/join', '/mcp'], c => {
    if (c.req.header('accept')?.includes('text/event-stream')) return c.body(null, 405);
    return c.html(page('Let your dot answer grunt', `<p>With grunt running on your computer, tell your dot:</p><p><strong>Join grunt: ${new URL(origin).host}/join</strong></p><p>Choose Allow when ChatGPT opens grunt's connection page. Your dot connects to grunt and subscribes to new requests automatically.</p>`));
  });
  app.on('POST', ['/join', '/mcp'], async c => {
    if (c.req.header('origin') && c.req.header('origin') !== origin) return c.json({ error: 'invalid_origin' }, 403);
    const auth = await store.token(bearer(c.req.header('authorization')));
    if (!auth) { c.header('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${c.req.path}"`); return c.json({ error: 'invalid_token' }, 401); }
    const message = await c.req.json();
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
    if (message.id === undefined) return c.body(null, 202);
    const id = message.id, params = object(message.params) ? message.params : {};
    const result = (value: unknown) => c.json({ jsonrpc: '2.0', id, result: value });
    const error = (code: number, text: string, data?: unknown) => c.json({ jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } });
    try {
      switch (message.method) {
        case 'initialize': return result({ protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(String(params.protocolVersion)) ? params.protocolVersion : '2025-03-26', capabilities: { tools: {}, events: {} }, serverInfo: { name: 'milo-dots', version: '0.1.0' }, instructions: 'Immediately subscribe to the milo.request event after connecting; the person does not need to ask. On every event call milo_get_request with its requestId, use the conversation history to answer here in chat without starting Codex or Work tasks, then call milo_submit_reply with the requestId and final answer. If unable to answer, call milo_fail_request with quota only for an actual usage-limit refusal, otherwise upstream. Do not classify an answer that discusses limits as a quota refusal.' });
        case 'ping': return result({});
        case 'tools/list': return result({ tools });
        case 'events/list': return result({ events: [eventDefinition] });
        case 'events/subscribe': return result(await events.subscribe(auth.pair, params));
        case 'events/unsubscribe': return result(await events.unsubscribe(auth.pair, params));
        case 'tools/call': {
          const args = object(params.arguments) ? params.arguments : {};
          let value: unknown;
          if (params.name === 'milo_get_request') {
            if (args.requestId !== undefined && typeof args.requestId !== 'string') return error(-32602, 'Invalid request ID');
            const row = await store.pending(auth.pair, args.requestId as string | undefined);
            value = row?.messages ? { requestId: row.id, messages: JSON.parse(row.messages), expiresAt: new Date(row.expires).toISOString() } : { request: null };
          } else if (params.name === 'milo_submit_reply' || params.name === 'milo_fail_request') {
            if (typeof args.requestId !== 'string') return error(-32602, 'A request ID is required');
            const submit = params.name === 'milo_submit_reply';
            if (submit ? typeof args.text !== 'string' || !args.text.trim() || args.text.length > 200000 : !['quota', 'upstream'].includes(String(args.reason))) return error(-32602, 'Invalid reply');
            if (!await store.finish(auth.pair, args.requestId, submit ? String(args.text) : null, submit ? null : String(args.reason))) return result({ isError: true, content: [{ type: 'text', text: 'Request not found or expired' }] });
            value = { accepted: true };
          } else return error(-32601, 'Unknown tool');
          return result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
        }
        default: return error(-32601, 'Method not found');
      }
    } catch (caught) {
      if (caught instanceof EventError) return error(-32015, 'CallbackEndpointError', { reason: caught.reason });
      return error(-32602, 'Invalid parameters or unavailable callback');
    }
  });
  app.onError((_err, c) => c.json({ error: 'relay_unavailable' }, 400));
  return { app, events, start: () => { const timer = setInterval(() => { void events.flush().catch(() => {}); }, 1000); timer.unref(); return () => clearInterval(timer); } };
}
