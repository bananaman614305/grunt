/**
 * Cost attribution from Milo's decision log (`GET /v1/decisions`).
 *
 * After each task the runner fetches the recent decisions and keeps the ones
 * whose `createdAt` falls inside the task's wall-clock window (with a small
 * skew allowance). That is deliberately approximate: nothing ties a decision
 * row to a pi session, so concurrent traffic on the same gateway would be
 * misattributed. Every report row carries the label
 * `approximate (time-window)` for exactly that reason.
 */

export const ATTRIBUTION_METHOD = "approximate (time-window)";
export const DEFAULT_SKEW_MS = 2_000;
const FETCH_LIMIT = 200;

/** The slice of a gateway `DecisionRecord` the benchmark reports on. */
export type DecisionRow = {
  id: string;
  tier: string;
  model: string;
  createdAt: string;
  /** Best-of-N fan-out width; 1 when the decision was not sampled. */
  samples: number;
  costUsd: number;
};

export type TaskAttribution = {
  method: typeof ATTRIBUTION_METHOD;
  decisions: DecisionRow[];
  costUsd: number;
  /** Set when the decisions fetch failed; the task still gets a verdict. */
  error?: string;
};

/** `/v1/decisions` lives next to `/v1/chat/completions`, so strip a trailing `/v1`. */
export function decisionsUrl(gateway: string): string {
  const root = gateway.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1/decisions?limit=${FETCH_LIMIT}`;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRow(value: unknown): DecisionRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["createdAt"] !== "string") return undefined;
  const upstream =
    typeof r["upstream"] === "object" && r["upstream"] !== null
      ? (r["upstream"] as Record<string, unknown>)
      : undefined;
  return {
    id: r["id"],
    tier: typeof r["tier"] === "string" ? r["tier"] : "unknown",
    model: typeof r["model"] === "string" ? r["model"] : "unknown",
    createdAt: r["createdAt"],
    samples: num(r["samples"]) || 1,
    costUsd: upstream === undefined ? 0 : num(upstream["costUsd"]),
  };
}

/**
 * Keep the decisions created inside `[startMs - skew, endMs + skew]`, oldest
 * first, and total their cost. Records that do not look like decisions are
 * dropped rather than trusted.
 */
export function attributeWindow(
  records: unknown[],
  startMs: number,
  endMs: number,
  skewMs: number = DEFAULT_SKEW_MS,
): TaskAttribution {
  const rows = records
    .map(toRow)
    .filter((row): row is DecisionRow => {
      if (row === undefined) return false;
      const at = Date.parse(row.createdAt);
      return Number.isFinite(at) && at >= startMs - skewMs && at <= endMs + skewMs;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    method: ATTRIBUTION_METHOD,
    decisions: rows,
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
  };
}

/**
 * Fetch recent decisions and attribute the window. The bearer is the same
 * OpenRouter key pi authenticates to the gateway with; it is sent to the
 * gateway only. Any failure (no key, network, non-200, bad JSON) comes back
 * as an `error` string on an empty attribution -- never a thrown exception,
 * so a decisions hiccup cannot void a finished task.
 */
export async function fetchAttribution(
  gateway: string,
  apiKey: string | undefined,
  startMs: number,
  endMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskAttribution> {
  const empty: TaskAttribution = { method: ATTRIBUTION_METHOD, decisions: [], costUsd: 0 };
  if (apiKey === undefined || apiKey === "") {
    return { ...empty, error: "OPENROUTER_API_KEY not set; decisions not fetched" };
  }
  try {
    const res = await fetchImpl(decisionsUrl(gateway), {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { ...empty, error: `decisions fetch failed: HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return { ...empty, error: "decisions fetch failed: no data array" };
    return attributeWindow(body.data, startMs, endMs);
  } catch (err) {
    return { ...empty, error: `decisions fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
