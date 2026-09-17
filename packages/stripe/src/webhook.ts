/**
 * Stripe webhook handling for prepaid credits (ADR-007). Milo listens for
 * two event types: `checkout.session.completed` credits the account once
 * payment clears, `charge.refunded` reverses it. Everything else is
 * ignored. Idempotency is enforced with `store.markStripeEvent`, which is
 * the only thing standing between "delivered twice" (Stripe's own retry
 * behavior, or a replayed event) and double-crediting an account.
 */

import type Stripe from "stripe";
import type { AccountId, BillingStore, MicroUsd } from "@milo/core";
import type { StripeClient } from "./client.js";

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export type OnCredited = (args: {
  accountId: AccountId;
  amountMicroUsd: MicroUsd;
}) => void | Promise<void>;

export type HandleStripeWebhookOptions = {
  store: BillingStore;
  stripe: StripeClient;
  rawBody: string | Buffer;
  signature: string;
  /** Called after a credit is posted so the caller can raise the OpenRouter sub-key limit. */
  onCredited?: OnCredited;
};

export type HandleStripeWebhookResult = { handled: boolean; type: string };

const HANDLED_EVENT_TYPES = new Set(["checkout.session.completed", "charge.refunded"]);

/** Stripe amounts are integer minor units (cents for USD); 1 cent = 10_000 micro-USD. */
function centsToMicroUsd(cents: number): MicroUsd {
  return cents * 10_000;
}

export async function handleStripeWebhook(
  opts: HandleStripeWebhookOptions,
): Promise<HandleStripeWebhookResult> {
  const event = verifyEvent(opts);

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return { handled: false, type: event.type };
  }

  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(opts, event);
    case "charge.refunded":
      return handleChargeRefunded(opts, event);
    default:
      return { handled: false, type: event.type };
  }
}

function verifyEvent(opts: HandleStripeWebhookOptions): Stripe.Event {
  try {
    return opts.stripe.sdk.webhooks.constructEvent(
      opts.rawBody,
      opts.signature,
      opts.stripe.webhookSecret,
    );
  } catch (err) {
    throw new WebhookSignatureError(
      `Stripe webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCheckoutCompleted(
  opts: HandleStripeWebhookOptions,
  event: Stripe.Event,
): Promise<HandleStripeWebhookResult> {
  const session = event.data.object as Stripe.Checkout.Session;

  // Only a fully paid session credits the account. `async` payment methods
  // can send this event before money has actually moved.
  if (session.payment_status !== "paid") {
    return { handled: false, type: event.type };
  }

  const isNewEvent = await opts.store.markStripeEvent(event.id);
  if (!isNewEvent) {
    // Already applied on a previous delivery of this same event id.
    return { handled: true, type: event.type };
  }

  const accountId = session.client_reference_id ?? (session.metadata?.["accountId"] as string | undefined);
  if (!accountId) {
    throw new Error(`checkout.session.completed ${session.id} carries no accountId`);
  }

  const amountMicroUsd = centsToMicroUsd(session.amount_total ?? 0);

  await opts.store.postLedger({
    accountId,
    kind: "credit_purchase",
    amountMicroUsd,
    reference: session.id,
  });

  if (opts.onCredited) {
    await opts.onCredited({ accountId, amountMicroUsd });
  }

  return { handled: true, type: event.type };
}

async function handleChargeRefunded(
  opts: HandleStripeWebhookOptions,
  event: Stripe.Event,
): Promise<HandleStripeWebhookResult> {
  const charge = event.data.object as Stripe.Charge;

  const isNewEvent = await opts.store.markStripeEvent(event.id);
  if (!isNewEvent) {
    return { handled: true, type: event.type };
  }

  // Set by `createCreditCheckout`'s `payment_intent_data.metadata`, which
  // Stripe copies onto the Charge it creates.
  const accountId = charge.metadata?.["accountId"];
  if (!accountId) {
    throw new Error(`charge.refunded ${charge.id} carries no accountId`);
  }

  const amountMicroUsd = -centsToMicroUsd(charge.amount_refunded);

  await opts.store.postLedger({
    accountId,
    kind: "refund",
    amountMicroUsd,
    reference: charge.id,
  });

  return { handled: true, type: event.type };
}
