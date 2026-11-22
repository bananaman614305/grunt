import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeatAPI, BEATAPI_MODEL, BEATAPI_ORIGIN } from './beatapi.js';
import type { BeatAPIGrant } from './beatapi.js';
import { Darus, DARUS_HOST, DARUS_MODEL } from './darus.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { measureMetadata } from '../../scripts/metadata-benchmark.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-metadata-efficiency-'));
  await recordDataSharingConsent(directory, ['beatapi', 'darus']);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const beatGrant = (): BeatAPIGrant => ({ version: 1, base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-private-grant', upstream_origin: BEATAPI_ORIGIN,
  model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, lifetime_paid: 0, payment_method_present: false,
  auto_recharge: false, credit_provenance: 'signup', baseline_balance: 2 });
const darusGrant = () => ({ base_url: `https://${DARUS_HOST}`, token: 'synthetic-private-grant' });
const request = (model: string) => ({ model, messages: [{ role: 'user', content: 'Synthetic fixture' }], tools: [], cwd: directory, stream: false });
function reply(url: string, balance = 2) {
  if (url.endsWith('/usage')) return Response.json({ data: { object: 'usage', credit_balance: balance, credits_settled: 0 } });
  if (url.endsWith('/models')) return Response.json({ data: [{ id: DARUS_MODEL, free: true, owned_by: 'Darus Gateway' }] });
  if (url.endsWith('/tpd')) return Response.json({ status: { eligible: true, protectBalance: true, day: new Date().toISOString().slice(0, 10),
    allowance: 10000000, used: 0, remaining: 10000000, balance: 0, multiplier: 1, tier: { key: 'FREE', tpd: 10000000, minBalance: 0 } } });
  const model = url.includes(DARUS_HOST) ? DARUS_MODEL : BEATAPI_MODEL;
  return Response.json({ model, choices: [{ message: { content: 'verified fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
}
function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
function fixture(kind: 'beatapi' | 'darus', custom?: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => custom ? custom(String(url), init) : reply(String(url)));
  const source = kind === 'beatapi' ? new BeatAPI({ directory, fetcher, loadGrant: async () => beatGrant() })
    : new Darus({ directory, fetcher, loadGrant: async () => darusGrant() });
  return { source, fetcher };
}

it.each(['beatapi', 'darus'] as const)('coalesces only overlapping %s access checks and rereads later', async kind => {
  const held = gate(), f = fixture(kind, async url => { await held.pending; return reply(url); });
  const work = Array.from({ length: 8 }, () => f.source.available());
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  held.release(); expect(await Promise.all(work)).toEqual(Array(8).fill(true));
  expect(f.fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 1 : 2);
  expect(await f.source.available()).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 2 : 4);
  await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('does not let one cancelled %s waiter cancel another', async kind => {
  const held = gate(), caller = new AbortController(); let underlying: AbortSignal | undefined;
  const f = fixture(kind, async (url, init) => { underlying = init?.signal ?? undefined; await held.pending; return reply(url); });
  const first = f.source.available(caller.signal), second = f.source.available();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); caller.abort();
  expect(await first).toBe(false); expect(underlying?.aborted).toBe(false);
  held.release(); expect(await second).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 1 : 2);
  await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('aborts %s underlying metadata when all waiters cancel', async kind => {
  let underlying: AbortSignal | undefined;
  const f = fixture(kind, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    underlying = init?.signal ?? undefined;
    underlying?.addEventListener('abort', () => reject(underlying?.reason), { once: true });
  }));
  const first = new AbortController(), second = new AbortController();
  const work = [f.source.available(first.signal), f.source.available(second.signal)];
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); first.abort(); second.abort();
  expect(await Promise.all(work)).toEqual([false, false]); expect(underlying?.aborted).toBe(true);
  await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('does not cache malformed %s evidence', async kind => {
  let malformed = true;
  const f = fixture(kind, async url => malformed ? new Response('invalid-json') : reply(url));
  expect(await f.source.available()).toBe(false); malformed = false;
  expect(await f.source.available()).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 2 : 3);
  await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('separates overlapping %s checks after credential rotation', async kind => {
  let token = 'first-key'; const held = gate();
  const fetcher = vi.fn<typeof fetch>(async url => { await held.pending; return reply(String(url)); });
  const source = kind === 'beatapi' ? new BeatAPI({ directory, fetcher, loadGrant: async () => ({ ...beatGrant(), token }) })
    : new Darus({ directory, fetcher, loadGrant: async () => ({ ...darusGrant(), token }) });
  const first = source.available(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); token = 'second-key';
  const second = source.available(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  held.release(); expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 2 : 4); await source.close();
});

it('shares BeatAPI availability with dispatch preflight but freshly checks the balance after inference', async () => {
  const held = gate(); let reads = 0;
  const f = fixture('beatapi', async url => {
    if (url.endsWith('/usage') && ++reads === 1) await held.pending;
    return reply(url, reads > 1 ? 1.99 : 2);
  });
  const available = f.source.available(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  const complete = f.source.complete(request('beatapi'), new AbortController().signal);
  const rejected = expect(complete).rejects.toMatchObject({ code: 'refused' });
  // Both callers must join before resolving the shared metadata read.
  await new Promise(resolve => setTimeout(resolve, 20)); held.release();
  expect(await available).toBe(true); await rejected;
  expect(f.fetcher.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['usage', 'completions', 'usage']);
  await f.source.close();
});

it('retains Darus protected-balance and exact-offer validation for shared checks', async () => {
  const held = gate();
  const f = fixture('darus', async url => { await held.pending; return url.endsWith('/tpd') ? Response.json({ status: { protectBalance: false } }) : reply(url); });
  const available = f.source.available(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  const complete = f.source.complete(request('darus'), new AbortController().signal);
  const rejected = expect(complete).rejects.toMatchObject({ code: 'refused' });
  await new Promise(resolve => setTimeout(resolve, 20)); held.release(); expect(await available).toBe(false); await rejected;
  expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/completions'))).toBe(false);
  await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('rechecks source-specific consent before joining %s metadata', async kind => {
  const held = gate(), f = fixture(kind, async url => { await held.pending; return reply(url); });
  const first = f.source.available(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  await rm(join(directory, 'data-sharing-consent.json'));
  expect(await f.source.available()).toBe(false);
  await expect(f.source.complete(request(kind), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(f.fetcher).toHaveBeenCalledTimes(1); held.release(); await first; await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('keeps an aborted uncooperative %s transport in its slot until it settles', async kind => {
  const held = gate(); let block = true;
  const f = fixture(kind, async url => { if (block) await held.pending; return reply(url); });
  const caller = new AbortController(), first = f.source.available(caller.signal);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); caller.abort(); expect(await first).toBe(false);
  expect(await f.source.available()).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(1);
  block = false; held.release(); await new Promise(resolve => setImmediate(resolve));
  expect(await f.source.available()).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(kind === 'beatapi' ? 2 : 3); await f.source.close();
});

it.each(['beatapi', 'darus'] as const)('cancels %s shared metadata on shutdown and prevents subsequent reads', async kind => {
  const f = fixture(kind, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const first = f.source.available(), second = f.source.available();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); await f.source.close();
  expect(await Promise.all([first, second])).toEqual([false, false]);
  expect(await f.source.available()).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(1);
});


it.each(['beatapi', 'darus'] as const)('verifies offline %s benchmark outcomes and fresh evidence', async kind => {
  const available = await measureMetadata({ BeatAPI, Darus }, kind, 4);
  expect(available).toMatchObject({ verifiedResults: 4, metadataRequests: kind === 'beatapi' ? 1 : 2, completionRequests: 0, laterCheckFresh: true });
  const dispatch = await measureMetadata({ BeatAPI, Darus }, kind, 4, true);
  expect(dispatch).toMatchObject({ verifiedResults: 5, metadataRequests: 2, completionRequests: 1 });
  expect(dispatch.elapsedMs).toBeGreaterThan(0);
});
