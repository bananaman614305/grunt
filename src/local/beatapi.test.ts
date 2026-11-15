import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BeatAPI, BEATAPI_MODEL, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant, writeBeatAPIGrant } from './beatapi.js';
import type { BeatAPIGrant } from './beatapi.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-beatapi-test-')); await recordDataSharingConsent(directory, ['beatapi']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });
const grant = (): BeatAPIGrant => ({ version: 1, base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-private-grant', upstream_origin: BEATAPI_ORIGIN, model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, lifetime_paid: 0, payment_method_present: false, auto_recharge: false, credit_provenance: 'signup', baseline_balance: 2 });
const request = () => ({ model: 'beatapi', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false, maxTokens: 99999 });
const usage = (balance = 2, settled = 0, extra = {}) => ({ data: { object: 'usage', credit_balance: balance, credits_settled: settled, ...extra } });
const completion = (extra = {}) => ({ model: BEATAPI_MODEL, choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 210081, completion_tokens: 12 }, ...extra });
function fixture(answer: unknown = completion(), balances = [usage(), usage()]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return new Response(JSON.stringify(String(url).endsWith('/usage') ? balances.shift() ?? usage() : answer), { status: 200 }); }) as unknown as typeof fetch;
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  return { source, fetcher, calls };
}
it('routes only the explicit free model through Grunt and caps output without spending signup credit', async () => {
  const f = fixture(); const app = createLocalApp(new Sources([f.source]));
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
  expect(response.status).toBe(200); expect((await response.json()).usage.prompt_tokens).toBe(210081);
  const post = f.calls.find(c => c.init?.method === 'POST')!; expect(JSON.parse(String(post.init!.body))).toMatchObject({ model: BEATAPI_MODEL, max_tokens: 4096, stream: false });
  expect(f.calls.map(c => c.url.split('/').at(-1))).toEqual(['usage', 'completions', 'usage']);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 60 }); expect(f.calls).toHaveLength(3);
});
it('availability performs nonbillable checks only and zero balance is supported', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(usage(0))));
  const source = new BeatAPI({ directory, loadGrant: async () => ({ ...grant(), baseline_balance: 0, credit_provenance: 'zero' }), fetcher });
  expect(await source.available()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0]?.[0] ?? '')).not.toContain('completions');
});
it.each([{ settled: 1 }, { balance: 3 }, { extra: { lifetime_paid: 10 } }, { extra: { payment_method_present: true } }, { extra: { auto_recharge: true } }])('rejects paid or billed account metadata %j before inference', async ({ balance, settled, extra }) => {
  const f = fixture(completion(), [usage(balance ?? 2, settled ?? 0, extra)]);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).toHaveLength(1);
});
it('rejects a change in balance after inference', async () => {
  const f = fixture(completion(), [usage(), usage(1.99)]); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
});
it.each(['deepseek-v4.1-flash', 'deepseek-flash', 'glm-5.3-flash-free'])('rejects an unverified response model %s', async model => {
  const f = fixture(completion({ model })); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
});
it('returns rate failures immediately, honors cooldown, and allows router fallback', async () => {
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/usage') ? new Response(JSON.stringify(usage())) : new Response('upstream-secret-never-echo', { status: 429, headers: { 'Retry-After': '91' } }));
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  await expect(source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 91 });
  const next = { id: 'next', available: async () => true, complete: vi.fn(async () => ({ text: 'fallback' })) };
  expect(await new Sources([source, next]).complete({ ...request(), model: 'milo' }, new AbortController().signal)).toEqual({ text: 'fallback' }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('preserves native function IDs and validates returned JSON against tool schemas', async () => {
  const tool = { type: 'function', function: { name: 'nonce', parameters: { type: 'object', properties: { nonce: { type: 'string', const: 'synthetic' } }, required: ['nonce'], additionalProperties: false } } };
  const call = { id: 'native_call', type: 'function', function: { name: 'nonce', arguments: '{"nonce":"synthetic"}' } };
  const f = fixture(completion({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
  expect((await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).calls).toEqual([call]);
  const invalid = fixture(completion({ choices: [{ message: { content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: '{"nonce":"wrong"}' } }] } }] }));
  await expect(invalid.source.complete({ ...request(), tools: [tool] }, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
});
it('rejects uncorrelated tool results before network calls', async () => {
  const f = fixture(); await expect(f.source.complete({ ...request(), messages: [{ role: 'tool', content: 'fake', tool_call_id: 'invented' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).toHaveLength(0);
});
it('requires current consent before metadata or inference', async () => {
  await rm(join(directory, 'data-sharing-consent.json')); const f = fixture(); expect(await f.source.available()).toBe(false); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).toHaveLength(0);
});
it('cancels stalled body reads and sanitizes upstream failures', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  const pending = source.complete(request(), controller.signal); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); controller.abort(); await expect(pending).rejects.toBeDefined(); await source.close();
  const broken = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher: async () => { throw new Error('sk-secret private payload'); } });
  await expect(broken.complete(request(), new AbortController().signal)).rejects.toThrow('BeatAPI account check failed');
});
it('enforces shutdown and request timeouts during metadata fetch', async () => {
  const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  const pending = source.complete(request(), new AbortController().signal); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); await source.close(); await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  const timed = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher, timeout: 5 }); await expect(timed.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
});
it('bounds upstream response size', async () => {
  const fetcher = vi.fn(async () => new Response('sk-secret', { headers: { 'Content-Length': '999999999' } }));
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher }); await expect(source.complete(request(), new AbortController().signal)).rejects.toThrow('supported size');
});
it('writes private receipts and rejects links, modes, stale billing and arbitrary grant hosts', async () => {
  const saved = grant(); await writeBeatAPIGrant(saved, directory); expect(await readBeatAPIGrant(directory)).toEqual(saved); expect((await readFile(beatapiGrantPath(directory), 'utf8'))).toContain('synthetic-private-grant');
  await chmod(beatapiGrantPath(directory), 0o644); await expect(readBeatAPIGrant(directory)).rejects.toMatchObject({ code: 'logged_out' });
  await rm(beatapiGrantPath(directory)); await symlink(join(directory, 'data-sharing-consent.json'), beatapiGrantPath(directory)); await expect(readBeatAPIGrant(directory)).rejects.toMatchObject({ code: 'logged_out' });
  await expect(writeBeatAPIGrant({ ...grant(), lifetime_paid: 5 } as unknown as BeatAPIGrant, directory)).rejects.toMatchObject({ code: 'logged_out' });
  await expect(writeBeatAPIGrant({ ...grant(), base_url: 'https://attacker.invalid/v1' }, directory)).rejects.toMatchObject({ code: 'logged_out' });
});

it('forwards a matching native tool result unchanged and rejects reused response IDs', async () => {
  const history = { id: 'old_call', type: 'function', function: { name: 'nonce', arguments: '{"nonce":"synthetic"}' } };
  const messages = [{ role: 'user', content: 'get nonce' }, { role: 'assistant', content: '', tool_calls: [history] }, { role: 'tool', content: '{"result":"synthetic"}', tool_call_id: 'old_call' }];
  const f = fixture(); await f.source.complete({ ...request(), messages }, new AbortController().signal);
  expect(JSON.parse(String(f.calls.find(c => c.init?.method === 'POST')!.init!.body)).messages).toEqual(messages);
  const repeated = fixture(completion({ choices: [{ message: { content: null, tool_calls: [history] } }] }));
  await expect(repeated.source.complete({ ...request(), messages, tools: [{ type: 'function', function: { name: 'nonce', parameters: { type: 'object' } } }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
});
it('sanitizes cancellation reasons and times out a stalled inference fetch', async () => {
  const cancelled = new AbortController(); cancelled.abort('sk-cancel-secret'); const f = fixture();
  await expect(f.source.complete(request(), cancelled.signal)).rejects.toThrow('BeatAPI request cancelled'); expect(f.calls).toHaveLength(0);
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/usage') ? new Response(JSON.stringify(usage())) : new Promise<Response>(() => {}));
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher, timeout: 20 });
  await expect(source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
});
it('rejects expired account verification before inference', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(usage())));
  const source = new BeatAPI({ directory, fetcher, loadGrant: async () => ({ ...grant(), verified_at: '2020-01-01T00:00:00.000Z' }) });
  await expect(source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'logged_out' }); expect(fetcher).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('rejects FIFO grants promptly so availability, cancellation and shutdown cannot block', async () => {
  execFileSync('mkfifo', ['-m', '600', beatapiGrantPath(directory)]);
  await expect(readBeatAPIGrant(directory)).rejects.toMatchObject({ code: 'logged_out' });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(usage()))), source = new BeatAPI({ directory, fetcher });
  expect(await source.available()).toBe(false);
  const controller = new AbortController(), pending = source.complete(request(), controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'cancelled' }); controller.abort('synthetic cancellation');
  await cancelled; await source.close(); expect(fetcher).not.toHaveBeenCalled();
}, 1000);
it('roundtrips parallel Responses function calls as one native assistant turn with both correlated outputs', async () => {
  const f = fixture(), app = createLocalApp(new Sources([f.source]));
  const input = [{ role: 'user', content: 'read two files' }, ...['a', 'b'].map(id => ({ type: 'function_call', call_id: id, name: 'read', arguments: JSON.stringify({ path: id }) })),
    ...['a', 'b'].map(id => ({ type: 'function_call_output', call_id: id, output: `result-${id}` }))];
  const response = await app.request('http://localhost:8788/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'beatapi', input, tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }) });
  expect(response.status).toBe(200); expect((await response.json()).output[0].content[0].text).toBe('hello');
  const posts = f.calls.filter(c => c.init?.method === 'POST'); expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]!.init!.body)).messages).toEqual([{ role: 'user', content: 'read two files' },
    { role: 'assistant', content: '', tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: id }) } })) },
    ...['a', 'b'].map(id => ({ role: 'tool', content: `result-${id}`, tool_call_id: id }))]);
});
it('rejects duplicate parallel call IDs and incomplete or duplicated results before network access', async () => {
  const call = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] });
  const result = (id: string) => ({ role: 'tool', content: 'result', tool_call_id: id });
  for (const messages of [[call('a'), call('a'), result('a')], [call('a'), call('b'), result('a')], [call('a'), call('b'), result('a'), result('a'), result('b')]]) {
    const f = fixture(); await expect(f.source.complete({ ...request(), messages }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).toHaveLength(0);
  }
});
