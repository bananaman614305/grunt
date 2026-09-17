/**
 * Every test that needs a database lives in this file on purpose. With
 * `MILO_TEST_DATABASE_URL` set they all share one server, and vitest runs
 * separate files in parallel, so a second database file would mean two
 * processes dropping each other's tables mid-run.
 */
import { DEFAULT_PRICING } from "@milo/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { grantCredit, listAccounts } from "./admin.js";
import { sha256Hex } from "./crypto.js";
import { appliedVersions, loadMigrations, migrate } from "./migrate.js";
import type { Db } from "./sql.js";
import { InsufficientBalanceError, PgBillingStore } from "./store.js";
import { openTestDb } from "./test-db.js";

let db: Db;
let store: PgBillingStore;

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  store = new PgBillingStore(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

let email = 0;
function nextEmail(): string {
  email += 1;
  return `user${email}-${Date.now()}@example.com`;
}

async function newAccount() {
  return store.createAccount(nextEmail());
}

describe("migrations", () => {
  it("ships numbered files starting at 1", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    expect(migrations[0]?.name).toBe("001_billing.sql");
  });

  it("is idempotent: a second run applies nothing", async () => {
    const before = await appliedVersions(db);
    expect(before.length).toBeGreaterThan(0);

    expect(await migrate(db)).toEqual([]);
    expect(await migrate(db)).toEqual([]);
    expect(await appliedVersions(db)).toEqual(before);
  });

  it("applies everything to an empty database", async () => {
    const fresh = await openTestDb();
    try {
      const applied = await migrate(fresh);
      expect(applied.map((m) => m.version)).toEqual((await loadMigrations()).map((m) => m.version));
      expect(await migrate(fresh)).toEqual([]);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("creates every table the contract needs", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(
      ["accounts", "api_keys", "ledger_entries", "schema_migrations", "stripe_events", "usage_records"].sort(),
    );
  });
});

describe("accounts", () => {
  it("creates, reads back, and starts at a zero balance", async () => {
    const address = nextEmail();
    const account = await store.createAccount(address);

    expect(account.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(account.email).toBe(address);
    expect(account.balanceMicroUsd).toBe(0);
    expect(account.status).toBe("active");
    expect(account.stripeCustomerId).toBeNull();
    expect(account.openRouterSubKeyEnc).toBeNull();
    expect(new Date(account.createdAt).toISOString()).toBe(account.createdAt);

    expect(await store.getAccount(account.id)).toEqual(account);
    expect(await store.getAccountByEmail(address.toUpperCase())).toEqual(account);
  });

  it("returns undefined for an account that does not exist", async () => {
    expect(await store.getAccount("00000000000000000000000000")).toBeUndefined();
    expect(await store.getAccountByEmail("nobody@example.com")).toBeUndefined();
  });

  it("refuses a second account on the same email", async () => {
    const address = nextEmail();
    await store.createAccount(address);
    await expect(store.createAccount(address)).rejects.toThrow();
  });

  it("patches the fields the gateway and Stripe set", async () => {
    const account = await newAccount();
    const patched = await store.updateAccount(account.id, {
      stripeCustomerId: "cus_123",
      openRouterSubKeyEnc: "v1.aaa.bbb.ccc",
      openRouterSubKeyHash: "orhash",
      status: "suspended",
    });

    expect(patched.stripeCustomerId).toBe("cus_123");
    expect(patched.openRouterSubKeyEnc).toBe("v1.aaa.bbb.ccc");
    expect(patched.openRouterSubKeyHash).toBe("orhash");
    expect(patched.status).toBe("suspended");
    expect(patched.createdAt).toBe(account.createdAt);
    expect(new Date(patched.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(account.updatedAt).getTime());
  });

  it("refuses to patch the balance, which only the ledger moves", async () => {
    const account = await newAccount();
    await expect(store.updateAccount(account.id, { balanceMicroUsd: 999 })).rejects.toThrow(/use postLedger/);
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(0);
  });

  it("throws when patching an account that does not exist", async () => {
    await expect(store.updateAccount("00000000000000000000000000", { status: "suspended" })).rejects.toThrow(
      /no account/,
    );
  });

  it("lists accounts newest first", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const listed = await listAccounts(store, { limit: 2 });
    expect(listed.map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("api keys", () => {
  it("mints mk_ + 32 bytes of base64url and returns the secret once", async () => {
    const account = await newAccount();
    const { key, secret } = await store.createApiKey(account.id, "laptop");

    expect(secret.startsWith("mk_")).toBe(true);
    const random = secret.slice("mk_".length);
    expect(random).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, unpadded base64url
    expect(Buffer.from(random, "base64url")).toHaveLength(32);

    expect(key.keyHash).toBe(sha256Hex(secret));
    expect(key.prefix).toBe(random.slice(0, 8));
    expect(key.name).toBe("laptop");
    expect(key.accountId).toBe(account.id);
    expect(key.revokedAt).toBeNull();
    expect(key.lastUsedAt).toBeNull();
  });

  it("mints a different secret every time", async () => {
    const account = await newAccount();
    const first = await store.createApiKey(account.id, "a");
    const second = await store.createApiKey(account.id, "b");
    expect(first.secret).not.toBe(second.secret);
    expect(first.key.keyHash).not.toBe(second.key.keyHash);
  });

  it("finds a key by hash and joins its account", async () => {
    const account = await newAccount();
    await store.updateAccount(account.id, { stripeCustomerId: "cus_join" });
    const { key, secret } = await store.createApiKey(account.id, "server");

    const found = await store.findApiKeyByHash(sha256Hex(secret));
    expect(found?.id).toBe(key.id);
    expect(found?.account.id).toBe(account.id);
    expect(found?.account.stripeCustomerId).toBe("cus_join");
    expect(found?.account.balanceMicroUsd).toBe(0);
  });

  it("does not find an unknown hash", async () => {
    expect(await store.findApiKeyByHash(sha256Hex("mk_nope"))).toBeUndefined();
  });

  it("ignores revoked keys", async () => {
    const account = await newAccount();
    const { key, secret } = await store.createApiKey(account.id, "old");

    expect(await store.findApiKeyByHash(sha256Hex(secret))).toBeDefined();
    await store.revokeApiKey(key.id);
    expect(await store.findApiKeyByHash(sha256Hex(secret))).toBeUndefined();

    // Still listed, so the account page can show what was revoked and when.
    const listed = await store.listApiKeys(account.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).not.toBeNull();

    // Revoking twice is a no-op, not an error, and does not move revoked_at.
    await store.revokeApiKey(key.id);
    expect((await store.listApiKeys(account.id))[0]?.revokedAt).toBe(listed[0]?.revokedAt);
  });

  it("touches last_used_at at most once a minute", async () => {
    const account = await newAccount();
    const { secret } = await store.createApiKey(account.id, "hot");

    const first = await store.findApiKeyByHash(sha256Hex(secret));
    expect(first?.lastUsedAt).not.toBeNull();

    const second = await store.findApiKeyByHash(sha256Hex(secret));
    const third = await store.findApiKeyByHash(sha256Hex(secret));
    expect(second?.lastUsedAt).toBe(first?.lastUsedAt);
    expect(third?.lastUsedAt).toBe(first?.lastUsedAt);

    // Backdate past the window and it writes again.
    await db.query("UPDATE api_keys SET last_used_at = now() - interval '2 hours' WHERE account_id = $1", [account.id]);
    const later = await store.findApiKeyByHash(sha256Hex(secret));
    expect(later?.lastUsedAt).not.toBe(first?.lastUsedAt);
  });

  it("lists an account's keys newest first and nobody else's", async () => {
    const mine = await newAccount();
    const theirs = await newAccount();
    const a = await store.createApiKey(mine.id, "a");
    const b = await store.createApiKey(mine.id, "b");
    await store.createApiKey(theirs.id, "theirs");

    expect((await store.listApiKeys(mine.id)).map((k) => k.id)).toEqual([b.key.id, a.key.id]);
    expect(await store.listApiKeys(theirs.id)).toHaveLength(1);
  });

  it("stores no plaintext: the secret appears in no column of any table", async () => {
    const account = await newAccount();
    const { key, secret } = await store.createApiKey(account.id, "audit");
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: 1_000, reference: "cs_1" });
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: key.id,
      decisionId: "dec_1",
      model: "openai/gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 20,
      upstreamCostMicroUsd: 100,
      chargedMicroUsd: 165,
    });
    await store.markStripeEvent("evt_audit");
    await store.findApiKeyByHash(sha256Hex(secret));

    const { rows: tables } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.length).toBeGreaterThan(0);

    const random = secret.slice("mk_".length);
    for (const { table_name } of tables) {
      const { rows } = await db.query(`SELECT * FROM "${table_name}"`);
      const dump = JSON.stringify(rows);
      expect(dump, `${table_name} holds the plaintext key`).not.toContain(secret);
      expect(dump, `${table_name} holds the key's random part`).not.toContain(random);
    }

    // The prefix is stored, and that is all of the key that ever is.
    const stored = (await store.listApiKeys(account.id))[0];
    expect(stored?.prefix).toBe(random.slice(0, 8));
    expect(secret).toContain(stored?.prefix ?? "");
  });
});

describe("postLedger", () => {
  it("adds, subtracts, and records the balance after each entry", async () => {
    const account = await newAccount();

    const credit = await store.postLedger({
      accountId: account.id,
      kind: "credit_purchase",
      amountMicroUsd: 5_000_000,
      reference: "cs_test_1",
    });
    expect(credit.balanceAfterMicroUsd).toBe(5_000_000);
    expect(credit.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const spend = await store.postLedger({
      accountId: account.id,
      kind: "usage",
      amountMicroUsd: -1_234_567,
      reference: "dec_1",
    });
    expect(spend.balanceAfterMicroUsd).toBe(3_765_433);
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(3_765_433);

    const ledger = await store.listLedger(account.id);
    expect(ledger.map((e) => e.id)).toEqual([spend.id, credit.id]);
    expect(ledger.reduce((sum, e) => sum + e.amountMicroUsd, 0)).toBe(3_765_433);
  });

  it("lets the balance fall to exactly -reserve but no further", async () => {
    const reserve = DEFAULT_PRICING.reserveMicroUsd;
    const account = await newAccount();
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: 1_000, reference: "cs" });

    const toTheFloor = await store.postLedger({
      accountId: account.id,
      kind: "usage",
      amountMicroUsd: -(1_000 + reserve),
      reference: "dec_floor",
    });
    expect(toTheFloor.balanceAfterMicroUsd).toBe(-reserve);

    await expect(
      store.postLedger({ accountId: account.id, kind: "usage", amountMicroUsd: -1, reference: "dec_over" }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    // The rejected spend left nothing behind.
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(-reserve);
    expect(await store.listLedger(account.id)).toHaveLength(2);
  });

  it("honours a custom reserve", async () => {
    const tight = new PgBillingStore(db, { reserveMicroUsd: 0 });
    const account = await tight.createAccount(nextEmail());
    await tight.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: 100, reference: "cs" });

    await expect(
      tight.postLedger({ accountId: account.id, kind: "usage", amountMicroUsd: -101, reference: "dec" }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const ok = await tight.postLedger({
      accountId: account.id,
      kind: "usage",
      amountMicroUsd: -100,
      reference: "dec",
    });
    expect(ok.balanceAfterMicroUsd).toBe(0);
  });

  it("never lets a credit be refused for lack of balance", async () => {
    const account = await newAccount();
    await store.postLedger({ accountId: account.id, kind: "adjustment", amountMicroUsd: -0, reference: "zero" });
    const credit = await store.postLedger({
      accountId: account.id,
      kind: "refund",
      amountMicroUsd: 42,
      reference: "re_1",
    });
    expect(credit.balanceAfterMicroUsd).toBe(42);
  });

  it("throws for an account that does not exist", async () => {
    await expect(
      store.postLedger({
        accountId: "00000000000000000000000000",
        kind: "usage",
        amountMicroUsd: -1,
        reference: "x",
      }),
    ).rejects.toThrow(/no account/);
  });

  it("keeps the arithmetic right under 20 concurrent spends", async () => {
    const reserve = DEFAULT_PRICING.reserveMicroUsd; // 50_000
    const account = await newAccount();
    await store.postLedger({
      accountId: account.id,
      kind: "credit_purchase",
      amountMicroUsd: 1_000_000,
      reference: "cs_concurrent",
    });

    // 105_000 each: nine fit inside the credit, the tenth lands exactly on the
    // -50_000 floor, and the rest must be refused.
    const spend = 105_000;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        store.postLedger({ accountId: account.id, kind: "usage", amountMicroUsd: -spend, reference: `dec_${i}` }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientBalanceError);
    }

    const finalBalance = 1_000_000 - 10 * spend;
    expect(finalBalance).toBe(-reserve);
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(finalBalance);

    // Every successful spend wrote an entry, and the running balances form the
    // sequence they would have if the spends had been serial.
    const ledger = await store.listLedger(account.id, { limit: 100 });
    expect(ledger).toHaveLength(11);
    const balances = ledger.map((e) => e.balanceAfterMicroUsd).sort((a, b) => b - a);
    expect(balances).toEqual([1_000_000, 895_000, 790_000, 685_000, 580_000, 475_000, 370_000, 265_000, 160_000, 55_000, -50_000]);
    expect(ledger.reduce((sum, e) => sum + e.amountMicroUsd, 0)).toBe(finalBalance);
  }, 30_000);

  it("caps and orders listLedger", async () => {
    const account = await newAccount();
    for (let i = 0; i < 5; i += 1) {
      await store.postLedger({ accountId: account.id, kind: "adjustment", amountMicroUsd: 1, reference: `n${i}` });
    }
    const all = await store.listLedger(account.id);
    expect(all).toHaveLength(5);
    expect(all[0]?.reference).toBe("n4");
    expect(await store.listLedger(account.id, { limit: 2 })).toHaveLength(2);
    expect(await store.listLedger(account.id, { limit: 0 })).toHaveLength(1); // clamped to 1
  });
});

describe("grantCredit", () => {
  it("posts an adjustment carrying the operator's note", async () => {
    const account = await newAccount();
    const entry = await grantCredit(store, account.id, 2_500_000, "goodwill: support ticket 12");

    expect(entry.kind).toBe("adjustment");
    expect(entry.amountMicroUsd).toBe(2_500_000);
    expect(entry.reference).toBe("goodwill: support ticket 12");
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(2_500_000);
  });

  it("refuses a zero, fractional, or unexplained grant", async () => {
    const account = await newAccount();
    await expect(grantCredit(store, account.id, 0, "nope")).rejects.toThrow(/non-zero integer/);
    await expect(grantCredit(store, account.id, 1.5, "nope")).rejects.toThrow(/non-zero integer/);
    await expect(grantCredit(store, account.id, 100, "  ")).rejects.toThrow(/needs a note/);
  });
});

describe("usage", () => {
  let accountId: string;
  let apiKeyId: string;

  beforeEach(async () => {
    const account = await newAccount();
    accountId = account.id;
    apiKeyId = (await store.createApiKey(account.id, "usage")).key.id;
  });

  it("records and reads back a charged request", async () => {
    const record = await store.recordUsage({
      accountId,
      apiKeyId,
      decisionId: "dec_abc",
      model: "anthropic/claude-haiku",
      inputTokens: 1_200,
      outputTokens: 340,
      upstreamCostMicroUsd: 4_000,
      chargedMicroUsd: 4_650,
    });

    expect(record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(record.decisionId).toBe("dec_abc");
    expect(record.inputTokens).toBe(1_200);
    expect(record.chargedMicroUsd).toBe(4_650);
  });

  it("accepts a null decision id for explicit-model passthrough", async () => {
    const record = await store.recordUsage({
      accountId,
      apiKeyId,
      decisionId: null,
      model: "openai/gpt-4o",
      inputTokens: 1,
      outputTokens: 1,
      upstreamCostMicroUsd: 1,
      chargedMicroUsd: 2,
    });
    expect(record.decisionId).toBeNull();
  });

  it("summarises requests, money, and models", async () => {
    const rows: Array<[string, number, number]> = [
      ["openai/gpt-4o-mini", 1_000, 1_200],
      ["openai/gpt-4o-mini", 2_000, 2_350],
      ["anthropic/claude-haiku", 500, 625],
    ];
    for (const [model, upstream, charged] of rows) {
      await store.recordUsage({
        accountId,
        apiKeyId,
        decisionId: null,
        model,
        inputTokens: 10,
        outputTokens: 10,
        upstreamCostMicroUsd: upstream,
        chargedMicroUsd: charged,
      });
    }

    const summary = await store.usageSummary(accountId);
    expect(summary.requests).toBe(3);
    expect(summary.upstreamCostMicroUsd).toBe(3_500);
    expect(summary.chargedMicroUsd).toBe(4_175);
    expect(summary.byModel).toEqual({ "openai/gpt-4o-mini": 2, "anthropic/claude-haiku": 1 });
  });

  it("is empty for an account with no usage", async () => {
    const other = await newAccount();
    expect(await store.usageSummary(other.id)).toEqual({
      requests: 0,
      chargedMicroUsd: 0,
      upstreamCostMicroUsd: 0,
      byModel: {},
    });
  });

  it("honours the since cutoff", async () => {
    await store.recordUsage({
      accountId,
      apiKeyId,
      decisionId: null,
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      upstreamCostMicroUsd: 1,
      chargedMicroUsd: 1,
    });

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect((await store.usageSummary(accountId, past)).requests).toBe(1);
    expect((await store.usageSummary(accountId, future)).requests).toBe(0);
  });

  it("counts only the account it was asked about", async () => {
    const other = await newAccount();
    const otherKey = (await store.createApiKey(other.id, "k")).key.id;
    await store.recordUsage({
      accountId: other.id,
      apiKeyId: otherKey,
      decisionId: null,
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      upstreamCostMicroUsd: 9,
      chargedMicroUsd: 9,
    });
    expect((await store.usageSummary(accountId)).requests).toBe(0);
    expect((await store.usageSummary(other.id)).requests).toBe(1);
  });
});

describe("markStripeEvent", () => {
  it("is true the first time and false on every retry", async () => {
    const id = `evt_${Date.now()}`;
    expect(await store.markStripeEvent(id)).toBe(true);
    expect(await store.markStripeEvent(id)).toBe(false);
    expect(await store.markStripeEvent(id)).toBe(false);
  });

  it("gives exactly one winner when the same event arrives concurrently", async () => {
    const id = `evt_race_${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => store.markStripeEvent(id)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("keeps different events apart", async () => {
    expect(await store.markStripeEvent(`evt_a_${Date.now()}`)).toBe(true);
    expect(await store.markStripeEvent(`evt_b_${Date.now()}`)).toBe(true);
  });
});
