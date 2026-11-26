import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Runcrate, RUNCRATE_BILLING_ORIGIN, RUNCRATE_DEEPSEEK, RUNCRATE_ORIGIN, RuncrateVerificationError, readRuncrateGrant, verifyRuncrateDirectGrant, writeRuncrateGrant } from './runcrate.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';
import { credentialFingerprint, writeVaultEntry } from './vault.js';

const paths: string[] = [];
const grant = { base_url: 'https://grant.test/runcrate', token: 'synthetic-private-grant' };
const request = { model: 'grunt', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: process.cwd(), stream: false };
async function directory(approved = true) {
  const path = await mkdtemp(join(tmpdir(), 'grunt-runcrate-')); paths.push(path);
  if (approved) await recordDataSharingConsent(path, ['runcrate']);
  return path;
}
const reply = (model: unknown = RUNCRATE_DEEPSEEK) => Response.json({ model, choices: [{ message: { content: 'Hello from Runcrate' } }], usage: { prompt_tokens: 23, completion_tokens: 5 } });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('persists only a private free-account/top-ups-disabled receipt and checks the exact model without inference', async () => {
  const path = await directory(); await writeRuncrateGrant({ ...grant, unwanted: 'not stored' } as typeof grant, path);
  expect(await readRuncrateGrant(path)).toMatchObject({ ...grant, free_account_verified: true, key_topups_disabled: true });
  expect(JSON.parse(await readFile(join(path, 'runcrate.json'), 'utf8'))).not.toHaveProperty('unwanted');
  expect((await stat(join(path, 'runcrate.json'))).mode & 0o777).toBe(0o600);
  expect(await readdir(path)).toEqual(['data-sharing-consent.json', 'runcrate.json']);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: RUNCRATE_DEEPSEEK }] }));
  expect(await new Runcrate({ directory: path, fetcher }).available()).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]![0]).toBe(`${grant.base_url}/v1/models`);
});

it('routes Grunt through only the pinned Runcrate model with the requested output budget', async () => {
  const path = await directory(); await writeRuncrateGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  const sources = new Sources([new Runcrate({ directory: path, fetcher })]);
  const response = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, max_tokens: 90000 })
  });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('runcrate');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe(`${grant.base_url}/v1/chat/completions`);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: RUNCRATE_DEEPSEEK, max_tokens: 90000, stream: false });
  await sources.close();
});

it('refuses a raw grant until free access and disabled key top-ups were verified', async () => {
  const path = await directory(); await writeFile(join(path, 'runcrate.json'), JSON.stringify(grant), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(), source = new Runcrate({ directory: path, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out' });
  expect(fetcher).not.toHaveBeenCalled();
  await writeFile(join(path, 'runcrate.json'), JSON.stringify({ ...grant, free_account_verified: true, key_topups_disabled: false, verified_at: new Date().toISOString() }), { mode: 0o600 });
  expect(await source.available()).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});

it('gates existing grants and rechecks revoked data-sharing consent on every request', async () => {
  const path = await directory(false); await writeRuncrateGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => reply()), source = new Runcrate({ directory: path, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
  await recordDataSharingConsent(path, ['runcrate']); await source.complete(request, AbortSignal.timeout(1000));
  await rm(join(path, 'data-sharing-consent.json'));
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['deepseek-v4-flash', 'deepseek-v3.2', null])('rejects a different or unidentified returned model: %s', async model => {
  const path = await directory(); await writeRuncrateGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => reply(model));
  await expect(new Runcrate({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('rejects unsafe grant files and HTTPS endpoint substitutions', async () => {
  const path = await directory(); await writeRuncrateGrant(grant, path);
  await chmod(join(path, 'runcrate.json'), 0o644); await expect(readRuncrateGrant(path)).rejects.toThrow('Unsafe');
  await rm(join(path, 'runcrate.json'));
  await writeFile(join(path, 'target.json'), JSON.stringify(grant), { mode: 0o600 });
  await symlink(join(path, 'target.json'), join(path, 'runcrate.json'));
  await expect(readRuncrateGrant(path)).rejects.toThrow();
  for (const base_url of ['http://grant.test', 'https://user:pass@grant.test', 'https://grant.test/?token=private']) {
    await expect(writeRuncrateGrant({ ...grant, base_url }, path)).rejects.toThrow('endpoint');
  }
});

it('propagates quota without retry or a paid model fallback', async () => {
  const path = await directory(); await writeRuncrateGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => new Response('private upstream message', { status: 429, headers: { 'Retry-After': '12' } }));
  await expect(new Runcrate({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota', retryAfter: 12, message: 'runcrate returned HTTP 429' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('requires exact-credential free-account and top-up verification for direct vault keys while allowing refreshed Squire egress grants', async () => {
  const path = await directory();
  const key1 = 'sk-runcrate-original-1';
  const key2 = 'sk-runcrate-replacement-2';
  const direct1 = { base_url: RUNCRATE_ORIGIN, token: key1 };
  const direct2 = { base_url: RUNCRATE_ORIGIN, token: key2 };

  await writeVaultEntry('runcrate', { api_key: key1, source: 'import' }, path);
  await expect(writeRuncrateGrant(direct1, path)).rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(stat(join(path, 'runcrate.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  const proof1 = {
    free_account_verified: true as const,
    key_topups_disabled: true as const,
    credential_sha256: credentialFingerprint(direct1),
    verified_at: new Date().toISOString()
  };
  await writeRuncrateGrant(direct1, path, { verification: proof1 });
  expect(await readRuncrateGrant(path, {})).toMatchObject({ ...direct1, key_topups_disabled: true });

  // Replacing the key in vault.json rejects unverified or stale-fingerprint direct receipt writes.
  await writeVaultEntry('runcrate', { api_key: key2, source: 'import' }, path);
  await expect(writeRuncrateGrant(direct2, path)).rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(writeRuncrateGrant(direct2, path, { verification: proof1 })).rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(writeRuncrateGrant(direct2, path, {
    verification: { ...proof1, credential_sha256: credentialFingerprint(direct2), key_topups_disabled: false as unknown as true }
  })).rejects.toBeInstanceOf(RuncrateVerificationError);
  // Existing receipt remains bound to key1 until key2 is verified.
  expect(JSON.parse(await readFile(join(path, 'runcrate.json'), 'utf8'))).toMatchObject({
    credential_sha256: credentialFingerprint(direct1)
  });

  // Built-in direct verifier checks balance=0, auto-recharge disabled, no payment methods, and model access.
  const makeBillingFetcher = (overrides: { balance?: unknown; autoRecharge?: unknown; paymentMethods?: unknown; models?: unknown; billingStatus?: number } = {}) =>
    vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${key2}`);
      const target = String(url);
      if (target === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/balance`) {
        if (overrides.billingStatus) return new Response(null, { status: overrides.billingStatus });
        return Response.json(overrides.balance ?? { creditsBalance: 0, activeUsageCost: 0, floating_balance_usd: 0 });
      }
      if (target === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/auto-recharge`) {
        return Response.json(overrides.autoRecharge ?? { enabled: false });
      }
      if (target === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/payment-methods`) {
        return Response.json(overrides.paymentMethods ?? { payment_methods: [] });
      }
      if (target === `${RUNCRATE_ORIGIN}/v1/models`) {
        return Response.json(overrides.models ?? { data: [{ id: RUNCRATE_DEEPSEEK }] });
      }
      return new Response(null, { status: 404 });
    });

  await expect(verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher({ balance: { creditsBalance: 5 } }) }))
    .rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher({ autoRecharge: { enabled: true } }) }))
    .rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher({ paymentMethods: { payment_methods: [{ id: 'pm_card' }] } }) }))
    .rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher({ billingStatus: 403 }) }))
    .rejects.toBeInstanceOf(RuncrateVerificationError);
  await expect(verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher({ models: { data: [{ id: 'other-model' }] } }) }))
    .rejects.toBeInstanceOf(RuncrateVerificationError);

  const verified2 = await verifyRuncrateDirectGrant(direct2, { fetcher: makeBillingFetcher() });
  expect(verified2).toMatchObject({
    free_account_verified: true,
    key_topups_disabled: true,
    credential_sha256: credentialFingerprint(direct2)
  });
  await writeRuncrateGrant(direct2, path, { verification: verified2 });
  expect(await readRuncrateGrant(path, {})).toMatchObject({ ...direct2, key_topups_disabled: true });

  // Refreshed Squire egress grants with a new fingerprint update runcrate.json cleanly.
  const refreshedEgress = { base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_refreshed1234567890', token: 'synthetic-egress-refreshed' };
  await writeRuncrateGrant(refreshedEgress, path);
  expect(await readRuncrateGrant(path, {})).toMatchObject({
    ...refreshedEgress,
    credential_sha256: credentialFingerprint(refreshedEgress),
    key_topups_disabled: true
  });
});
