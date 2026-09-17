/**
 * `milo billing`, exercised entirely against fakes: an in-memory
 * `BillingAdminStore`, a mocked Stripe SDK (the same shape
 * `packages/stripe/src/setup.test.ts` uses), and a stubbed OpenRouter
 * provisioning client (the same shape `packages/provisioning/src/reconcile.test.ts`
 * uses). No network, no database -- the JSON gateway API this CLI's
 * subcommands parallel does not even need to exist for these to run.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Account, ApiKey, BillingStore, LedgerEntry, MiloKeyId, UsageRecord } from "@milo/core";
import { createStripeClient } from "@milo/stripe";
import type Stripe from "stripe";
import type { OpenRouterProvisioningClient } from "@milo/provisioning";
import { run } from "./billing.js";
import type { BillingAdminStore, CliDeps } from "../deps.js";
import { createTestDeps } from "../test-support.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Everything `milo billing` needs from a `BillingStore`, in memory. */
function createFakeBillingAdminStore(): BillingAdminStore {
  const accounts = new Map<string, Account>();
  const ledger = new Map<string, LedgerEntry[]>();
  const usage = new Map<string, UsageRecord[]>();
  const apiKeys = new Map<MiloKeyId, ApiKey>();
  const stripeEvents = new Set<string>();
  const now = () => new Date().toISOString();

  function requireAccount(id: string): Account {
    const account = accounts.get(id);
    if (!account) throw new Error(`unknown account ${id}`);
    return account;
  }

  const store: BillingStore = {
    async createAccount(email) {
      const account: Account = {
        id: randomUUID(),
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
      const current = requireAccount(id);
      const updated: Account = { ...current, ...patch, updatedAt: now() };
      accounts.set(id, updated);
      return updated;
    },

    async createApiKey(accountId, name) {
      requireAccount(accountId);
      const secret = `mk_${randomUUID()}`;
      const key: ApiKey = {
        id: randomUUID(),
        accountId,
        keyHash: randomUUID(),
        prefix: secret.slice(3, 11),
        name,
        createdAt: now(),
        revokedAt: null,
        lastUsedAt: null,
      };
      apiKeys.set(key.id, key);
      return { key, secret };
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
      if (key && !key.revokedAt) key.revokedAt = now();
    },

    async listApiKeys(accountId) {
      return [...apiKeys.values()]
        .filter((k) => k.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async postLedger(entry) {
      const account = requireAccount(entry.accountId);
      const balanceAfterMicroUsd = account.balanceMicroUsd + entry.amountMicroUsd;
      const full: LedgerEntry = { ...entry, id: randomUUID(), balanceAfterMicroUsd, createdAt: now() };
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
      const full: UsageRecord = { ...record, id: randomUUID(), createdAt: now() };
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

  return Object.assign(store, {
    async listAccounts(opts?: { limit?: number }) {
      const list = [...accounts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return opts?.limit ? list.slice(0, opts.limit) : list;
    },
    async close() {
      // Nothing to release; a real PgBillingStore closes its pool here.
    },
  });
}

/** The mocked Stripe SDK from `packages/stripe/src/setup.test.ts`, unchanged. */
function mockStripeSdk(): Stripe {
  const products: Array<{ id: string; name: string; active: boolean }> = [];
  const prices: Array<{ id: string; lookup_key: string; active: boolean }> = [];
  const webhookEndpoints: Array<{ id: string; url: string }> = [];
  let seq = 0;

  return {
    products: {
      async list() {
        return { data: products };
      },
      async create(params: { name: string }) {
        const product = { id: `prod_${++seq}`, name: params.name, active: true };
        products.push(product);
        return product;
      },
    },
    prices: {
      async list(params: { lookup_keys: string[] }) {
        return { data: prices.filter((p) => params.lookup_keys.includes(p.lookup_key) && p.active) };
      },
      async create(params: { lookup_key: string }) {
        const price = { id: `price_${++seq}`, lookup_key: params.lookup_key, active: true };
        prices.push(price);
        return price;
      },
    },
    webhookEndpoints: {
      async list() {
        return { data: webhookEndpoints };
      },
      async create(params: { url: string }) {
        const endpoint = { id: `we_${++seq}`, url: params.url, secret: "whsec_generated" };
        webhookEndpoints.push(endpoint);
        return endpoint;
      },
    },
  } as unknown as Stripe;
}

/** Same shape as `packages/provisioning/src/reconcile.test.ts`'s `fakeClient`. */
function fakeProvisioningClient(usageUsd: number): OpenRouterProvisioningClient {
  return {
    getKey: vi.fn(async () => ({
      hash: "hash_1",
      name: "milo-acct",
      disabled: false,
      limitUsd: 100,
      limitRemainingUsd: 100 - usageUsd,
      usageUsd,
    })),
    createKey: vi.fn(),
    updateKey: vi.fn(),
    deleteKey: vi.fn(),
    listKeys: vi.fn(),
    getCredits: vi.fn(),
  } as unknown as OpenRouterProvisioningClient;
}

function deps(overrides: Partial<CliDeps> = {}, store?: BillingAdminStore) {
  const built = createTestDeps({
    openBillingStore: async () => store ?? createFakeBillingAdminStore(),
    ...overrides,
  });
  return built;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("milo billing: dispatch", () => {
  it("prints help and exits 0 on --help / -h / help", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { deps: d, stdout } = deps();
      expect(await run([flag], d)).toBe(0);
      expect(stdout.toString()).toContain("Usage: milo billing <subcommand>");
    }
  });

  it("prints help to stderr and exits 1 with no subcommand", async () => {
    const { deps: d, stderr } = deps();
    expect(await run([], d)).toBe(1);
    expect(stderr.toString()).toContain("Usage: milo billing <subcommand>");
  });

  it("exits 1 on an unknown subcommand, naming it", async () => {
    const { deps: d, stderr } = deps();
    expect(await run(["frobnicate"], d)).toBe(1);
    expect(stderr.toString()).toContain('unknown subcommand "frobnicate"');
  });

  it("exits 1 when --db is missing and MILO_DATABASE_URL is not set", async () => {
    const { deps: d, stderr } = deps({ env: {} });
    expect(await run(["accounts"], d)).toBe(1);
    expect(stderr.toString()).toContain("MILO_DATABASE_URL is required");
  });

  it("reads the database url from MILO_DATABASE_URL when --db is not given", async () => {
    const store = createFakeBillingAdminStore();
    await store.createAccount("a@example.com");
    const openBillingStore = vi.fn(async (url: string) => {
      expect(url).toBe("postgres://env-url");
      return store;
    });
    const { deps: d, stdout } = deps({ env: { MILO_DATABASE_URL: "postgres://env-url" }, openBillingStore });
    expect(await run(["accounts"], d)).toBe(0);
    expect(openBillingStore).toHaveBeenCalledWith("postgres://env-url");
    expect(stdout.toString()).toContain("a@example.com");
  });
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

describe("milo billing accounts", () => {
  it("lists accounts newest first, with balances as dollars", async () => {
    const store = createFakeBillingAdminStore();
    const a = await store.createAccount("first@example.com");
    await new Promise((r) => setTimeout(r, 2));
    await store.createAccount("second@example.com");
    await store.postLedger({ accountId: a.id, kind: "credit_purchase", amountMicroUsd: 5_000_000, reference: "seed" });

    const { deps: d, stdout } = deps({}, store);
    const code = await run(["accounts", "--db", "x"], d);

    expect(code).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("first@example.com");
    expect(out).toContain("second@example.com");
    expect(out).toContain("$5.0000");
    // Newest first.
    expect(out.indexOf("second@example.com")).toBeLessThan(out.indexOf("first@example.com"));
  });

  it("prints a placeholder for no accounts", async () => {
    const { deps: d, stdout } = deps({}, createFakeBillingAdminStore());
    expect(await run(["accounts", "--db", "x"], d)).toBe(0);
    expect(stdout.toString()).toContain("(no accounts)");
  });

  it("rejects a non-positive --limit", async () => {
    const { deps: d, stderr } = deps({}, createFakeBillingAdminStore());
    expect(await run(["accounts", "--db", "x", "--limit", "0"], d)).toBe(1);
    expect(stderr.toString()).toContain("--limit must be a positive integer");
  });
});

// ---------------------------------------------------------------------------
// grant
// ---------------------------------------------------------------------------

describe("milo billing grant", () => {
  it("posts a ledger credit and prints the new balance", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");

    const { deps: d, stdout } = deps({}, store);
    const code = await run(["grant", account.id, "10", "--note", "goodwill", "--db", "x"], d);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Granted $10.0000");
    expect(stdout.toString()).toContain("New balance: $10.0000");
    const ledger = await store.listLedger(account.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reference).toBe("goodwill");
    expect(ledger[0]!.kind).toBe("adjustment");
  });

  it("requires --note", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    const { deps: d, stderr } = deps({}, store);

    expect(await run(["grant", account.id, "10", "--db", "x"], d)).toBe(1);
    expect(stderr.toString()).toContain("--note is required");
  });

  it("requires a non-zero numeric amount", async () => {
    const { deps: d, stderr } = deps({}, createFakeBillingAdminStore());
    expect(await run(["grant", "acct_1", "not-a-number", "--note", "x", "--db", "x"], d)).toBe(1);
    expect(stderr.toString()).toContain("<usd> must be a non-zero number");
  });

  it("surfaces an unknown account as an error, exit 1", async () => {
    const { deps: d, stderr } = deps({}, createFakeBillingAdminStore());
    expect(await run(["grant", "no-such-account", "10", "--note", "x", "--db", "x"], d)).toBe(1);
    expect(stderr.toString()).toContain("no-such-account");
  });
});

// ---------------------------------------------------------------------------
// keys / revoke-key
// ---------------------------------------------------------------------------

describe("milo billing keys / revoke-key", () => {
  it("lists an account's keys and marks a revoked one", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    const { key } = await store.createApiKey(account.id, "laptop");

    const before = deps({}, store);
    expect(await run(["keys", account.id, "--db", "x"], before.deps)).toBe(0);
    expect(before.stdout.toString()).toContain("laptop");
    expect(before.stdout.toString()).toContain("active");

    const revoke = deps({}, store);
    expect(await run(["revoke-key", key.id, "--db", "x"], revoke.deps)).toBe(0);
    expect(revoke.stdout.toString()).toContain(`Revoked key ${key.id}`);

    const after = deps({}, store);
    expect(await run(["keys", account.id, "--db", "x"], after.deps)).toBe(0);
    expect(after.stdout.toString()).toContain("revoked");
  });

  it("prints a placeholder for an account with no keys", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    const { deps: d, stdout } = deps({}, store);
    expect(await run(["keys", account.id, "--db", "x"], d)).toBe(0);
    expect(stdout.toString()).toContain("(no keys)");
  });

  it("requires an <accountId> / <keyId> positional", async () => {
    const { deps: d1, stderr: e1 } = deps({}, createFakeBillingAdminStore());
    expect(await run(["keys", "--db", "x"], d1)).toBe(1);
    expect(e1.toString()).toContain("missing <accountId>");

    const { deps: d2, stderr: e2 } = deps({}, createFakeBillingAdminStore());
    expect(await run(["revoke-key", "--db", "x"], d2)).toBe(1);
    expect(e2.toString()).toContain("missing <keyId>");
  });
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe("milo billing usage", () => {
  it("summarizes requests, charges, and per-model counts", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "openai/gpt-5.6-luna",
      inputTokens: 100,
      outputTokens: 50,
      upstreamCostMicroUsd: 1_000_000,
      chargedMicroUsd: 1_150_050,
    });

    const { deps: d, stdout } = deps({}, store);
    expect(await run(["usage", account.id, "--db", "x"], d)).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("Requests: 1");
    expect(out).toContain("Charged: $1.1501");
    expect(out).toContain("openai/gpt-5.6-luna: 1");
  });

  it("rejects an invalid --since", async () => {
    const { deps: d, stderr } = deps({}, createFakeBillingAdminStore());
    expect(await run(["usage", "acct_1", "--since", "not-a-date", "--db", "x"], d)).toBe(1);
    expect(stderr.toString()).toContain("--since is not a valid ISO 8601 timestamp");
  });
});

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

describe("milo billing ledger", () => {
  it("lists ledger entries newest first", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: 5_000_000, reference: "cs_1" });

    const { deps: d, stdout } = deps({}, store);
    expect(await run(["ledger", account.id, "--db", "x"], d)).toBe(0);
    expect(stdout.toString()).toContain("cs_1");
    expect(stdout.toString()).toContain("credit_purchase");
  });
});

// ---------------------------------------------------------------------------
// stripe-setup
// ---------------------------------------------------------------------------

describe("milo billing stripe-setup", () => {
  it("prints the signing secret once, on the first run against a url", async () => {
    const sdk = mockStripeSdk();
    const createStripeClientFake = vi.fn((opts?: { webhookSecret?: string }) =>
      createStripeClient({ sdk, webhookSecret: opts?.webhookSecret ?? "whsec_test" }),
    );

    const first = deps({ createStripeClient: createStripeClientFake });
    const code1 = await run(["stripe-setup", "--webhook-url", "https://milo.dev/webhook"], first.deps);
    expect(code1).toBe(0);
    expect(first.stdout.toString()).toContain("Signing secret (shown once): whsec_generated");
    expect(first.stdout.toString()).toContain("STRIPE_WEBHOOK_SECRET");

    const second = deps({ createStripeClient: createStripeClientFake });
    const code2 = await run(["stripe-setup", "--webhook-url", "https://milo.dev/webhook"], second.deps);
    expect(code2).toBe(0);
    expect(second.stdout.toString()).not.toContain("Signing secret");
    expect(second.stdout.toString()).toContain("already existed");
  });

  it("requires --webhook-url", async () => {
    const { deps: d, stderr } = deps();
    expect(await run(["stripe-setup"], d)).toBe(1);
    expect(stderr.toString()).toContain("--webhook-url is required");
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe("milo billing reconcile", () => {
  it("reports per-account discrepancies and a total", async () => {
    const store = createFakeBillingAdminStore();
    const account = await store.createAccount("a@example.com");
    await store.updateAccount(account.id, { openRouterSubKeyHash: "hash_1", openRouterSubKeyEnc: "enc_1" });
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "some/model",
      inputTokens: 10,
      outputTokens: 10,
      upstreamCostMicroUsd: 1_000_000,
      chargedMicroUsd: 1_150_050,
    });

    const client = fakeProvisioningClient(2); // OpenRouter saw $2, Milo only recorded $1.
    const { deps: d, stdout } = deps({ createProvisioningClient: () => client }, store);

    expect(await run(["reconcile", "--db", "x"], d)).toBe(0);
    const out = stdout.toString();
    expect(out).toContain(account.id);
    expect(out).toContain("posted");
    expect(out).toContain("Total posted: $1.0000");
  });

  it("exits 1 when the provisioning client cannot be built", async () => {
    const { deps: d, stderr } = deps({
      createProvisioningClient: () => {
        throw new Error("OPENROUTER_PROVISIONING_KEY is not set");
      },
    });
    expect(await run(["reconcile", "--db", "x"], d)).toBe(1);
    expect(stderr.toString()).toContain("OPENROUTER_PROVISIONING_KEY is not set");
  });
});
