/**
 * `BillingStore` on Postgres. The contract lives in
 * `@milo/core` (packages/core/src/billing/types.ts) and is pinned; this file
 * implements it and adds only what an operator script needs on top
 * (`listAccounts`, `close`).
 *
 * Two invariants are enforced here rather than left to callers:
 *
 *  - A Milo key exists in the database only as a SHA-256 digest and an 8-char
 *    display prefix. `createApiKey` is the one place the secret exists, and it
 *    returns it once.
 *  - `accounts.balance_micro_usd` is only ever moved by `postLedger`, inside
 *    the same transaction that writes the ledger row, under `SELECT ... FOR
 *    UPDATE` on the account. `updateAccount` refuses a balance patch.
 */
import {
  DEFAULT_PRICING,
  MILO_KEY_PREFIX,
  type Account,
  type AccountId,
  type ApiKey,
  type BillingStore,
  type LedgerEntry,
  type LedgerKind,
  type MicroUsd,
  type MiloKeyId,
  type UsageRecord,
} from "@milo/core";
import { randomBytes } from "node:crypto";
import { monotonicFactory } from "ulid";
import { sha256Hex } from "./crypto.js";
import { migrate } from "./migrate.js";
import { openDb, toInt, toIso, toIsoOrNull, toStringOrNull, type Db, type SqlClient, type SqlRow } from "./sql.js";

export const DATABASE_URL_ENV = "MILO_DATABASE_URL";

/** Bytes of randomness behind an `mk_` key. 32 bytes is 43 base64url chars. */
const KEY_RANDOM_BYTES = 32;
/** How much of the random part is kept in the clear, for display. */
const KEY_PREFIX_CHARS = 8;
/** `last_used_at` is a liveness hint, not an audit trail; one write a minute. */
const LAST_USED_INTERVAL = "1 minute";

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 500;

/**
 * Monotonic so ids issued inside the same millisecond still sort in creation
 * order. Every listing here orders by `created_at DESC, id DESC`, and
 * `timestamptz` alone does not separate two rows written in the same
 * microsecond -- the id is what breaks the tie.
 */
const newId = monotonicFactory();

/** A spend that would take the balance below `-reserve`. Callers map this to a 402. */
export class InsufficientBalanceError extends Error {
  constructor(
    readonly accountId: AccountId,
    readonly balanceMicroUsd: MicroUsd,
    readonly amountMicroUsd: MicroUsd,
    readonly reserveMicroUsd: MicroUsd,
  ) {
    super(
      `billing: account ${accountId} has ${balanceMicroUsd} micro-USD; ` +
        `a charge of ${-amountMicroUsd} would pass the -${reserveMicroUsd} floor`,
    );
    this.name = "InsufficientBalanceError";
  }
}

export type PgBillingStoreOptions = {
  /**
   * How far below zero a spend may take an account. A streamed response is
   * charged after the fact, so the balance can land slightly negative; the
   * reserve is how much of that Milo is willing to eat per request.
   */
  reserveMicroUsd?: MicroUsd;
};

const ACCOUNT_COLUMNS = `
  id, email, stripe_customer_id, openrouter_sub_key_enc, openrouter_sub_key_hash,
  balance_micro_usd, status, created_at, updated_at
`;

function rowToAccount(row: SqlRow, prefix = ""): Account {
  const at = (name: string): unknown => row[`${prefix}${name}`];
  return {
    id: String(at("id")),
    email: String(at("email")),
    stripeCustomerId: toStringOrNull(at("stripe_customer_id")),
    openRouterSubKeyEnc: toStringOrNull(at("openrouter_sub_key_enc")),
    openRouterSubKeyHash: toStringOrNull(at("openrouter_sub_key_hash")),
    balanceMicroUsd: toInt(at("balance_micro_usd")),
    status: String(at("status")) as Account["status"],
    createdAt: toIso(at("created_at")),
    updatedAt: toIso(at("updated_at")),
  };
}

function rowToApiKey(row: SqlRow): ApiKey {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    keyHash: String(row["key_hash"]),
    prefix: String(row["prefix"]),
    name: String(row["name"]),
    createdAt: toIso(row["created_at"]),
    revokedAt: toIsoOrNull(row["revoked_at"]),
    lastUsedAt: toIsoOrNull(row["last_used_at"]),
  };
}

function rowToLedgerEntry(row: SqlRow): LedgerEntry {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    kind: String(row["kind"]) as LedgerKind,
    amountMicroUsd: toInt(row["amount_micro_usd"]),
    balanceAfterMicroUsd: toInt(row["balance_after_micro_usd"]),
    reference: String(row["reference"]),
    createdAt: toIso(row["created_at"]),
  };
}

function rowToUsageRecord(row: SqlRow): UsageRecord {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    apiKeyId: String(row["api_key_id"]),
    decisionId: toStringOrNull(row["decision_id"]),
    model: String(row["model"]),
    inputTokens: toInt(row["input_tokens"]),
    outputTokens: toInt(row["output_tokens"]),
    upstreamCostMicroUsd: toInt(row["upstream_cost_micro_usd"]),
    chargedMicroUsd: toInt(row["charged_micro_usd"]),
    createdAt: toIso(row["created_at"]),
  };
}

/** camelCase patch field -> column. `balanceMicroUsd` is deliberately absent. */
const ACCOUNT_PATCH_COLUMNS: Record<string, string> = {
  email: "email",
  stripeCustomerId: "stripe_customer_id",
  openRouterSubKeyEnc: "openrouter_sub_key_enc",
  openRouterSubKeyHash: "openrouter_sub_key_hash",
  status: "status",
};

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX));
}

export class PgBillingStore implements BillingStore {
  readonly reserveMicroUsd: MicroUsd;

  constructor(
    readonly db: Db,
    options: PgBillingStoreOptions = {},
  ) {
    this.reserveMicroUsd = options.reserveMicroUsd ?? DEFAULT_PRICING.reserveMicroUsd;
  }

  /**
   * Opens the database named by `url` (default `MILO_DATABASE_URL`, and
   * in-process PGlite when that is unset), runs pending migrations, and
   * returns the store. Migrating on open matches the decision log and keeps a
   * deploy from needing a separate step; the advisory lock in `migrate` makes
   * it safe for several instances to boot at once.
   */
  static async open(options: PgBillingStoreOptions & { url?: string; migrate?: boolean } = {}): Promise<PgBillingStore> {
    const db = await openDb(options.url ?? process.env[DATABASE_URL_ENV]);
    try {
      if (options.migrate !== false) await migrate(db);
    } catch (error) {
      await db.close();
      throw error;
    }
    const storeOptions: PgBillingStoreOptions = {};
    if (options.reserveMicroUsd !== undefined) storeOptions.reserveMicroUsd = options.reserveMicroUsd;
    return new PgBillingStore(db, storeOptions);
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async createAccount(email: string): Promise<Account> {
    const { rows } = await this.db.query(
      `INSERT INTO accounts (id, email) VALUES ($1, $2) RETURNING ${ACCOUNT_COLUMNS}`,
      [newId(), email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("billing: createAccount inserted no row");
    return rowToAccount(row);
  }

  async getAccount(id: AccountId): Promise<Account | undefined> {
    const { rows } = await this.db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? undefined : rowToAccount(row);
  }

  async getAccountByEmail(email: string): Promise<Account | undefined> {
    const { rows } = await this.db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE lower(email) = lower($1)`, [
      email,
    ]);
    const row = rows[0];
    return row === undefined ? undefined : rowToAccount(row);
  }

  /**
   * Patches an account. `balanceMicroUsd` is rejected: the balance is derived
   * from the ledger (ADR-007), so moving money means `postLedger`, which
   * writes the entry and the new balance in one transaction. Silently
   * accepting a balance patch here would let a caller desynchronise the two.
   */
  async updateAccount(id: AccountId, patch: Partial<Omit<Account, "id" | "createdAt">>): Promise<Account> {
    if (patch.balanceMicroUsd !== undefined) {
      throw new Error("billing: balanceMicroUsd is derived from the ledger; use postLedger");
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [field, column] of Object.entries(ACCOUNT_PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    sets.push("updated_at = now()");

    const { rows } = await this.db.query(
      `UPDATE accounts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      params,
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`billing: no account ${id}`);
    return rowToAccount(row);
  }

  /** Newest first. Not part of `BillingStore`; the admin helpers use it. */
  async listAccounts(opts?: { limit?: number }): Promise<Account[]> {
    const { rows } = await this.db.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at DESC, id DESC LIMIT $1`,
      [clampLimit(opts?.limit)],
    );
    return rows.map((row) => rowToAccount(row));
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  /**
   * Mints `mk_` + 32 bytes of base64url randomness. The secret is returned
   * once and never stored: the row keeps its SHA-256 hex and the first 8
   * characters of the random part, which is all the account page needs to let
   * someone tell two of their keys apart.
   */
  async createApiKey(accountId: AccountId, name: string): Promise<{ key: ApiKey; secret: string }> {
    const random = randomBytes(KEY_RANDOM_BYTES).toString("base64url");
    const secret = `${MILO_KEY_PREFIX}${random}`;
    const { rows } = await this.db.query(
      `INSERT INTO api_keys (id, account_id, key_hash, prefix, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, account_id, key_hash, prefix, name, created_at, revoked_at, last_used_at`,
      [newId(), accountId, sha256Hex(secret), random.slice(0, KEY_PREFIX_CHARS), name],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("billing: createApiKey inserted no row");
    return { key: rowToApiKey(row), secret };
  }

  /**
   * The authentication lookup: the key row plus its account, revoked keys
   * excluded. Also touches `last_used_at`, but at most once a minute -- this
   * runs on every authenticated request, and a write per request would turn a
   * read path into a write path for no information anyone reads at that
   * resolution.
   */
  async findApiKeyByHash(keyHash: string): Promise<(ApiKey & { account: Account }) | undefined> {
    const { rows } = await this.db.query(
      `SELECT k.id, k.account_id, k.key_hash, k.prefix, k.name,
              k.created_at, k.revoked_at, k.last_used_at,
              a.id AS a_id, a.email AS a_email, a.stripe_customer_id AS a_stripe_customer_id,
              a.openrouter_sub_key_enc AS a_openrouter_sub_key_enc,
              a.openrouter_sub_key_hash AS a_openrouter_sub_key_hash,
              a.balance_micro_usd AS a_balance_micro_usd, a.status AS a_status,
              a.created_at AS a_created_at, a.updated_at AS a_updated_at
         FROM api_keys k
         JOIN accounts a ON a.id = k.account_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [keyHash],
    );
    const row = rows[0];
    if (row === undefined) return undefined;

    const key = rowToApiKey(row);
    const touched = await this.db.query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '${LAST_USED_INTERVAL}')
        RETURNING last_used_at`,
      [key.id],
    );
    const touchedRow = touched.rows[0];
    if (touchedRow !== undefined) key.lastUsedAt = toIsoOrNull(touchedRow["last_used_at"]);

    return { ...key, account: rowToAccount(row, "a_") };
  }

  /** No-op if the key is already revoked or does not exist. */
  async revokeApiKey(id: MiloKeyId): Promise<void> {
    await this.db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
  }

  /** Newest first, revoked keys included so the account page can show them. */
  async listApiKeys(accountId: AccountId): Promise<ApiKey[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, key_hash, prefix, name, created_at, revoked_at, last_used_at
         FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC, id DESC`,
      [accountId],
    );
    return rows.map(rowToApiKey);
  }

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------

  /**
   * The only way the balance moves. One transaction: lock the account row,
   * read the balance, check the floor, write the new balance and the ledger
   * entry that explains it. `FOR UPDATE` is what makes concurrent spends add
   * up -- without it two requests can both read the same balance and both
   * decide they fit.
   */
  async postLedger(
    entry: Omit<LedgerEntry, "id" | "balanceAfterMicroUsd" | "createdAt">,
  ): Promise<LedgerEntry> {
    const reserve = this.reserveMicroUsd;
    return this.db.transaction(async (tx: SqlClient) => {
      const { rows } = await tx.query<{ balance_micro_usd: unknown }>(
        "SELECT balance_micro_usd FROM accounts WHERE id = $1 FOR UPDATE",
        [entry.accountId],
      );
      const current = rows[0];
      if (current === undefined) throw new Error(`billing: no account ${entry.accountId}`);

      const balance = toInt(current.balance_micro_usd);
      const next = balance + entry.amountMicroUsd;
      if (entry.amountMicroUsd < 0 && next < -reserve) {
        throw new InsufficientBalanceError(entry.accountId, balance, entry.amountMicroUsd, reserve);
      }

      await tx.query("UPDATE accounts SET balance_micro_usd = $2, updated_at = now() WHERE id = $1", [
        entry.accountId,
        next,
      ]);
      const inserted = await tx.query(
        `INSERT INTO ledger_entries (id, account_id, kind, amount_micro_usd, balance_after_micro_usd, reference)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, account_id, kind, amount_micro_usd, balance_after_micro_usd, reference, created_at`,
        [newId(), entry.accountId, entry.kind, entry.amountMicroUsd, next, entry.reference],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("billing: postLedger inserted no row");
      return rowToLedgerEntry(row);
    });
  }

  /** Newest first. */
  async listLedger(accountId: AccountId, opts?: { limit?: number }): Promise<LedgerEntry[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, kind, amount_micro_usd, balance_after_micro_usd, reference, created_at
         FROM ledger_entries WHERE account_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [accountId, clampLimit(opts?.limit)],
    );
    return rows.map(rowToLedgerEntry);
  }

  // ---------------------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------------------

  async recordUsage(record: Omit<UsageRecord, "id" | "createdAt">): Promise<UsageRecord> {
    const { rows } = await this.db.query(
      `INSERT INTO usage_records
         (id, account_id, api_key_id, decision_id, model, input_tokens, output_tokens,
          upstream_cost_micro_usd, charged_micro_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, account_id, api_key_id, decision_id, model, input_tokens, output_tokens,
                 upstream_cost_micro_usd, charged_micro_usd, created_at`,
      [
        newId(),
        record.accountId,
        record.apiKeyId,
        record.decisionId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.upstreamCostMicroUsd,
        record.chargedMicroUsd,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("billing: recordUsage inserted no row");
    return rowToUsageRecord(row);
  }

  /** Newest first; `limit` defaults to 50 and caps at 500. */
  async listUsage(accountId: AccountId, opts?: { limit?: number; sinceIso?: string }): Promise<UsageRecord[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
    const where = opts?.sinceIso === undefined ? "" : " AND created_at >= $3::timestamptz";
    const params: unknown[] = opts?.sinceIso === undefined ? [accountId, limit] : [accountId, limit, opts.sinceIso];
    const { rows } = await this.db.query(
      `SELECT id, account_id, api_key_id, decision_id, model, input_tokens, output_tokens,
              upstream_cost_micro_usd, charged_micro_usd, created_at
         FROM usage_records
        WHERE account_id = $1${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      params,
    );
    return rows.map(rowToUsageRecord);
  }

  /** `byModel` counts requests per model, the same sense as the decision log's. */
  async usageSummary(
    accountId: AccountId,
    sinceIso?: string,
  ): Promise<{
    requests: number;
    chargedMicroUsd: MicroUsd;
    upstreamCostMicroUsd: MicroUsd;
    byModel: Record<string, number>;
  }> {
    const where = sinceIso === undefined ? "" : " AND created_at >= $2::timestamptz";
    const params = sinceIso === undefined ? [accountId] : [accountId, sinceIso];
    const { rows } = await this.db.query(
      `SELECT model,
              count(*) AS requests,
              coalesce(sum(charged_micro_usd), 0) AS charged,
              coalesce(sum(upstream_cost_micro_usd), 0) AS upstream
         FROM usage_records
        WHERE account_id = $1${where}
        GROUP BY model`,
      params,
    );

    const byModel: Record<string, number> = {};
    let requests = 0;
    let chargedMicroUsd = 0;
    let upstreamCostMicroUsd = 0;
    for (const row of rows) {
      const count = toInt(row["requests"]);
      byModel[String(row["model"])] = count;
      requests += count;
      chargedMicroUsd += toInt(row["charged"]);
      upstreamCostMicroUsd += toInt(row["upstream"]);
    }
    return { requests, chargedMicroUsd, upstreamCostMicroUsd, byModel };
  }

  // ---------------------------------------------------------------------------
  // Stripe
  // ---------------------------------------------------------------------------

  /**
   * True the first time an event id is seen, false afterwards. Stripe retries
   * a webhook until it gets a 2xx, so the handler has to be able to tell a
   * retry from a new event before it posts a credit.
   */
  async markStripeEvent(eventId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      "INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [eventId],
    );
    return rows.length > 0;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
