/** `milo cost [--since <iso>] [--db <url>]`. */
import { parseArgs } from "node:util";
import type { DecisionLog } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL } from "../config.js";
import type { CliDeps } from "../deps.js";
import { formatTable } from "../format.js";

export const help = `Usage: milo cost [options]

Show what routed requests actually cost, read from the decision log:
total spend, cost by tier and by model, average per request, and the
best-of-N sampling tax.

Options:
  --since <iso>   Only include decisions at or after this ISO 8601 timestamp
  --db <url>      Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  -h, --help      Show this help
`;

type Cost = Awaited<ReturnType<DecisionLog["stats"]>>["cost"];

/** Six-decimal dollars, e.g. `$0.001234`. Sub-cent costs are the common case. */
function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function formatCost(cost: Cost): string {
  const lines = [
    `Total spend:      ${usd(cost.total)}`,
    `Priced requests:  ${cost.withCost}`,
    `Avg per request:  ${cost.avgPerRequest !== null ? usd(cost.avgPerRequest) : "n/a"}`,
  ];

  const taxPct = cost.total > 0 ? ` (${((cost.samplingTax / cost.total) * 100).toFixed(1)}% of total)` : "";
  lines.push(`Sampling tax:     ${usd(cost.samplingTax)}${taxPct}`);

  const tierRows = Object.entries(cost.byTier).map(([tier, spend]) => [tier, usd(spend)]);
  lines.push("", "By tier:");
  lines.push(tierRows.length > 0 ? formatTable(["tier", "spend"], tierRows) : "  (no priced requests)");

  const modelRows = Object.entries(cost.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, spend]) => [model, usd(spend)]);
  lines.push("", "By model:");
  lines.push(modelRows.length > 0 ? formatTable(["model", "spend"], modelRows) : "  (no priced requests)");

  return lines.join("\n");
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        since: { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo cost: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const since = parsed.values.since;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    deps.stderr.write(`milo cost: --since is not a valid ISO 8601 timestamp: "${since}"\n`);
    return 1;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  const log = await deps.openLog(dbUrl);
  try {
    const stats = await log.stats(since !== undefined ? { sinceIso: since } : undefined);
    deps.stdout.write(`${formatCost(stats.cost)}\n`);
    return 0;
  } finally {
    await log.close();
  }
}
