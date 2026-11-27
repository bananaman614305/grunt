import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type Statement = string | { sql: string; args?: SQLInputValue[] };

// The daemon uses SQLite locally. The bundle uses Node's driver so the same
// database files can be opened without installing a platform-specific addon.
function withSqliteErrors<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number') {
      const code = error.errcode & 0xff;
      if (code === 5 || code === 6) Object.assign(error, { code: code === 5 ? 'SQLITE_BUSY' : 'SQLITE_LOCKED' });
    }
    throw error;
  }
}

export function createClient({ url }: { url: string }) {
  const path = fileURLToPath(url);
  const open = () => new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const database = open();
  const statements = (db: DatabaseSync) => ({
    execute: async (statement: Statement) => withSqliteErrors(() => {
      const { sql, args = [] } = typeof statement === 'string' ? { sql: statement } : statement;
      return { rows: db.prepare(sql).all(...args) };
    }),
    executeMultiple: async (sql: string) => withSqliteErrors(() => db.exec(sql)),
  });
  const client = statements(database);
  const transaction = async () => {
    const timeout = Number((await client.execute('PRAGMA busy_timeout')).rows[0]?.timeout ?? 0);
    const db = open();
    try { withSqliteErrors(() => db.exec(`PRAGMA busy_timeout=${timeout}; BEGIN IMMEDIATE`)); }
    catch (error) { db.close(); throw error; }
    const operations = statements(db);
    let closed = false;
    const close = () => {
      if (closed) return;
      db.close();
      closed = true;
    };
    return {
      get closed() { return closed; },
      execute: operations.execute,
      executeMultiple: async (sql: string) => {
        await operations.executeMultiple(sql);
        if (sql === 'COMMIT' || sql === 'ROLLBACK') close();
      },
      commit: async () => { await operations.executeMultiple('COMMIT'); close(); },
      rollback: async () => { if (!closed) { await operations.executeMultiple('ROLLBACK'); close(); } },
      close,
    };
  };
  return {
    ...client,
    transaction,
    batch: async (batch: Statement[]) => {
      const tx = await transaction();
      try {
        for (const statement of batch) await tx.execute(statement);
        await tx.commit();
      } finally { tx.close(); }
    },
    close: () => database.close(),
  };
}
