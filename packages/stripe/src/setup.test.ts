import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { CREDIT_PACKS } from "@milo/core";
import { createStripeClient } from "./client.js";
import { ensureStripeProducts, registerWebhook, STRIPE_WEBHOOK_EVENT_TYPES } from "./setup.js";

function mockSdk() {
  const products: Array<{ id: string; name: string; active: boolean }> = [];
  const prices: Array<{ id: string; lookup_key: string; active: boolean }> = [];
  const webhookEndpoints: Array<{ id: string; url: string }> = [];
  let seq = 0;

  const sdk = {
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

  return sdk;
}

describe("ensureStripeProducts", () => {
  it("creates the product and one price per pack, and is idempotent", async () => {
    const sdk = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const first = await ensureStripeProducts(stripe);
    expect(Object.keys(first.priceIds)).toHaveLength(CREDIT_PACKS.length);

    const second = await ensureStripeProducts(stripe);
    expect(second).toEqual(first);
  });
});

describe("registerWebhook", () => {
  it("creates the endpoint once and returns the secret only that first time", async () => {
    const sdk = mockSdk();
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });
    const url = "https://milo.dev/billing/stripe/webhook";

    const first = await registerWebhook(stripe, url);
    expect(first.secret).toBe("whsec_generated");

    const second = await registerWebhook(stripe, url);
    expect(second.id).toBe(first.id);
    expect(second.secret).toBeUndefined();
  });

  it("subscribes to exactly the two events the handler understands", () => {
    expect(STRIPE_WEBHOOK_EVENT_TYPES).toEqual(["checkout.session.completed", "charge.refunded"]);
  });
});
