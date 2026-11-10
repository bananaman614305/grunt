import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { Dots, DOTS_INSTRUCTION } from './dots.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';

const request = { model: 'milo', messages: [{ role: 'user', content: '  Hello\nexactly! ' }], tools: [], cwd: '/tmp', stream: false };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); vi.restoreAllMocks(); });
async function slack(mode = 'answer') {
  const posts: Record<string, string>[] = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://localhost');
    const body = Object.fromEntries(new URLSearchParams(raw || url.search));
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'rate') { res.writeHead(429, { 'Retry-After': '0.03' }); res.end('{}'); return; }
    if (['invalid_auth', 'token_revoked', 'not_authed'].includes(mode)) { res.end(JSON.stringify({ ok: false, error: mode })); return; }
    if (mode === 'leak') { res.end(JSON.stringify({ ok: false, error: 'synthetic-private-token' })); return; }
    if (url.pathname === '/api/auth.test') { res.end(JSON.stringify({ ok: true, user_id: 'PERSON' })); return; }
    if (url.pathname === '/api/chat.postMessage') {
      posts.push(body); polls = 0;
      res.end(JSON.stringify({ ok: true, ts: `${posts.length * 10}.000001` })); return;
    }
    polls++;
    const root = body.ts;
    const messages = mode === 'silent' ? [] : [
      { ts: '99.000001', thread_ts: 'wrong', user: 'DOT', text: 'wrong thread' },
      { ts: '98.000001', thread_ts: root, user: 'PERSON', text: 'self' },
      { ts: '1.000001', thread_ts: root, user: 'DOT', text: 'old reply' },
      { ts: `${posts.length * 10 + 1}.000001`, thread_ts: root, user: 'DOT', text: mode === 'quota' ? 'You have reached your weekly usage limit' : polls < 3 ? 'Working…' : 'Finished answer', edited: { ts: polls < 3 ? '1.0' : '2.0' } }
    ];
    res.end(JSON.stringify({ ok: true, messages }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(resolve as () => void); server.closeAllConnections(); }));
  const fetcher: typeof fetch = (url, init) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init);
  const driver = new Dots({ token: 'synthetic-private-token', channel: 'DM', mention: '<@DOT>', fetcher, poll: 10, settle: 40, timeout: 1000 });
  cleanup.push(() => driver.close());
  return { driver, posts, fetcher, get polls() { return polls; } };
}
it('omits unconfigured dots and prepends configured dots without changing exclusions', async () => {
  const baseline = configure({});
  expect(baseline.sources.map(s => s.id)).toEqual(['freellmapi', 'opencode', 'kilo']);
  expect(await new Dots().available()).toBe(false);
  expect(await (await createLocalApp(new Sources([new Dots()])).request('http://127.0.0.1:8788/v1/models')).json()).toMatchObject({ data: [{ id: 'milo' }] });
  expect(await new Dots({ token: 'synthetic' }).available()).toBe(false);
  expect(configure({ MILO_DOTS_SLACK_TOKEN: 'synthetic', MILO_DOTS_CHANNEL: 'DM' }).sources.map(s => s.id)).toEqual(['dots', 'freellmapi', 'opencode', 'kilo']);
  expect(configure({ MILO_DOTS_SLACK_TOKEN: 'synthetic', MILO_DOTS_CHANNEL: 'DM', MILO_SOURCES: 'kilo' }).sources.map(s => s.id)).toEqual(['kilo']);
});
it('returns the edited settled answer through the model API and keeps a follow-up in its thread', async () => {
  const fixture = await slack();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await fixture.driver.available()).toBe(true);
  const fallback = { id: 'fallback', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  const app = createLocalApp(new Sources([fixture.driver, fallback]));
  expect((await (await app.request('http://127.0.0.1:8788/v1/models')).json()).data.map((m: { id: string }) => m.id)).toContain('dots');
  const call = async (body: unknown) => (await (await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).choices[0].message.content;
  expect(await call({ ...request, model: 'dots' })).toBe('Finished answer');
  expect(fixture.polls).toBeGreaterThan(3);
  expect(await call({ ...request, messages: [...request.messages, { role: 'assistant', content: 'Finished answer' }, { role: 'user', content: 'Next question' }] })).toBe('Finished answer');
  expect(fixture.posts.map(p => p.thread_ts)).toEqual([undefined, '10.000001']);
  expect(fixture.posts.map(p => p.text)).toEqual([`<@DOT>\n${request.messages[0]!.content}\n\n${DOTS_INSTRUCTION}`, `<@DOT>\nNext question\n\n${DOTS_INSTRUCTION}`]);
  expect(fixture.posts.every(p => p.text!.includes('Do not start Codex or Work tasks.'))).toBe(true);
  expect(fallback.complete).not.toHaveBeenCalled();
  expect(log.mock.calls.map(call => call[0])).toEqual(['Milo source: dots answered model dots', 'Milo source: dots answered model milo']);
});
it.each([
  ['silent', 'timeout'], ['quota', 'quota'], ['invalid_auth', 'logged_out'], ['token_revoked', 'logged_out'], ['not_authed', 'logged_out'], ['rate', 'upstream'], ['leak', 'upstream']
])('maps %s safely and falls back for milo while dots stays exclusive', async (mode, code) => {
  const fixture = await slack(mode);
  const driver = new Dots({ token: 'synthetic-private-token', channel: 'DM', fetcher: fixture.fetcher, poll: 5, settle: 10, timeout: 120 });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  if (code === 'logged_out') expect(await driver.available()).toBe(false);
  const start = Date.now();
  let error: unknown;
  try { await driver.complete(request, new AbortController().signal); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain('synthetic-private-token');
  if (mode === 'rate') expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  const fallback = { id: 'fallback', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  const sources = new Sources([driver, fallback]);
  expect(await sources.complete(request, new AbortController().signal)).toEqual({ text: 'fallback' });
  await expect(sources.complete({ ...request, model: 'dots' }, new AbortController().signal)).rejects.toMatchObject({ code });
  expect(fallback.complete).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.map(call => call[0])).toEqual([`Milo source: dots failed (${code}) for model milo`, 'Milo source: fallback answered model milo', `Milo source: dots failed (${code}) for model dots`]);
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-token');
});
it('caller cancellation stops polling and does not invoke fallback', async () => {
  const fixture = await slack('silent');
  const fallback = { id: 'fallback', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  await expect(new Sources([fixture.driver, fallback]).complete(request, AbortSignal.timeout(40))).rejects.toThrow();
  expect(fallback.complete).not.toHaveBeenCalled();
});

it('redacts transport errors that contain the token', async () => {
  const driver = new Dots({ token: 'synthetic-private-token', channel: 'DM', fetcher: async () => { throw new Error('synthetic-private-token'); } });
  expect(await driver.available()).toBe(false);
  await expect(driver.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream', message: 'Dots Slack request failed' });
});
