/**
 * Report shaping for the agentic benchmark: the JSON report is the full
 * record, the markdown is the same numbers made readable. Message content is
 * never in either -- the inputs are counters, verdicts, and decision-log
 * metadata only.
 */

import type { TaskAttribution } from "./decisions.js";
import type { PiRunStats } from "./pi-events.js";

export type Verdict = "pass" | "fail" | "timeout" | "error";

export type TaskResult = {
  id: string;
  verdict: Verdict;
  /** Exit code of `node test.js` in the workdir; null when it did not run. */
  testExitCode: number | null;
  wallTimeMs: number;
  pi: PiRunStats;
  gateway: TaskAttribution;
  /** Retained temp workdir (only with --keep). */
  workdir?: string;
  /** Short failure note for verdicts `timeout` and `error`. */
  note?: string;
};

export type AgenticSummary = {
  tasks: number;
  solved: number;
  solveRate: number;
  turns: number;
  toolCalls: number;
  wallTimeMs: number;
  tokens: { input: number; output: number };
  gatewayCostUsd: number;
};

export type AgenticReport = {
  generatedAt: string;
  gateway: string;
  timeoutMs: number;
  attribution: string;
  tasks: TaskResult[];
  summary: AgenticSummary;
};

export function summarize(tasks: TaskResult[]): AgenticSummary {
  const solved = tasks.filter((t) => t.verdict === "pass").length;
  return {
    tasks: tasks.length,
    solved,
    solveRate: tasks.length === 0 ? 0 : solved / tasks.length,
    turns: tasks.reduce((n, t) => n + t.pi.turns, 0),
    toolCalls: tasks.reduce((n, t) => n + t.pi.toolCallTotal, 0),
    wallTimeMs: tasks.reduce((n, t) => n + t.wallTimeMs, 0),
    tokens: {
      input: tasks.reduce((n, t) => n + t.pi.usage.input, 0),
      output: tasks.reduce((n, t) => n + t.pi.usage.output, 0),
    },
    gatewayCostUsd: tasks.reduce((n, t) => n + t.gateway.costUsd, 0),
  };
}

export function buildReport(
  tasks: TaskResult[],
  meta: { gateway: string; timeoutMs: number; generatedAt?: string },
): AgenticReport {
  return {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    gateway: meta.gateway,
    timeoutMs: meta.timeoutMs,
    attribution: "gateway cost/tier/samples are approximate (time-window)",
    tasks,
    summary: summarize(tasks),
  };
}

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const fmtUsd = (usd: number): string => `$${usd.toFixed(4)}`;
const fmtPct = (rate: number): string => `${(rate * 100).toFixed(0)}%`;

function toolSummary(calls: Record<string, number>): string {
  const entries = Object.entries(calls).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return "-";
  return entries.map(([name, count]) => `${name}:${count}`).join(" ");
}

export function formatAgenticMarkdown(report: AgenticReport): string {
  const lines: string[] = [];
  lines.push("# Agentic benchmark (pi through Milo)");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Gateway: ${report.gateway}`);
  lines.push(`- Per-task timeout: ${fmtSeconds(report.timeoutMs)}`);
  lines.push(`- Attribution: ${report.attribution}`);
  lines.push("");
  lines.push("| task | verdict | turns | tool calls | wall time | tokens in/out | gateway cost |");
  lines.push("|---|---|---:|---|---:|---:|---:|");
  for (const t of report.tasks) {
    const verdict = t.verdict + (t.note !== undefined ? ` (${t.note})` : "");
    lines.push(
      `| ${t.id} | ${verdict} | ${t.pi.turns} | ${toolSummary(t.pi.toolCalls)} | ` +
        `${fmtSeconds(t.wallTimeMs)} | ${t.pi.usage.input}/${t.pi.usage.output} | ${fmtUsd(t.gateway.costUsd)} |`,
    );
  }
  lines.push("");
  const s = report.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Solve rate: **${s.solved}/${s.tasks}** (${fmtPct(s.solveRate)})`);
  lines.push(`- Turns: ${s.turns}, tool calls: ${s.toolCalls}, wall time: ${fmtSeconds(s.wallTimeMs)}`);
  lines.push(`- Tokens: ${s.tokens.input} in / ${s.tokens.output} out`);
  lines.push(`- Gateway cost: ${fmtUsd(s.gatewayCostUsd)}`);
  const failedFetches = report.tasks.filter((t) => t.gateway.error !== undefined);
  if (failedFetches.length > 0) {
    lines.push("");
    lines.push("## Attribution gaps");
    lines.push("");
    for (const t of failedFetches) lines.push(`- ${t.id}: ${t.gateway.error}`);
  }
  lines.push("");
  return lines.join("\n");
}
