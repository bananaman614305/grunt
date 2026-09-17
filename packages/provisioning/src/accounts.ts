/**
 * Per-account OpenRouter sub-key lifecycle. Rule (ADR-007): a sub-key's
 * spend limit is always kept equal to the account's current balance, so
 * OpenRouter itself refuses spend beyond what the account has paid for.
 */

import type { Account, BillingStore } from "@milo/core";
import { microToUsd } from "@milo/core";
import type { OpenRouterProvisioningClient } from "./client.js";
import { encryptSecret } from "./crypto.js";

function subKeyName(accountId: string): string {
  return `milo-${accountId}`;
}

/** Rounds a USD amount to whole cents, the smallest unit OpenRouter's `limit` accepts. */
function roundToCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function balanceUsdFloor0(account: Account): number {
  return Math.max(0, microToUsd(account.balanceMicroUsd));
}

/**
 * Creates the account's OpenRouter sub-key if it doesn't have one yet, named
 * `milo-<accountId>` with a limit equal to the account's current balance
 * (floored at 0). Stores the key's hash and an encrypted copy of the
 * plaintext key on the account; the plaintext itself is never stored or
 * returned to the caller. A no-op (returns the account unchanged) if the
 * account already has a sub-key.
 */
export async function ensureSubKey(opts: {
  store: BillingStore;
  client: OpenRouterProvisioningClient;
  encryptionKey: string;
  account: Account;
}): Promise<Account> {
  const { store, client, encryptionKey, account } = opts;
  if (account.openRouterSubKeyHash) return account;

  const limitUsd = roundToCents(balanceUsdFloor0(account));
  const created = await client.createKey({ name: subKeyName(account.id), limitUsd });
  const openRouterSubKeyEnc = encryptSecret(created.key, encryptionKey);

  return store.updateAccount(account.id, {
    openRouterSubKeyHash: created.hash,
    openRouterSubKeyEnc,
  });
}

/**
 * Sets the sub-key's limit to the account's current balance in USD, rounded
 * to cents. Re-reads the account from `store` first so a stale in-memory
 * `account` (e.g. passed in right after a concurrent credit) doesn't push a
 * stale limit. Call this after every credit and periodically (e.g. from a
 * cron) so a balance drop (a refund, a chargeback) is reflected too. No-op
 * if the account has no sub-key yet.
 */
export async function syncLimit(opts: {
  store: BillingStore;
  client: OpenRouterProvisioningClient;
  account: Account;
}): Promise<void> {
  const { store, client, account } = opts;
  const fresh = (await store.getAccount(account.id)) ?? account;
  if (!fresh.openRouterSubKeyHash) return;

  const limitUsd = roundToCents(balanceUsdFloor0(fresh));
  await client.updateKey(fresh.openRouterSubKeyHash, { limitUsd });
}

/**
 * Disables the account's OpenRouter sub-key so no further upstream spend is
 * possible. Intended for account suspension; does not itself change
 * `account.status` — the caller updates that in the store. No-op if the
 * account has no sub-key.
 */
export async function disableSubKey(opts: {
  client: OpenRouterProvisioningClient;
  account: Account;
}): Promise<void> {
  const { client, account } = opts;
  if (!account.openRouterSubKeyHash) return;
  await client.updateKey(account.openRouterSubKeyHash, { disabled: true });
}
