/** `milo stats [--since <iso>] [--db <url>]`. */
import { parseArgs } from "node:util";
import type { DecisionLog } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL } from "../config.js";
import type { CliDeps } from "../deps.js";

export const help = `Usage: milo stats [options]

Print a summary of the decision log.

Options:
  --since <iso>   Only include decisions at or after this ISO 8601 timestamp
  --db <url>      Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  -h, --help      Show this help
`;

type Stats = Awaited<ReturnType<DecisionLog["stats"]>>;

export function formatStats(stats: Stats): string {
  const lines = [`Total decisions: ${stats.total}`, "By tier:"];
  for (const [tier, count] of Object.entries(stats.byTier)) {
    lines.push(`  ${tier}: ${count}`);
  }
  lines.push("By model:");
  for (const [model, count] of Object.entries(stats.byModel)) {
    lines.push(`  ${model}: ${count}`);
  }
  lines.push(`Degraded: ${stats.degraded}`);
  lines.push(`Sticky: ${stats.sticky}`);
  lines.push(
    `Average Jev latency: ${stats.avgJevLatencyMs !== null ? `${stats.avgJevLatencyMs.toFixed(1)}ms` : "n/a"}`,
  );
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
    deps.stderr.write(`milo stats: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const since = parsed.values.since;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    deps.stderr.write(`milo stats: --since is not a valid ISO 8601 timestamp: "${since}"\n`);
    return 1;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  const log = await deps.openLog(dbUrl);
  try {
    const stats = await log.stats(since !== undefined ? { sinceIso: since } : undefined);
    deps.stdout.write(`${formatStats(stats)}\n`);
    return 0;
  } finally {
    await log.close();
  }
}
