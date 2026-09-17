/**
 * The decision log: every RouteDecision (plus the upstream call outcome,
 * once known) recorded for audit and tuning. Never stores message content
 * or a key; see the guard in `assertNoSecrets`.
 *
 * It also implements `StickyStore`, so the gateway can hand the log to the
 * router as the durable backing for its sticky cache. The two live in the
 * same database on purpose: a sticky entry is a decision that is still in
 * force, and keeping it next to the decisions it points at means one file to
 * back up, one migration path, and no second service to stand up for a table
 * with one row per live conversation.
 */
import { createClient, type Client, type Row } from "@libsql/client";
import type { StickyEntry, StickyStore } from "../router/sticky-store.js";
import type { DecisionRecord, RouteDecision, RouteSignals, Roster, Tier } from "../types.js";
import { assertKeyHash, rosterModelCount } from "./roster-store.js";
import type { RosterMeta, RosterSource, RosterStore, StoredRoster, StoredRosterSummary } from "./roster-store.js";
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
 * it lands in SQLite. Applied to sticky writes too, since those store a
 * whole decision.
 */
function assertNoSecrets(record: RouteDecision): void {
  checkNoSecrets("reason", record.reason);
  if (record.signals) {
    checkNoSecrets("signals", record.signals);
  }
}

/**
 * A decision row as it comes back out, with the account it belongs to when it
 * has one. `accountId` lives here rather than on `DecisionRecord` in
 * `types.ts` because that contract is pinned: a Milo-key account (ADR-007) is
 * a property of the *row*, not of the routing decision, and a bring-your-own
 * key request has no account at all.
 */
export type StoredDecision = DecisionRecord & { accountId?: string };

function rowToRecord(row: Row): StoredDecision {
  const record: StoredDecision = {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    tier: String(row.tier) as Tier,
    model: String(row.model),
    reason: String(row.reason),
    policyVersion: String(row.policy_version),
    sticky: Boolean(row.sticky),
    createdAt: String(row.created_at),
  };
  if (row.signals_json !== null && row.signals_json !== undefined) {
    record.signals = JSON.parse(String(row.signals_json)) as RouteSignals;
  }
  if (row.upstream_json !== null && row.upstream_json !== undefined) {
    record.upstream = JSON.parse(String(row.upstream_json)) as NonNullable<DecisionRecord["upstream"]>;
  }
  if (row.account_id !== null && row.account_id !== undefined) {
    record.accountId = String(row.account_id);
  }
  return record;
}

function rowToStoredRoster(row: Row): StoredRoster {
  return {
    keyHash: String(row.key_hash),
    roster: JSON.parse(String(row.roster_json)) as Roster,
    source: String(row.source) as RosterSource,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 500;

const ROSTER_LIST_LIMIT_DEFAULT = 100;
const ROSTER_LIST_LIMIT_MAX = 1000;

export class DecisionLog implements StickyStore, RosterStore {
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
              (id, fingerprint, tier, model, reason, policy_version, sticky, created_at, signals_json, upstream_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.fingerprint,
        record.tier,
        record.model,
        record.reason,
        record.policyVersion,
        record.sticky ? 1 : 0,
        record.createdAt,
        record.signals ? JSON.stringify(record.signals) : null,
        record.upstream ? JSON.stringify(record.upstream) : null,
      ],
    });
  }

  /**
   * One decision by id.
   *
   * Named `getDecision` rather than `get` because `get` belongs to
   * `StickyStore` below, where it takes a fingerprint and returns a sticky
   * entry. Two `get`s on one class that take a string and mean different
   * things is exactly the sort of thing that reads fine and routes wrong.
   */
  async getDecision(id: string): Promise<StoredDecision | undefined> {
    const rs = await this.db.execute({ sql: "SELECT * FROM decisions WHERE id = ?", args: [id] });
    const row = rs.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Attaches an account to a decision that has already been written. The
   * router logs a decision before the gateway knows anything about money, so
   * the account is stamped on afterwards rather than passed in (ADR-007). A
   * no-op (does not throw) if `id` does not exist.
   */
  async setAccount(id: string, accountId: string): Promise<void> {
    await this.db.execute({ sql: "UPDATE decisions SET account_id = ? WHERE id = ?", args: [accountId, id] });
  }

  /** Newest first. `accountId` scopes the list to one account's decisions. */
  async listRecent(opts?: { limit?: number; fingerprint?: string; accountId?: string }): Promise<StoredDecision[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX));
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (opts?.fingerprint) {
      clauses.push("fingerprint = ?");
      args.push(opts.fingerprint);
    }
    if (opts?.accountId) {
      clauses.push("account_id = ?");
      args.push(opts.accountId);
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

  async stats(opts?: { sinceIso?: string; accountId?: string }): Promise<{
    total: number;
    byTier: Record<string, number>;
    byModel: Record<string, number>;
    sticky: number;
    avgJevLatencyMs: number | null;
  }> {
    const clauses: string[] = [];
    const args: string[] = [];
    if (opts?.sinceIso) {
      clauses.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    if (opts?.accountId) {
      clauses.push("account_id = ?");
      args.push(opts.accountId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rs = await this.db.execute({
      sql: `SELECT tier, model, sticky, signals_json FROM decisions ${where}`,
      args,
    });

    const byTier: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let sticky = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const row of rs.rows) {
      const tier = String(row.tier);
      const model = String(row.model);
      byTier[tier] = (byTier[tier] ?? 0) + 1;
      byModel[model] = (byModel[model] ?? 0) + 1;
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
      sticky,
      avgJevLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    };
  }

  // -------------------------------------------------------------------------
  // StickyStore
  // -------------------------------------------------------------------------

  /**
   * The live sticky entry for a fingerprint, or undefined when there is none
   * or it has expired. An expired row is deleted on the way past, so the
   * table stays roughly the size of the live conversation set without a
   * sweeper.
   */
  async get(fingerprint: string): Promise<StickyEntry | undefined> {
    const rs = await this.db.execute({
      sql: "SELECT user_turns, expires_at, decision_json FROM sticky WHERE fingerprint = ?",
      args: [fingerprint],
    });
    const row = rs.rows[0];
    if (row === undefined) return undefined;

    const expiresAt = Number(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await this.delete(fingerprint);
      return undefined;
    }
    return {
      decision: JSON.parse(String(row.decision_json)) as RouteDecision,
      userTurns: Number(row.user_turns),
      expiresAt,
    };
  }

  /**
   * Pins an entry for a fingerprint, replacing whatever was there. The
   * decision is stored whole rather than joined back to `decisions`: the
   * router writes here before the decision has been logged, and a sticky
   * entry that could not be read until its decision row landed would miss on
   * exactly the turn it is meant to serve. `decision_id` is kept alongside so
   * the entry can still be traced to its row.
   */
  async set(fingerprint: string, entry: StickyEntry): Promise<void> {
    assertNoSecrets(entry.decision);
    await this.db.execute({
      sql: `INSERT INTO sticky (fingerprint, decision_id, user_turns, expires_at, decision_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
              decision_id = excluded.decision_id,
              user_turns = excluded.user_turns,
              expires_at = excluded.expires_at,
              decision_json = excluded.decision_json`,
      args: [
        fingerprint,
        entry.decision.id,
        entry.userTurns,
        entry.expiresAt,
        JSON.stringify(entry.decision),
      ],
    });
  }

  /** No-op (does not throw) if `fingerprint` is not pinned. */
  async delete(fingerprint: string): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM sticky WHERE fingerprint = ?", args: [fingerprint] });
  }

  // -------------------------------------------------------------------------
  // RosterStore
  // -------------------------------------------------------------------------

  /** The roster this key stored, or undefined when it never stored one. */
  async getRoster(keyHash: string): Promise<StoredRoster | undefined> {
    assertKeyHash(keyHash);
    const rs = await this.db.execute({
      sql: "SELECT key_hash, roster_json, source, created_at, updated_at FROM rosters WHERE key_hash = ?",
      args: [keyHash],
    });
    const row = rs.rows[0];
    return row ? rowToStoredRoster(row) : undefined;
  }

  /**
   * Stores (or replaces) one key's roster. `created_at` survives a replace,
   * so the row still says when this user first chose their own models.
   *
   * The roster goes through the same secret guard as a decision: model ids
   * are short strings a user typed, and a user who pastes their key into the
   * model list should get an error rather than a row holding it.
   */
  async setRoster(keyHash: string, roster: Roster, meta: RosterMeta = {}): Promise<StoredRoster> {
    assertKeyHash(keyHash);
    checkNoSecrets("roster", roster);
    const source: RosterSource = meta.source ?? "user";
    const now = meta.now ?? new Date().toISOString();
    const json = JSON.stringify(roster);

    await this.db.execute({
      sql: `INSERT INTO rosters (key_hash, roster_json, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(key_hash) DO UPDATE SET
              roster_json = excluded.roster_json,
              source = excluded.source,
              updated_at = excluded.updated_at`,
      args: [keyHash, json, source, now, now],
    });

    const stored = await this.getRoster(keyHash);
    // The row was just written, so this only fails if something else deleted
    // it concurrently; returning what we wrote is still the honest answer.
    return stored ?? { keyHash, roster, source, createdAt: now, updatedAt: now };
  }

  /** True when a row was there to remove. */
  async deleteRoster(keyHash: string): Promise<boolean> {
    assertKeyHash(keyHash);
    const rs = await this.db.execute({ sql: "DELETE FROM rosters WHERE key_hash = ?", args: [keyHash] });
    return rs.rowsAffected > 0;
  }

  /**
   * Every stored roster, most recently updated first, as shapes rather than
   * contents: a hash, how many models it names, and when it moved. For
   * `milo roster list`, which is an operator looking at a deployment, not a
   * user reading their own list.
   */
  async listRosters(opts?: { limit?: number }): Promise<StoredRosterSummary[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? ROSTER_LIST_LIMIT_DEFAULT, ROSTER_LIST_LIMIT_MAX));
    const rs = await this.db.execute({
      sql: `SELECT key_hash, roster_json, source, created_at, updated_at FROM rosters
            ORDER BY updated_at DESC, key_hash ASC LIMIT ?`,
      args: [limit],
    });
    return rs.rows.map((row) => {
      const stored = rowToStoredRoster(row);
      return {
        keyHash: stored.keyHash,
        modelCount: rosterModelCount(stored.roster),
        source: stored.source,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
    });
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
