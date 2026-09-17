/**
 * The thin database seam the billing store sits on.
 *
 * Driver choice: `pg`. The store has to run against Fly Managed Postgres in
 * production and against PGlite in-process for `pnpm test`, and `pg` is the
 * one that makes those two the same code. It takes `$1` placeholders and an
 * array of params and hands back `{ rows }` -- exactly PGlite's `query()`
 * signature -- so the adapters below are a dozen lines each and no SQL is
 * rewritten per driver. `postgres` (porsager) is nicer to write by hand but
 * its API is a tagged template that builds its own parameter list; PGlite has
 * no equivalent, so every query would have to exist twice or go through a
 * translation layer, which is a worse thing to own than this file.
 */

/** Type-only, so nothing here loads PGlite unless `openPglite` is reached. */
import type * as Pglite from "@electric-sql/pglite";

export type SqlRow = Record<string, unknown>;

/** Something you can run one statement on: a pool, or a connection in a transaction. */
export interface SqlClient {
  query<R extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
  /** Runs a multi-statement script. No parameters; for migrations only. */
  exec(text: string): Promise<void>;
}

export interface Db extends SqlClient {
  /**
   * Runs `fn` on one connection wrapped in BEGIN/COMMIT, rolling back if it
   * throws. Everything `fn` does must go through the `tx` it is handed; a
   * query issued on the `Db` itself takes a different connection and is not
   * part of the transaction.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Which adapter is underneath, for error messages and test skips. */
  readonly driver: "pg" | "pglite";
}

const POOL_MAX = 10;

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/**
 * Opens a database from a URL.
 *
 * - `postgres://...` / `postgresql://...` -> a real server through `pg`.
 * - `memory:` or an empty/absent url -> PGlite in memory (tests).
 * - `pglite:/path/to/dir` -> PGlite persisted to that directory.
 */
export async function openDb(url?: string): Promise<Db> {
  const target = url && url.length > 0 ? url : "memory:";
  if (isPostgresUrl(target)) return openPgPool(target);
  if (target === "memory:") return openPglite(undefined);
  if (target.startsWith("pglite:")) return openPglite(target.slice("pglite:".length));
  throw new Error(
    `billing: unsupported database url ${JSON.stringify(target)} (expected postgres://, pglite:/dir, or memory:)`,
  );
}

async function openPgPool(connectionString: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: POOL_MAX });

  // A pool emits `error` on an idle client dropped by the server. Unhandled,
  // that takes the process down; the pool discards the client either way.
  pool.on("error", () => {});

  const wrap = (run: (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>): SqlClient => ({
    async query<R extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]) {
      const result = await run(text, params);
      return { rows: result.rows as R[] };
    },
    async exec(text: string) {
      await run(text);
    },
  });

  const top = wrap((text, params) => pool.query(text, params === undefined ? undefined : [...params]));

  return {
    driver: "pg",
    query: top.query,
    exec: top.exec,
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap((text, params) => client.query(text, params === undefined ? undefined : [...params])));
        await client.query("COMMIT");
        return out;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection is already unusable; release() below discards it.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await loadPglite();
  const pg = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;

  type PgliteQueryable = {
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(text: string): Promise<unknown>;
  };

  const wrap = (target: PgliteQueryable): SqlClient => ({
    async query<R extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]) {
      const result = await target.query<R>(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await target.exec(text);
    },
  });

  const top = wrap(pg);

  return {
    driver: "pglite",
    query: top.query,
    exec: top.exec,
    // PGlite is one connection and serializes whatever is queued on it, so a
    // transaction here is exclusive by construction: the `FOR UPDATE` in
    // postLedger is a no-op against itself but the arithmetic still lands one
    // transaction at a time, same as a real server.
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

async function loadPglite(): Promise<typeof Pglite> {
  try {
    return await import("@electric-sql/pglite");
  } catch (cause) {
    throw new Error(
      "billing: PGlite is a devDependency of @milo/billing. Install @electric-sql/pglite, " +
        "or point MILO_DATABASE_URL at a postgres:// server.",
      { cause },
    );
  }
}

/** Integer money and counts come back as `string` from `pg` (int8) and as `number` from PGlite. */
export function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  throw new Error(`billing: expected an integer column, got ${typeof value}`);
}

/** `timestamptz` comes back as a `Date` from both drivers; be tolerant anyway. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error(`billing: expected a timestamp column, got ${typeof value}`);
}

export function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

export function toStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
