import { createServer, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
const { OpenCode } = await import(process.env.GRUNT_BUILT_PROOF ? '../../dist/local/opencode.js' : './opencode.js');
const { createLocalApp } = await import(process.env.GRUNT_BUILT_PROOF ? '../../dist/local/api.js' : './api.js');
const { Sources } = await import(process.env.GRUNT_BUILT_PROOF ? '../../dist/local/source.js' : './source.js');

it.each(['complete', 'caller', 'shutdown', 'stream-loss', 'invalid-question', 'reply-error'] as const)('R1 rejects permission questions through grunt HTTP and cleans up on %s', async mode => {
  let events: ServerResponse | undefined, pending: ServerResponse | undefined;
  let aborted = false;
  let rejected = false, disconnected!: () => void, asked!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const question = new Promise<void>(resolve => { asked = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/event') {
      events = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      req.on('close', disconnected);
    } else if (req.url === '/session') {
      res.end(JSON.stringify({ id: 'ses_test' }));
    } else if (req.url === '/session/ses_test/message') {
      pending = res;
      events?.write('data: {"type":"permission.asked","properties":{"id":"per_other","sessionID":"ses_other"}}\n\n');
      if (mode === 'stream-loss') { events?.end(); asked(); return; }
      if (mode === 'invalid-question') {
        events?.write('data: {"type":"permission.asked","properties":{"sessionID":"ses_test","id":"../invalid"}}\n\n');
        asked(); return;
      }
      // Split an SSE frame across writes to exercise incremental decoding.
      events?.write('data: {"type":"permission.asked","properties":');
      events?.write('{"id":"per_test","sessionID":"ses_test","permission":"external_directory"}}\r\n\r\n');
      asked();
    } else if (req.url === '/permission/per_test/reply') {
      let body = '';
      for await (const chunk of req) body += chunk;
      rejected = JSON.parse(body).reply === 'reject';
      if (mode === 'reply-error') { res.writeHead(500); res.end(); return; }
      res.end('true');
      if (mode === 'complete') pending!.end(JSON.stringify({ parts: [{ type: 'text', text: 'Outside access denied; continuing the turn.' }] }));
    } else if (req.url === '/session/ses_test/abort') {
      aborted = true; pending?.end('{}'); res.end('true');
    } else { res.writeHead(400); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const driver = new OpenCode({ url: `http://127.0.0.1:${address.port}` });
  const controller = new AbortController();
  const started = Date.now();
  try {
    const app = createLocalApp(new Sources([driver]));
    const result = app.fetch(new Request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      body: JSON.stringify({ model: 'opencode', cwd: '/tmp', stream: false, tools: [], messages: [{ role: 'user', content: 'Read /etc/hostname and tell me its contents' }] })
    }));
    const outcome = result.catch(error => error);
    await question;
    if (mode === 'caller') controller.abort();
    if (mode === 'shutdown') await driver.close();
    const response = await outcome;
    if (mode === 'complete') {
      expect(response.status).toBe(200);
      expect((await response.json()).choices[0].message.content).toBe('Outside access denied; continuing the turn.');
      expect(rejected).toBe(true);
    } else {
      expect(aborted).toBe(true);
      if (['stream-loss', 'invalid-question', 'reply-error'].includes(mode)) expect(response.status).toBe(503);
    }
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('event listener leaked')), 1000))]);
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    await driver.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
