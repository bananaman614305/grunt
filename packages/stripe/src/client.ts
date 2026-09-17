/**
 * Thin wrapper over the official `stripe` npm package. Everything else in
 * this package takes a `StripeClient`, not a raw `Stripe` instance, so the
 * webhook secret never has to be threaded through call sites separately.
 */

import Stripe from "stripe";

/**
 * Pinned explicitly (rather than left to the package default) so that
 * bumping the `stripe` dependency can never silently change the wire
 * format of requests and webhook payloads out from under us.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export interface StripeClient {
  /** The underlying `stripe` SDK instance. */
  readonly sdk: Stripe;
  /** Used only to verify webhook signatures. Never logged. */
  readonly webhookSecret: string;
}

export interface CreateStripeClientOptions {
  /**
   * Inject a pre-built (e.g. mocked) `Stripe` SDK instance instead of
   * constructing one from `STRIPE_SECRET_KEY`. For tests.
   */
  sdk?: Stripe;
  /** Overrides `STRIPE_SECRET_KEY`. Ignored when `sdk` is given. */
  secretKey?: string;
  /** Overrides `STRIPE_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

/**
 * Builds a `StripeClient` from `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET` in the environment (or the overrides in `opts`,
 * which is how tests inject a mocked SDK without touching env vars).
 */
export function createStripeClient(opts: CreateStripeClientOptions = {}): StripeClient {
  const webhookSecret = opts.webhookSecret ?? process.env["STRIPE_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }

  if (opts.sdk) {
    return { sdk: opts.sdk, webhookSecret };
  }

  const secretKey = opts.secretKey ?? process.env["STRIPE_SECRET_KEY"];
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }

  return {
    sdk: new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }),
    webhookSecret,
  };
}
