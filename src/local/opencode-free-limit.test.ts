import { createServer, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { OpenCode } from './opencode.js';
import { SourceError } from './source.js';

it('fails fast on the free-limit retry event and cools down the whole model pool', async () => {
  let events: ServerResponse | undefined, aborted = false, messages = 0;
  const next = Date.now() + 3600_000;
  const server = createServer((req, res) => {
    if (req.url === '/event') {
      events = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
    } else if (req.url === '/session') res.end(JSON.stringify({ id: 'ses_test' }));
    else if (req.url === '/session/ses_test/message' && req.method === 'POST') {
      messages++;
      // OpenCode would now sleep until the reset; only the retry event arrives.
      events?.write(`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'ses_test', status: { type: 'retry', attempt: 1, action: { reason: 'free_tier_limit' }, next } } })}\n\n`);
    } else if (req.url === '/session/ses_test/abort') { aborted = true; res.end('true'); }
    else { res.writeHead(400); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = new OpenCode({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, models: ['deepseek-v4.1-flash-free', 'big-pickle'] });
  const request = { model: 'opencode', cwd: '/tmp', stream: false, tools: [], messages: [{ role: 'user', content: 'hello' }] };
  try {
    const started = Date.now();
    const error = await driver.complete(request, AbortSignal.timeout(10000)).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ code: 'quota' });
    expect((error as SourceError).retryAfter).toBeGreaterThan(3500);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(aborted).toBe(true);
    expect(messages).toBe(1);
    // The second model shares the same per-IP limit, so it is not tried.
    await expect(driver.complete(request, AbortSignal.timeout(10000))).rejects.toMatchObject({ code: 'quota' });
    expect(messages).toBe(1);
  } finally {
    await driver.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
