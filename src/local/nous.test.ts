import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { NOUS_FREE_MODEL, Nous, nousFreeAccountPolicy } from './nous.js';
import { Sources } from './source.js';

const origin = 'https://inference-api.nousresearch.com';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-nous-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const free = {
  id: NOUS_FREE_MODEL,
  context_length: 1_000_000,
  pricing: { prompt: '0', completion: '0', input_cache_read: '0', input_cache_write: '0' },
  supported_parameters: ['tools', 'tool_choice']
};

function fixture(catalog: unknown = [free]) {
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === `${origin}/v1/models`) return Response.json({ data: catalog });
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  });
  const loadGrant = vi.fn(async () => ({ base_url: origin, token: 'synthetic-oauth-token' }));
  const source = new Nous({ directory, fetcher, loadGrant });
  return { source, fetcher, loadGrant };
}

it('routes a Grunt reply through the pinned Nous model after a fresh public catalog check', async () => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher } = fixture();
  const sources = new Sources([source]);
  try {
    const app = createLocalApp(sources, { port: 0 });
    const response = await app.fetch(new Request('http://127.0.0.1:0/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nous', messages: [{ role: 'user', content: 'Say hello' }] })
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe('nous');
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'Hello' } }] });
    expect(fetcher).toHaveBeenLastCalledWith(`${origin}/v1/chat/completions`, expect.objectContaining({
      body: expect.stringContaining(`"model":"${NOUS_FREE_MODEL}"`)
    }));
    const catalogCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/models'));
    expect(catalogCalls.length).toBeGreaterThan(0);
    for (const [, init] of catalogCalls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  } finally { await sources.close(); }
});

it.each([
  { ...free, id: 'qwen/qwen4-max' },
  { ...free, context_length: 199_999 },
  { ...free, pricing: { prompt: '0', completion: '0.2' } },
  { ...free, pricing: { ...free.pricing, input_cache_write: '0.2' } },
  { ...free, pricing: { prompt: '0' } },
  { ...free, supported_parameters: [] }
])('refuses inference when the catalog entry does not qualify', async model => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher, loadGrant } = fixture([model]);
  try {
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'refused' });
    expect(loadGrant).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${origin}/v1/models`, expect.anything());
  } finally { await source.close(); }
});

it('performs no network access when the user has not approved Nous', async () => {
  const { source, fetcher, loadGrant } = fixture();
  try {
    expect(await source.available()).toBe(false);
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'refused' });
    expect(loadGrant).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await source.close(); }
});

it('learns the longest grounded reset from the Nous quota response', async () => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher } = fixture();
  fetcher.mockImplementation(async input => String(input).endsWith('/models')
    ? Response.json({ data: [free] })
    : Response.json({ error: { resets_in_seconds: 180, message: 'private-error' } }, {
      status: 429, headers: { 'x-ratelimit-reset-requests-1h': '240', 'Retry-After': '60' }
    }));
  try {
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'quota', retryAfter: 240, message: 'nous returned HTTP 429' });
  } finally { await source.close(); }
});

it('requires zero paid entitlement, funds and subscription charges', () => {
  const access = { allowed: false, paid_access: false, has_active_subscription: false,
    active_subscription_is_paid: false, subscription_credits_remaining: 0,
    purchased_credits_remaining: 0, total_usable_credits: 0, subscription_monthly_charge: null };
  const free = { subscription: null, purchased_credits_remaining: 0, paid_service_access: access };
  const cases = [
    free,
    { ...free, subscription: { plan: 'Free', monthly_charge: 0 } },
    { ...free, subscription: { plan: 'Plus', monthly_charge: 20 } },
    { ...free, purchased_credits_remaining: 1 },
    { ...free, paid_service_access: { ...access, active_subscription_is_paid: true } },
    { ...free, paid_service_access: { ...access, allowed: false, paid_access: true } },
    { ...free, paid_service_access: { ...access, total_usable_credits: 1 } },
    { ...free, paid_service_access: {} }
  ];
  const script = `import json, sys\n${nousFreeAccountPolicy}\nprint(json.dumps([free_account(case) for case in json.load(sys.stdin)]))`;
  const outcome = execFileSync('python3', ['-I', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 5000 });
  expect(JSON.parse(outcome)).toEqual([true, true, false, false, false, false, false, false]);
});
