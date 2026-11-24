import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import { FreeApi, FREE_API_PROVIDERS, isDeepSeekV41Model, readFreeApiGrant } from './free-api.js';
import type { FreeApiProvider } from './free-api.js';
import { Zro, ZRO_DEEPSEEK } from './zro.js';

const locations: string[] = [];
const grant = { base_url: 'https://grant.test/egress/provider', token: 'synthetic-private-grant' };
const request = { model: 'zro', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false };
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-free-api-')); locations.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(locations.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(Object.keys(FREE_API_PROVIDERS) as FreeApiProvider[])('pins %s to its exact provider model and endpoint through Grunt', async provider => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: FREE_API_PROVIDERS[provider].model,
    choices: [{ message: { content: 'Hello from the selected provider', tool_calls: [] } }], usage: { prompt_tokens: 210050, completion_tokens: 8 } }));
  const source = new FreeApi(provider, { loadGrant: async () => grant, fetcher });
  const response = await createLocalApp(new Sources([source])).request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider, messages: request.messages, max_tokens: 90000,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] })
  });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe(provider);
  expect((await response.json()).usage.prompt_tokens).toBe(210050);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe(`${grant.base_url}${FREE_API_PROVIDERS[provider].prefix}/chat/completions`);
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: FREE_API_PROVIDERS[provider].model, max_tokens: provider === 'zro' ? 90000 : 4096, stream: false,
    tools: [{ type: 'function', function: { name: 'read' } }] });
  await source.close();
});

it.each([null, ''])('surfaces Zro reasoning-only truncation to Pi when content is %j', async content => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: ZRO_DEEPSEEK,
    choices: [{ finish_reason: 'length', message: { content, reasoning_content: 'Synthetic hidden reasoning' } }],
    usage: { prompt_tokens: 20, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } }));
  const source = new Zro({ loadGrant: async () => ({ ...grant, free_account_verified: true, verified_at: '2026-11-24T00:00:00Z' }), fetcher });
  const app = createLocalApp(new Sources([source]));
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: request.messages, max_tokens: 65536, stream: true, stream_options: { include_usage: true } })
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-grunt-source')).toBe('zro');
  const wire = await response.text();
  const frames = wire.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  expect(frames.at(-1)).toBe('[DONE]');
  expect(JSON.parse(frames.at(-3)!)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'length' }] });
  expect(JSON.parse(frames.at(-2)!)).toMatchObject({ usage: { completion_tokens: 4096 } });
  expect(wire).not.toContain('Synthetic hidden reasoning');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).max_tokens).toBe(65536);
  await source.close();
});

it('lets Zro choose its output budget when the caller supplies none', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }] }));
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher });
  await expect(source.complete(request, AbortSignal.timeout(1000))).resolves.toMatchObject({ text: 'Hello', finishReason: 'stop' });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).not.toHaveProperty('max_tokens');
});

it('rejects unknown providers and arbitrary model requests before any HTTP call', async () => {
  expect(() => new FreeApi('../private' as FreeApiProvider)).toThrow('Unsupported free API provider');
  const fetcher = vi.fn<typeof fetch>();
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher });
  await expect(source.complete({ ...request, model: 'paid-model' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  await expect(source.complete({ ...request, tools: [{ type: 'web_search' }] }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([[401, 'logged_out'], [402, 'quota'], [403, 'refused'], [429, 'quota'], [503, 'upstream']] as const)('does not retry or fall back after HTTP %s', async (status, code) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('secret upstream payload', { status, headers: { 'Retry-After': '23' } }));
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher });
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code, retryAfter: 23, message: `zro returned HTTP ${status}` });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('reads only an owned private regular grant file and refuses symlinks or broad permissions', async () => {
  const location = await directory(), path = join(location, 'zro.json');
  await writeFile(path, JSON.stringify(grant), { mode: 0o600 });
  expect(await readFreeApiGrant('zro', location)).toEqual(grant);
  const source = new FreeApi('zro', { directory: location });
  expect(await source.available()).toBe(true);
  await chmod(path, 0o644);
  await expect(readFreeApiGrant('zro', location)).rejects.toThrow('Unsafe');
  expect(await source.available()).toBe(false);
  await rm(path);
  const actual = join(location, 'actual.json'); await writeFile(actual, JSON.stringify(grant), { mode: 0o600 });
  await symlink(actual, path);
  await expect(readFreeApiGrant('zro', location)).rejects.toThrow();
});

it.each(['http://grant.test', 'https://user:pass@grant.test', 'https://grant.test/?token=secret', 'https://grant.test/#secret', 'not-a-url'])('does not call unsafe grant endpoint %s', async base_url => {
  const fetcher = vi.fn<typeof fetch>(), source = new FreeApi('zro', { loadGrant: async () => ({ ...grant, base_url }), fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out', message: 'zro access is not configured' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves caller cancellation and never sends an already cancelled request', async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn<typeof fetch>(), source = new FreeApi('zro', { loadGrant: async () => grant, fetcher });
  await expect(source.complete(request, controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('distinguishes timeout and shutdown from generic transport failure without leaking errors', async () => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(new Error('secret transport details'));
    else init?.signal?.addEventListener('abort', () => reject(new Error('secret transport details')), { once: true });
  }));
  const timed = new FreeApi('zro', { loadGrant: async () => grant, fetcher, timeout: 10 });
  await expect(timed.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout', message: 'zro endpoint is unavailable' });
  const closed = new FreeApi('zro', { loadGrant: async () => grant, fetcher }); await closed.close();
  await expect(closed.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'cancelled', message: 'Free API probe closed' });
});

it.each(['timeout', 'shutdown', 'caller'] as const)('preserves %s cancellation after headers while reading the response body', async phase => {
  let started!: () => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
    },
    pull() { started(); return new Promise<void>(() => {}); }
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } }));
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher, timeout: phase === 'timeout' ? 25 : 1000 });
  const caller = new AbortController(), pending = source.complete(request, caller.signal);
  await bodyStarted;
  if (phase === 'shutdown') await source.close();
  if (phase === 'caller') caller.abort(new Error('caller cancellation fixture'));
  if (phase === 'caller') await expect(pending).rejects.toThrow('caller cancellation fixture');
  else await expect(pending).rejects.toMatchObject({ code: phase === 'timeout' ? 'timeout' : 'cancelled',
    message: phase === 'timeout' ? 'zro endpoint is unavailable' : 'Free API probe closed' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'deepseek/deepseek-v4.1-flash',
  'deepseek-ai/DeepSeek-V4.1-Flash', 'free/deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-free',
  'deepseek-v4.1-flash:free', 'deepseek-flash'])('recognizes documented V4.1 identity %s', model => {
  expect(isDeepSeekV41Model(model)).toBe(true);
});

it.each([undefined, null, '', 'deepseek-v4-flash', 'deepseek-v3.2', 'unrelated-model',
  'deepseek-ai/DeepSeek-V4-Flash', 'free/deepseek-v3.2',
  'deepseek-v4.1-flash-custom', 'other/deepseek-v4.1-flash', { model: 'deepseek-v4.1-flash' }])('does not verify missing or different model identity %s', model => {
  expect(isDeepSeekV41Model(model)).toBe(false);
});

it.each([{ choices: [] }, { choices: [{ message: { content: null, tool_calls: [] } }] }, { choices: [{ message: { content: 'hello', tool_calls: [{ type: 'other' }] } }] }])('rejects malformed provider completions', async body => {
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher: async () => Response.json(body) });
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream', message: 'zro returned an invalid completion' });
});

it('preserves function calls and refuses explicit provider refusals', async () => {
  const call = { id: 'call-test', type: 'function', function: { name: 'read', arguments: '{}' } };
  const source = new FreeApi('zro', { loadGrant: async () => grant, fetcher: async () => Response.json({ choices: [{ message: { content: null, tool_calls: [call] } }] }) });
  expect(await source.complete(request, AbortSignal.timeout(1000))).toMatchObject({ text: '', calls: [call] });
  const refusal = new FreeApi('zro', { loadGrant: async () => grant, fetcher: async () => Response.json({ choices: [{ message: { refusal: 'private provider reason' } }] }) });
  await expect(refusal.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused', message: 'zro refused the request' });
});
