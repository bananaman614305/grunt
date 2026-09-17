import type { Account } from "@milo/core";
import { usdToMicro } from "@milo/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenRouterProvisioningClient } from "./client.js";
import { reconcileUsage } from "./reconcile.js";
import { createInMemoryBillingStore } from "./test-support.js";

function fakeClient(usageUsd: number): OpenRouterProvisioningClient {
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

async function withSubKeyAccount(store: ReturnType<typeof createInMemoryBillingStore>): Promise<Account> {
  const created = await store.createAccount("a@example.com");
  return store.updateAccount(created.id, { openRouterSubKeyHash: "hash_1", openRouterSubKeyEnc: "enc_1" });
}

describe("reconcileUsage", () => {
  it("posts no adjustment when OpenRouter usage matches what Milo recorded", async () => {
    const store = createInMemoryBillingStore();
    const account = await withSubKeyAccount(store);
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "some/model",
      inputTokens: 10,
      outputTokens: 10,
      upstreamCostMicroUsd: usdToMicro(2),
      chargedMicroUsd: usdToMicro(2.3),
    });

    const client = fakeClient(2);
    const summary = await reconcileUsage({ store, client, accounts: [account] });

    expect(summary.accounts).toHaveLength(1);
    expect(summary.accounts[0]!.posted).toBe(false);
    expect(summary.accounts[0]!.discrepancyMicroUsd).toBe(0);
    expect(summary.totalPostedMicroUsd).toBe(0);
    expect(await store.listLedger(account.id)).toHaveLength(0);
  });

  it("posts an adjustment for the difference when OpenRouter reports more spend than Milo charged", async () => {
    const store = createInMemoryBillingStore();
    const account = await withSubKeyAccount(store);
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "some/model",
      inputTokens: 10,
      outputTokens: 10,
      upstreamCostMicroUsd: usdToMicro(2),
      chargedMicroUsd: usdToMicro(2.3),
    });

    // OpenRouter says 5 USD spent total on the sub-key; Milo only recorded 2 USD
    // of usage (a stream got cut before its usage chunk arrived).
    const client = fakeClient(5);
    const summary = await reconcileUsage({ store, client, accounts: [account] });

    expect(summary.accounts[0]!.posted).toBe(true);
    expect(summary.accounts[0]!.discrepancyMicroUsd).toBe(usdToMicro(3));
    expect(summary.totalPostedMicroUsd).toBe(usdToMicro(3));

    const ledger = await store.listLedger(account.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe("adjustment");
    expect(ledger[0]!.amountMicroUsd).toBe(-usdToMicro(3));
    expect(ledger[0]!.reference).toMatch(/^reconcile:hash_1:/);
  });

  it("never posts when Milo charged the same or more than OpenRouter reports", async () => {
    const store = createInMemoryBillingStore();
    const account = await withSubKeyAccount(store);
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "some/model",
      inputTokens: 10,
      outputTokens: 10,
      upstreamCostMicroUsd: usdToMicro(5),
      chargedMicroUsd: usdToMicro(5.75),
    });

    const client = fakeClient(5); // OpenRouter reports exactly what Milo recorded
    const summary = await reconcileUsage({ store, client, accounts: [account] });

    expect(summary.accounts[0]!.posted).toBe(false);
    expect(await store.listLedger(account.id)).toHaveLength(0);
  });

  it("skips accounts with no sub-key provisioned yet", async () => {
    const store = createInMemoryBillingStore();
    const account = await store.createAccount("a@example.com");
    const client = fakeClient(5);

    const summary = await reconcileUsage({ store, client, accounts: [account] });

    expect(summary.accounts).toHaveLength(0);
    expect(client.getKey).not.toHaveBeenCalled();
  });

  it("is idempotent for the same checkpoint: running twice in a row with no new usage posts only once", async () => {
    const store = createInMemoryBillingStore();
    const account = await withSubKeyAccount(store);
    await store.recordUsage({
      accountId: account.id,
      apiKeyId: "key_1",
      decisionId: null,
      model: "some/model",
      inputTokens: 10,
      outputTokens: 10,
      upstreamCostMicroUsd: usdToMicro(2),
      chargedMicroUsd: usdToMicro(2.3),
    });

    const client = fakeClient(5);
    const first = await reconcileUsage({ store, client, accounts: [account] });
    expect(first.accounts[0]!.posted).toBe(true);

    // Nothing changed upstream or in Milo's usage records; re-running must not double-post.
    const refreshed = (await store.getAccount(account.id))!;
    const second = await reconcileUsage({ store, client, accounts: [refreshed] });

    expect(second.accounts[0]!.posted).toBe(false);
    expect(second.accounts[0]!.discrepancyMicroUsd).toBe(0);
    const ledger = await store.listLedger(account.id);
    expect(ledger.filter((e) => e.kind === "adjustment")).toHaveLength(1);
  });
});
