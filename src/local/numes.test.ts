import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { FREE_API_PROVIDERS } from './free-api.js';
import { configure } from './main.js';
import { Numes, NUMES_DEEPSEEK_FLASH_CONSENT, NUMES_DEEPSEEK_FLASH_MODEL } from './numes.js';

const { model } = FREE_API_PROVIDERS.numes;
const request = {
  model: 'numes', messages: [{ role: 'user', content: 'Hello' }],
  tools: [], cwd: '/', stream: false, maxTokens: 128
};
const zeroCap = { disabled: false, is_management_key: false, limit: 0, limit_remaining: 0 };
const offer = { id: model, context_length: 1048576, pricing: { prompt: '0', completion: '0', request: '0' }, supported_parameters: ['tools'] };
const deepSeekEndpoint = 'amazee-ai-5149fc8341b341f3a6ebe026ae44f7c7/token-factory-df2d2988c4514d66a143237f387d4e64';
const endpoint = { ...offer, tag: deepSeekEndpoint, billing_currency: 'USD', max_prompt_tokens: 917504, supported_parameters: ['tools', 'max_tokens'] };
let directory: string;

function source(fetcher: typeof fetch, deepSeekFlash = false) {
  return new Numes({ directory, fetcher, deepSeekFlash, loadGrant: async () => ({ base_url: 'https://api.numes.ai', token: 'test-token' }) });
}

function exactEndpoint(details = endpoint, capturedAt = Date.now(), stale = false) {
  return Response.json({ data: { id: NUMES_DEEPSEEK_FLASH_MODEL, endpoints: [details] } }, {
    headers: { 'X-Catalogue-Supply-Captured-At': new Date(capturedAt).toISOString(), 'X-Catalogue-Stale': String(stale) }
  });
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'numes-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('does not look up the key or send inference before Numes consent', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const numes = source(fetcher);
  await expect(numes.available()).resolves.toBe(false);
  await expect(numes.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('checks for the exact free tool-capable offer and a zero spending cap', async () => {
  await recordDataSharingConsent(directory, ['numes']);
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => Response.json({ data: zeroCap }))
    .mockImplementationOnce(async () => Response.json({ data: [offer] }))
    .mockImplementationOnce(async () => Response.json({ data: zeroCap }))
    .mockImplementationOnce(async () => Response.json({ data: [{ ...offer, pricing: { ...offer.pricing, request: '0.001' } }] }));
  const numes = source(fetcher);
  await expect(numes.available()).resolves.toBe(true);
  await expect(numes.available()).resolves.toBe(false);
});

it('fails closed if the same key no longer has a zero spending cap', async () => {
  await recordDataSharingConsent(directory, ['numes']);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { ...zeroCap, limit: null } }));
  await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.numes.ai/api/v1/key', expect.objectContaining({ redirect: 'error' }));
});

it('pins model and prices and returns native tool calls only for an exact zero-cost response', async () => {
  await recordDataSharingConsent(directory, ['numes']);
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'scout_probe', arguments: '{"value":"ok"}' } }];
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => Response.json({ data: zeroCap }))
    .mockImplementationOnce(async () => Response.json({ model, choices: [{ message: { content: null, tool_calls: calls } }],
      usage: { cost: 0, prompt_tokens: 24, completion_tokens: 10 } }));
  const tools = [{ type: 'function', function: { name: 'scout_probe', parameters: { type: 'object' } } }];
  await expect(source(fetcher).complete({ ...request, tools }, new AbortController().signal)).resolves
    .toMatchObject({ calls, inputTokens: 24, outputTokens: 10 });
  const [, init] = fetcher.mock.calls[1]!;
  expect(JSON.parse(String(init?.body))).toMatchObject({ model, tools, provider: { max_price: { prompt: 0, completion: 0 } } });
});

it.each([[undefined, 60], ['120', 120]])('honors a Numes account retry hint and backs off briefly for upstream capacity', async (header, retryAfter) => {
  await recordDataSharingConsent(directory, ['numes']);
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: zeroCap }))
    .mockResolvedValueOnce(Response.json({ error: { metadata: { error_type: 'rate_limited' } } }, {
      status: 429, ...(header === undefined ? {} : { headers: { 'Retry-After': header } })
    }));
  await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter });
});

it('rejects model mismatch and nonzero settled cost', async () => {
  await recordDataSharingConsent(directory, ['numes']);
  const fetcher = vi.fn<typeof fetch>();
  for (const [responseModel, cost] of [['deepseek/deepseek-v4.1-flash:free', 0], [model, 0.001]]) {
    fetcher.mockImplementationOnce(async () => Response.json({ data: zeroCap }))
      .mockImplementationOnce(async () => Response.json({ model: responseModel, choices: [{ message: { content: 'hello' } }], usage: { cost } }));
  }
  const numes = source(fetcher);
  await expect(numes.complete(request, new AbortController().signal)).rejects.toThrow('HTTP 502');
  await expect(numes.complete(request, new AbortController().signal)).rejects.toThrow('HTTP 502');
});

it('allows the private Flash selector only in an exact Numes configuration', async () => {
  const env = { GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'numes' };
  const primary = configure(env);
  const selected = configure({ ...env, GRUNT_NUMES_MODEL: NUMES_DEEPSEEK_FLASH_MODEL });
  expect(primary.sources.map(adapter => adapter.id)).toEqual(['numes']);
  expect(selected.sources.map(adapter => adapter.id)).toEqual(['numes']);
  expect(primary.status().sources.find(adapter => adapter.id === 'numes')).toMatchObject({ model });
  expect(selected.status().sources.find(adapter => adapter.id === 'numes')).toMatchObject({ model: NUMES_DEEPSEEK_FLASH_MODEL });
  expect(() => configure({ ...env, GRUNT_NUMES_MODEL: NUMES_DEEPSEEK_FLASH_MODEL.slice(0, -5) })).toThrow('exact Numes-only');
  expect(() => configure({ ...env, GRUNT_SOURCES: 'numes,zro', GRUNT_NUMES_MODEL: NUMES_DEEPSEEK_FLASH_MODEL })).toThrow('exact Numes-only');
  await Promise.all([primary.close(), selected.close()]);
});

it('requires the Flash disclosure separately from the GLM receipt', async () => {
  await recordDataSharingConsent(directory, ['numes']);
  const fetcher = vi.fn<typeof fetch>();
  const numes = source(fetcher, true);
  await expect(numes.available()).resolves.toBe(false);
  await expect(numes.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('rechecks the exact USD endpoint then sends a pinned zero-price Flash request', async () => {
  await recordDataSharingConsent(directory, [NUMES_DEEPSEEK_FLASH_CONSENT]);
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'scout_probe', arguments: '{}' } }];
  const tools = [{ type: 'function', function: { name: 'scout_probe', parameters: { type: 'object' } } }];
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: zeroCap }))
    .mockResolvedValueOnce(exactEndpoint())
    .mockResolvedValueOnce(Response.json({ model: NUMES_DEEPSEEK_FLASH_MODEL, choices: [{ message: { content: null, tool_calls: calls } }], usage: { cost: 0 } }));
  await expect(source(fetcher, true).complete({ ...request, tools }, new AbortController().signal)).resolves.toMatchObject({ calls });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://api.numes.ai/api/v1/key', `https://api.numes.ai/api/v1/models/${NUMES_DEEPSEEK_FLASH_MODEL}/endpoints`,
    'https://api.numes.ai/api/v1/chat/completions'
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
    model: NUMES_DEEPSEEK_FLASH_MODEL, tools, provider: { max_price: { prompt: 0, completion: 0 }, require_parameters: true,
      only: [deepSeekEndpoint], allow_fallbacks: false }
  });
});

it.each([
  () => exactEndpoint({ ...endpoint, tag: 'unverified/endpoint' }),
  () => exactEndpoint({ ...endpoint, max_prompt_tokens: 199999 }),
  () => exactEndpoint({ ...endpoint, pricing: { ...endpoint.pricing, request: '0.001' } }),
  () => exactEndpoint(endpoint, Date.now() - 61_000),
  () => exactEndpoint(endpoint, Date.now(), true)
])('skips Flash inference for an ineligible or stale endpoint', async endpointResponse => {
  await recordDataSharingConsent(directory, [NUMES_DEEPSEEK_FLASH_CONSENT]);
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: zeroCap }))
    .mockResolvedValueOnce(endpointResponse());
  await expect(source(fetcher, true).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
