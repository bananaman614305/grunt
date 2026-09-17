-- Accounts, Milo keys, the money ledger, usage, and Stripe event ids.
-- See docs/adr/007-milo-keys-and-credits.md. Never edit a shipped migration;
-- append a new numbered file instead.

CREATE TABLE IF NOT EXISTS accounts (
  id                        TEXT PRIMARY KEY,
  email                     TEXT NOT NULL,
  stripe_customer_id        TEXT,
  -- The account's OpenRouter sub-key, AES-256-GCM ciphertext (see crypto.ts).
  -- Encrypted rather than hashed because it has to be sent upstream.
  openrouter_sub_key_enc    TEXT,
  openrouter_sub_key_hash   TEXT,
  -- Derived from ledger_entries and maintained in the same transaction that
  -- writes them. May go slightly negative when a stream outruns its reserve.
  balance_micro_usd         BIGINT NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One account per email: getAccountByEmail is a login path, not a search.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_key ON accounts (lower(email));
CREATE INDEX IF NOT EXISTS accounts_stripe_customer_id_idx ON accounts (stripe_customer_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- SHA-256 hex of the whole `mk_...` secret. The secret itself is shown once
  -- at creation and is never stored anywhere.
  key_hash      TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

-- Unique because it is the authentication lookup: two keys hashing the same
-- would be a collision worth failing loudly on.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_key ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_account_id_idx ON api_keys (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind                      TEXT NOT NULL
                              CHECK (kind IN ('credit_purchase', 'usage', 'adjustment', 'refund')),
  -- Positive adds to the balance, negative spends.
  amount_micro_usd          BIGINT NOT NULL,
  balance_after_micro_usd   BIGINT NOT NULL,
  reference                 TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_created_idx
  ON ledger_entries (account_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS usage_records (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  api_key_id                TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  decision_id               TEXT,
  model                     TEXT NOT NULL,
  input_tokens              INTEGER NOT NULL,
  output_tokens             INTEGER NOT NULL,
  upstream_cost_micro_usd   BIGINT NOT NULL,
  charged_micro_usd         BIGINT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_records_account_created_idx
  ON usage_records (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_account_model_idx ON usage_records (account_id, model);
CREATE INDEX IF NOT EXISTS usage_records_decision_id_idx ON usage_records (decision_id);

-- Stripe retries webhooks. The primary key is the whole idempotency mechanism:
-- an insert that conflicts means the event was already applied.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
