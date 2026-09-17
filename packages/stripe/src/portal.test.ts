import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createStripeClient } from "./client.js";
import { createPortalSession } from "./portal.js";

describe("createPortalSession", () => {
  it("creates a billing portal session and returns its url", async () => {
    const calls: Stripe.BillingPortal.SessionCreateParams[] = [];
    const sdk = {
      billingPortal: {
        sessions: {
          async create(params: Stripe.BillingPortal.SessionCreateParams) {
            calls.push(params);
            return { url: "https://billing.stripe.com/p/session_123" };
          },
        },
      },
    } as unknown as Stripe;
    const stripe = createStripeClient({ sdk, webhookSecret: "whsec_test" });

    const result = await createPortalSession({
      stripe,
      customerId: "cus_1",
      returnUrl: "https://milo.dev/account",
    });

    expect(result.url).toBe("https://billing.stripe.com/p/session_123");
    expect(calls[0]).toEqual({ customer: "cus_1", return_url: "https://milo.dev/account" });
  });
});
