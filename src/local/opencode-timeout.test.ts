import { idleEvents } from './fixtures/opencode-events.js';
import { expect, it, vi } from 'vitest';
import { OpenCode } from './opencode.js';
import { Sources, replayTimeout, SourceError } from './source.js';
import { createLocalApp } from './api.js';

const request = { model: 'grunt', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };

it('falls through a confirmed pre-dispatch deadline regardless of provider name (LIV-1)', async () => {
  const next = vi.fn(async () => ({ text: 'fallback answer' }));
  const sources = new Sources([
    { id: 'primary', available: async () => true, complete: async () => { throw replayTimeout('deadline', true); } },
    { id: 'next', available: async () => true, complete: next }
  ]);
  await expect(sources.complete(request, new AbortController().signal)).resolves.toEqual({ text: 'fallback answer' });
});

it('an unclassified timeout remains terminal (LIV-1)', async () => {
  const backup = vi.fn(async () => ({ text: 'fallback answer' }));
  const sources = new Sources([
    { id: 'opencode', available: async () => true, complete: async () => { throw new SourceError('timeout', 'unknown phase'); } },
    { id: 'backup', available: async () => true, complete: backup }
  ]);
  await expect(sources.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
  expect(backup).not.toHaveBeenCalled();
});

it.each(['pre-dispatch', 'post-dispatch', 'caller', 'shutdown'] as const)('handles OpenCode %s without confusing cancellation and fallback', async mode => {
  const controller = new AbortController();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const next = vi.fn(async () => ({ text: 'fallback answer' }));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/event') && mode !== 'pre-dispatch') return idleEvents();
    if (String(url).endsWith(mode === 'pre-dispatch' ? '/event' : '/message')) {
      started();
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    }
    return Response.json({ id: 'session_one' });
  });
  const deadline = mode === 'pre-dispatch' || mode === 'post-dispatch';
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher, ...(deadline ? { timeout: 200 } : {}) });
  const sources = new Sources([driver, { id: 'next', available: async () => true, complete: next }]);
  try {
    const app = createLocalApp(sources);
    const pending = deadline
      ? app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      : sources.complete(request, controller.signal);
    const outcome = Promise.resolve(pending).then(value => ({ value }), error => ({ error }));
    await ready;
    if (mode === 'caller') controller.abort();
    if (mode === 'shutdown') await driver.close();
    const result = await outcome;
    if (deadline) {
      expect('value' in result).toBe(true);
      const response = (result as { value: Response }).value;
      if (mode === 'pre-dispatch') {
        expect(response.status).toBe(200);
        expect((await response.json()).choices[0].message.content).toBe('fallback answer');
        expect(next).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/message'))).toBe(false);
      } else {
        expect(response.status).toBe(504);
        expect((await response.json()).error.code).toBe('timeout');
        expect(next).not.toHaveBeenCalled();
      }
    } else {
      expect('error' in result).toBe(true);
      expect(next).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('grunt source: opencode cancelled for model grunt');
      expect(log.mock.calls.flat().join('\n')).not.toContain('failed (timeout)');
      expect(timeout).not.toHaveBeenCalledWith(90000);
    }
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/session/session_one/abort'))).toBe(true);
  } finally { await driver.close(); log.mockRestore(); timeout.mockRestore(); }
});
