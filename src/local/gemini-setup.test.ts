import { expect, it, vi } from 'vitest';
import { FreeLLMAdmin, GEMINI_MODEL, setupProviders } from './setup.js';

it('connects saved Gemini access after Kilo using grants without starting signup', async () => {
  const grant = vi.fn(async (reference: string) => ({ base_url: `https://egress.test/${reference.split('/').pop()}`, token: 'synthetic-grant' }));
  const addGrant = vi.fn();
  const start = vi.fn();
  await setupProviders({ credentials: { list: async () => ['gemini', 'kilo'].map(service => ({ service, reference: `vault://${service}`, field_names: ['value'] })), grant }, runs: { start, get: vi.fn() } }, { addGrant }, { providers: [], dataSharingApproved: ['kilo'], notify: vi.fn() });
  expect(addGrant.mock.calls.map(([provider]) => provider)).toEqual(['kilo', 'gemini']);
  expect(grant.mock.calls).toEqual([['vault://kilo'], ['vault://gemini']]);
  expect(start).not.toHaveBeenCalled();
});

it('skips absent Gemini access without minting a grant or starting signup', async () => {
  const grant = vi.fn(), addGrant = vi.fn(), start = vi.fn(), notify = vi.fn();
  await setupProviders({ credentials: { list: async () => [], grant }, runs: { start, get: vi.fn() } }, { addGrant }, { providers: [], dataSharingApproved: [], notify });
  expect(notify).toHaveBeenCalledWith('gemini: skipped; no saved API access');
  expect(grant).not.toHaveBeenCalled();
  expect(addGrant).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it('normalises Google model ids and registers the requested model at the grant endpoint', async () => {
  const router = new FreeLLMAdmin();
  const call = vi.spyOn(router, 'call').mockImplementation(async path => {
    if (path === '/keys/custom/discover-models') return { models: [{ id: `models/${GEMINI_MODEL}` }] };
    if (path === '/keys') return [];
    return {};
  });
  await router.addGrant('gemini', { base_url: 'https://egress.test/gemini/', token: 'synthetic-grant' });
  expect(call).toHaveBeenCalledWith('/keys/custom', { baseUrl: 'https://egress.test/gemini/v1beta/openai', apiKey: 'synthetic-grant', label: 'Milo gemini (Squire)', models: [{ model: GEMINI_MODEL, supportsTools: true }] });
  call.mockResolvedValueOnce([{ id: 1, platform: 'custom', label: 'Milo gemini (Squire)', baseUrl: 'https://egress.test/gemini/v1beta/openai', models: [{ modelId: GEMINI_MODEL }] }]);
  await expect(router.hasKey('gemini')).resolves.toBe(true);
});

it('orders Gemini after every Kilo row and before Freebuff while preserving other priorities', async () => {
  const router = new FreeLLMAdmin();
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'Milo kilo (Squire)', priority: 1 },
    { modelDbId: 2, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'Kilo Free', priority: 2 },
    { modelDbId: 3, platform: 'custom', modelId: GEMINI_MODEL, keyLabel: 'Milo gemini (Squire)', priority: 3 },
    { modelDbId: 4, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 4 },
    { modelDbId: 5, platform: 'custom', modelId: 'other', keyLabel: 'Unmanaged', priority: 7, enabled: true }
  ];
  const call = vi.spyOn(router, 'call').mockImplementation(async path => path === '/fallback' ? rows : {});
  await router.configureChain([], ['kilo', 'freebuff']);
  const updated = call.mock.calls.find(([, , method]) => method === 'PUT')![1] as { modelDbId: number; priority: number; enabled: boolean }[];
  expect(updated.every(row => row.enabled)).toBe(true);
  expect(updated[2].priority).toBeGreaterThan(updated[0].priority);
  expect(updated[2].priority).toBeGreaterThan(updated[1].priority);
  expect(updated[2].priority).toBeLessThan(updated[3].priority);
  expect(updated[4].priority).toBe(7);
});

it('falls through to the next source when the Gemini route returns HTTP 429', async () => {
  const { FreeLLMAPI } = await import('./freellmapi.js');
  const { Sources } = await import('./source.js');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
  const gemini = new FreeLLMAPI({ key: 'synthetic-local-key', model: GEMINI_MODEL, fetcher });
  const complete = vi.fn(async () => ({ text: 'fallback answered' }));
  const sources = new Sources([gemini, { id: 'next', available: async () => true, complete }]);
  await expect(sources.complete({ model: 'milo', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: '/tmp', stream: false }, new AbortController().signal)).resolves.toEqual({ text: 'fallback answered' });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).model).toBe(GEMINI_MODEL);
  expect(complete).toHaveBeenCalledOnce();
});
