import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { MILLIONSEEK_SLOW_UPSTREAM, MillionSeek } from './millionseek.js';
import { RETIRE_AFTER_FAILURES, StickyRouter } from './routing.js';
import { SourceStatus } from './source-status.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

const minute = 60000, request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'hi' }], tools: [], cwd: '/tmp', stream: false };
const routers: StickyRouter[] = [];
afterEach(async () => { await Promise.all(routers.splice(0).map(r => r.close())); vi.restoreAllMocks(); });
const slow = (status: number, extra: { retryAfter?: number } = {}) => new SourceError('upstream', 'gateway', extra.retryAfter, undefined, { httpStatus: status, transport: 'http', endpointLabel: 'chat.completions' });
const timeout = () => new SourceError('timeout', 'produced no output');
const reset = () => new SourceError('upstream', 'reset', undefined, undefined, { networkCode: 'ECONNRESET' });
// 'millionseek' opts into the policy; 'kilo' (a registered adapter) does not.
function setup(policy: boolean) {
  let now = 1_000_000;
  const sources: Source[] = ['millionseek', 'kilo'].map(id => ({ id, available: async () => true, complete: vi.fn(async () => ({ text: 'ok' })),
    ...(policy && id === 'millionseek' ? { slowUpstream: MILLIONSEEK_SLOW_UPSTREAM } : {}) }));
  const status = new SourceStatus(sources.map(s => s.id), () => now);
  const router = new StickyRouter(sources, { registry: () => ({ ...bundledRegistry, adapters: sources.map(s => ({ ...bundledRegistry.adapters.find(a => a.id === s.id)!, weight: 1 })) }), observation: status, now: () => now, random: () => 0 });
  routers.push(router);
  return { router, status, sources, advance: (ms: number) => { now += ms; }, now: () => now,
    // Seconds the source is benched for right after a failure.
    benched: async (id: string, failure: SourceError) => { const at = now; await router.recordFailure(id, failure); return ((router.cooldown(id)?.until ?? at) - at) / 1000; } };
}

it('uses the default five minute base for a slow failure without an override', async () => {
  const t = setup(false);
  expect(await t.benched('millionseek', slow(502))).toBe(5 * 60);
});
it('benches a slow upstream failure for the policy base, doubling per consecutive one up to the cap', async () => {
  const t = setup(true), { baseSeconds, maxSeconds } = MILLIONSEEK_SLOW_UPSTREAM;
  // Any mix of slow failures escalates together: 502, 524, reset, first-output timeout, 503.
  const mix = [slow(502), slow(524), reset(), timeout(), slow(503), slow(504)];
  const seen: number[] = [];
  for (const failure of mix) { seen.push(await t.benched('millionseek', failure)); t.advance(maxSeconds * 1000 + 1); }
  expect(seen).toEqual([baseSeconds, baseSeconds * 2, baseSeconds * 4, maxSeconds, maxSeconds, maxSeconds]);
  expect(baseSeconds).toBeGreaterThan(15 * 60);
});
it('a success resets the escalation', async () => {
  const t = setup(true);
  expect(await t.benched('millionseek', slow(502))).toBe(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds);
  t.advance(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds * 1000 + 1);
  expect(await t.benched('millionseek', slow(502))).toBe(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds * 2);
  t.advance(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds * 2000 + 1);
  await t.status.complete(t.sources[0]!, request, new AbortController().signal);
  t.advance(1);
  expect(await t.benched('millionseek', timeout())).toBe(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds);
});
it('a straggler inside the cooldown is the same episode and does not escalate', async () => {
  const t = setup(true), { baseSeconds } = MILLIONSEEK_SLOW_UPSTREAM;
  expect(await t.benched('millionseek', slow(502))).toBe(baseSeconds);
  t.advance(2 * minute);
  expect(await t.benched('millionseek', slow(502))).toBe(baseSeconds - 120);
  t.advance(baseSeconds * 1000);
  expect(await t.benched('millionseek', timeout())).toBe(baseSeconds * 2);
});
it('a provider Retry-After wins over the policy', async () => {
  const t = setup(true);
  expect(await t.benched('millionseek', slow(503, { retryAfter: 90 }))).toBe(90);
  t.advance(2 * minute);
  // And it does not count as a slow failure for escalation.
  expect(await t.benched('millionseek', slow(502))).toBe(MILLIONSEEK_SLOW_UPSTREAM.baseSeconds);
});
it('failures that are not slow keep the default cooldown', async () => {
  const t = setup(true);
  expect(await t.benched('millionseek', new SourceError('upstream', 'bad body'))).toBe(15 * 60);
  t.advance(16 * minute);
  expect(await t.benched('millionseek', new SourceError('upstream', 'server error', undefined, undefined, { httpStatus: 500 }))).toBe(15 * 60);
  t.advance(16 * minute);
  expect(await t.benched('millionseek', new SourceError('refused', 'no'))).toBe(15 * 60);
});
it('retirement preserves a longer upstream cooldown', async () => {
  // Five identical 502s, each after its cooldown, retire the route as before.
  const t = setup(true);
  for (let i = 1; i <= RETIRE_AFTER_FAILURES; i++) {
    expect(t.router.retired('millionseek')).toBe(false);
    await t.router.recordFailure('millionseek', slow(502));
    t.advance(MILLIONSEEK_SLOW_UPSTREAM.maxSeconds * 1000 + 1);
  }
  expect(RETIRE_AFTER_FAILURES).toBe(5);
  const retiredAt = t.status.routingBackoff('millionseek')!;
  expect(retiredAt.streak).toBe(RETIRE_AFTER_FAILURES);
  expect(retiredAt.until - retiredAt.at).toBe(MILLIONSEEK_SLOW_UPSTREAM.maxSeconds * 1000);
});
it('flapping-outage-streak-reset counts alternating failures toward retirement', async () => {
  const t = setup(false);
  for (let i = 1; i <= RETIRE_AFTER_FAILURES; i++) {
    await t.router.recordFailure('millionseek', i % 2 ? timeout() : slow(502));
    const hold = t.status.routingBackoff('millionseek')!;
    expect(hold).toMatchObject({ signature: 'outage:::', streak: i });
    expect(t.router.retired('millionseek')).toBe(i === RETIRE_AFTER_FAILURES);
    t.advance(hold.until - t.now() + 1);
  }
});
it('millionseek opts in with a longer first cooldown than the default and a bounded cap', () => {
  const source = new MillionSeek();
  expect(source.slowUpstream).toBe(MILLIONSEEK_SLOW_UPSTREAM);
  expect(source.reportsProgress).toBe(true);
  expect(source.firstOutputMs).toBeGreaterThan(48000);
  expect(source.firstOutputMs).toBeLessThan(125000);
});
