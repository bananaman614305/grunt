import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { AntseedVikey } from './antseed-vikey.js';
import { Kilo, KILO_BEAM, KILO_ORIGIN } from './kilo.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { configure } from './main.js';
import { bundledRegistry, validateRegistry } from '../registry.js';
import { writeAutomaticPool } from './automatic-pool.js';
import type { ModelRequest } from './source.js';

const seller = 'e4c4129c86752a2a8d092ddb0eb1c27cc4933c7b';
const vik = 'deepseek/deepseek-v4.1-flash-free';
const quote = (outputUsdPerMillion = 0) => ({ data: [{ id: vik, peers: [{ peerId: seller, serviceId: vik, type: 'text', inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion,
  freeTier: { base: { maxRequestsPerAddress: 10, maxRequestsPerIp: 100, windowMs: 86_400_000 } } }] }] });
const billed = (prompt = '0') => ({ data: [{ id: KILO_BEAM, isFree: true, context_length: 1048576, pricing: { prompt, completion: '0' }, supported_parameters: ['tools', 'max_tokens'] }] });
const priceHeaders = {
  'x-antseed-peer-id': seller, 'x-antseed-unit-priced': '0',
  'x-antseed-input-usd-per-million': '0', 'x-antseed-cached-input-usd-per-million': '0', 'x-antseed-output-usd-per-million': '0',
};
const req: ModelRequest = { model: 'grunt', cwd: '/tmp', stream: false, maxTokens: 32, messages: [{ role: 'user', content: 'hello' }], tools: [] };
const signal = new AbortController().signal;

it('reconciles a matching setup-managed source list with curated additions while preserving manual overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-managed-pool-'));
  await writeAutomaticPool(directory, ['kilo']);
  const managed = configure({ GRUNT_DAEMON: '1', GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'kilo' });
  const manual = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'kilo' });
  const overridden = configure({ GRUNT_DAEMON: '1', GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'opencode' });
  try {
    expect(managed.sources.map(source => source.id)).toEqual(expect.arrayContaining(bundledRegistry.adapters.map(adapter => adapter.id)));
    expect(manual.sources.map(source => source.id)).toEqual(['kilo']);
    expect(overridden.sources.map(source => source.id)).toEqual(['opencode']);
  } finally { await managed.close(); await manual.close(); await overridden.close(); await rm(directory, { recursive: true, force: true }); }
});

it('offers curated Beam by default while keeping unqualified Vikey explicitly selected', async () => {
  const explicit = configure({ GRUNT_SOURCES: 'antseed-vikey,reflection-beam' }), normal = configure({});
  const optedIn = configure({ GRUNT_SOURCES: 'freellmapi,kilo', GRUNT_OPT_IN_SOURCES: 'antseed-vikey,reflection-beam,unknown,antseed-vikey' });
  try {
    expect(explicit.sources.map(source => source.id)).toEqual(['antseed-vikey', 'reflection-beam']);
    expect(normal.sources.map(source => source.id)).not.toContain('antseed-vikey');
    expect(normal.sources.map(source => source.id)).toContain('reflection-beam');
    expect(optedIn.sources.map(source => source.id)).toEqual(['freellmapi', 'kilo', 'antseed-vikey', 'reflection-beam']);
  } finally { await explicit.close(); await normal.close(); await optedIn.close(); }
});

it('keeps normal sticky routing and permits opt-ins in subworker routing', async () => {
  const pool = configure({ GRUNT_SOURCES: 'kilo,antseed-vikey,reflection-beam' });
  const choose = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    for (const source of pool.sources) {
      vi.spyOn(source, 'available').mockResolvedValue(true);
      vi.spyOn(source, 'complete').mockResolvedValue({ text: source.id });
    }
    const vik = pool.sources[1]!;
    await expect(pool.complete(req, signal)).resolves.toMatchObject({ text: 'kilo' });
    choose.mockReturnValue(0.99999);
    await expect(pool.complete(req, signal)).resolves.toMatchObject({ text: 'kilo' });
    const onSource = vi.fn();
    await expect(pool.complete({ ...req, worker: { id: 'beam', onSource } }, signal)).resolves.toMatchObject({ text: 'reflection-beam' });
    expect(onSource).toHaveBeenCalledWith('reflection-beam');
    // A mixed chain also gives its secondary worker router the local opt-ins.
    const mixed = configure({ GRUNT_SOURCES: 'freellmapi', GRUNT_OPT_IN_SOURCES: 'antseed-vikey' });
    try {
      vi.spyOn(mixed.sources[1]!, 'available').mockResolvedValue(true);
      vi.spyOn(mixed.sources[1]!, 'complete').mockResolvedValue({ text: vik.id });
      await expect(mixed.complete({ ...req, worker: { id: 'vik', onSource } }, signal)).resolves.toMatchObject({ text: 'antseed-vikey' });
    } finally { await mixed.close(); }
  } finally { choose.mockRestore(); await pool.close(); }
});

it('rejects registry entries that replace the vetted Beam implementation or model', () => {
  const beam = bundledRegistry.adapters.find(adapter => adapter.id === 'reflection-beam')!;
  for (const patch of [{ kind: 'agent' }, { modalities: ['image'] }, { install: 'npm:fake-beam' }, { model: 'paid-beam' }]) {
    expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...beam, ...patch }] })).toThrow();
  }
});

it('pins Vikey and declines a nonzero catalog price before inference', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(quote(0.0001)))
    .mockResolvedValueOnce(Response.json(quote()))
    .mockResolvedValueOnce(Response.json({ model: vik, choices: [{ message: { content: 'hello' } }] }, { headers: priceHeaders }));
  const source = new AntseedVikey({ fetcher });
  await expect(source.complete(req, signal)).rejects.toMatchObject({ code: 'not_installed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(source.sellerQuota()).toBeUndefined();
  await expect(source.complete(req, signal)).resolves.toMatchObject({ text: 'hello' });
  const [url, init] = fetcher.mock.calls[2]!;
  expect(source.sellerQuota()).toEqual({ perAddress: 10, perIp: 100, windowSeconds: 86400 });
  expect(url).toBe('http://127.0.0.1:8381/v1/chat/completions');
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: `${seller}@${vik}`, max_tokens: 32 });
});

it('passes through Vikey quota cooldown and rejects a different seller', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(quote()))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '505' } }))
    .mockResolvedValueOnce(Response.json(quote()))
    .mockResolvedValueOnce(Response.json({ model: vik }, { headers: { ...priceHeaders, 'x-antseed-peer-id': 'other' } }));
  const source = new AntseedVikey({ fetcher });
  await expect(source.complete(req, signal)).rejects.toMatchObject({ code: 'quota', retryAfter: 505 });
  await expect(source.complete(req, signal)).rejects.toMatchObject({ code: 'refused' });
});

it.each([[seller, 'address', 720], [seller, 'stake_required', undefined], ['other', 'address', undefined]])(
  'accepts a free-window delay only for the selected seller and a renewable limit', async (peerId, limitedBy, retryAfter) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(quote()))
      .mockResolvedValueOnce(Response.json({ code: 'free_tier_exhausted', free_tier: { peerId, limitedBy, retryAfterSeconds: 720 } }, { status: 429 }));
    await expect(new AntseedVikey({ fetcher }).complete(req, signal)).rejects.toMatchObject({ code: 'quota', retryAfter });
  }
);

it('gates Beam on the exact live $0 offer and never uses a Kilo grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-beam-test-'));
  try {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(billed('0.1')))
      .mockResolvedValueOnce(Response.json(billed()))
      .mockResolvedValueOnce(Response.json({ model: KILO_BEAM, choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0, cost_details: {
          upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0,
        } } }));
    const source = new Kilo({ directory, fetcher, reflectionBeam: true });
    await expect(source.complete(req, signal)).rejects.toMatchObject({ code: 'refused' });
    expect(fetcher).not.toHaveBeenCalled();
    await recordDataSharingConsent(directory, ['reflection-beam']);
    await expect(source.complete(req, signal)).rejects.toMatchObject({ code: 'refused' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(source.complete(req, signal)).resolves.toMatchObject({ text: 'hello' });
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe(`${KILO_ORIGIN}/chat/completions`);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: KILO_BEAM, max_tokens: 32 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
