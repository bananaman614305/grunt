# @milo/stripe

Stripe integration for Milo's prepaid credits (see `docs/adr/007-milo-keys-and-credits.md`
and the pinned contracts in `packages/core/src/billing/types.ts`). No HTTP
server lives here — the gateway wires these functions into
`POST /billing/stripe/webhook` and whatever checkout/portal routes it exposes.

## Env vars

- `STRIPE_SECRET_KEY` — Milo's Stripe secret key. Never logged, never in fixtures or the repo.
- `STRIPE_WEBHOOK_SECRET` — the `whsec_...` signing secret for the endpoint below. Produced once by `registerWebhook` (see below); never logged.

Both are read by `createStripeClient()` from `src/client.ts`. Tests inject a
mocked `sdk` and an explicit `webhookSecret` instead of touching the
environment.

## Webhook URL

Milo exposes `POST /billing/stripe/webhook` (implemented by the gateway,
not this package). Point Stripe's webhook endpoint at
`https://<milo-host>/billing/stripe/webhook`. It must receive the raw,
unparsed request body — `stripe.webhooks.constructEvent` fails signature
verification if anything reshapes the body first.

## Setup functions

Run once (and safely re-run) by an orchestrator script, not at request time:

- `ensureStripeProducts(stripe)` — creates the "Milo credits" product and
  one Price per entry in `CREDIT_PACKS`, keyed by lookup key (`milo_pack_5`,
  `milo_pack_20`, `milo_pack_100`). No-op if they already exist.
- `registerWebhook(stripe, url)` — creates the webhook endpoint at `url`
  for `checkout.session.completed` and `charge.refunded` if one doesn't
  already exist there. Returns the signing secret **only** the first time
  it creates the endpoint — copy it into `STRIPE_WEBHOOK_SECRET`
  immediately; Stripe never returns it again after creation.

```ts
import { createStripeClient, ensureStripeProducts, registerWebhook } from "@milo/stripe";

const stripe = createStripeClient(); // reads STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
await ensureStripeProducts(stripe);
const { secret } = await registerWebhook(stripe, "https://milo.dev/billing/stripe/webhook");
if (secret) console.log("Set STRIPE_WEBHOOK_SECRET to the value just printed by Stripe.");
```

## What's here

- `src/client.ts` — `createStripeClient()`: builds a `StripeClient` (the
  `stripe` SDK instance plus the webhook secret) from env, or from an
  injected mock `sdk` for tests. Pins `STRIPE_API_VERSION` explicitly so a
  `stripe` package upgrade can't silently change wire behavior.
- `src/checkout.ts` — `createCreditCheckout(...)`: ensures a Stripe
  customer exists for the account, creates a `payment`-mode Checkout
  Session for the requested `CREDIT_PACKS` entry, and returns its url.
- `src/webhook.ts` — `handleStripeWebhook(...)`: verifies the signature,
  credits the account on a paid `checkout.session.completed` (exactly
  once, via `store.markStripeEvent`), posts a negative ledger entry on
  `charge.refunded`, and ignores everything else.
- `src/portal.ts` — `createPortalSession(...)`: a Stripe customer portal
  session url for receipts and payment-method management.
- `src/setup.ts` — the two idempotent setup functions above.

## Open questions / known limits

- `charge.refunded` carries `amount_refunded`, which is the *cumulative*
  refunded amount on the charge, not the incremental amount of this
  particular refund. A single full refund (the only case this package's
  tests exercise) posts the right number; a charge refunded in several
  partial installments would currently post the same cumulative total on
  each `charge.refunded` delivery for that charge (deduplicated by event
  id, not by charge id), overstating multi-partial-refund cases. Revisit
  if Milo ever supports partial refunds.
- `charge.refunded` resolves the account via `charge.metadata.accountId`,
  which is only present because `createCreditCheckout` sets
  `payment_intent_data.metadata` at Checkout Session creation time (Stripe
  copies PaymentIntent metadata onto the Charge it creates). A charge that
  didn't originate from `createCreditCheckout` has no accountId and the
  refund handler throws.
- `ensureStripeProducts` finds the existing product by name via
  `products.list` rather than the Search API, to avoid Search's eventual
  consistency; this means the product name ("Milo credits") is effectively
  part of the contract — renaming it will create a second product on the
  next run.
