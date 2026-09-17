/**
 * An in-memory `BillingStore` for tests. Not exported from the package
 * (only imported by `*.test.ts` files) — production code always gets a real
 * store injected by the caller.
 */

import { randomUUID } from "node:crypto";
import type { Account, AccountId, ApiKey, BillingStore, LedgerEntry, MiloKeyId, UsageRecord } from "@milo/core";

export function createInMemoryBillingStore(): BillingStore {
  const accounts = new Map<AccountId, Account>();
  const ledger = new Map<AccountId, LedgerEntry[]>();
  const usage = new Map<AccountId, UsageRecord[]>();
  const apiKeys = new Map<MiloKeyId, ApiKey & { account: Account }>();
  const stripeEvents = new Set<string>();

  function requireAccount(id: AccountId): Account {
    const account = accounts.get(id);
    if (!account) throw new Error(`unknown account ${id}`);
    return account;
  }

  return {
    async createAccount(email) {
      const now = new Date().toISOString();
      const account: Account = {
        id: randomUUID(),
        email,
        stripeCustomerId: null,
        openRouterSubKeyEnc: null,
        openRouterSubKeyHash: null,
        balanceMicroUsd: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      accounts.set(account.id, account);
      return account;
    },

    async getAccount(id) {
      return accounts.get(id);
    },

    async getAccountByEmail(email) {
      for (const account of accounts.values()) {
        if (account.email === email) return account;
      }
      return undefined;
    },

    async updateAccount(id, patch) {
      const current = requireAccount(id);
      const updated: Account = { ...current, ...patch, updatedAt: new Date().toISOString() };
      accounts.set(id, updated);
      return updated;
    },

    async createApiKey(accountId, name) {
      const account = requireAccount(accountId);
      const secret = `mk_${randomUUID()}`;
      const apiKey: ApiKey = {
        id: randomUUID(),
        accountId,
        keyHash: randomUUID(),
        prefix: secret.slice(3, 11),
        name,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      };
      apiKeys.set(apiKey.id, { ...apiKey, account });
      return { key: apiKey, secret };
    },

    async findApiKeyByHash(keyHash) {
      for (const key of apiKeys.values()) {
        if (key.keyHash === keyHash) return key;
      }
      return undefined;
    },

    async revokeApiKey(id) {
      const key = apiKeys.get(id);
      if (key) key.revokedAt = new Date().toISOString();
    },

    async listApiKeys(accountId) {
      return [...apiKeys.values()].filter((k) => k.accountId === accountId);
    },

    async postLedger(entry) {
      const account = requireAccount(entry.accountId);
      const balanceAfterMicroUsd = account.balanceMicroUsd + entry.amountMicroUsd;
      const full: LedgerEntry = {
        ...entry,
        id: randomUUID(),
        balanceAfterMicroUsd,
        createdAt: new Date().toISOString(),
      };
      const list = ledger.get(entry.accountId) ?? [];
      list.push(full);
      ledger.set(entry.accountId, list);
      accounts.set(account.id, { ...account, balanceMicroUsd: balanceAfterMicroUsd, updatedAt: full.createdAt });
      return full;
    },

    async listLedger(accountId, opts) {
      const list = [...(ledger.get(accountId) ?? [])].reverse();
      return opts?.limit ? list.slice(0, opts.limit) : list;
    },

    async recordUsage(record) {
      const full: UsageRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
      const list = usage.get(record.accountId) ?? [];
      list.push(full);
      usage.set(record.accountId, list);
      return full;
    },

    async usageSummary(accountId, sinceIso) {
      const list = (usage.get(accountId) ?? []).filter((r) => !sinceIso || r.createdAt >= sinceIso);
      const byModel: Record<string, number> = {};
      let chargedMicroUsd = 0;
      let upstreamCostMicroUsd = 0;
      for (const record of list) {
        chargedMicroUsd += record.chargedMicroUsd;
        upstreamCostMicroUsd += record.upstreamCostMicroUsd;
        byModel[record.model] = (byModel[record.model] ?? 0) + 1;
      }
      return { requests: list.length, chargedMicroUsd, upstreamCostMicroUsd, byModel };
    },

    async markStripeEvent(eventId) {
      if (stripeEvents.has(eventId)) return false;
      stripeEvents.add(eventId);
      return true;
    },
  };
}
