/**
 * A minimal in-memory `BillingStore` for tests. Not exported from the
 * package's public entry point — it exists only so this package's own
 * tests don't need a real database, and so a real gateway/database
 * implementation has nothing to diverge from except the pinned interface
 * in `@milo/core`.
 */

import type {
  Account,
  AccountId,
  ApiKey,
  BillingStore,
  LedgerEntry,
  MiloKeyId,
  UsageRecord,
} from "@milo/core";

export type FakeBillingStore = BillingStore & {
  accounts: Map<AccountId, Account>;
  ledger: LedgerEntry[];
};

export function createFakeBillingStore(): FakeBillingStore {
  const accounts = new Map<AccountId, Account>();
  const ledger: LedgerEntry[] = [];
  const appliedStripeEvents = new Set<string>();
  const apiKeys = new Map<MiloKeyId, ApiKey>();
  const usage: UsageRecord[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;
  const now = () => new Date().toISOString();

  const store: BillingStore = {
    async createAccount(email) {
      const account: Account = {
        id: nextId("acc"),
        email,
        stripeCustomerId: null,
        openRouterSubKeyEnc: null,
        openRouterSubKeyHash: null,
        balanceMicroUsd: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      };
      accounts.set(account.id, account);
      return account;
    },

    async getAccount(id) {
      return accounts.get(id);
    },

    async getAccountByEmail(email) {
      return [...accounts.values()].find((a) => a.email === email);
    },

    async updateAccount(id, patch) {
      const existing = accounts.get(id);
      if (!existing) throw new Error(`Unknown account: ${id}`);
      const updated: Account = { ...existing, ...patch, updatedAt: now() };
      accounts.set(id, updated);
      return updated;
    },

    async createApiKey(accountId, name) {
      const key: ApiKey = {
        id: nextId("key"),
        accountId,
        keyHash: nextId("hash"),
        prefix: "testtest",
        name,
        createdAt: now(),
        revokedAt: null,
        lastUsedAt: null,
      };
      apiKeys.set(key.id, key);
      return { key, secret: `mk_${key.id}` };
    },

    async findApiKeyByHash(keyHash) {
      const key = [...apiKeys.values()].find((k) => k.keyHash === keyHash);
      if (!key) return undefined;
      const account = accounts.get(key.accountId);
      if (!account) return undefined;
      return { ...key, account };
    },

    async revokeApiKey(id) {
      const key = apiKeys.get(id);
      if (key) key.revokedAt = now();
    },

    async listApiKeys(accountId) {
      return [...apiKeys.values()].filter((k) => k.accountId === accountId);
    },

    async postLedger(entry) {
      const account = accounts.get(entry.accountId);
      if (!account) throw new Error(`Unknown account: ${entry.accountId}`);
      const balanceAfterMicroUsd = account.balanceMicroUsd + entry.amountMicroUsd;
      const full: LedgerEntry = {
        ...entry,
        id: nextId("ledger"),
        balanceAfterMicroUsd,
        createdAt: now(),
      };
      ledger.push(full);
      accounts.set(account.id, { ...account, balanceMicroUsd: balanceAfterMicroUsd, updatedAt: full.createdAt });
      return full;
    },

    async listLedger(accountId, listOpts) {
      const entries = ledger.filter((e) => e.accountId === accountId);
      return listOpts?.limit ? entries.slice(-listOpts.limit) : entries;
    },

    async recordUsage(record) {
      const full: UsageRecord = { ...record, id: nextId("usage"), createdAt: now() };
      usage.push(full);
      return full;
    },

    async usageSummary(accountId, sinceIso) {
      const relevant = usage.filter((u) => u.accountId === accountId && (!sinceIso || u.createdAt >= sinceIso));
      const byModel: Record<string, number> = {};
      let chargedMicroUsd = 0;
      let upstreamCostMicroUsd = 0;
      for (const u of relevant) {
        byModel[u.model] = (byModel[u.model] ?? 0) + 1;
        chargedMicroUsd += u.chargedMicroUsd;
        upstreamCostMicroUsd += u.upstreamCostMicroUsd;
      }
      return { requests: relevant.length, chargedMicroUsd, upstreamCostMicroUsd, byModel };
    },

    async markStripeEvent(eventId) {
      if (appliedStripeEvents.has(eventId)) return false;
      appliedStripeEvents.add(eventId);
      return true;
    },
  };

  return Object.assign(store, { accounts, ledger });
}
