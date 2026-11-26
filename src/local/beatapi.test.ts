import { claudeCodeRequest } from './fixtures/claude-code-tools.js';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BeatAPI, BEATAPI_GLM_MODEL, BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant, writeBeatAPIGrant } from './beatapi.js';
import type { BeatAPIGrant } from './beatapi.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';
import { SourceStatus } from './source-status.js';
import { SourceAvailability } from './source-availability.js';
import { DiagnosticsStore, withDiagnosticContext } from './diagnostics.js';
import { randomUUID } from 'node:crypto';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-beatapi-test-')); await recordDataSharingConsent(directory, ['beatapi']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });
const grant = (): Extract<BeatAPIGrant, { version: 1 }> => ({ version: 1, base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-private-grant', upstream_origin: BEATAPI_ORIGIN, model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, lifetime_paid: 0, payment_method_present: false, auto_recharge: false, credit_provenance: 'signup', baseline_balance: 2 });
const poolGrant = (): Extract<BeatAPIGrant, { version: 2 }> => ({ ...grant(), version: 2, models: BEATAPI_MODELS });
const request = () => ({ model: 'beatapi', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false, maxTokens: 99999 });
const usage = (balance = 2, settled = 0, extra = {}) => ({ data: { object: 'usage', credit_balance: balance, credits_settled: settled, ...extra } });
const completion = (extra = {}) => ({ model: BEATAPI_MODEL, choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 210081, completion_tokens: 12 }, ...extra });

it('bounds ordinary denied account checks and rediscovers restored access at the next eligible poll', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now(), restoredAt = start + 10_000;
  const fetcher = vi.fn(async () => Date.now() < restoredAt ? new Response(null, { status: 403 }) : Response.json(usage()));
  const beat = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  const store = await DiagnosticsStore.open({ directory: join(await realpath(directory), 'diagnostics'), runtimeVersion: '0.10.9' });
  const status = new SourceStatus([beat.id]), admission = new SourceAvailability(status);
  try {
    await withDiagnosticContext({ requestId: randomUUID(), kind: 'diagnostic', sink: store }, async () => {
      expect(await status.available(beat)).toBe(false);
      for (let second = 1; second < 30; second++) {
        vi.setSystemTime(start + second * 1000);
        expect(await status.available(beat)).toBe(false);
        expect(admission.start([beat])).toBe(0);
      }
      vi.setSystemTime(start + 30_000);
      expect(admission.start([beat])).toBe(1);
      await admission.changed(AbortSignal.timeout(1000));
      expect(admission.peek(beat.id)).toBe(true);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const events = (await store.list()).events;
    expect(events.filter(e => e.endpointLabel === 'account').map(e => e.httpStatus)).toEqual([403, 200]);
    expect(events.find(e => e.type === 'account.available')?.at).toBe(restoredAt + 20_000);
  } finally { await admission.close(); await beat.close(); await store.close(); }
});

function fixture(answer: unknown = completion(), balances = [usage(), usage()]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return new Response(JSON.stringify(String(url).endsWith('/usage') ? balances.shift() ?? usage() : answer), { status: 200 }); }) as unknown as typeof fetch;
  const source = new BeatAPI({ directory, loadGrant: async () => grant(), fetcher });
  return { source, fetcher, calls };
}
function rotatingFixture(respond: (model: string) => Response | Promise<Response> = model => Response.json(completion({ model })), timeout = 5000) {
  let now = 0;
  const dispatched: string[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/usage')) return Response.json(usage());
    const { model } = JSON.parse(String(init?.body));
    dispatched.push(model);
    return respond(model);
  });
  const source = new BeatAPI({ directory, fetcher, now: () => now, timeout });
  return { source, dispatched, advance: (ms: number) => { now += ms; } };
}
it('routes only the explicit free model through Grunt with provider-default output without spending signup credit', async () => {
  const f = fixture(); const app = createLocalApp(new Sources([f.source]));
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
  expect(response.status).toBe(200); expect((await response.json()).usage.prompt_tokens).toBe(210081);
  const post = f.calls.find(c => c.init?.method === 'POST')!; expect(JSON.parse(String(post.init!.body))).toMatchObject({ model: BEATAPI_MODEL, stream: false });
  expect(JSON.parse(String(post.init!.body))).not.toHaveProperty('max_tokens');
  expect(f.calls.map(c => c.url.split('/').at(-1))).toEqual(['usage', 'completions', 'usage']);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 60 }); expect(f.calls).toHaveLength(3);
});
it('rotates the two vetted free models through Grunt only after one shared cooldown', async () => {
  const saved = poolGrant();
  await writeBeatAPIGrant(saved, directory);
  expect(await readBeatAPIGrant(directory)).toEqual(saved);
  const f = rotatingFixture();
  const app = createLocalApp(new Sources([f.source]));
  const chat = () => app.request('http://localhost:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request())
  });
  for (const model of [BEATAPI_MODEL, BEATAPI_GLM_MODEL, BEATAPI_MODEL]) {
    const response = await chat();
    expect(response.status).toBe(200);
    expect((await response.json()).usage.prompt_tokens).toBe(210081);
    expect(f.dispatched.at(-1)).toBe(model);
    await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 60 });
    f.advance(60_000);
  }
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_GLM_MODEL, BEATAPI_MODEL]);
});
it('keeps an existing receipt pinned to DeepSeek after each successful request', async () => {
  await writeBeatAPIGrant(grant(), directory);
  const f = rotatingFixture();
  const signal = new AbortController().signal;
  await f.source.complete(request(), signal);
  f.advance(60_000);
  await f.source.complete(request(), signal);
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_MODEL]);
});
it('rejects unordered, duplicate, missing, and unverified models in a pool receipt', async () => {
  for (const models of [[BEATAPI_GLM_MODEL, BEATAPI_MODEL], [BEATAPI_MODEL, BEATAPI_MODEL], [BEATAPI_MODEL], [BEATAPI_MODEL, 'glm-5.3-flash'], [...BEATAPI_MODELS, 'hy4-flash-free']]) {
    await expect(writeBeatAPIGrant({ ...poolGrant(), models } as unknown as BeatAPIGrant, directory)).rejects.toMatchObject({ code: 'logged_out' });
  }
});
it('respects a shared GLM quota response without retrying or advancing the model', async () => {
  await writeBeatAPIGrant(poolGrant(), directory);
  const f = rotatingFixture(model => model === BEATAPI_GLM_MODEL
    ? new Response(null, { status: 429, headers: { 'Retry-After': '91' } }) : Response.json(completion({ model })));
  const signal = new AbortController().signal;
  await f.source.complete(request(), signal);
  f.advance(60_000);
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 91 });
  f.advance(90_000);
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 1 });
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_GLM_MODEL]);
  f.advance(1_000);
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 91 });
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_GLM_MODEL, BEATAPI_GLM_MODEL]);
});
it.each(
  [404, 410].flatMap(status => BEATAPI_MODELS.map(model => ({ status, model })))
)('switches on a later request when $model returned HTTP $status', async ({ status, model }) => {
  await writeBeatAPIGrant(poolGrant(), directory);
  const f = rotatingFixture(selectedModel => selectedModel === model
    ? new Response(null, { status }) : Response.json(completion({ model: selectedModel })));
  const signal = new AbortController().signal;
  const otherModel = model === BEATAPI_MODEL ? BEATAPI_GLM_MODEL : BEATAPI_MODEL;
  const dispatched = [];
  if (model === BEATAPI_GLM_MODEL) {
    await f.source.complete(request(), signal);
    dispatched.push(otherModel);
    f.advance(60_000);
  }
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'upstream', diagnostics: { httpStatus: status } });
  dispatched.push(model);
  expect(f.dispatched).toEqual(dispatched);
  await f.source.complete(request(), signal);
  expect(f.dispatched).toEqual([...dispatched, otherModel]);
});
it('does not advance the model when a legacy receipt receives HTTP 404', async () => {
  await writeBeatAPIGrant(grant(), directory);
  const f = rotatingFixture(() => new Response(null, { status: 404 }));
  const signal = new AbortController().signal;
  for (const attempt of [1, 2]) {
    await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'upstream', diagnostics: { httpStatus: 404 } });
    expect(f.dispatched).toHaveLength(attempt);
  }
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_MODEL]);
});
it('rejects the other approved alias as a response to the selected model', async () => {
  await writeBeatAPIGrant(poolGrant(), directory);
  const f = rotatingFixture(() => Response.json(completion()));
  const signal = new AbortController().signal;
  await f.source.complete(request(), signal);
  f.advance(60_000);
  await expect(f.source.complete(request(), signal)).rejects.toThrow('BeatAPI returned an unverified free model identity');
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_GLM_MODEL]);
});
it.each([
  { label: 'a stalled transport', code: 'timeout', respond: () => new Promise<Response>(() => {}) },
  { label: 'an upstream gateway timeout', code: 'upstream', respond: () => new Response(null, { status: 504 }) }
])('preserves the shared cooldown after $label without advancing the model', async ({ code, respond }) => {
  await writeBeatAPIGrant(poolGrant(), directory);
  const f = rotatingFixture(respond, 200);
  const signal = new AbortController().signal;
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code });
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 60 });
  expect(f.dispatched).toEqual([BEATAPI_MODEL]);
  f.advance(60_000);
  await expect(f.source.complete(request(), signal)).rejects.toMatchObject({ code });
  expect(f.dispatched).toEqual([BEATAPI_MODEL, BEATAPI_MODEL]);
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
  expect(await new Sources([source, next]).complete({ ...request(), model: 'grunt' }, new AbortController().signal)).toEqual({ text: 'fallback' }); expect(fetcher).toHaveBeenCalledTimes(2);
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
  for (const bad of ['https://attacker.invalid/v1', 'https://api.beatapi.io/v1', 'https://api.beatapi.io:8443', 'https://api.beatapi.io.evil.test', 'http://api.beatapi.io', 'https://user:pass@api.beatapi.io', 'https://api.beatapi.io?k=1', 'https://api.beatapi.io#frag']) {
    await expect(writeBeatAPIGrant({ ...grant(), base_url: bad }, directory)).rejects.toMatchObject({ code: 'logged_out' });
  }
});

it('accepts direct verified HTTPS origin api.beatapi.io alongside legacy Squire egress grants', async () => {
  const direct: BeatAPIGrant = { ...poolGrant(), base_url: BEATAPI_ORIGIN, token: 'synthetic-direct-beatapi-key' };
  await writeBeatAPIGrant(direct, directory);
  expect(await readBeatAPIGrant(directory)).toEqual(direct);
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    calls.push(String(url));
    expect(String(url).startsWith(BEATAPI_ORIGIN)).toBe(true);
    expect(String(url)).not.toContain('trusty-squire-api.fly.dev');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-direct-beatapi-key');
    return Response.json(String(url).endsWith('/usage') ? usage() : completion());
  });
  const source = new BeatAPI({ directory, fetcher });
  try {
    const reply = await source.complete(request(), AbortSignal.timeout(1000));
    expect(reply.text).toBe('hello');
    expect(calls).toEqual([
      `${BEATAPI_ORIGIN}/v1/usage`,
      `${BEATAPI_ORIGIN}/v1/chat/completions`,
      `${BEATAPI_ORIGIN}/v1/usage`
    ]);
  } finally { await source.close(); }
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
it('accepts every tool of a recorded Claude Code request', async () => {
  for (const index of [0, 1, 2] as const) {
    const f = fixture(completion({ choices: [{ message: { content: 'Done' } }] }));
    await expect(f.source.complete(claudeCodeRequest(index, 'beatapi'), new AbortController().signal)).resolves.toMatchObject({ text: 'Done' });
    expect(f.calls.some(call => call.url.endsWith('/chat/completions') && JSON.parse(String(call.init?.body)).tools.length === claudeCodeRequest(0).tools.length)).toBe(true);
  }
});
