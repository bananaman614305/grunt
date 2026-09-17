/**
 * Stripe customer portal sessions. Covers receipts and payment-method
 * management for now (ADR-007 leaves refunds/taxes/invoices as horizon
 * items and points at the portal for receipts).
 */

import type { StripeClient } from "./client.js";

export type CreatePortalSessionOptions = {
  stripe: StripeClient;
  customerId: string;
  returnUrl: string;
};

export type CreatePortalSessionResult = { url: string };

export async function createPortalSession(
  opts: CreatePortalSessionOptions,
): Promise<CreatePortalSessionResult> {
  const session = await opts.stripe.sdk.billingPortal.sessions.create({
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
  return { url: session.url };
}
