/** `milo decisions [--limit <n>] [--db <url>]`. */
import { parseArgs } from "node:util";
import type { DecisionRecord } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL } from "../config.js";
import type { CliDeps } from "../deps.js";
import { formatTable } from "../format.js";

export const help = `Usage: milo decisions [options]

List recent routing decisions as a compact table.

Options:
  --limit <n>   Max rows to print (default: 20)
  --db <url>    Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  -h, --help    Show this help
`;

const DEFAULT_LIMIT = 20;

function flags(record: DecisionRecord): string {
  const parts: string[] = [];
  if (record.sticky) parts.push("sticky");
  return parts.length > 0 ? parts.join(",") : "-";
}

export function formatDecisionsTable(records: DecisionRecord[]): string {
  if (records.length === 0) return "(no decisions logged)";
  const rows = records.map((record) => [
    record.id,
    record.createdAt,
    record.tier,
    record.model,
    record.signals?.taskType ?? "-",
    record.signals ? record.signals.difficulty.toFixed(2) : "-",
    flags(record),
  ]);
  return formatTable(["ID", "TIME", "TIER", "MODEL", "TASK", "DIFF", "FLAGS"], rows);
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        limit: { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo decisions: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  let limit = DEFAULT_LIMIT;
  if (parsed.values.limit !== undefined) {
    const parsedLimit = Number(parsed.values.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      deps.stderr.write(`milo decisions: --limit must be a positive integer, got "${parsed.values.limit}"\n`);
      return 1;
    }
    limit = parsedLimit;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  const log = await deps.openLog(dbUrl);
  try {
    const records = await log.listRecent({ limit });
    deps.stdout.write(`${formatDecisionsTable(records)}\n`);
    return 0;
  } finally {
    await log.close();
  }
}
