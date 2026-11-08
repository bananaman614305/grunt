/**
 * Persistence for the subscription usage meter, in the same SQLite file as
 * the decision log (migration 12). Counts, timings and limit readings only.
 */

import { createClient } from "@libsql/client";
import type { Client, Row } from "@libsql/client";
import { applyMigrations } from "../log/schema.js";
import { isSubscriptionId } from "./types.js";
import type { BackendErrorKind, LimitSignal, SubscriptionId } from "./types.js";

export type CallRecord = {
  id: string;
  decisionId: string;
  backend: SubscriptionId;
  createdAt: string;
  ok: boolean;
  error?: BackendErrorKind;
  latencyMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiEquivalentUsd?: number;
  taskType?: string;
  reason?: string;
};

export type UsageTotals = {
  backend: SubscriptionId;
  calls: number;
  failures: number;
  rateLimited: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Sum of the API-equivalent cost the CLI reported, where it reported one. */
  apiEquivalentUsd: number;
  latencyMsTotal: number;
};

export class UsageStore {
  private constructor(private readonly db: Client) {}

  /** `url` is `":memory:"` or `file:/path/to.db`. Runs migrations before returning. */
  static async open(url: string): Promise<UsageStore> {
    const db = createClient({ url });
    await applyMigrations(db);
    return new UsageStore(db);
  }

  async recordCall(call: CallRecord): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO subscription_calls
              (id, decision_id, backend, created_at, ok, error, latency_ms, input_tokens, cached_input_tokens,
               output_tokens, api_equivalent_usd, task_type, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        call.id,
        call.decisionId,
        call.backend,
        call.createdAt,
        call.ok ? 1 : 0,
        call.error ?? null,
        Math.round(call.latencyMs),
        call.inputTokens,
        call.cachedInputTokens,
        call.outputTokens,
        call.apiEquivalentUsd ?? null,
        call.taskType ?? null,
        call.reason ?? null,
      ],
    });
  }

  async saveLimits(backend: SubscriptionId, limits: LimitSignal): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO subscription_limits (backend, observed_at, status, windows_json) VALUES (?, ?, ?, ?)
            ON CONFLICT (backend) DO UPDATE SET observed_at = excluded.observed_at, status = excluded.status,
              windows_json = excluded.windows_json`,
      args: [backend, limits.observedAt, limits.status, JSON.stringify(limits.windows)],
    });
  }

  async loadLimits(): Promise<Partial<Record<SubscriptionId, LimitSignal>>> {
    const rs = await this.db.execute("SELECT backend, observed_at, status, windows_json FROM subscription_limits");
    const out: Partial<Record<SubscriptionId, LimitSignal>> = {};
    for (const row of rs.rows) {
      const backend = String(row["backend"]);
      if (!isSubscriptionId(backend)) continue;
      const status = String(row["status"]);
      out[backend] = {
        observedAt: String(row["observed_at"]),
        status: status === "limited" || status === "warning" ? status : "allowed",
        windows: parseWindows(row["windows_json"]),
      };
    }
    return out;
  }

  /** When each backend last failed with a rate-limit error, if ever. */
  async lastRateLimited(): Promise<Partial<Record<SubscriptionId, string>>> {
    const rs = await this.db.execute(
      "SELECT backend, MAX(created_at) AS at FROM subscription_calls WHERE error = 'rate_limited' GROUP BY backend",
    );
    const out: Partial<Record<SubscriptionId, string>> = {};
    for (const row of rs.rows) {
      const backend = String(row["backend"]);
      if (isSubscriptionId(backend) && row["at"] !== null) out[backend] = String(row["at"]);
    }
    return out;
  }

  /** Per-backend totals for calls created at or after `since` (ISO 8601). */
  async totals(since: string): Promise<UsageTotals[]> {
    const rs = await this.db.execute({
      sql: `SELECT backend,
                   COUNT(*) AS calls,
                   SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                   SUM(CASE WHEN error = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
                   SUM(input_tokens) AS input_tokens,
                   SUM(cached_input_tokens) AS cached_input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(COALESCE(api_equivalent_usd, 0)) AS api_usd,
                   SUM(latency_ms) AS latency_ms
            FROM subscription_calls WHERE created_at >= ? GROUP BY backend ORDER BY backend`,
      args: [since],
    });
    return rs.rows.flatMap((row) => {
      const backend = String(row["backend"]);
      return isSubscriptionId(backend) ? [toTotals(backend, row)] : [];
    });
  }

  close(): void {
    this.db.close();
  }
}

function toTotals(backend: SubscriptionId, row: Row): UsageTotals {
  return {
    backend,
    calls: Number(row["calls"] ?? 0),
    failures: Number(row["failures"] ?? 0),
    rateLimited: Number(row["rate_limited"] ?? 0),
    inputTokens: Number(row["input_tokens"] ?? 0),
    cachedInputTokens: Number(row["cached_input_tokens"] ?? 0),
    outputTokens: Number(row["output_tokens"] ?? 0),
    apiEquivalentUsd: Number(row["api_usd"] ?? 0),
    latencyMsTotal: Number(row["latency_ms"] ?? 0),
  };
}

function parseWindows(raw: unknown): LimitSignal["windows"] {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as LimitSignal["windows"]) : [];
  } catch {
    return [];
  }
}
