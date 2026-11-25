import { createClient } from "@libsql/client";
import type { Client, InValue } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Call, Kind, Message, Note, Status, Task } from "./types.js";

export class AgentStore {
  private constructor(readonly db: Client) {}
  static async open(url: string) {
    if (url.startsWith("file:") && url !== "file::memory:") mkdirSync(dirname(url.slice(5)), { recursive: true });
    const db = createClient({ url: url === ":memory:" ? "file::memory:" : url });
    await db.executeMultiple(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, person TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_person ON messages(person, ts);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, person TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, model TEXT, route_reason TEXT, result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_person ON tasks(person, created_at);
      CREATE TABLE IF NOT EXISTS notes (person TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(person, text));
      CREATE TABLE IF NOT EXISTS calls (model TEXT NOT NULL, kind TEXT NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, latency_ms INTEGER NOT NULL, outcome TEXT NOT NULL, cost REAL NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_metering(started_at INTEGER NOT NULL PRIMARY KEY);
      INSERT INTO account_metering SELECT ${Date.now()} WHERE NOT EXISTS (SELECT 1 FROM account_metering);
      CREATE INDEX IF NOT EXISTS calls_time ON calls(ts);
      UPDATE tasks SET status='failed', error='Gateway restarted before the task finished.', updated_at=${Date.now()} WHERE status IN ('queued','running');
    `);
    // Keep the timestamp and outcome on the attribution itself: calls.rowid can change during VACUUM.
    const tx = await db.transaction('write');
    try {
      const legacy = (await tx.execute("PRAGMA table_info(account_attempts)")).rows.some(row => row.name === 'call_id');
      if (legacy) await tx.execute("ALTER TABLE account_attempts RENAME TO account_attempts_legacy");
      await tx.execute(`CREATE TABLE IF NOT EXISTS account_attempts(
        id INTEGER PRIMARY KEY, account TEXT NOT NULL, measured_tokens INTEGER, device TEXT NOT NULL,
        country TEXT NOT NULL, ts INTEGER NOT NULL, outcome TEXT NOT NULL)`);
      if (legacy) {
        // Previous country values came from unverified request headers.
        await tx.execute(`INSERT INTO account_attempts(id,account,measured_tokens,device,country,ts,outcome)
          SELECT a.call_id,a.account,a.measured_tokens,a.device,'Unknown',c.ts,c.outcome
          FROM account_attempts_legacy a JOIN calls c ON c.rowid=a.call_id`);
        await tx.execute("DROP TABLE account_attempts_legacy");
      }
      await tx.execute("CREATE INDEX IF NOT EXISTS account_attempts_account ON account_attempts(account,ts)");
      await tx.execute("CREATE INDEX IF NOT EXISTS account_attempts_time ON account_attempts(ts)");
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      db.close();
      throw error;
    }
    return new AgentStore(db);
  }
  private async rows<T>(sql: string, args: InValue[] = []): Promise<T[]> {
    return (await this.db.execute({ sql, args })).rows as unknown as T[];
  }
  async messages(person: string) { return (await this.rows<Message>("SELECT * FROM messages WHERE person=? ORDER BY rowid DESC LIMIT 20", [person])).reverse(); }
  async tasks(person: string) { return this.rows<Task>("SELECT * FROM tasks WHERE person=? AND status IN ('queued','running') UNION ALL SELECT * FROM (SELECT * FROM tasks WHERE person=? AND status NOT IN ('queued','running') ORDER BY created_at DESC LIMIT 30)", [person, person]); }
  async task(person: string, id: string) { return (await this.rows<Task>("SELECT * FROM tasks WHERE person=? AND id=?", [person, id]))[0]; }
  async notes(person: string) { return this.rows<Note>("SELECT text,ts FROM notes WHERE person=? ORDER BY rowid DESC LIMIT 64", [person]); }
  async calls() { return this.rows<Call>("SELECT * FROM calls ORDER BY rowid DESC LIMIT 500"); }
  async message(person: string, role: Message["role"], text: string): Promise<Message> {
    const m = { id: randomUUID(), person, role, text, ts: Date.now() };
    await this.db.execute({ sql: "INSERT INTO messages VALUES (?,?,?,?,?)", args: [m.id, person, role, text, m.ts] });
    return m;
  }
  async remember(person: string, text: string) { await this.db.execute({ sql: "INSERT OR IGNORE INTO notes VALUES (?,?,?)", args: [person, text, Date.now()] }); }
  async dispatch(person: string, title: string, brief: string, kind: Kind) {
    const id = randomUUID(), now = Date.now();
    await this.db.execute({ sql: "INSERT INTO tasks (id,person,title,brief,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)", args: [id, person, title, brief, kind, now, now] });
    return (await this.task(person, id))!;
  }
  async update(person: string, id: string, patch: Partial<Pick<Task, "status" | "model" | "route_reason" | "result" | "error">>, from: Status[] = ["queued", "running"]) {
    const entries = Object.entries({ ...patch, updated_at: Date.now() });
    await this.db.execute({ sql: `UPDATE tasks SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE person=? AND id=? AND status IN (${from.map(() => "?").join(",")})`, args: [...entries.map(([, v]) => v), person, id, ...from] });
    return this.task(person, id);
  }
  async record(c: Call, attribution?: { account: string; tokens: number | null; device: string; country: string }) {
    const insert = { sql: "INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)", args: [c.model,c.kind,c.tokens_in,c.tokens_out,c.latency_ms,c.outcome,c.cost,c.ts] };
    if (!attribution) { await this.db.execute(insert); return; }
    const { account, tokens, device, country } = attribution;
    await this.db.batch([insert, { sql: "INSERT INTO account_attempts(account,measured_tokens,device,country,ts,outcome) VALUES (?,?,?,?,?,?)",
      args: [account, tokens, device, country, c.ts, c.outcome] }], 'write');
  }
  async state(person: string) {
    const [messages, tasks, notes] = await Promise.all([this.messages(person), this.tasks(person), this.notes(person)]);
    return { messages, tasks, notes };
  }
  close() { this.db.close(); }
}
