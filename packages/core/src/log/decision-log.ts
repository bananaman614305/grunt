/**
 * The decision log: every RouteDecision (plus the upstream call outcome,
 * once known) recorded for audit and tuning. Never stores message content
 * or a key; see the guard in `assertNoSecrets`.
 */
import { createClient, type Client, type Row } from "@libsql/client";
import type { DecisionRecord, RouteSignals, Tier } from "../types.js";
import { applyMigrations } from "./schema.js";

const MAX_FIELD_LENGTH = 2000;
const LOOKS_LIKE_SECRET = /sk-or-|Bearer\s/i;

function checkString(path: string, value: string): void {
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(
      `decision log: refusing to store ${path} (${value.length} chars, over the ${MAX_FIELD_LENGTH}-char limit)`,
    );
  }
  if (LOOKS_LIKE_SECRET.test(value)) {
    throw new Error(`decision log: refusing to store ${path} (looks like it contains a key or bearer token)`);
  }
}

/** Recursively walks a value looking for oversized or key-shaped strings. */
function checkNoSecrets(path: string, value: unknown): void {
  if (typeof value === "string") {
    checkString(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => checkNoSecrets(`${path}[${i}]`, item));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      checkNoSecrets(`${path}.${key}`, item);
    }
  }
}

/**
 * Runtime guard: rejects a record whose `reason` or `signals` contain a
 * string over 2,000 characters, or anything that looks like an OpenRouter
 * key or a bearer token. `RouteDecision` never carries message content or
 * a key by contract, but this catches a caller that got it wrong before
 * it lands in SQLite.
 */
function assertNoSecrets(record: DecisionRecord): void {
  checkNoSecrets("reason", record.reason);
  if (record.signals) {
    checkNoSecrets("signals", record.signals);
  }
}

function rowToRecord(row: Row): DecisionRecord {
  const record: DecisionRecord = {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    tier: String(row.tier) as Tier,
    model: String(row.model),
    reason: String(row.reason),
    policyVersion: String(row.policy_version),
    sticky: Boolean(row.sticky),
    degraded: Boolean(row.degraded),
    createdAt: String(row.created_at),
  };
  if (row.signals_json !== null && row.signals_json !== undefined) {
    record.signals = JSON.parse(String(row.signals_json)) as RouteSignals;
  }
  if (row.upstream_json !== null && row.upstream_json !== undefined) {
    record.upstream = JSON.parse(String(row.upstream_json)) as NonNullable<DecisionRecord["upstream"]>;
  }
  return record;
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 500;

export class DecisionLog {
  private constructor(private readonly db: Client) {}

  /** `url` is `":memory:"` or `file:/path/to.db`. Runs migrations before returning. */
  static async open(url: string): Promise<DecisionLog> {
    const db = createClient({ url });
    await applyMigrations(db);
    return new DecisionLog(db);
  }

  async insert(record: DecisionRecord): Promise<void> {
    assertNoSecrets(record);
    await this.db.execute({
      sql: `INSERT INTO decisions
              (id, fingerprint, tier, model, reason, policy_version, sticky, degraded, created_at, signals_json, upstream_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.fingerprint,
        record.tier,
        record.model,
        record.reason,
        record.policyVersion,
        record.sticky ? 1 : 0,
        record.degraded ? 1 : 0,
        record.createdAt,
        record.signals ? JSON.stringify(record.signals) : null,
        record.upstream ? JSON.stringify(record.upstream) : null,
      ],
    });
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    const rs = await this.db.execute({ sql: "SELECT * FROM decisions WHERE id = ?", args: [id] });
    const row = rs.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  /** Newest first. */
  async listRecent(opts?: { limit?: number; fingerprint?: string; degradedOnly?: boolean }): Promise<
    DecisionRecord[]
  > {
    const limit = Math.max(1, Math.min(opts?.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX));
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (opts?.fingerprint) {
      clauses.push("fingerprint = ?");
      args.push(opts.fingerprint);
    }
    if (opts?.degradedOnly) {
      clauses.push("degraded = 1");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rs = await this.db.execute({
      sql: `SELECT * FROM decisions ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [...args, limit],
    });
    return rs.rows.map(rowToRecord);
  }

  /** No-op (does not throw) if `id` does not exist. */
  async setUpstream(id: string, upstream: NonNullable<DecisionRecord["upstream"]>): Promise<void> {
    await this.db.execute({
      sql: "UPDATE decisions SET upstream_json = ? WHERE id = ?",
      args: [JSON.stringify(upstream), id],
    });
  }

  async stats(opts?: { sinceIso?: string }): Promise<{
    total: number;
    byTier: Record<string, number>;
    byModel: Record<string, number>;
    degraded: number;
    sticky: number;
    avgJevLatencyMs: number | null;
  }> {
    const where = opts?.sinceIso ? "WHERE created_at >= ?" : "";
    const args = opts?.sinceIso ? [opts.sinceIso] : [];
    const rs = await this.db.execute({
      sql: `SELECT tier, model, sticky, degraded, signals_json FROM decisions ${where}`,
      args,
    });

    const byTier: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let degraded = 0;
    let sticky = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const row of rs.rows) {
      const tier = String(row.tier);
      const model = String(row.model);
      byTier[tier] = (byTier[tier] ?? 0) + 1;
      byModel[model] = (byModel[model] ?? 0) + 1;
      if (row.degraded) degraded += 1;
      if (row.sticky) sticky += 1;
      if (row.signals_json !== null && row.signals_json !== undefined) {
        const signals = JSON.parse(String(row.signals_json)) as RouteSignals;
        if (typeof signals.latencyMs === "number") {
          latencySum += signals.latencyMs;
          latencyCount += 1;
        }
      }
    }

    return {
      total: rs.rows.length,
      byTier,
      byModel,
      degraded,
      sticky,
      avgJevLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    };
  }

  /** One JSON record per line, oldest first, paginated internally. */
  async *exportJsonl(): AsyncIterable<string> {
    const pageSize = 200;
    let offset = 0;
    for (;;) {
      const rs = await this.db.execute({
        sql: "SELECT * FROM decisions ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
        args: [pageSize, offset],
      });
      if (rs.rows.length === 0) return;
      for (const row of rs.rows) {
        yield `${JSON.stringify(rowToRecord(row))}\n`;
      }
      offset += rs.rows.length;
      if (rs.rows.length < pageSize) return;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
