/**
 * Test database. `MILO_TEST_DATABASE_URL` points the suite at a real
 * Postgres; with it unset the tests run on PGlite, which is Postgres compiled
 * to wasm and runs in the test process, so `pnpm test` needs no service.
 *
 * Excluded from the build (see tsconfig `exclude`) because it is the one file
 * that reaches for the devDependency.
 */
import { openDb, type Db } from "./sql.js";

export const TEST_DATABASE_URL_ENV = "MILO_TEST_DATABASE_URL";

/**
 * A migrated-from-scratch database. On PGlite that is a fresh in-memory
 * instance per call; on a real server the billing tables are dropped first,
 * so pointing `MILO_TEST_DATABASE_URL` at anything you care about will lose
 * it. Keep all database tests in one file: they share the server.
 */
export async function openTestDb(): Promise<Db> {
  const url = process.env[TEST_DATABASE_URL_ENV];
  const db = await openDb(url !== undefined && url !== "" ? url : "memory:");
  if (db.driver === "pg") {
    await db.exec(`
      DROP TABLE IF EXISTS usage_records, ledger_entries, api_keys, stripe_events,
                           accounts, schema_migrations CASCADE;
    `);
  }
  return db;
}
