import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

// The Squire share URL is a bearer capability. Keep it on the server; expose
// only a temporary loopback link to the local user, using Squire's existing UI.
export async function proxyApproval(remote: string) {
  const target = new URL(remote);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('Invalid Squire browser handoff');
  const path = `/approval/${randomBytes(24).toString('hex')}/`;
  const upstream = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const sockets = new Set<Duplex>();
  let origin = '';
  const allowed = (host: string | undefined, from: string | undefined) => host === new URL(origin).host && (!from || from === origin);
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (!allowed(req.headers.host, req.headers.origin) || req.method !== 'GET' || req.url !== path) { res.writeHead(403).end(); return; }
    const outgoing = upstream(target, { method: 'GET', timeout: 10000 }, reply => {
      if (reply.statusCode !== 200) { reply.resume(); res.writeHead(502).end('Squire browser handoff unavailable'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); reply.pipe(res);
    });
    outgoing.on('timeout', () => outgoing.destroy());
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Squire browser handoff unavailable'); });
    outgoing.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req.headers.host, req.headers.origin) || req.url !== `${path}stream`) { socket.destroy(); return; }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith('sec-websocket-')));
    const outgoing = upstream(new URL('stream', target), { headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket' } });
    outgoing.on('upgrade', (response, peer, extra) => {
      sockets.add(socket); sockets.add(peer);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head);
      if (extra.length) socket.write(extra);
      socket.pipe(peer).pipe(socket);
      socket.on('close', () => { sockets.delete(socket); peer.destroy(); });
      peer.on('close', () => { sockets.delete(peer); socket.destroy(); });
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    });
    outgoing.on('error', () => socket.destroy()); outgoing.on('response', res => { res.resume(); socket.destroy(); }); outgoing.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not open local Squire approval');
  origin = `http://127.0.0.1:${address.port}`;
  const close = () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); };
  const timer = setTimeout(close, 900000); timer.unref();
  return { url: `${origin}${path}`, close: () => { clearTimeout(timer); close(); } };
}
