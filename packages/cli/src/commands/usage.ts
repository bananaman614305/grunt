/** `milo usage`: how much of each subscription is used, left, and when it resets. */
import { parseArgs } from "node:util";
import type { CapacitySnapshot, UsageTotals } from "@milo/core";
import { loadConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import { ensureLogDirectory, gatewayOptionsFrom, resolveDecisionLog } from "./serve.js";

export const help = `Usage: milo usage [options]

Show, per subscription, how much of the plan is used and left and when it
resets, plus Milo's own calls in the last 24 hours and 7 days.

"cli" numbers come from the CLI itself: Codex reports its limits on request;
Claude Code reports them with every answer, so its numbers are as fresh as
Milo's last Claude call. "unknown" means the CLI has not reported a number
yet; "estimated" means Milo only knows its own calls and refusals.

Options:
  --url <base>      Ask a running \`milo serve\` (e.g. http://127.0.0.1:8787) instead of the local log
  --config <path>   Path to milo.config.json
  --db <url>        Decision log libsql URL (overrides MILO_DB, which overrides config)
  --json            Print the raw JSON
  -h, --help        Show this help
`;

export type UsageEntry = {
  backend: string;
  label: string;
  capacity: CapacitySnapshot;
  last24h: UsageTotals | null;
  last7d: UsageTotals | null;
};

export type UsageReport = { object: "usage"; subscriptions: UsageEntry[] };

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        url: { type: "string" },
        config: { type: "string" },
        db: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo usage: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  let report: UsageReport;
  try {
    report = parsed.values.url !== undefined ? await fetchReport(parsed.values.url, deps) : await localReport(parsed.values, deps);
  } catch (error) {
    deps.stderr.write(`milo usage: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.json) {
    deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  deps.stdout.write(formatUsage(report));
  return 0;
}

async function fetchReport(base: string, deps: CliDeps): Promise<UsageReport> {
  const response = await deps.fetch(new URL("/v1/usage", base).toString());
  if (!response.ok) throw new Error(`${base} answered ${response.status}`);
  return (await response.json()) as UsageReport;
}

async function localReport(values: { config?: string; db?: string }, deps: CliDeps): Promise<UsageReport> {
  const config = loadConfig(values.config).config;
  const url = resolveDecisionLog(config, deps.env, values.db);
  ensureLogDirectory(url, process.cwd());
  const gateway = await deps.createGateway(gatewayOptionsFrom(config, url, deps.env));
  try {
    const response = await gateway.app.request("/v1/usage");
    return (await response.json()) as UsageReport;
  } finally {
    await gateway.close();
  }
}

function pct(value: number | undefined): string {
  return value === undefined ? "unknown" : `${value}%`;
}

function when(iso: string | undefined): string {
  if (iso === undefined) return "-";
  return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
}

function tokens(t: UsageTotals | null): string {
  if (t === null) return "0 / 0";
  return `${t.inputTokens} / ${t.outputTokens}`;
}

/** The human table. Exported for tests. */
export function formatUsage(report: UsageReport): string {
  const header = ["subscription", "used", "left", "window", "resets", "source", "status", "24h calls", "24h limited", "24h tokens in/out", "7d calls"];
  const rows = report.subscriptions.map((s) => {
    const c = s.capacity;
    const status = c.limited ? `limited until ${when(c.limitedUntil)}` : "ok";
    return [
      s.label,
      pct(c.usedPercent),
      pct(c.remainingPercent),
      c.window ?? "-",
      when(c.resetsAt),
      c.source,
      status,
      String(s.last24h?.calls ?? 0),
      String(s.last24h?.rateLimited ?? 0),
      tokens(s.last24h),
      String(s.last7d?.calls ?? 0),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return `${[line(header), ...rows.map(line)].join("\n")}\n`;
}
