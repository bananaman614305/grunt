# @milo/provisioning

Milo's OpenRouter provisioning client: per-account sub-keys with spend
limits, and usage reconciliation against Milo's own ledger. Implements the
provisioning half of ADR-007 (`docs/adr/007-milo-keys-and-credits.md`).

## Env vars

- `OPENROUTER_PROVISIONING_KEY` — Milo's OpenRouter **provisioning**
  (management) key. Required scope: it must be a provisioning/management key
  from OpenRouter's dashboard, not a regular inference key — only a
  provisioning key can call `/v1/keys` and `/v1/credits`. Never logged, never
  put in an error message or a fixture. Passed to `OpenRouterProvisioningClient`
  via the constructor or read from this env var by default.
- `MILO_ENCRYPTION_KEY` — base64-encoded 32-byte AES-256 key used to encrypt
  each account's OpenRouter sub-key before it's stored on
  `Account.openRouterSubKeyEnc` (see `src/crypto.ts`). Generate one with
  `openssl rand -base64 32`. Losing this key means every stored sub-key
  becomes unrecoverable and every account needs a fresh sub-key provisioned.

## The limit-equals-balance rule

Per ADR-007, an account's OpenRouter sub-key spend limit is always kept
equal to the account's current balance in USD (floored at 0, rounded to
cents — OpenRouter's `limit` is a USD amount):

- `ensureSubKey` creates the sub-key the first time an account needs one,
  named `milo-<accountId>`, with its limit set to the balance at creation
  time.
- `syncLimit` re-reads the account's current balance and pushes it to
  OpenRouter as the new limit. Call it after every credit (Stripe webhook)
  and periodically (e.g. hourly cron) so drift — a refund, a chargeback, a
  missed call — self-heals.
- `disableSubKey` disables the sub-key outright (`disabled: true`) on
  account suspension, independent of the limit.

This means OpenRouter itself is the backstop that prevents an account from
spending more than it has paid for, even if Milo's own reservation logic has
a bug.

## Usage reconciliation

`reconcileUsage` compares OpenRouter's cumulative reported spend on each
account's sub-key against the sum of `usage_records.upstream_cost_micro_usd`
Milo has recorded (plus any reconcile adjustments already posted). If
OpenRouter reports more — typically a stream that was cut before its final
usage chunk arrived, so Milo never charged for it — it posts a ledger
`adjustment` entry for exactly the gap, referenced `reconcile:<hash>:<iso>`,
and returns a summary. Designed to run from a cron or `milo billing
reconcile`; safe to call as often as you like, since re-running with no new
upstream spend recomputes a zero discrepancy and posts nothing. See the
header comment in `src/reconcile.ts` for the checkpoint derivation, which
works within the pinned `BillingStore` contract (no dedicated "last
reconciled" field) by treating previously-posted adjustments as the
checkpoint.

## OpenRouter endpoints used

Confirmed 2026-09-17 against OpenRouter's docs (see `src/client.ts`'s header
comment for the full endpoint table): `GET/POST /api/v1/keys`,
`GET/PATCH/DELETE /api/v1/keys/{hash}`, `GET /api/v1/credits`.
