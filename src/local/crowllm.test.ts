import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { CrowLLM } from './crowllm.js';
import { Sources } from './source.js';
import { configure } from './main.js';
import { createLocalApp } from './api.js';

const model = 'glm-5.3-flash:free';
let directory: string;
const request = () => ({ model: 'crowllm', cwd: directory, stream: false, messages: [{ role: 'user', content: 'Synthetic hello.' }], tools: [] });
const grant = { base_url: 'https://crowllm.com', token: 'synthetic-key' };
const offer = { model_name: model, quota_type: 0, model_ratio: 0, model_price: 0, completion_ratio: 3.6,
  enable_groups: ['free'], supported_endpoint_types: ['openai'] };
const source = (fetcher: typeof fetch) => new CrowLLM({ directory, fetcher, loadGrant: async () => grant });
function replies(pricing = offer, limited = false) {
  return vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/api/usage/token/')) return Response.json({ code: true, data: { object: 'token_usage', expires_at: 0 } });
    if (String(url).endsWith('/api/pricing')) return Response.json({ success: true, data: [pricing] });
    return limited ? Response.json({ error: { code: 429 } }, { status: 429, headers: { 'Retry-After': '42' } })
      : Response.json({ model, choices: [{ message: { content: 'Hello.' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'crowllm-test-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it('does not contact CrowLLM before source-specific consent', async () => {
  const fetcher = replies();
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([0.07, '0', undefined])('blocks nonnumeric or nonzero billing ratios (%s)', async ratio => {
  await recordDataSharingConsent(directory, ['crowllm']);
  const fetcher = replies({ ...offer, model_ratio: ratio } as typeof offer);
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(false);
});

it('pins the exact zero-priced model and reports token usage', async () => {
  await recordDataSharingConsent(directory, ['crowllm']);
  const fetcher = replies();
  await expect(source(fetcher).complete(request(), AbortSignal.timeout(5000))).resolves.toEqual({ text: 'Hello.', inputTokens: 5, outputTokens: 2 });
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://crowllm.com/v1/chat/completions');
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).model).toBe(model);
});

it('checks current pricing again after an earlier successful request', async () => {
  await recordDataSharingConsent(directory, ['crowllm']);
  const fetcher = replies();
  const client = source(fetcher);
  await client.complete(request(), AbortSignal.timeout(5000));
  fetcher.mockImplementation(async url => String(url).endsWith('/api/usage/token/')
    ? Response.json({ code: true, data: { object: 'token_usage', expires_at: 0 } })
    : Response.json({ success: true, data: [{ ...offer, model_ratio: 0.07 }] }));
  await expect(client.complete(request(), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'refused' });
});

it('fails over from CrowLLM rate limits to another free source', async () => {
  await recordDataSharingConsent(directory, ['crowllm']);
  const fetcher = replies(offer, true);
  const fallback = { id: 'fallback', available: async () => true, complete: async () => ({ text: 'Fallback reply.' }) };
  const sources = new Sources([source(fetcher), fallback]);
  try {
    await expect(sources.complete({ ...request(), model: 'grunt' }, AbortSignal.timeout(5000))).resolves.toMatchObject({ text: 'Fallback reply.' });
    expect(sources.status().sources.find(row => row.id === 'crowllm')?.errorCode).toBe('quota');
  } finally { await sources.close(); }
});

it.each(['crowllm', 'codex,crowllm'])('returns native calls through configured routing (%s)', async ids => {
  await recordDataSharingConsent(directory, ['crowllm']);
  const fetcher = replies();
  fetcher.mockImplementation(async url => {
    if (String(url).endsWith('/api/usage/token/')) return Response.json({ code: true, data: { object: 'token_usage', expires_at: 0 } });
    if (String(url).endsWith('/api/pricing')) return Response.json({ success: true, data: [offer] });
    return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'ready', arguments: '{}' } }
    ] } }] });
  });
  vi.stubGlobal('fetch', fetcher);
  const { writePrivateProviderGrant } = await import('./provider-grant.js');
  await writePrivateProviderGrant('crowllm', grant, directory);
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: ids });
  try {
    const response = await createLocalApp(sources, { cwd: directory }).request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request(), model: ids === 'crowllm' ? 'grunt' : 'crowllm',
        tools: [{ type: 'function', function: { name: 'ready', parameters: { type: 'object' } } }] })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Grunt-Source')).toBe('crowllm');
    expect((await response.json()).choices[0].finish_reason).toBe('tool_calls');
  } finally { await sources.close(); }
});
