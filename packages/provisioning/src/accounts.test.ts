import { randomBytes } from "node:crypto";
import { usdToMicro } from "@milo/core";
import { describe, expect, it, vi } from "vitest";
import { disableSubKey, ensureSubKey, syncLimit } from "./accounts.js";
import type { OpenRouterProvisioningClient } from "./client.js";
import { decryptSecret } from "./crypto.js";
import { createInMemoryBillingStore } from "./test-support.js";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");

function fakeClient(overrides: Partial<OpenRouterProvisioningClient> = {}): OpenRouterProvisioningClient {
  return {
    createKey: vi.fn(async ({ name }: { name: string; limitUsd?: number }) => ({
      key: `sk-or-v1-${name}`,
      hash: `hash_${name}`,
      id: `hash_${name}`,
    })),
    updateKey: vi.fn(async () => ({
      hash: "hash",
      name: "milo",
      disabled: false,
      limitUsd: null,
      limitRemainingUsd: null,
      usageUsd: 0,
    })),
    getKey: vi.fn(),
    deleteKey: vi.fn(),
    listKeys: vi.fn(),
    getCredits: vi.fn(),
    ...overrides,
  } as unknown as OpenRouterProvisioningClient;
}

describe("ensureSubKey", () => {
  it("creates a sub-key named milo-<accountId> with a limit equal to the balance, and stores hash + encrypted key, never the plaintext", async () => {
    const store = createInMemoryBillingStore();
    const account = await store.createAccount("a@example.com");
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: usdToMicro(7.5), reference: "test" });
    const fresh = (await store.getAccount(account.id))!;

    const client = fakeClient();
    const updated = await ensureSubKey({ store, client, encryptionKey: ENCRYPTION_KEY, account: fresh });

    expect(client.createKey).toHaveBeenCalledWith({ name: `milo-${account.id}`, limitUsd: 7.5 });
    expect(updated.openRouterSubKeyHash).toBe(`hash_milo-${account.id}`);
    expect(updated.openRouterSubKeyEnc).toBeTruthy();
    expect(updated.openRouterSubKeyEnc).not.toContain("sk-or-v1-");
    expect(decryptSecret(updated.openRouterSubKeyEnc!, ENCRYPTION_KEY)).toBe(`sk-or-v1-milo-${account.id}`);

    // Stored copy never carries the plaintext key.
    const stored = JSON.stringify(await store.getAccount(account.id));
    expect(stored).not.toContain(`sk-or-v1-milo-${account.id}`);
  });

  it("is a no-op when the account already has a sub-key", async () => {
    const store = createInMemoryBillingStore();
    let account = await store.createAccount("a@example.com");
    account = await store.updateAccount(account.id, { openRouterSubKeyHash: "existing_hash", openRouterSubKeyEnc: "existing_enc" });

    const client = fakeClient();
    const result = await ensureSubKey({ store, client, encryptionKey: ENCRYPTION_KEY, account });

    expect(client.createKey).not.toHaveBeenCalled();
    expect(result.openRouterSubKeyHash).toBe("existing_hash");
  });

  it("floors the limit at 0 for a negative balance", async () => {
    const store = createInMemoryBillingStore();
    const account = await store.createAccount("a@example.com");
    await store.postLedger({ accountId: account.id, kind: "usage", amountMicroUsd: usdToMicro(-3), reference: "test" });
    const fresh = (await store.getAccount(account.id))!;

    const client = fakeClient();
    await ensureSubKey({ store, client, encryptionKey: ENCRYPTION_KEY, account: fresh });

    expect(client.createKey).toHaveBeenCalledWith({ name: `milo-${account.id}`, limitUsd: 0 });
  });
});

describe("syncLimit", () => {
  it("sends the current balance in USD rounded to cents", async () => {
    const store = createInMemoryBillingStore();
    let account = await store.createAccount("a@example.com");
    account = await store.updateAccount(account.id, { openRouterSubKeyHash: "hash_1", openRouterSubKeyEnc: "enc_1" });
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: usdToMicro(10.005), reference: "test" });

    const client = fakeClient();
    await syncLimit({ store, client, account });

    expect(client.updateKey).toHaveBeenCalledWith("hash_1", { limitUsd: 10.01 });
  });

  it("re-reads the account so a stale balance passed by the caller doesn't win", async () => {
    const store = createInMemoryBillingStore();
    let account = await store.createAccount("a@example.com");
    account = await store.updateAccount(account.id, { openRouterSubKeyHash: "hash_1", openRouterSubKeyEnc: "enc_1" });
    const staleAccount = account;
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: usdToMicro(20), reference: "test" });

    const client = fakeClient();
    await syncLimit({ store, client, account: staleAccount });

    expect(client.updateKey).toHaveBeenCalledWith("hash_1", { limitUsd: 20 });
  });

  it("does nothing when there is no sub-key yet", async () => {
    const store = createInMemoryBillingStore();
    const account = await store.createAccount("a@example.com");
    const client = fakeClient();

    await syncLimit({ store, client, account });

    expect(client.updateKey).not.toHaveBeenCalled();
  });
});

describe("disableSubKey", () => {
  it("disables the sub-key on OpenRouter", async () => {
    const store = createInMemoryBillingStore();
    let account = await store.createAccount("a@example.com");
    account = await store.updateAccount(account.id, { openRouterSubKeyHash: "hash_1", openRouterSubKeyEnc: "enc_1" });

    const client = fakeClient();
    await disableSubKey({ client, account });

    expect(client.updateKey).toHaveBeenCalledWith("hash_1", { disabled: true });
  });

  it("does nothing when there is no sub-key", async () => {
    const store = createInMemoryBillingStore();
    const account = await store.createAccount("a@example.com");
    const client = fakeClient();

    await disableSubKey({ client, account });

    expect(client.updateKey).not.toHaveBeenCalled();
  });
});
