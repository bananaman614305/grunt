/**
 * One-time (and idempotent) Stripe account setup: the "Milo credits"
 * product with one Price per pack, and the webhook endpoint. These are
 * pure functions over a `StripeClient` so an orchestrator script can call
 * them directly; nothing here runs at request time.
 */

import type Stripe from "stripe";
import { CREDIT_PACKS } from "@milo/core";
import type { StripeClient } from "./client.js";

export const MILO_CREDITS_PRODUCT_NAME = "Milo credits";

/** The two events `handleStripeWebhook` understands. */
export const STRIPE_WEBHOOK_EVENT_TYPES: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "charge.refunded",
];

export function lookupKeyForPack(packId: string): string {
  return `milo_${packId}`;
}

export type EnsureStripeProductsResult = {
  productId: string;
  /** packId -> Stripe Price id. */
  priceIds: Record<string, string>;
};

/**
 * Creates the "Milo credits" product and one Price per `CREDIT_PACKS`
 * entry (looked up by lookup key, e.g. `milo_pack_5`) if they don't
 * already exist. Safe to run repeatedly.
 */
export async function ensureStripeProducts(
  stripe: StripeClient,
): Promise<EnsureStripeProductsResult> {
  const sdk = stripe.sdk;

  const productId = await ensureProduct(sdk);

  const priceIds: Record<string, string> = {};
  for (const pack of CREDIT_PACKS) {
    priceIds[pack.id] = await ensurePrice(sdk, productId, pack);
  }

  return { productId, priceIds };
}

async function ensureProduct(sdk: Stripe): Promise<string> {
  // `products.list` is a fully-consistent read, unlike the Search API, so
  // this can't race its own just-created product on a repeated run.
  const products = await sdk.products.list({ limit: 100 });
  const existing = products.data.find((p) => p.name === MILO_CREDITS_PRODUCT_NAME && p.active);
  if (existing) return existing.id;

  const created = await sdk.products.create({ name: MILO_CREDITS_PRODUCT_NAME });
  return created.id;
}

async function ensurePrice(
  sdk: Stripe,
  productId: string,
  pack: (typeof CREDIT_PACKS)[number],
): Promise<string> {
  const lookupKey = lookupKeyForPack(pack.id);
  const existing = await sdk.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const found = existing.data[0];
  if (found) return found.id;

  const created = await sdk.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: pack.usdCents,
    lookup_key: lookupKey,
    nickname: pack.label,
  });
  return created.id;
}

export type RegisterWebhookResult = {
  id: string;
  /** Only set the first time the endpoint is created; Stripe never returns it again. */
  secret?: string;
};

/**
 * Creates the webhook endpoint for `STRIPE_WEBHOOK_EVENT_TYPES` at `url`
 * if one doesn't already exist for that url. The signing secret is only
 * ever handed back on creation — copy it into `STRIPE_WEBHOOK_SECRET`
 * immediately; a second run against the same url returns no secret.
 */
export async function registerWebhook(
  stripe: StripeClient,
  url: string,
): Promise<RegisterWebhookResult> {
  const sdk = stripe.sdk;

  const endpoints = await sdk.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.data.find((e) => e.url === url);
  if (existing) return { id: existing.id };

  const created = await sdk.webhookEndpoints.create({
    url,
    enabled_events: STRIPE_WEBHOOK_EVENT_TYPES,
  });
  return created.secret ? { id: created.id, secret: created.secret } : { id: created.id };
}
