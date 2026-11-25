import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent, DATA_SHARING_POLICIES } from './data-sharing.js';
import { Ifm, ifmDuration, ifmRetryAfter, IFM_MODEL } from './ifm.js';
import { bundledRegistry, localOptInAdapters } from '../registry.js';
import { providerQuotaPolicy } from './quota-policy.js';
import type { ModelRequest } from './source.js';

let directory: string;
const grant = { base_url: 'https://api.ifm.ai', token: 'synthetic-key' };
const ask = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'ifm', cwd: directory, stream: false, messages: [{ role: 'user', content: 'Synthetic hello.' }], tools: [], ...extra });
const tool = { type: 'function' as const, function: { name: 'scout_probe', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } };
const catalog = { object: 'list', data: [{ id: IFM_MODEL, owned_by: 'MBZUAI', context_length: 524288, max_model_len: 524288 }] };
const reply = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ model: IFM_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 17, completion_tokens: 9 }, ...extra });
function api(chat: () => Response | Promise<Response>, models: unknown = catalog) {
  return vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/models') ? Response.json(models) : chat());
}
const source = (fetcher: typeof fetch, now?: () => number) => new Ifm({ directory, fetcher, loadGrant: async () => grant, ...(now ? { now } : {}) });
const approved = () => recordDataSharingConsent(directory, ['ifm']);
const posts = (fetcher: ReturnType<typeof api>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'));
const bodyOf = (fetcher: ReturnType<typeof api>, index = 0) => JSON.parse(String(posts(fetcher)[index]![1]!.body));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ifm-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('stays off and sends nothing without its own data-sharing receipt', async () => {
  const fetcher = api(() => Response.json(reply({ content: 'hi' })));
  expect(await source(fetcher).available()).toBe(false);
  await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not inherit another source’s consent', async () => {
  await recordDataSharingConsent(directory, ['millionseek', 'kilo', 'crowllm']);
  expect(await source(api(() => Response.json(reply({ content: 'hi' })))).available()).toBe(false);
});

it('answers a hello, strips the template newline, pins the model and passes the documented sampling', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: '\nHello', reasoning: 'thinking' })));
  await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).resolves.toEqual({ text: 'Hello', inputTokens: 17, outputTokens: 9 });
  expect(String(posts(fetcher)[0]![0])).toBe('https://api.ifm.ai/v1/chat/completions');
  expect(bodyOf(fetcher)).toMatchObject({ model: IFM_MODEL, temperature: 1, top_p: 0.95 });
  expect(bodyOf(fetcher)).not.toHaveProperty('max_tokens');
});

it('honours the caller output budget and adds no cap of its own', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'ok' })));
  await source(fetcher).complete(ask({ maxTokens: 9000 }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher).max_tokens).toBe(9000);
});

it.each([
  ['a different model in the body', () => Response.json(reply({ content: 'x' }, { model: 'other/model' }))],
  ['a different served-model header', () => Response.json(reply({ content: 'x' }), { headers: { 'ifm-served-model': 'other/model' } })],
  ['a reported charge', () => Response.json(reply({ content: 'x' }, { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }))],
  ['an empty answer', () => Response.json(reply({ content: '\n' }))]
])('rejects %s', async (_name, chat) => {
  await approved();
  await expect(source(api(chat)).complete(ask(), AbortSignal.timeout(5000))).rejects.toBeInstanceOf(Error);
});

it('refuses a catalog that lacks the exact model or its documented context', async () => {
  await approved();
  for (const models of [{ data: [] }, { data: [{ ...catalog.data[0], context_length: 131072 }] }, { data: [{ ...catalog.data[0], owned_by: 'someone' }] }]) {
    const fetcher = api(() => Response.json(reply({ content: 'x' })), models);
    expect(await source(fetcher).available()).toBe(false);
    await expect(source(fetcher).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
    expect(posts(fetcher)).toHaveLength(0);
  }
});

it('rejects a grant for any other host', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'x' })));
  const other = new Ifm({ directory, fetcher, loadGrant: async () => ({ base_url: 'https://example.com', token: 'synthetic' }) });
  expect(await other.available()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('returns a validated native tool call and refuses one that breaks its schema', async () => {
  await approved();
  const call = (args: string) => ({ content: '\n', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'scout_probe', arguments: args } }] });
  const good = api(() => Response.json(reply(call('{"value": 7}'), {})));
  await expect(source(good).complete(ask({ tools: [tool] }), AbortSignal.timeout(5000))).resolves.toMatchObject({ text: '', calls: [{ id: 'call-1', function: { name: 'scout_probe', arguments: '{"value": 7}' } }] });
  expect(bodyOf(good).tools).toHaveLength(1);
  const bad = api(() => Response.json(reply(call('{"value": "seven"}'))));
  await expect(source(bad).complete(ask({ tools: [tool] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream' });
});

it('replays reasoning verbatim on the matching assistant turn and only there', async () => {
  await approved();
  const calls = [{ id: 'call-1', type: 'function', function: { name: 'scout_probe', arguments: '{"value": 7}' } }];
  const fetcher = api(() => Response.json(reply({ content: '\n', reasoning: 'Plan: call the probe.\n', tool_calls: calls })));
  const client = source(fetcher);
  const first = await client.complete(ask({ tools: [tool] }), AbortSignal.timeout(5000));
  const turn = [{ role: 'user', content: 'Synthetic hello.' }, { role: 'assistant', content: '', tool_calls: first.calls },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }];
  fetcher.mockImplementation(async url => String(url).endsWith('/v1/models') ? Response.json(catalog) : Response.json(reply({ content: 'Done.' })));
  await client.complete(ask({ tools: [tool], messages: turn }), AbortSignal.timeout(5000));
  const sent = bodyOf(fetcher, 1).messages;
  expect(sent[1]).toMatchObject({ role: 'assistant', reasoning_content: 'Plan: call the probe.\n' });
  expect(sent[0]).not.toHaveProperty('reasoning_content');
  expect(sent[2]).not.toHaveProperty('reasoning_content');
  // A different conversation that merely reuses the call id does not receive that reasoning.
  const other = [{ role: 'user', content: 'Other.' }, { role: 'assistant', content: '', tool_calls: [{ ...first.calls![0]!, function: { name: 'scout_probe', arguments: '{"value": 8}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }];
  await client.complete(ask({ tools: [tool], messages: other }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher, 2).messages[1]).not.toHaveProperty('reasoning_content');
});

it('accepts the documented reasoning_content field name too', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'Answer.', reasoning_content: 'because' })));
  const client = source(fetcher);
  await client.complete(ask(), AbortSignal.timeout(5000));
  await client.complete(ask({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Answer.' }, { role: 'user', content: 'again' }] }), AbortSignal.timeout(5000));
  expect(bodyOf(fetcher, 1).messages[1].reasoning_content).toBe('because');
});

it('reports a reply cut off by its budget as length-limited and drops its unfinished tool call', async () => {
  await approved();
  const cut = api(() => Response.json(reply({ content: '\nPartial answer', tool_calls: [{ id: 'c', type: 'function', function: { name: 'scout_probe', arguments: '{"val' } }] },
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '\nPartial answer', tool_calls: [{ id: 'c', type: 'function', function: { name: 'scout_probe', arguments: '{"val' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 64 } })));
  await expect(source(cut).complete(ask({ tools: [tool], maxTokens: 64 }), AbortSignal.timeout(5000)))
    .resolves.toEqual({ text: 'Partial answer', finishReason: 'length', inputTokens: 20, outputTokens: 64 });
});

it('stops on HTTP 402 and never treats it as quota', async () => {
  await approved();
  const client = source(api(() => new Response('{}', { status: 402 })));
  await expect(client.complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
});

it('uses Retry-After on a 429, and the next UTC midnight when the daily counter is empty', async () => {
  await approved();
  const now = Date.UTC(2026, 10, 25, 20, 0, 0);
  const limited = (headers: Record<string, string>) => source(api(() => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers })), () => now);
  await expect(limited({ 'retry-after': '37' }).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 37 });
  const daily = limited({ 'x-ratelimit-remaining-tokens-daily': '0' });
  await expect(daily.complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 4 * 3600 });
  expect(daily.quotaWindow()).toEqual({ startedAt: Date.UTC(2026, 10, 25), resetAt: Date.UTC(2026, 10, 26) });
  await expect(limited({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s' }).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'quota', retryAfter: 1 });
});

it('infers no reset from a bare 429', () => {
  expect(ifmRetryAfter(new Headers(), Date.now())).toBeUndefined();
  expect(ifmRetryAfter(new Headers({ 'x-ratelimit-remaining-tokens': '30000000', 'x-ratelimit-reset-tokens': '24h0m0s' }), Date.now())).toBeUndefined();
});

it('parses Go-style durations', () => {
  expect([ifmDuration('1s'), ifmDuration('1m30s'), ifmDuration('250ms'), ifmDuration('24h0m0s'), ifmDuration('soon'), ifmDuration(null)]).toEqual([1, 90, 1, 86400, undefined, undefined]);
});

it('maps 401 to logged out and 403 to refused', async () => {
  await approved();
  await expect(source(api(() => new Response('{}', { status: 401 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'logged_out' });
  await expect(source(api(() => new Response('{}', { status: 403 }))).complete(ask(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
});

it('refuses images and hosted tools before any request', async () => {
  await approved();
  const fetcher = api(() => Response.json(reply({ content: 'x' })));
  await expect(source(fetcher).complete(ask({ imageInput: true }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  await expect(source(fetcher).complete(ask({ tools: [{ type: 'web_search' }] }), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('is a local opt-in with the lowest weight, outside the bundled registry, and states what is unverified', () => {
  const entry = localOptInAdapters.find(adapter => adapter.id === 'ifm')!;
  expect(entry.weight).toBeLessThan(Math.min(...localOptInAdapters.filter(adapter => adapter.id !== 'ifm').map(adapter => adapter.weight)));
  expect(entry.weight).toBeLessThan(Math.min(...bundledRegistry.adapters.map(adapter => adapter.weight)));
  expect(bundledRegistry.adapters.some(adapter => adapter.id === 'ifm')).toBe(false);
  const policy = DATA_SHARING_POLICIES.find(item => item.provider === 'ifm')!;
  expect(policy.approval).toBe('material');
  expect(policy.disclosure).toMatch(/unverified/);
  expect(policy.disclosure).toMatch(/Cerebras and Nebius/);
  expect(providerQuotaPolicy('ifm')).toMatchObject({ refill: 'utc-daily' });
});

it('is never recorded by naming the source: only its own listed approval records it, and a changed policy needs it again', async () => {
  const { approveDataSharing, readDataSharingConsent, refreshDataSharingConsent, recordDataSharingConsent: record } = await import('./data-sharing.js');
  const notice = vi.fn();
  expect(await approveDataSharing({ directory, providers: ['ifm', 'opencode'], notice, env: {} })).toMatchObject({ skipped: ['ifm'], approved: ['opencode'] });
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual([]);
  expect(await approveDataSharing({ directory, providers: ['ifm'], notice, env: { GRUNT_APPROVE_DATA_SHARING: 'millionseek,kilo' } })).toMatchObject({ skipped: ['ifm'] });
  expect(await approveDataSharing({ directory, providers: ['ifm'], notice, env: { GRUNT_APPROVE_DATA_SHARING: 'ifm' } })).toMatchObject({ approved: ['ifm'], skipped: [] });
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual(['ifm']);
  // A stale receipt for an older policy version is not renewed on its own.
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(join(directory, 'data-sharing-consent.json'), JSON.stringify({ version: 1, approved: { ifm: { policy: 'old', approvedAt: new Date().toISOString() } } }));
  await chmod(join(directory, 'data-sharing-consent.json'), 0o600);
  expect(await refreshDataSharingConsent(directory, {})).toEqual([]);
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual([]);
  await record(directory, ['ifm']);
  expect(await readDataSharingConsent(directory, ['ifm'])).toEqual(['ifm']);
});
