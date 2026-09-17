# ADR-007: Milo keys and prepaid credits

Status: accepted, 2026-09-17

## Decision

Milo issues its own API keys (`mk_...`) and sells prepaid credits. An account has a Stripe customer, a balance in integer micro-dollars, and one OpenRouter sub-key minted through OpenRouter's provisioning API from Milo's own OpenRouter account, with its spend limit kept equal to the account's balance. A request authenticated with a Milo key goes upstream with that sub-key; the account is charged the upstream cost reported by OpenRouter times (1 + margin), plus a flat decision fee covering Jev, and the charge and remaining balance are returned in `x-milo-cost-usd` and `x-milo-balance-usd` headers. A request with no balance is refused with 402 before any upstream call. Bring-your-own-OpenRouter-key requests keep working unchanged and are not charged.

Credits are bought through Stripe Checkout in fixed packs; a verified webhook posts a ledger credit and raises the sub-key limit. Every balance change is a ledger entry; the balance is derived, never edited. Streaming responses are charged from the usage in the final chunk; a small reserve is held per request and released on settle so a stream cannot run far past a zero balance.

Storage is Postgres on Fly Managed Postgres. Milo keys and OpenRouter sub-keys are stored hashed; the sub-key itself is stored encrypted with a server secret because it must be sent upstream.

## Why

Margin on model cost is the pricing users of OpenRouter already understand, and routing savings show up directly on their bill. Per-account sub-keys let OpenRouter enforce the spend ceiling and report exact costs, so Milo never fronts more than a customer has paid. Keeping BYOK free preserves the partner and early-user path.

## Consequences

Milo now holds money and customer credentials: the encryption secret, Stripe keys, and the provisioning key are Fly secrets, never in the repo. `/v1/decisions` is scoped per account. Refunds, taxes, and invoices are horizon items; Stripe's customer portal covers receipts for now.
