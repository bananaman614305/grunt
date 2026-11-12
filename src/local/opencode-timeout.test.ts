import { expect, it, vi } from 'vitest';
import { OpenCode } from './opencode.js';
import { Sources, SourceError } from './source.js';
import { createLocalApp } from './api.js';

const request = { model: 'milo', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };

it('falls through a fake OpenCode timeout to the next source', async () => {
  const next = vi.fn(async () => ({ text: 'fallback answer' }));
  const sources = new Sources([
    { id: 'opencode', available: async () => true, complete: async () => { throw new SourceError('timeout', 'deadline'); } },
    { id: 'next', available: async () => true, complete: next }
  ]);
  await expect(sources.complete(request, new AbortController().signal)).resolves.toEqual({ text: 'fallback answer' });
});

it.each(['deadline', 'caller', 'shutdown'] as const)('handles OpenCode %s without confusing cancellation and fallback', async mode => {
  const controller = new AbortController();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const next = vi.fn(async () => ({ text: 'fallback answer' }));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/message')) {
      started();
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    }
    return Response.json({ id: 'session_one' });
  });
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher, ...(mode === 'deadline' ? { timeout: 20 } : {}) });
  const sources = new Sources([driver, { id: 'next', available: async () => true, complete: next }]);
  try {
    const app = createLocalApp(sources);
    const pending = mode === 'deadline'
      ? app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      : sources.complete(request, controller.signal);
    const outcome = Promise.resolve(pending).then(value => ({ value }), error => ({ error }));
    await ready;
    if (mode === 'caller') controller.abort();
    if (mode === 'shutdown') await driver.close();
    const result = await outcome;
    if (mode === 'deadline') {
      expect('value' in result).toBe(true);
      const response = (result as { value: Response }).value;
      expect(response.status).toBe(200);
      expect((await response.json()).choices[0].message.content).toBe('fallback answer');
      expect(next).toHaveBeenCalledOnce();
    } else {
      expect('error' in result).toBe(true);
      expect(next).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('grunt source: opencode cancelled for model milo');
      expect(log.mock.calls.flat().join('\n')).not.toContain('failed (timeout)');
      expect(timeout).toHaveBeenCalledWith(90000);
    }
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/session/session_one/abort'))).toBe(true);
  } finally { await driver.close(); log.mockRestore(); timeout.mockRestore(); }
});
