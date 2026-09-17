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
  /**
   * Overrides `STRIPE_API_BASE`: a full base URL for a key-injecting proxy
   * (for example a vault egress grant). The SDK's requests, which it builds
   * as `/v1/...` on the host, are rewritten to `<base path>/v1/...`.
   */
  apiBase?: string;
}

/** Builds the SDK options for a proxied base URL, or `{}` when none is set. */
export function proxiedSdkOptions(apiBase: string | undefined): Stripe.StripeConfig {
  if (!apiBase) return {};
  const url = new URL(apiBase);
  const prefix = url.pathname.replace(/\/+$/, "");
  const rewrite: typeof fetch = (input, init) => {
    const original = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    original.pathname = `${prefix}${original.pathname}`;
    return fetch(original.toString(), init);
  };
  return {
    host: url.hostname,
    protocol: url.protocol === "http:" ? "http" : "https",
    ...(url.port ? { port: url.port } : {}),
    httpClient: Stripe.createFetchHttpClient(rewrite),
  };
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

  const apiBase = opts.apiBase ?? process.env["STRIPE_API_BASE"];
  return {
    sdk: new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, ...proxiedSdkOptions(apiBase) }),
    webhookSecret,
  };
}
