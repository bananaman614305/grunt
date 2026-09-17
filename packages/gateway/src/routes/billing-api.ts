/**
 * The JSON surface behind a Milo account: what it holds, what it spent, and
 * how to put more money in it (ADR-007).
 *
 * Everything under `/v1/account` authenticates with a Milo key and nothing
 * else. A bring-your-own-key caller is not a customer -- there is no account
 * to show, no balance to read and nothing to charge -- so those requests get
 * 403 with a pointer at the account page rather than an empty account.
 *
 * Two routes deliberately have no auth at all:
 *
 *   - `POST /billing/stripe/webhook`, which is authenticated by Stripe's
 *     signature over the raw body and by nothing else. It lives outside
 *     `/v1` so the bearer-token middleware never sees it.
 *   - `POST /v1/signup`, which is how someone gets their first key. It is
 *     **the MVP onboarding and it is deliberately thin**: anyone who can
 *     reach the deployment can claim an email address and get a working key
 *     for it, because there is no email sign-in yet to prove the address is
 *     theirs. What stands in for that until there is: a hard per-IP rate
 *     limit (5 an hour), a 409 on an email that already exists so an existing
 *     account can never be taken over, and a balance of zero on a fresh
 *     account, so the worst a stranger can do is create an empty account
 *     under an address they do not own. HORIZON: replace this with an email
 *     sign-in link before anyone advertises the endpoint.
 *
 * No response here ever contains a key: not the `mk_` secret (except the one
 * time it is minted, which is the only moment it exists), not a key hash, and
 * not the account's OpenRouter sub-key.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { CREDIT_PACKS, microToUsd } from "@milo/core";
import type { Account, AccountId, ApiKey, AuthMode, PricingConfig } from "@milo/core";
import { syncLimit } from "@milo/provisioning";
import { UnknownCreditPackError, WebhookSignatureError, createCreditCheckout, createPortalSession, handleStripeWebhook } from "@milo/stripe";
import type { AppDeps } from "../app.js";
import { authOf, requestOrigin } from "../billing.js";
import type { BillingRuntime } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";
import { readJsonObject } from "./shared.js";

/** Usage rows returned with the summary. One page, newest first. */
const USAGE_RECORD_LIMIT = 50;
/** Ledger entries returned by default; `?limit=` narrows it. */
const LEDGER_LIMIT_DEFAULT = 50;
const LEDGER_LIMIT_MAX = 500;

/** Signups allowed from one address per window, and the window itself. */
const SIGNUP_PER_HOUR = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
/** Bound on tracked addresses, so the counter cannot grow without limit. */
const SIGNUP_MAX_ADDRESSES = 10_000;

export function registerBillingRoutes(app: Hono, deps: AppDeps): void {
  const signups = new SignupLimiter();

  app.get("/v1/account", (c) => withAccount(c, deps, (billing, auth) => account(c, billing, auth)));
  app.post("/v1/account/keys", (c) => withAccount(c, deps, (billing, auth) => createKey(c, billing, auth)));
  app.delete("/v1/account/keys/:id", (c) => withAccount(c, deps, (billing, auth) => revokeKey(c, billing, auth)));
  app.get("/v1/account/usage", (c) => withAccount(c, deps, (billing, auth) => usage(c, billing, auth)));
  app.get("/v1/account/ledger", (c) => withAccount(c, deps, (billing, auth) => ledger(c, billing, auth)));
  app.post("/v1/account/checkout", (c) => withAccount(c, deps, (billing, auth) => checkout(c, deps, billing, auth)));
  app.post("/v1/account/portal", (c) => withAccount(c, deps, (billing, auth) => portal(c, billing, auth)));

  app.post("/v1/signup", (c) => signup(c, deps, signups));
  app.post("/billing/stripe/webhook", (c) => stripeWebhook(c, deps));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Runs `handler` when the caller is a Milo key; 403 when it is not. */
async function withAccount(
  c: Context,
  deps: AppDeps,
  handler: (billing: BillingRuntime, auth: Extract<AuthMode, { kind: "milo" }>) => Promise<Response>,
): Promise<Response> {
  const billing = deps.billing;
  if (billing === undefined) {
    return errorResponse(
      c,
      404,
      "This deployment has no Milo accounts.",
      "not_found_error",
      "milo_keys_disabled",
    );
  }

  const auth = authOf(c);
  if (auth.kind !== "milo") {
    return errorResponse(
      c,
      403,
      `This route needs a Milo key (mk_...). Sign in at ${requestOrigin(c)}/account to get one; ` +
        "an OpenRouter key routes and pays for itself, so it has no Milo account behind it.",
      "invalid_request_error",
      "milo_key_required",
    );
  }

  return handler(billing, auth);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The account, its balance, its keys (never their hashes), and the prices. */
async function account(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  const keys = await billing.store.listApiKeys(auth.account.id);
  return c.json({
    account: accountView(auth.account),
    balanceUsd: microToUsd(auth.account.balanceMicroUsd),
    keys: keys.map(keyView),
    pricing: pricingView(billing.pricing),
  });
}

async function usage(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  const since = c.req.query("since");
  // Checked here rather than left to the database: an unparseable timestamp
  // reaching a `::timestamptz` cast is a 500 for what is a typo in a query
  // string.
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    return errorResponse(
      c,
      400,
      "`since` must be an ISO-8601 timestamp.",
      "invalid_request_error",
      "invalid_since",
    );
  }

  const summary = await billing.store.usageSummary(auth.account.id, since);

  // `listUsage` is not on the pinned `BillingStore` contract, so a store that
  // does not have it answers with the summary and an empty list rather than
  // failing the whole read.
  const records =
    (await billing.store.listUsage?.(auth.account.id, {
      limit: USAGE_RECORD_LIMIT,
      ...(since === undefined ? {} : { sinceIso: since }),
    })) ?? [];

  return c.json({
    since: since ?? null,
    summary: {
      ...summary,
      chargedUsd: microToUsd(summary.chargedMicroUsd),
      upstreamCostUsd: microToUsd(summary.upstreamCostMicroUsd),
    },
    records: records.map((record) => ({
      ...record,
      chargedUsd: microToUsd(record.chargedMicroUsd),
      upstreamCostUsd: microToUsd(record.upstreamCostMicroUsd),
    })),
  });
}

async function ledger(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  const asked = Number(c.req.query("limit"));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), LEDGER_LIMIT_MAX) : LEDGER_LIMIT_DEFAULT;
  const entries = await billing.store.listLedger(auth.account.id, { limit });
  return c.json({
    data: entries.map((entry) => ({
      ...entry,
      amountUsd: microToUsd(entry.amountMicroUsd),
      balanceAfterUsd: microToUsd(entry.balanceAfterMicroUsd),
    })),
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Mints a key and returns the secret. This is the only time it exists. */
async function createKey(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  const body = (await readJsonObject(c)) ?? {};
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name === "") {
    return errorResponse(c, 400, "A key needs a name.", "invalid_request_error", "invalid_request_body");
  }

  const { key, secret } = await billing.store.createApiKey(auth.account.id, name);
  return c.json({ key: keyView(key), secret }, 201);
}

async function revokeKey(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const keys = await billing.store.listApiKeys(auth.account.id);
  // Scoped to the caller's own keys, so one account cannot revoke another's
  // by guessing an id -- and an id that is not theirs reads as "no such key".
  if (!keys.some((key) => key.id === id)) {
    return errorResponse(c, 404, "No key with that id on this account.", "not_found_error", "key_not_found");
  }

  await billing.store.revokeApiKey(id);
  return c.json({ revoked: true, id });
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

async function checkout(
  c: Context,
  deps: AppDeps,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  if (billing.stripe === undefined) return stripeUnconfigured(c);

  const body = (await readJsonObject(c)) ?? {};
  const packId = typeof body["packId"] === "string" ? body["packId"] : "";

  const origin = requestOrigin(c);
  try {
    const { url } = await createCreditCheckout({
      store: billing.store,
      stripe: billing.stripe,
      accountId: auth.account.id,
      packId,
      // Stripe substitutes the session id into the literal placeholder, so it
      // has to reach Stripe unescaped.
      successUrl: `${origin}/account/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/account`,
    });
    return c.json({ url });
  } catch (err) {
    if (err instanceof UnknownCreditPackError) {
      return errorResponse(
        c,
        400,
        `Unknown credit pack. Known packs: ${CREDIT_PACKS.map((pack) => pack.id).join(", ")}.`,
        "invalid_request_error",
        "unknown_credit_pack",
      );
    }
    deps.logger.error("stripe checkout failed", { error: errorMessage(err) });
    return errorResponse(c, 502, "Stripe could not start a checkout.", "api_error", "stripe_unavailable");
  }
}

async function portal(
  c: Context,
  billing: BillingRuntime,
  auth: Extract<AuthMode, { kind: "milo" }>,
): Promise<Response> {
  if (billing.stripe === undefined) return stripeUnconfigured(c);

  // The Stripe customer is created by the first checkout, so there is nothing
  // for the portal to open before then.
  const customerId = auth.account.stripeCustomerId;
  if (customerId === null) {
    return errorResponse(
      c,
      409,
      "This account has no Stripe customer yet. Buy credits once and the billing portal opens.",
      "invalid_request_error",
      "no_stripe_customer",
    );
  }

  const { url } = await createPortalSession({
    stripe: billing.stripe,
    customerId,
    returnUrl: `${requestOrigin(c)}/account`,
  });
  return c.json({ url });
}

/**
 * Stripe's webhook. The body must be read as raw text: the signature covers
 * the exact bytes Stripe sent, so a re-serialised JSON object would not
 * verify.
 *
 * A credit that lands here raises the account's OpenRouter sub-key limit to
 * the new balance, which is what actually lets the money be spent (ADR-007).
 * Anything Milo does not handle still answers 200: Stripe retries a non-2xx,
 * and retrying an event nobody wants is pure noise.
 */
async function stripeWebhook(c: Context, deps: AppDeps): Promise<Response> {
  const billing = deps.billing;
  if (billing?.stripe === undefined) return stripeUnconfigured(c);
  const stripe = billing.stripe;

  const signature = c.req.header("stripe-signature") ?? "";
  const rawBody = await c.req.text();

  try {
    const result = await handleStripeWebhook({
      store: billing.store,
      stripe,
      rawBody,
      signature,
      onCredited: async ({ accountId }) => {
        if (billing.provisioning === undefined) return;
        const account = await billing.store.getAccount(accountId);
        if (account === undefined) return;
        await syncLimit({ store: billing.store, client: billing.provisioning, account });
      },
    });
    deps.logger.info("stripe webhook", { type: result.type, handled: result.handled });
    return c.json({ received: true, handled: result.handled, type: result.type });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      deps.logger.warn("stripe webhook signature rejected", {});
      return errorResponse(c, 400, "Invalid Stripe signature.", "invalid_request_error", "invalid_signature");
    }
    // Stripe retries a 500, which is what we want for a transient store error.
    deps.logger.error("stripe webhook failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not apply that Stripe event.", "api_error", "webhook_failed");
  }
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

async function signup(c: Context, deps: AppDeps, limiter: SignupLimiter): Promise<Response> {
  const billing = deps.billing;
  if (billing === undefined) {
    return errorResponse(c, 404, "This deployment has no Milo accounts.", "not_found_error", "milo_keys_disabled");
  }

  if (!limiter.allow(clientAddress(c), Date.now())) {
    return errorResponse(
      c,
      429,
      `Too many signups from this address. Try again in an hour.`,
      "rate_limit_error",
      "signup_rate_limited",
      { "retry-after": String(Math.ceil(SIGNUP_WINDOW_MS / 1000)) },
    );
  }

  const body = (await readJsonObject(c)) ?? {};
  const email = typeof body["email"] === "string" ? body["email"].trim() : "";
  if (!isEmail(email)) {
    return errorResponse(c, 400, "A valid email address is required.", "invalid_request_error", "invalid_email");
  }

  const existing = await billing.store.getAccountByEmail(email);
  if (existing !== undefined) {
    return errorResponse(
      c,
      409,
      "An account already exists for that email. Use your existing key, or ask for a new one from the account page.",
      "invalid_request_error",
      "email_taken",
    );
  }

  const created = await billing.store.createAccount(email);
  const { secret } = await billing.store.createApiKey(created.id, "default");
  // The account id is safe to log; the key is not, and is not.
  deps.logger.info("account created", { accountId: created.id });

  return c.json({ accountId: created.id, key: secret }, 201);
}

/**
 * Fixed-window signup counter, per client address. A token bucket would be
 * kinder, but the point here is a hard ceiling on account creation from one
 * place, and a window that simply refuses the sixth attempt is the easiest
 * version of that to reason about.
 *
 * The address comes from `x-forwarded-for`, which is only as trustworthy as
 * the proxy in front of Milo (on Fly it is set by the edge and cannot be
 * spoofed end to end; behind no proxy at all it is absent and the socket
 * address is used). This is a nuisance bound, not a security control.
 */
class SignupLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  allow(address: string, now: number): boolean {
    const window = this.windows.get(address);
    if (window === undefined || window.resetAt <= now) {
      if (this.windows.size >= SIGNUP_MAX_ADDRESSES) this.sweep(now);
      this.windows.set(address, { count: 1, resetAt: now + SIGNUP_WINDOW_MS });
      return true;
    }
    if (window.count >= SIGNUP_PER_HOUR) return false;
    window.count += 1;
    return true;
  }

  /** Drops expired windows; if none have expired, drops the oldest half. */
  private sweep(now: number): void {
    for (const [address, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(address);
    }
    if (this.windows.size < SIGNUP_MAX_ADDRESSES) return;
    const half = Math.ceil(this.windows.size / 2);
    let dropped = 0;
    for (const address of this.windows.keys()) {
      if (dropped++ >= half) break;
      this.windows.delete(address);
    }
  }
}

function clientAddress(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return c.req.header("fly-client-ip") ?? c.req.header("x-real-ip") ?? "unknown";
}

/** Deliberately loose: the address is not verified yet, only shaped. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The account, minus the two fields that are key material. */
function accountView(account: Account): {
  id: AccountId;
  email: string;
  status: Account["status"];
  balanceMicroUsd: number;
  balanceUsd: number;
  createdAt: string;
} {
  return {
    id: account.id,
    email: account.email,
    status: account.status,
    balanceMicroUsd: account.balanceMicroUsd,
    balanceUsd: microToUsd(account.balanceMicroUsd),
    createdAt: account.createdAt,
  };
}

/** A key as its owner sees it: never the hash, never the secret. */
function keyView(key: ApiKey): {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
} {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
  };
}

function pricingView(pricing: PricingConfig): Record<string, unknown> {
  return {
    ...pricing,
    decisionFeeUsd: microToUsd(pricing.decisionFeeMicroUsd),
    reserveUsd: microToUsd(pricing.reserveMicroUsd),
    creditPacks: CREDIT_PACKS,
  };
}

function stripeUnconfigured(c: Context): Response {
  return errorResponse(
    c,
    503,
    "Payments are not configured on this deployment.",
    "api_error",
    "stripe_unconfigured",
  );
}
