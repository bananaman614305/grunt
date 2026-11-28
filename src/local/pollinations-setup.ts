import { rm } from 'node:fs/promises';
import { DATA_SHARING_POLICIES, readDataSharingConsent } from './data-sharing.js';
import {
  POLLINATIONS_MODEL, POLLINATIONS_ORIGIN, pollinationsGrantPath, readPollinationsGrant,
  verifyPollinationsAccess, writePollinationsGrant, writePollinationsVaultReceipt
} from './pollinations.js';
import type { PollinationsGrant } from './pollinations.js';
import { resolveSquireGrant } from './provider-grant.js';
import type { SquireGrantSource } from './provider-grant.js';
import { assertProviderNotRefused, isAccountRefusal, recordProviderRefusal } from './provider-refusal.js';
import { readVaultGrant, writeVaultEntry } from './vault.js';

export const POLLINATIONS_STORE = { service: 'pollinations', label: 'grunt-free-pollinations', api_hosts: ['gen.pollinations.ai'], auth_shape: 'bearer' };
// A fresh name per attempt: an earlier key keeps its name but its value is gone.
export const pollinationsKeyName = (now = new Date()) => `${POLLINATIONS_STORE.label}-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;

interface Credential {
  service: string | null;
  reference: string;
  field_names: string[];
  allowed_hosts?: string[];
  auth_strategy?: string | null;
  label?: string;
  name?: string;
}
export interface PollinationsSetupSquire extends SquireGrantSource {
  signup(service: string, url: string, goal: string, facts?: Record<string, string>): Promise<void>;
  credentials: {
    list(): Promise<Credential[]>;
    grant(reference: string): Promise<{ base_url: string; token: string }>;
  };
  approveDataSharing?(providers: readonly string[]): void;
}
export interface PollinationsSetupOptions {
  directory: string;
  squire: PollinationsSetupSquire;
  signal?: AbortSignal;
  dataSharingApproved?: readonly string[];
  notify?(line: string): void;
  fetcher?: typeof fetch;
  background?: boolean;
  exportToVault?: boolean;
}
const failure = () => new Error('Pollinations free signup or key guard verification did not complete; rerun usegrunt setup');
const foregroundNeeded = () => new Error('Pollinations needs foreground setup; run usegrunt setup to verify or reconnect access');
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw failure();
      return operation();
    }), new Promise<never>((_resolve, reject) => {
      aborted = () => reject(failure());
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    })]);
  } catch (error) { if (isAccountRefusal(error)) throw error; throw failure(); }
  finally { if (aborted) signal.removeEventListener('abort', aborted); }
}
const eligible = (credential: Credential) => credential.service?.trim().toLowerCase() === 'pollinations'
  // Squire's egress grant selects its upstream from the first allowed host.
  // A matching service label alone cannot bind an opaque grant to this API.
  && Array.isArray(credential.allowed_hosts) && credential.allowed_hosts[0] === POLLINATIONS_STORE.api_hosts[0]!
  // Summary metadata exposes auth_strategy, not the capture-time auth_shape.
  // Older summaries may leave it unset; reject every explicit non-key strategy.
  && (credential.auth_strategy == null || credential.auth_strategy === 'api_key')
  && Array.isArray(credential.field_names)
  && credential.field_names.some(field => typeof field === 'string' && /^(?:pollinations)?(?:api)?(?:key|token|secret|apitoken|accesstoken)$|^value$/.test(field.toLowerCase().replace(/[^a-z0-9]/g, '')));
const owned = (credential: Credential) => (credential.label ?? credential.name)?.trim().toLowerCase() === POLLINATIONS_STORE.label;

/** All secrets stay in Squire's vault or the private backend grant file. */
export async function setupPollinations(options: PollinationsSetupOptions): Promise<void> {
  if (options.background) {
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10000)]);
    try {
      if (signal.aborted) throw foregroundNeeded();
      const approved = await bounded(() => readDataSharingConsent(options.directory, ['pollinations']), signal);
      if (!approved.includes('pollinations') || (options.dataSharingApproved && !options.dataSharingApproved.includes('pollinations'))) throw foregroundNeeded();
      const saved = await bounded(() => readPollinationsGrant(options.directory), signal);
      await bounded(() => verifyPollinationsAccess(saved, { signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }), signal);
      return;
    } catch { throw foregroundNeeded(); }
  }
  const approved = [...new Set([...(options.dataSharingApproved ?? []), ...await readDataSharingConsent(options.directory, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
  if (!approved.includes('pollinations')) throw new Error('Pollinations data sharing requires the grouped setup approval');
  if (options.signal?.aborted) throw failure();
  options.squire.approveDataSharing?.(approved);
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 600000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const guards = { signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}) };
  const invalidate = () => rm(pollinationsGrantPath(options.directory), { force: true });

  // A refused account never leads to another signup until the person clears it.
  await assertProviderNotRefused(options.directory, 'pollinations');
  try {
    try {
      const saved = await bounded(() => readPollinationsGrant(options.directory), signal);
      await bounded(() => verifyPollinationsAccess(saved, guards), signal);
      options.notify?.('Pollinations: existing zero-budget free community GLM access verified');
      return;
    } catch (error) { if (signal.aborted) throw failure(); if (isAccountRefusal(error)) throw error; }
    // A failed fresh verification must never leave an older receipt usable.
    await invalidate();
    const localVault = await bounded(() => readVaultGrant('pollinations', options.directory), signal).catch(() => undefined);
    if (localVault) {
      try {
        await bounded(() => verifyPollinationsAccess(localVault, guards), signal);
        if (signal.aborted) throw failure();
        await writePollinationsVaultReceipt({
          version: 1, base_url: localVault.base_url, token: localVault.token,
          upstream_origin: POLLINATIONS_ORIGIN, model: POLLINATIONS_MODEL,
          verified_at: new Date().toISOString(), free_account_verified: true,
          key_zero_budget_verified: true, quest_pollen_only: true
        }, options.directory);
        if (signal.aborted) throw failure();
        options.notify?.('Pollinations: zero-budget Quest-only free community GLM access connected through local Grunt vault');
        return;
      } catch (error) { if (signal.aborted) throw failure(); if (isAccountRefusal(error)) throw error; }
    }
    const connectCredential = async (credential: Credential) => {
      const grant = await bounded(() => resolveSquireGrant('pollinations', credential.reference, options.squire, {
        directory: options.directory,
        signal,
        ...(options.background !== undefined ? { background: options.background } : {}),
        ...(options.exportToVault !== undefined ? { exportToVault: options.exportToVault } : {}),
        ...(options.notify ? { notify: options.notify } : {})
      }), signal);
      await bounded(() => verifyPollinationsAccess(grant, guards), signal);
      if (signal.aborted) throw failure();
      const receipt: PollinationsGrant = {
        version: 1, base_url: grant.base_url, token: grant.token,
        upstream_origin: POLLINATIONS_ORIGIN, model: POLLINATIONS_MODEL,
        verified_at: new Date().toISOString(), free_account_verified: true,
        key_zero_budget_verified: true, quest_pollen_only: true
      };
      if (grant.transport === 'direct') {
        await writeVaultEntry('pollinations', { api_key: grant.token, origin: POLLINATIONS_ORIGIN, source: 'squire' }, options.directory);
        await writePollinationsVaultReceipt(receipt, options.directory);
        if (signal.aborted) throw failure();
        options.notify?.('Pollinations: zero-budget Quest-only free community GLM access connected through local Grunt vault');
      } else {
        await writePollinationsGrant(receipt, options.directory);
        if (signal.aborted) throw failure();
        options.notify?.('Pollinations: zero-budget Quest-only free community GLM access connected through Squire');
      }
    };
    const before = (await bounded(() => options.squire.credentials.list(), signal)).filter(eligible);
    const references = new Set(before.map(credential => credential.reference));
    // A saved Squire key that passes the free-key guard is reused; no signup starts.
    for (const credential of [...before.filter(owned), ...before.filter(item => !owned(item))]) {
      try { await connectCredential(credential); return; }
      catch (error) { if (signal.aborted) throw failure(); if (isAccountRefusal(error)) throw error; }
    }
    await bounded(() => options.squire.signup('pollinations', 'https://enter.pollinations.ai/keys',
      `Use the personal Google identity already connected to Squire for Pollinations, or reuse the same existing account. GitHub OAuth is also permitted for that same user's account if already linked; never switch identities or create an extra account. Go straight to the keys page. Never add a card, payment method, purchased Pollen, subscription, paid wallet funds, purchases or top-ups; do not open or change billing or modify an unrelated key. Pollinations shows a key's value only when it is created, so an existing key cannot be captured: leave every listed key unchanged and create one new secret key named with the supplied key_name. Its Pollen budget must be exactly 0 (hard zero, not blank/unlimited), Quest Pollen Only must be enabled, and account permissions must be usage only: no profile, keys, model management, agents or other account permissions. Prefer the exact model allowlist ${POLLINATIONS_MODEL} only if the normal dashboard offers an individual model selector. If it only offers categories, keep models unrestricted (null); do not choose a category or use CLI/API key self-edit. Grunt separately enforces the fixed singleton free route and server zero-budget guards. Do not enable default model fallback, edit or rotate an unrelated key, reset a key, or buy/claim paid credits. The small ordinary first-key Quest reward is allowed. Capture or reuse this key directly in this user's Squire vault under service pollinations, label ${POLLINATIONS_STORE.label}, api_hosts ["${POLLINATIONS_STORE.api_hosts[0]}"], auth_shape bearer. Use operate_extract for a new capture; never return or display the key in chat. Confirm the saved key settings before finishing. The user approved this provider's community/upstream data sharing in the grouped setup prompt; accept only required disclosures. Leave optional marketing off. Stop on refusal. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed.`, { key_name: pollinationsKeyName(), Budget: '0' }), signal);
    // BrowserSquire invalidates credential metadata after a completed signup;
    // this second list therefore includes a newly captured Grunt key.
    const credentials = (await bounded(() => options.squire.credentials.list(), signal)).filter(eligible);
    const credential = credentials.find(item => !references.has(item.reference)) ?? credentials.find(owned) ?? credentials[0];
    if (!credential) throw failure();
    await connectCredential(credential);
  } catch (error) {
    await invalidate().catch(() => {});
    if (isAccountRefusal(error) && !signal.aborted) throw await recordProviderRefusal(options.directory, 'pollinations', error);
    throw failure();
  } finally { clearTimeout(timeout); }
}
