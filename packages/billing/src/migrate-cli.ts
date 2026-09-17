/**
 * `pnpm --filter @milo/billing migrate`. Applies pending migrations to
 * `MILO_DATABASE_URL` and prints what it did. Exits non-zero on failure so a
 * deploy step can depend on it.
 */
import { migrate } from "./migrate.js";
import { openDb } from "./sql.js";
import { DATABASE_URL_ENV } from "./store.js";

const url = process.env[DATABASE_URL_ENV];
if (url === undefined || url === "") {
  console.error(`billing: ${DATABASE_URL_ENV} is not set`);
  process.exit(1);
}

const db = await openDb(url);
try {
  const applied = await migrate(db);
  if (applied.length === 0) {
    console.log("billing: already up to date");
  } else {
    for (const migration of applied) console.log(`billing: applied ${migration.name}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
