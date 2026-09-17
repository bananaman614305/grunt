import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createCreditCheckout, UnknownCreditPackError } from "./checkout.js";
import { createStripeClient } from "./client.js";
import { createFakeBillingStore } from "./test-support/fake-billing-store.js";

type CustomersCreateCall = { email?: string; metadata?: Record<string, string> };
type SessionsCreateCall = Stripe.Checkout.SessionCreateParams;

function mockSdk() {
  const customersCreateCalls: CustomersCreateCall[] = [];
  const sessionsCreateCalls: SessionsCreateCall[] = [];
  let customerSeq = 0;

  const sdk = {
    customers: {
      async create(params: CustomersCreateCall) {
        customersCreateCalls.push(params);
        return { id: `cus_${++customerSeq}`, ...params };
      },
    },
    checkout: {
      sessions: {
        async create(params: SessionsCreateCall) {
          sessionsCreateCalls.push(params);
          return {
            id: "cs_test_123",
            url: "https://checkout.stripe.com/c/pay/cs_test_123",
            ...params,
          };
        },
      },
    },
  } as unknown as Stripe;

  return { sdk, customersCreateCalls, sessionsCreateCalls };
}

describe("createCreditCheckout", () => {
  it("rejects an unknown pack", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("a@example.com");
    const { sdk } = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    await expect(
      createCreditCheckout({
        store,
        stripe,
        accountId: account.id,
        packId: "pack_nope",
        successUrl: "https://milo.dev/success",
        cancelUrl: "https://milo.dev/cancel",
      }),
    ).rejects.toBeInstanceOf(UnknownCreditPackError);
  });

  it("creates a Stripe customer when the account has none, and stores it", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("new@example.com");
    const { sdk, customersCreateCalls } = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const result = await createCreditCheckout({
      store,
      stripe,
      accountId: account.id,
      packId: "pack_5",
      successUrl: "https://milo.dev/success",
      cancelUrl: "https://milo.dev/cancel",
    });

    expect(customersCreateCalls).toHaveLength(1);
    expect(customersCreateCalls[0]?.email).toBe("new@example.com");

    const updated = await store.getAccount(account.id);
    expect(updated?.stripeCustomerId).toBe("cus_1");
    expect(result.url).toContain("checkout.stripe.com");
  });

  it("reuses an existing Stripe customer instead of creating a new one", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("existing@example.com");
    await store.updateAccount(account.id, { stripeCustomerId: "cus_existing" });
    const { sdk, customersCreateCalls, sessionsCreateCalls } = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    await createCreditCheckout({
      store,
      stripe,
      accountId: account.id,
      packId: "pack_20",
      successUrl: "https://milo.dev/success",
      cancelUrl: "https://milo.dev/cancel",
    });

    expect(customersCreateCalls).toHaveLength(0);
    expect(sessionsCreateCalls[0]?.customer).toBe("cus_existing");
  });

  it("sets the session's mode, amount, metadata, and client_reference_id from the pack", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("pay@example.com");
    const { sdk, sessionsCreateCalls } = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    await createCreditCheckout({
      store,
      stripe,
      accountId: account.id,
      packId: "pack_100",
      successUrl: "https://milo.dev/success",
      cancelUrl: "https://milo.dev/cancel",
    });

    const call = sessionsCreateCalls[0];
    expect(call?.mode).toBe("payment");
    expect(call?.client_reference_id).toBe(account.id);
    expect(call?.metadata).toEqual({ accountId: account.id, packId: "pack_100" });
    expect(call?.payment_intent_data?.metadata).toEqual({ accountId: account.id, packId: "pack_100" });
    expect(call?.success_url).toBe("https://milo.dev/success");
    expect(call?.cancel_url).toBe("https://milo.dev/cancel");
    const lineItem = call?.line_items?.[0];
    expect(lineItem?.price_data?.unit_amount).toBe(10_000); // pack_100 = $100.00 = 10_000 cents
    expect(lineItem?.price_data?.currency).toBe("usd");
  });
});
