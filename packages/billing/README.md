# @milo/billing

Accounts, Milo API keys, the money ledger, and usage records on Postgres.
Implements `BillingStore` from `@milo/core` (`packages/core/src/billing/types.ts`),
which is pinned; see `docs/adr/007-milo-keys-and-credits.md` for the decisions
behind it.

Money is integer micro-dollars (1e-6 USD) end to end. No floats, no rounding
at the edges.

## Environment

| Variable                  | Required            | Meaning                                                                                          |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `MILO_DATABASE_URL`       | yes, in production  | `postgres://user:pass@host:5432/db`. A Fly secret; never in the repo.                              |
| `MILO_ENCRYPTION_KEY`     | yes, in production  | Base64 of 32 random bytes. AES-256-GCM key for the OpenRouter sub-key column. A Fly secret.        |
| `MILO_TEST_DATABASE_URL`  | no                  | Used by the tests instead of PGlite. **The suite drops the billing tables on it.**                 |

Generate an encryption key with `generateEncryptionKey()` from this package, or:

```
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`openDb()` also accepts `pglite:/path/to/dir` and `memory:` so the store can be
exercised without a server.

## Migrations

Forward only. Numbered `.sql` files in `src/migrations/`, applied in order,
each in its own transaction alongside the `schema_migrations` row that records
it, under a Postgres advisory lock so several booting instances cannot race.
Never edit a shipped migration; append the next number.

```
pnpm --filter @milo/billing migrate    # applies pending migrations to MILO_DATABASE_URL
```

`PgBillingStore.open()` runs them too, so a deploy does not strictly need the
separate step.

## Schema

```
accounts
  id                       text PK (ulid)
  email                    text, unique on lower(email)
  stripe_customer_id       text
  openrouter_sub_key_enc   text        -- AES-256-GCM ciphertext, see src/crypto.ts
  openrouter_sub_key_hash  text        -- OpenRouter's own hash, for usage lookups
  balance_micro_usd        bigint      -- moved only by postLedger, in its transaction
  status                   text        -- active | suspended
  created_at, updated_at   timestamptz

api_keys
  id           text PK (ulid)
  account_id   text -> accounts(id) on delete cascade
  key_hash     text UNIQUE            -- SHA-256 hex of the whole mk_... secret
  prefix       text                   -- first 8 chars after mk_, for display
  name         text
  created_at, revoked_at, last_used_at  timestamptz

ledger_entries
  id                       text PK (ulid)
  account_id               text -> accounts(id) on delete cascade
  kind                     text  -- credit_purchase | usage | adjustment | refund
  amount_micro_usd         bigint  -- positive credits, negative spends
  balance_after_micro_usd  bigint
  reference                text    -- checkout session, decision id, or operator note
  created_at               timestamptz
  index (account_id, created_at desc, id desc)

usage_records
  id                       text PK (ulid)
  account_id               text -> accounts(id) on delete cascade
  api_key_id               text -> api_keys(id) on delete cascade
  decision_id              text        -- null for explicit-model passthrough
  model                    text
  input_tokens             integer
  output_tokens            integer
  upstream_cost_micro_usd  bigint      -- what OpenRouter charged Milo
  charged_micro_usd        bigint      -- what the account was charged
  created_at               timestamptz
  index (account_id, created_at desc), (account_id, model), (decision_id)

stripe_events
  event_id     text PK                 -- the whole idempotency mechanism
  received_at  timestamptz

schema_migrations
  version integer PK, name text, applied_at timestamptz
```

## Invariants worth knowing

- **Keys are never stored.** `createApiKey` returns the `mk_...` secret once;
  the row keeps its SHA-256 hex and an 8-character display prefix. A test
  scans every column of every table for the plaintext.
- **The balance moves only through `postLedger`.** It locks the account row
  with `SELECT ... FOR UPDATE`, checks the floor, then writes the new balance
  and the ledger entry in one transaction. `updateAccount` throws on a
  `balanceMicroUsd` patch rather than letting the two drift apart.
- **The floor is `-reserve`, not zero.** A streamed response is charged after
  the fact, so a request may land the balance slightly negative; `reserve`
  (default `DEFAULT_PRICING.reserveMicroUsd`, $0.05) is how far. A spend that
  would go past it throws `InsufficientBalanceError`, which the gateway maps
  to a 402. Pass `reserveMicroUsd` to the constructor or `open()` to change it.
- **`findApiKeyByHash` ignores revoked keys** and touches `last_used_at` at
  most once a minute, so the authentication path is not a write per request.

## Driver

`pg`. The store has to run against Fly Managed Postgres in production and
against PGlite in-process for `pnpm test`; `pg` takes `$1` placeholders and a
params array and returns `{ rows }`, which is exactly PGlite's `query()`, so
`src/sql.ts` adapts both in a dozen lines each and no SQL exists twice.
`postgres` (porsager) reads better by hand, but its tagged-template API has no
PGlite counterpart, so every query would need a translation layer.

## Admin

`src/admin.ts` is plain functions, no CLI, for the orchestrator to import:

```ts
import { PgBillingStore, grantCredit, listAccounts } from "@milo/billing";

const store = await PgBillingStore.open();
await grantCredit(store, accountId, 5_000_000, "goodwill: ticket 12"); // $5
const accounts = await listAccounts(store, { limit: 100 });
await store.close();
```

A grant goes through the ledger like every other balance change, so it shows
up in the account's history with the note as its reference.

## Tests

```
pnpm test                                   # PGlite, no service needed
MILO_TEST_DATABASE_URL=postgres://... pnpm test   # a real server
```

All database tests live in `src/store.test.ts`. They share one server when
`MILO_TEST_DATABASE_URL` is set, and the suite drops the billing tables before
it starts, so do not point it at anything you want to keep.
