/**
 * Prepaid credit purchases via Stripe Checkout (ADR-007). One Checkout
 * Session, mode `payment`, per pack purchase; the account's balance is
 * credited later by the webhook once Stripe confirms payment.
 */

import { CREDIT_PACKS } from "@milo/core";
import type { Account, AccountId, BillingStore } from "@milo/core";
import type { StripeClient } from "./client.js";

export class UnknownCreditPackError extends Error {
  constructor(packId: string) {
    super(`Unknown credit pack: ${packId}`);
    this.name = "UnknownCreditPackError";
  }
}

export type CreateCreditCheckoutOptions = {
  store: BillingStore;
  stripe: StripeClient;
  accountId: AccountId;
  packId: string;
  successUrl: string;
  cancelUrl: string;
};

export type CreateCreditCheckoutResult = { url: string };

/**
 * Ensures the account has a Stripe customer, then creates a Checkout
 * Session for the given pack. `metadata` and `client_reference_id` both
 * carry the account id so the webhook can credit the right account even
 * if only one of the two survives on the event Stripe eventually sends.
 */
export async function createCreditCheckout(
  opts: CreateCreditCheckoutOptions,
): Promise<CreateCreditCheckoutResult> {
  const pack = CREDIT_PACKS.find((p) => p.id === opts.packId);
  if (!pack) throw new UnknownCreditPackError(opts.packId);

  const account = await opts.store.getAccount(opts.accountId);
  if (!account) throw new Error(`Unknown account: ${opts.accountId}`);

  const customerId = await ensureStripeCustomer(opts.store, opts.stripe, account);

  const session = await opts.stripe.sdk.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    client_reference_id: opts.accountId,
    metadata: { accountId: opts.accountId, packId: pack.id },
    // Copied onto the resulting PaymentIntent/Charge too, so a later
    // `charge.refunded` webhook can still find the account without a
    // Checkout Session lookup.
    payment_intent_data: {
      metadata: { accountId: opts.accountId, packId: pack.id },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.usdCents,
          product_data: { name: `Milo credits — ${pack.label}` },
        },
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });

  if (!session.url) {
    throw new Error(`Stripe did not return a Checkout Session url for pack ${pack.id}`);
  }
  return { url: session.url };
}

async function ensureStripeCustomer(
  store: BillingStore,
  stripe: StripeClient,
  account: Account,
): Promise<string> {
  if (account.stripeCustomerId) return account.stripeCustomerId;

  const customer = await stripe.sdk.customers.create({
    email: account.email,
    metadata: { accountId: account.id },
  });
  await store.updateAccount(account.id, { stripeCustomerId: customer.id });
  return customer.id;
}
