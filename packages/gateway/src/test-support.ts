/**
 * An in-memory `BillingStore` for the gateway's own tests. Not exported from
 * the package and excluded from the build (see `tsconfig.json`): production
 * always gets a real store injected by the caller.
 *
 * It is written to be *faithful* rather than merely sufficient, because the
 * gateway's behaviour depends on details of the real store's contract:
 *
 *   - a key exists only as `sha256Hex(secret)`, computed with the same
 *     function `PgBillingStore` uses, so the gateway's own hashing of an
 *     incoming bearer has to match it or nothing authenticates;
 *   - `findApiKeyByHash` does not return revoked keys, exactly as the SQL
 *     does (`WHERE revoked_at IS NULL`);
 *   - `postLedger` refuses a spend that would take the balance below
 *     `-reserve` by throwing the real `InsufficientBalanceError`, which is
 *     the case a streamed response can hit after the fact.
 */

import { InsufficientBalanceError, sha256Hex } from "@milo/billing";
import { DEFAULT_PRICING } from "@milo/core";
import type {
  Account,
  AccountId,
  ApiKey,
  BillingStore,
  LedgerEntry,
  MicroUsd,
  MiloKeyId,
  UsageRecord,
} from "@milo/core";
import { randomBytes } from "node:crypto";
import type { UsageListing } from "./billing.js";

export type FakeBillingStore = BillingStore &
  UsageListing & {
    readonly accounts: Map<AccountId, Account>;
    readonly ledger: LedgerEntry[];
    readonly usage: UsageRecord[];
    readonly keys: Map<MiloKeyId, ApiKey>;
  };

export function createFakeBillingStore(opts: { reserveMicroUsd?: MicroUsd } = {}): FakeBillingStore {
  const reserve = opts.reserveMicroUsd ?? DEFAULT_PRICING.reserveMicroUsd;
  const accounts = new Map<AccountId, Account>();
  const keys = new Map<MiloKeyId, ApiKey>();
  const ledger: LedgerEntry[] = [];
  const usage: UsageRecord[] = [];
  const stripeEvents = new Set<string>();
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${++seq}`;
  const now = (): string => new Date().toISOString();

  function require_(id: AccountId): Account {
    const account = accounts.get(id);
    if (account === undefined) throw new Error(`unknown account ${id}`);
    return account;
  }

  return {
    accounts,
    keys,
    ledger,
    usage,

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
      return [...accounts.values()].find((a) => a.email.toLowerCase() === email.toLowerCase());
    },

    async updateAccount(id, patch) {
      if (patch.balanceMicroUsd !== undefined) {
        throw new Error("billing: balanceMicroUsd is derived from the ledger; use postLedger");
      }
      const updated: Account = { ...require_(id), ...patch, updatedAt: now() };
      accounts.set(id, updated);
      return updated;
    },

    async createApiKey(accountId, name) {
      require_(accountId);
      const random = randomBytes(32).toString("base64url");
      const secret = `mk_${random}`;
      const key: ApiKey = {
        id: nextId("key"),
        accountId,
        keyHash: sha256Hex(secret),
        prefix: random.slice(0, 8),
        name,
        createdAt: now(),
        revokedAt: null,
        lastUsedAt: null,
      };
      keys.set(key.id, key);
      return { key, secret };
    },

    async findApiKeyByHash(keyHash) {
      const key = [...keys.values()].find((k) => k.keyHash === keyHash && k.revokedAt === null);
      if (key === undefined) return undefined;
      const account = accounts.get(key.accountId);
      if (account === undefined) return undefined;
      return { ...key, account };
    },

    async revokeApiKey(id) {
      const key = keys.get(id);
      if (key !== undefined && key.revokedAt === null) keys.set(id, { ...key, revokedAt: now() });
    },

    async listApiKeys(accountId) {
      return [...keys.values()].filter((k) => k.accountId === accountId);
    },

    async postLedger(entry) {
      const account = require_(entry.accountId);
      const next = account.balanceMicroUsd + entry.amountMicroUsd;
      if (entry.amountMicroUsd < 0 && next < -reserve) {
        throw new InsufficientBalanceError(entry.accountId, account.balanceMicroUsd, entry.amountMicroUsd, reserve);
      }
      const full: LedgerEntry = { ...entry, id: nextId("led"), balanceAfterMicroUsd: next, createdAt: now() };
      ledger.push(full);
      accounts.set(account.id, { ...account, balanceMicroUsd: next, updatedAt: full.createdAt });
      return full;
    },

    async listLedger(accountId, listOpts) {
      const entries = ledger.filter((e) => e.accountId === accountId).reverse();
      return listOpts?.limit === undefined ? entries : entries.slice(0, listOpts.limit);
    },

    async recordUsage(record) {
      const full: UsageRecord = { ...record, id: nextId("use"), createdAt: now() };
      usage.push(full);
      return full;
    },

    async listUsage(accountId, listOpts) {
      const rows = usage
        .filter((u) => u.accountId === accountId && (listOpts?.sinceIso === undefined || u.createdAt >= listOpts.sinceIso))
        .reverse();
      return listOpts?.limit === undefined ? rows : rows.slice(0, listOpts.limit);
    },

    async usageSummary(accountId, sinceIso) {
      const rows = usage.filter((u) => u.accountId === accountId && (sinceIso === undefined || u.createdAt >= sinceIso));
      const byModel: Record<string, number> = {};
      let chargedMicroUsd = 0;
      let upstreamCostMicroUsd = 0;
      for (const row of rows) {
        byModel[row.model] = (byModel[row.model] ?? 0) + 1;
        chargedMicroUsd += row.chargedMicroUsd;
        upstreamCostMicroUsd += row.upstreamCostMicroUsd;
      }
      return { requests: rows.length, chargedMicroUsd, upstreamCostMicroUsd, byModel };
    },

    async markStripeEvent(eventId) {
      if (stripeEvents.has(eventId)) return false;
      stripeEvents.add(eventId);
      return true;
    },
  };
}
