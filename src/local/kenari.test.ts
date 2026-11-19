import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { bundledRegistry } from '../registry.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Kenari, KENARI_FREE_MODEL } from './kenari.js';
import { Sources } from './source.js';

let directory: string;
const grant = { base_url: 'https://example.invalid/egress', token: 'synthetic' };
const request = { model: 'kenari', messages: [{ role: 'user', content: 'Hello' }], tools: [], cwd: '/', stream: false };
const offer = { id: KENARI_FREE_MODEL, context_length: 1_024_000, pricing: { free: true }, tool_call: true };
const catalog = () => Response.json({ data: [offer] });
const source = (fetcher: typeof fetch) => new Kenari({ directory, fetcher, loadGrant: async () => grant });

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'kenari-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('does not make any request before current provider consent', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const kenari = source(fetcher);
  await expect(kenari.available()).resolves.toBe(false);
  await expect(kenari.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not treat the public catalogue as evidence that a revoked key is installed', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
  await expect(source(fetcher).available()).resolves.toBe(false);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${grant.base_url}/v1/usage`, expect.objectContaining({ redirect: 'error' }));
});

it('uses only the exact free route and returns its native tools through Grunt', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const calls = [{ id: 'test-call', type: 'function', function: { name: 'scout_probe', arguments: '{"value":"hello"}' } }];
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => catalog())
    .mockImplementationOnce(async () => Response.json({ model: KENARI_FREE_MODEL,
      choices: [{ message: { content: null, tool_calls: calls } }], usage: { prompt_tokens: 12, completion_tokens: 9 } }));
  const sources = new Sources([source(fetcher)]);
  try {
    const result = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        ...request, tools: [{ type: 'function', function: { name: 'scout_probe', parameters: { type: 'object' } } }]
      })
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('x-grunt-source')).toBe('kenari');
    expect(await result.json()).toMatchObject({ choices: [{ message: { tool_calls: calls } }] });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(`${grant.base_url}/v1/chat/completions`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: KENARI_FREE_MODEL, stream: false });
    expect(init?.redirect).toBe('error');
  } finally { await sources.close(); }
});

it('stops before inference if the catalog no longer marks the model free', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ ...offer, pricing: { free: false } }] }));
  await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('retains the quota delay and does not retry inside the adapter', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => catalog())
    .mockImplementationOnce(async () => new Response(null, { status: 429, headers: { 'Retry-After': '25' } }));
  await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 25 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([['free_quota_daily', 300], ['free_quota_rpm', undefined]])(
  'uses the midnight reset only for verified daily exhaustion (%s)', async (code, retryAfter) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-19T23:55:00Z'));
    try {
      await recordDataSharingConsent(directory, ['kenari']);
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => catalog())
        .mockImplementationOnce(async () => Response.json({ error: { code } }, { status: 429 }));
      await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'quota', retryAfter });
    } finally { vi.restoreAllMocks(); }
  }
);

it('falls through from a registered Kenari quota error to another free source', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/chat/completions')
    ? new Response(null, { status: 429, headers: { 'Retry-After': '25' } })
    : String(url).endsWith('/v1/usage') ? Response.json({ object: 'usage.summary' }) : catalog());
  const fallback = { id: 'kilo', supportsFunctionTools: true,
    available: async () => true, complete: vi.fn(async () => ({ text: 'fallback reply' })) };
  const registry = { ...bundledRegistry, adapters: ['kenari', 'kilo'].map(id => ({
    ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, tier: 'stable' as const, weight: 0.5
  })) };
  const sources = new Sources([source(fetcher), fallback], { registry: () => registry, random: () => 0 });
  try {
    expect(await sources.complete({ ...request, model: 'grunt' }, new AbortController().signal)).toEqual({ text: 'fallback reply' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/chat/completions'))).toHaveLength(1);
    expect(fallback.complete).toHaveBeenCalledOnce();
  } finally { await sources.close(); }
});

it('rejects replies that report the paid model ID', async () => {
  await recordDataSharingConsent(directory, ['kenari']);
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => catalog())
    .mockImplementationOnce(async () => Response.json({ model: KENARI_FREE_MODEL.slice(0, -5),
      choices: [{ message: { content: 'unexpected model' } }] }));
  await expect(source(fetcher).complete(request, new AbortController().signal)).rejects.toThrow('HTTP 502');
});
