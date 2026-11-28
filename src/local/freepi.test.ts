import { claudeCodeRequest } from './fixtures/claude-code-tools.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreePi, assertFreePiAccount, FREEPI_MODEL } from './freepi.js';
import type { ModelRequest } from './source.js';
vi.mock('./data-sharing.js', () => ({ readDataSharingConsent: vi.fn(async () => ['freepi']) }));
import { readDataSharingConsent } from './data-sharing.js';
const now = Date.parse('2026-11-20T12:00:00Z');
const account = () => ({ guest: false, lane: 'standard', refill_at: '2026-11-21T00:00:00Z', remaining_usd_today: 1.125, remaining_credits_today: 15000,
  credit_usd: 0, credit_credits: 0, bonus_credits: 0, bonus_wallet_credits: 0, premium_credits: 0, premium_bought_credits: 0, premium_gifted_credits: 0 });
const catalog = () => ({ latest: '0.6.28', min: '0.6.28', models: [{ id: FREEPI_MODEL, free: true, stats_id: 'deepseek/deepseek-v4.1-flash-1017' }] });
const reply = () => ({ model: 'deepseek-ai/deepseek-v41-flash-1017', choices: [{ finish_reason: 'stop', message: { content: 'Synthetic hello. Sponsored content unchanged.', tool_calls: null } }], usage: { prompt_tokens: 40, completion_tokens: 19 } });
const request = (): ModelRequest => ({ model: 'grunt', publicContext: true, messages: [{ role: 'user', content: 'Synthetic hello.' }], tools: [], cwd: '/synthetic', stream: false });
const token = `x.${Buffer.from(JSON.stringify({ sub: 'synthetic-account' })).toString('base64url')}.x`;
let lockDirectory: string;
beforeEach(async () => { lockDirectory = await mkdtemp(join(tmpdir(), 'grunt-freepi-')); vi.mocked(readDataSharingConsent).mockResolvedValue(['freepi']); });
afterEach(async () => { await rm(lockDirectory, { recursive: true, force: true }); });
function fixture(overrides: { account?: Record<string, unknown>; catalog?: unknown; reply?: unknown; postAccount?: Record<string, unknown> } = {}) {
  const calls: string[] = []; let stats = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/client-version') return Response.json(overrides.catalog ?? catalog());
    if (path === '/me/stats') return Response.json(stats++ ? overrides.postAccount ?? overrides.account ?? account() : overrides.account ?? account());
    expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body)).model).toBe(FREEPI_MODEL);
    return Response.json(overrides.reply ?? reply());
  });
  const source = new FreePi({ directory: lockDirectory, lockDirectory, fetcher, now: () => now, loadToken: async () => token });
  return { source, calls, fetcher };
}
describe('Free-Pi guarded official API', () => {
  it('checks every account and catalog before inference, postchecks wallets, and keeps text/usage', async () => {
    const f = fixture(); const r = await f.source.complete(request(), AbortSignal.timeout(1000));
    expect(JSON.parse(String(f.fetcher.mock.calls[2]![1]?.body))).not.toHaveProperty('max_tokens');
    expect(r).toEqual({ text: 'Synthetic hello. Sponsored content unchanged.', inputTokens: 40, outputTokens: 19 });
    expect(f.calls).toEqual(['/client-version', '/me/stats', '/v1/chat/completions', '/me/stats']);
    await f.source.complete(request(), AbortSignal.timeout(1000)); expect(f.calls).toHaveLength(8);
  });
  it('allows provider-granted bonus balances when nothing was purchased', async () => {
    const f = fixture({ account: { ...account(), bonus_credits: 1000, bonus_wallet_credits: 1000 } });
    await f.source.complete(request(), AbortSignal.timeout(1000)); expect(f.calls).toContain('/v1/chat/completions');
    expect(() => assertFreePiAccount({ ...account(), bonus_credits: -1 }, now)).toThrow();
    expect(() => assertFreePiAccount({ ...account(), bonus_wallet_credits: '1000' }, now)).toThrow();
  });
  it.each(['credit_usd', 'credit_credits', 'premium_credits', 'premium_bought_credits', 'premium_gifted_credits', 'premium_expiring_credits', 'regular_wallet_credits'])('still blocks a purchased or premium %s balance beside a bonus', async key => {
    const f = fixture({ account: { ...account(), bonus_credits: 1000, bonus_wallet_credits: 1000, [key]: 1 } });
    await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).not.toContain('/v1/chat/completions');
  });
  it.each(['credit_usd', 'credit_credits', 'premium_credits', 'premium_bought_credits', 'premium_gifted_credits', 'premium_expiring_credits', 'regular_wallet_credits'])('blocks spendable %s before POST', async key => {
    const f = fixture({ account: { ...account(), [key]: 1 } });
    await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).not.toContain('/v1/chat/completions');
  });
  it.each([{ paid_wallet: 0 }, { auto_recharge: false }, { postpaid: false }, { subscription: null }])('blocks unknown accounting fields %j', async extra => {
    const f = fixture({ account: { ...account(), ...extra } });
    await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  });
  it('rejects missing wallet fields, invalid reset and exhausted allowance', () => {
    const missing: Record<string, unknown> = account(); delete missing.bonus_credits;
    expect(() => assertFreePiAccount(missing, now)).toThrow();
    expect(() => assertFreePiAccount({ ...account(), refill_at: 'invalid' }, now)).toThrow();
    expect(() => assertFreePiAccount({ ...account(), remaining_credits_today: 0 }, now)).toThrowError(expect.objectContaining({ code: 'quota', retryAfter: 43200 }));
    expect(() => assertFreePiAccount({ ...account(), remaining_credits_today: 0 }, now, true)).not.toThrow();
  });
  it.each([{ ...catalog(), latest: '0.6.29' }, { ...catalog(), min: '0.6.25' }, { models: [{ ...catalog().models[0], free: false }] }, { models: [] }])('blocks changed/free-offer contracts', async modelCatalog => {
    const f = fixture({ catalog: modelCatalog }); await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).not.toContain('/v1/chat/completions');
  });
  it('requires explicit current consent and reviewed public context', async () => {
    const f = fixture(); await expect(f.source.complete({ ...request(), publicContext: undefined } as unknown as ModelRequest, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
    vi.mocked(readDataSharingConsent).mockResolvedValue([]); expect(await f.source.available()).toBe(false); expect(f.calls).toEqual([]);
  });
  it('preserves structured tools and rejects model substitution', async () => {
    const tool = { id: 'synthetic', type: 'function', function: { name: 'echo', arguments: '{"value":"ok"}' } };
    const f = fixture({ reply: { ...reply(), choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [tool] } }] } });
    expect((await f.source.complete({ ...request(), tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }] }, AbortSignal.timeout(1000))).calls).toEqual([tool]);
    const wrong = fixture({ reply: { ...reply(), model: 'unapproved-model' } }); await expect(wrong.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  });
  it('fails closed on a postflight wallet change', async () => {
    const f = fixture({ postAccount: { ...account(), credit_credits: 2 } }); await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  });
  it('serializes the same account across source instances', async () => {
    const first = fixture(), second = fixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const base = first.fetcher.getMockImplementation()!;
    first.fetcher.mockImplementation(async (url, init) => { if (new URL(String(url)).pathname === '/v1/chat/completions') await gate; return base(url, init); });
    const ongoing = first.source.complete(request(), AbortSignal.timeout(5000));
    await vi.waitFor(() => expect(first.calls).toContain('/me/stats'));
    await expect(second.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota' });
    release(); await ongoing;
  });
  it.each([
    { name: 'unadvertised', args: '{"value":"ok"}', finish: 'tool_calls', historical: false },
    { name: 'echo', args: '{"value":1}', finish: 'tool_calls', historical: false },
    { name: 'echo', args: '{"value":"ok"}', finish: 'length', historical: false },
    { name: 'echo', args: '{"value":"ok"}', finish: 'tool_calls', historical: true }
  ])('rejects unadvertised, invalid, truncated or historically duplicated calls: %j', async row => {
    const call = { id: 'old-call', type: 'function' as const, function: { name: row.name, arguments: row.args } };
    const f = fixture({ reply: { ...reply(), choices: [{ finish_reason: row.finish, message: { content: null, tool_calls: [call] } }] } });
    const r = request(); r.tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
    if (row.historical) r.messages = [{ role: 'user', content: 'Synthetic history' }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: 'Synthetic result', tool_call_id: call.id }, { role: 'user', content: 'Continue' }];
    const completion = f.source.complete(r, AbortSignal.timeout(1000));
    if (row.finish === 'length') await expect(completion).resolves.toMatchObject({ text: '', finishReason: 'length' });
    else await expect(completion).rejects.toMatchObject({ code: 'upstream' });
  });
  it('rejects an invalid advertised schema before any network call', async () => {
    const f = fixture(); await expect(f.source.complete({ ...request(), tools: [{ type: 'function', function: { name: 'bad', parameters: { type: 'not-a-json-schema-type' } } }] }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.calls).toEqual([]);
  });

  it('rejects non-string sponsored/content envelopes even with valid tools', async () => {
    const f = fixture({ reply: { ...reply(), choices: [{ finish_reason: 'tool_calls', message: { content: { sponsored: 'not-string' }, tool_calls: [{ id: 'new-call', type: 'function', function: { name: 'echo', arguments: '{}' } }] } }] } });
    await expect(f.source.complete({ ...request(), tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }] }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  });

});
describe('Free-Pi recorded Claude Code tools', () => {
  it('accepts every tool of a recorded Claude Code request', async () => {
    for (const index of [0, 1, 2] as const) {
      const f = fixture(); await expect(f.source.complete({ ...claudeCodeRequest(index), publicContext: true }, AbortSignal.timeout(1000))).resolves.toMatchObject({ text: expect.any(String) });
      expect(f.calls).toContain('/v1/chat/completions');
    }
  });
});
