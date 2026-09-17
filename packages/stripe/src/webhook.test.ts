import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createStripeClient } from "./client.js";
import { handleStripeWebhook, WebhookSignatureError } from "./webhook.js";
import { createFakeBillingStore } from "./test-support/fake-billing-store.js";

function mockSdk(constructEvent: (rawBody: string | Buffer, signature: string, secret: string) => Stripe.Event) {
  return { webhooks: { constructEvent } } as unknown as Stripe;
}

function checkoutCompletedEvent(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Event {
  return {
    id: "evt_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 500, // $5.00
        client_reference_id: "acc_1",
        metadata: { accountId: "acc_1", packId: "pack_5" },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function chargeRefundedEvent(overrides: Partial<Stripe.Charge> = {}): Stripe.Event {
  return {
    id: "evt_refund_1",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_1",
        amount_refunded: 500,
        metadata: { accountId: "acc_1", packId: "pack_5" },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

describe("handleStripeWebhook", () => {
  it("rejects a bad signature", async () => {
    const store = createFakeBillingStore();
    const sdk = mockSdk(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    await expect(
      handleStripeWebhook({ store, stripe, rawBody: "{}", signature: "bad" }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("credits the account exactly once across two deliveries of the same event", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("a@example.com");
    const event = checkoutCompletedEvent({ client_reference_id: account.id });
    const sdk = mockSdk(() => event);
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const credited: Array<{ accountId: string; amountMicroUsd: number }> = [];
    const onCredited = async (args: { accountId: string; amountMicroUsd: number }) => {
      credited.push(args);
    };

    const first = await handleStripeWebhook({
      store,
      stripe,
      rawBody: "{}",
      signature: "sig",
      onCredited,
    });
    const second = await handleStripeWebhook({
      store,
      stripe,
      rawBody: "{}",
      signature: "sig",
      onCredited,
    });

    expect(first).toEqual({ handled: true, type: "checkout.session.completed" });
    expect(second).toEqual({ handled: true, type: "checkout.session.completed" });

    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]?.kind).toBe("credit_purchase");
    expect(store.ledger[0]?.amountMicroUsd).toBe(5_000_000); // $5.00
    expect(store.ledger[0]?.reference).toBe("cs_1");

    const updated = await store.getAccount(account.id);
    expect(updated?.balanceMicroUsd).toBe(5_000_000);

    // onCredited only fires for the delivery that actually applied the credit.
    expect(credited).toEqual([{ accountId: account.id, amountMicroUsd: 5_000_000 }]);
  });

  it("ignores a checkout.session.completed event that hasn't actually been paid", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("a@example.com");
    const event = checkoutCompletedEvent({ client_reference_id: account.id, payment_status: "unpaid" });
    const sdk = mockSdk(() => event);
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const result = await handleStripeWebhook({ store, stripe, rawBody: "{}", signature: "sig" });

    expect(result).toEqual({ handled: false, type: "checkout.session.completed" });
    expect(store.ledger).toHaveLength(0);
  });

  it("posts a negative refund entry exactly once across two deliveries", async () => {
    const store = createFakeBillingStore();
    const account = await store.createAccount("a@example.com");
    await store.postLedger({ accountId: account.id, kind: "credit_purchase", amountMicroUsd: 5_000_000, reference: "cs_1" });

    const event = chargeRefundedEvent({ metadata: { accountId: account.id, packId: "pack_5" } });
    const sdk = mockSdk(() => event);
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    await handleStripeWebhook({ store, stripe, rawBody: "{}", signature: "sig" });
    await handleStripeWebhook({ store, stripe, rawBody: "{}", signature: "sig" });

    const refunds = store.ledger.filter((e) => e.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amountMicroUsd).toBe(-5_000_000);
    expect(refunds[0]?.reference).toBe("ch_1");

    const updated = await store.getAccount(account.id);
    expect(updated?.balanceMicroUsd).toBe(0);
  });

  it("ignores event types it doesn't handle", async () => {
    const store = createFakeBillingStore();
    const event = { id: "evt_other", type: "customer.created", data: { object: {} } } as unknown as Stripe.Event;
    const sdk = mockSdk(() => event);
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const result = await handleStripeWebhook({ store, stripe, rawBody: "{}", signature: "sig" });

    expect(result).toEqual({ handled: false, type: "customer.created" });
    expect(store.ledger).toHaveLength(0);
  });
});
