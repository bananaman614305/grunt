# Billing: Milo keys and prepaid credits

ADR-007 is the binding contract; this page is the operator- and user-facing
walkthrough of what it built. Milo can run for free with a bring-your-own
OpenRouter key (`docs/api/gateway.md`, unchanged), or a user can create a
Milo-issued key (`mk_...`) and prepay for credits, in which case Milo brings
its own OpenRouter sub-key and charges the user's balance.

## How credits work, for a user

1. **Create an account** at `GET /account/new` -- an email address is the
   entire signup form. Submitting it creates the account and shows the new
   `mk_...` key exactly once, with a warning it will not be shown again.
   There is no password and no email verification: anyone who later knows
   the account id can mint another key against it from `/account` (see
   "The signup-by-email caveat" below).
2. **Buy credits** at `GET /account` -- three fixed packs (`$5`, `$20`,
   `$100`, from `CREDIT_PACKS` in `packages/core/src/billing/types.ts`), each
   a button that opens a Stripe Checkout session and redirects there. Stripe
   redirects back to `/account/success?session_id=...` or `/account/cancel`.
   A successful payment is not credited synchronously: Stripe's webhook
   (`checkout.session.completed`) posts the ledger credit, typically within
   about a minute, which is what `/account/success` tells the visitor to
   expect.
3. **Send requests with the Milo key.** `Authorization: Bearer mk_...`
   routes through Milo's own OpenRouter sub-key for that account instead of
   a bring-your-own key. Every response still carries the usual `x-milo-*`
   decision headers, plus `x-milo-cost-usd` and `x-milo-balance-usd` (ADR-007).
   A request with no balance is refused with `402` before any upstream call.
4. **Pricing**: upstream OpenRouter cost, times `1 + margin`, plus a flat
   per-routed-request decision fee. Both numbers come from `GET /v1/account`'s
   `pricing` object at request time -- `/account` prints the line "You pay
   OpenRouter's price plus `<margin>`% and `$<fee>` per routed request" from
   that response, not from a number baked into the page, so it never drifts
   from what the gateway actually charges.
5. **Manage the account** at `/account`: current balance, create/revoke Milo
   keys (a new key's secret is shown once, the same as signup), a usage
   summary and the most recent usage records, and a "Manage billing" button
   that opens the Stripe customer portal for receipts and payment methods.

None of this needs a password: the Milo key itself is the credential, kept
only in the browser's `sessionStorage` while `/account` is open, and sent as
`Authorization: Bearer` to the JSON API (`GET/POST /v1/account*`,
`POST /v1/signup`) that the pages call from inline scripts. Losing the key
means creating a new one is impossible without the account id (see below) --
there is no recovery flow yet.

### The signup-by-email caveat

Signup asks for an email only to have something to put on the Stripe
customer and the receipt; it is not verified and not a login. The Milo key
is the only credential -- anyone holding it can view the account, mint keys,
and spend the balance, and anyone holding the *account id* (visible in
Stripe metadata, in the CLI's `milo billing accounts` output, and echoed by
`/v1/signup`'s response) could mint a new key from a hardened deployment that
allowed accountId-based key creation. Milo's own `/v1/account/keys` requires
the Milo key itself (ADR-007's per-account JSON API is bearer-authenticated
throughout), so knowing the account id alone is not enough against that API
-- but treat the account id as sensitive anyway, and treat the key as a
bearer secret with no second factor. Real auth (password, magic link, email
verification) is a horizon item.

## The account pages

Server-rendered, framework-free HTML in
`packages/gateway/src/routes/account-pages.ts`, matching the look of the
root landing page (`packages/gateway/src/app.ts`). The shell itself carries
no auth and reads no per-account data server-side; a small inline script on
each page calls the JSON API client-side with the pasted Milo key.

| Route | What it does |
|---|---|
| `GET /account` | Sign in with a Milo key (stored only in `sessionStorage`), then balance, buy-credits buttons, the billing-portal button, API key management, and a usage summary. |
| `GET /account/new` | Email-only signup form; shows the account id and the new key once. |
| `GET /account/success` | Landed on from Stripe Checkout on success (`?session_id=...`); explains the webhook delay. |
| `GET /account/cancel` | Landed on from Stripe Checkout on cancel. |

Security notes for anyone touching this file: everything interpolated from
a request (today, only `/account/success`'s `session_id` query parameter)
is HTML-escaped before it reaches the page; the inline client scripts render
every value the API returns with `textContent`/`createElement`, never
`innerHTML`, so a key's `name` or a model id cannot inject markup.

## The `milo billing` CLI

An operator surface over the same billing database, for support and
back-office work the account pages don't expose. See `docs/cli.md` for full
`--help` output and sample runs of every subcommand:
`accounts`, `grant`, `keys`, `revoke-key`, `usage`, `ledger`, `stripe-setup`,
`reconcile`. Every subcommand takes `--db <url>` or reads it from
`MILO_DATABASE_URL`.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `MILO_DATABASE_URL` | gateway, `milo billing` | Postgres connection string for the billing database (`postgres://...`; `pglite:/dir` or unset/`memory:` for local dev and tests). |
| `STRIPE_SECRET_KEY` | gateway (checkout/portal), `milo billing stripe-setup` | Stripe secret key. |
| `STRIPE_WEBHOOK_SECRET` | gateway (webhook handler) | Verifies the Stripe webhook's signature. Minted once by `milo billing stripe-setup --webhook-url <url>` -- store the value it prints; Stripe will not show it again. |
| `OPENROUTER_PROVISIONING_KEY` | gateway (sub-key lifecycle), `milo billing reconcile` | OpenRouter's provisioning API key, used to create/limit/disable per-account sub-keys and to read their cumulative usage. Distinct from the per-user OpenRouter keys BYOK requests carry. |
| `MILO_ENCRYPTION_KEY` | gateway | Server secret an account's OpenRouter sub-key is encrypted with at rest (ADR-007; sub-keys must be sent upstream, so they can't be stored as a hash the way Milo keys are). |

All five are Fly secrets in production, never in the repo (ADR-007's
consequences section, `CLAUDE.md`).

## Bootstrapping Stripe

Run once per Stripe account (test mode and live mode each need their own
run), and safe to run again -- everything it does is looked up by name,
lookup key, or url before creating anything. `--webhook-url` is wherever the
gateway's own Stripe webhook route is mounted (see `docs/api/gateway.md` for
the exact path):

```
$ STRIPE_SECRET_KEY=sk_... milo billing stripe-setup --webhook-url https://milo-gateway.fly.dev/<webhook-route>
Product: prod_...
  pack_5: price_...
  pack_20: price_...
  pack_100: price_...
Webhook endpoint: we_... (https://milo-gateway.fly.dev/<webhook-route>)
Signing secret (shown once): whsec_...
Store this as STRIPE_WEBHOOK_SECRET now -- Stripe will not show it again.
```

Set `STRIPE_WEBHOOK_SECRET` to the printed value immediately. Running the
same command again against the same `--webhook-url` finds the existing
endpoint and prints no secret.

## Reconciling usage

`milo billing reconcile` closes the one gap Milo's own accounting can leave
open: a streamed response cut before its final usage chunk arrives, so Milo
never learns that request's cost and never charges for it, while OpenRouter
still billed the account's sub-key for the tokens it generated. Run it on a
schedule (a cron, a Fly scheduled machine); it is idempotent, so running it
twice in a row posts nothing the second time. See `docs/adr/007-milo-keys-and-credits.md`
and `packages/provisioning/src/reconcile.ts` for the mechanism.
