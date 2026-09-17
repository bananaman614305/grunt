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
  sql: string;
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
];

/**
 * Applies every migration in MIGRATIONS that schema_migrations does not
 * already record, in version order. Safe to call on every `open()`: a
 * migration already recorded is skipped, and every statement in
 * MIGRATIONS' SQL uses IF NOT EXISTS so a partially-applied run (e.g. the
 * process died between executeMultiple and the schema_migrations insert)
 * can still be re-applied without error.
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
    await db.executeMultiple(migration.sql);
    await db.execute({
      sql: "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
      args: [migration.version, migration.description, new Date().toISOString()],
    });
  }
}
