/**
 * SQL schema for the decision log, plus a tiny forward-only migration
 * runner. Add new columns by appending a migration to MIGRATIONS; never
 * edit an already-shipped migration's SQL.
 */
import type { Client } from "@libsql/client";

export type Migration = {
  /** Monotonically increasing, starting at 1. */
  version: number;
  description: string;
  /** One or more statements, separated by semicolons. */
  sql?: string;
  /**
   * Runs instead of `sql`, for a change SQLite cannot express as plain
   * statements that are safe to re-run (an `ADD COLUMN` that has to be
   * skipped when the column is already there, say).
   */
  run?: (db: Client) => Promise<void>;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "create decisions table",
    sql: `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  sticky INTEGER NOT NULL,
  degraded INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  signals_json TEXT,
  upstream_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions (created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_fingerprint ON decisions (fingerprint);
`,
  },
  {
    version: 2,
    description: "drop the degraded column and add the sticky table",
    // Two changes, one migration, because they are one decision: routing has
    // no fallback tier any more (ADR-002 revision 3), so there is nothing for
    // a `degraded` flag to mean, and stickiness has to survive a redeploy
    // now that a cold instance cannot quietly answer `mid` while it warms up.
    //
    // SQLite grew ALTER TABLE ... DROP COLUMN in 3.35, but it refuses on a
    // NOT NULL column without a default, which is how migration 1 declared
    // this one. So the table is rebuilt. Migration 1 is left exactly as
    // shipped: a database created before this is migrated by the rebuild
    // below, and a fresh one briefly creates the column and then drops it,
    // which costs nothing and keeps the history honest.
    sql: `
CREATE TABLE IF NOT EXISTS decisions_v2 (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  sticky INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  signals_json TEXT,
  upstream_json TEXT
);
INSERT OR IGNORE INTO decisions_v2
  (id, fingerprint, tier, model, reason, policy_version, sticky, created_at, signals_json, upstream_json)
  SELECT id, fingerprint, tier, model, reason, policy_version, sticky, created_at, signals_json, upstream_json
  FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_v2 RENAME TO decisions;
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions (created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_fingerprint ON decisions (fingerprint);

CREATE TABLE IF NOT EXISTS sticky (
  fingerprint TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  user_turns INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decision_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticky_expires_at ON sticky (expires_at);
`,
  },
  {
    version: 3,
    description: "add the per-key roster table",
    // Per-key rosters (ADR-008). Keyed by the SHA-256 of the bearer
    // credential -- the same hash the rate limiter buckets on -- because Milo
    // stores no key material (ADR-003) but still has to recognise the same
    // caller on a shared deployment. `roster_json` is the whole `Roster`, so
    // a row is self-contained and readable without the model catalogue.
    sql: `
CREATE TABLE IF NOT EXISTS rosters (
  key_hash TEXT PRIMARY KEY,
  roster_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rosters_updated_at ON rosters (updated_at);
`,
  },
  {
    version: 4,
    description: "add the decision account column",
    // Milo-issued keys (ADR-007) make one deployment multi-tenant, so a
    // decision now has to say whose it was: `/v1/decisions*` returns only the
    // authenticated account's rows. Nullable, because a bring-your-own-key
    // request has no account, and every row written before this migration has
    // none either -- those stay deployment-wide, exactly as they were.
    //
    // `run` rather than `sql`: SQLite has no `ADD COLUMN IF NOT EXISTS`, and
    // this runner re-applies a migration whose bookkeeping insert did not
    // land, so the add has to be skipped when the column is already there.
    run: async (db) => {
      const columns = await db.execute("PRAGMA table_info(decisions)");
      if (!columns.rows.some((row) => String(row.name) === "account_id")) {
        await db.execute("ALTER TABLE decisions ADD COLUMN account_id TEXT");
      }
      await db.execute("CREATE INDEX IF NOT EXISTS idx_decisions_account_id ON decisions (account_id)");
    },
  },
  {
    version: 5,
    description: "add the sampling columns",
    // Best-of-N sampling (ADR-010): a decision may resolve to N fast-tier
    // samples, and the row then has to say both what executed (`tier`, the
    // fast model) and what the policy would have picked without sampling
    // (`unsampled_tier`), or the audit trail cannot explain the choice.
    // Nullable: every unsampled decision, and every row written before this
    // migration, has neither. Same `run` shape as migration 4, because
    // SQLite has no `ADD COLUMN IF NOT EXISTS` and a partially-applied run
    // must be re-appliable.
    run: async (db) => {
      const columns = await db.execute("PRAGMA table_info(decisions)");
      const names = new Set(columns.rows.map((row) => String(row.name)));
      if (!names.has("samples")) {
        await db.execute("ALTER TABLE decisions ADD COLUMN samples INTEGER");
      }
      if (!names.has("unsampled_tier")) {
        await db.execute("ALTER TABLE decisions ADD COLUMN unsampled_tier TEXT");
      }
    },
  },
  {
    version: 6,
    description: "add the preference tables",
    // Preference memory (ADR-011). Keyed like rosters by the SHA-256 of the
    // bearer credential (the account key's hash for `mk_` keys), because Milo
    // stores no key material (ADR-003). One row per (caller, scope, field):
    // `scope` is "global" or a task type, `field` a closed-vocabulary label,
    // `value` a member of that field's closed vocabulary -- never message
    // content. `provenance` is the fingerprint of the teaching turn, so a row
    // can say where it came from without saying what was said. `version`
    // counts contradictions: replacing a value bumps it and resets
    // `confidence`; repetition only raises `confidence` (capped at 1).
    //
    // `preference_settings` carries the per-key switches ADR-011 promises:
    // capture off entirely, and the brief off for every request from a key.
    // A key with no row has both on.
    sql: `
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  version INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (key_hash, scope, field)
);
CREATE INDEX IF NOT EXISTS idx_preferences_key_hash ON preferences (key_hash);

CREATE TABLE IF NOT EXISTS preference_settings (
  key_hash TEXT PRIMARY KEY,
  capture_enabled INTEGER NOT NULL DEFAULT 1,
  brief_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    description: "add the personal-fact tables",
    // Personal-fact memory (ADR-017). Keyed like preferences and rosters by
    // the SHA-256 of the bearer credential (ADR-008), because Milo stores no
    // key material (ADR-003). Unlike the preference table, `content_encrypted`
    // holds the user's own words -- the fact text -- through the billing
    // AES-256-GCM envelope keyed by MILO_ENCRYPTION_KEY. This is the one place
    // Milo persists raw content, and it is why the column is never plaintext:
    // the store refuses to write a fact when no encryptor is available, and
    // the migration names the column `_encrypted` so no future reader mistakes
    // it for cleartext. `category` is a closed-vocabulary LABEL (address,
    // contact, identifier, credential-hint, convention, other) that rides
    // alongside the ciphertext; the label is not content. `provenance` is the
    // fingerprint of the capturing turn -- a digest, never content.
    //
    // `fact_settings` carries the per-key kill switch ADR-017 promises: a key
    // with no row has fact memory on (default 1), and the switch turns capture
    // and injection off for everything from that key.
    sql: `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  content_encrypted TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_key_hash ON facts (key_hash);

CREATE TABLE IF NOT EXISTS fact_settings (
  key_hash TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`,
  },
];

/**
 * Applies every migration in MIGRATIONS that schema_migrations does not
 * already record, in version order. Safe to call on every `open()`: a
 * migration already recorded is skipped, and every statement in
 * MIGRATIONS' SQL is written so a partially-applied run (e.g. the process
 * died between executeMultiple and the schema_migrations insert) can still
 * be re-applied without error -- `IF NOT EXISTS` on every create,
 * `INSERT OR IGNORE` on the migration-2 table copy, and migration 4's `run`
 * checking for its column before adding it.
 */
export async function applyMigrations(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = await db.execute("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => Number(row.version)));

  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));

  for (const migration of pending) {
    if (migration.sql !== undefined) await db.executeMultiple(migration.sql);
    if (migration.run !== undefined) await migration.run(db);
    await db.execute({
      sql: "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
      args: [migration.version, migration.description, new Date().toISOString()],
    });
  }
}
