/**
 * Forward-only migration runner.
 *
 * Migrations are numbered `.sql` files in `src/migrations/` (`001_billing.sql`,
 * `002_....sql`). They are applied in numeric order, each in its own
 * transaction together with the `schema_migrations` row that records it, so a
 * crash mid-run leaves the database on a migration boundary and the next run
 * picks up where it stopped. There is no down path: to change something
 * shipped, append another file.
 *
 * The runner also takes an advisory lock, so two instances booting at once
 * (the gateway and a `pnpm migrate`, say) do not both try to create the same
 * table.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./sql.js";

export type Migration = {
  /** Monotonically increasing, starting at 1. */
  version: number;
  /** The filename, which is what `schema_migrations` records. */
  name: string;
  sql: string;
};

const FILENAME = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

/** Arbitrary but fixed: `hashtext('milo.billing.migrate')` would do as well. */
const ADVISORY_LOCK_KEY = 4_170_071;

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new Error(`billing: cannot read migrations from ${dir} (did the build copy them?)`, { cause });
  }

  const migrations: Migration[] = [];
  for (const entry of entries.sort()) {
    const match = FILENAME.exec(entry);
    if (match === null) {
      if (entry.endsWith(".sql")) {
        throw new Error(`billing: migration ${entry} is not named <number>_<name>.sql`);
      }
      continue;
    }
    migrations.push({
      version: Number(match[1]),
      name: entry,
      sql: await readFile(join(dir, entry), "utf8"),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  for (const [i, migration] of migrations.entries()) {
    if (migration.version !== i + 1) {
      throw new Error(
        `billing: migration versions must run 1..n with no gaps; found ${migration.name} where ${i + 1} was expected`,
      );
    }
  }
  return migrations;
}

/**
 * Applies every migration `schema_migrations` does not already record.
 * Idempotent: calling it on an up-to-date database applies nothing and
 * returns an empty list.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const migrations = await loadMigrations(dir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied: Migration[] = [];
  for (const migration of migrations) {
    const done = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
      const { rows } = await tx.query<{ version: unknown }>("SELECT version FROM schema_migrations WHERE version = $1", [
        migration.version,
      ]);
      if (rows.length > 0) return false;

      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      return true;
    });
    if (done) applied.push(migration);
  }
  return applied;
}

/** Versions already recorded, ascending. */
export async function appliedVersions(db: Db): Promise<number[]> {
  const { rows } = await db.query<{ version: unknown }>("SELECT version FROM schema_migrations ORDER BY version");
  return rows.map((row) => Number(row.version));
}
