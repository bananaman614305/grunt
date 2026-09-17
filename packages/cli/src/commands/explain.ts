/** `milo explain <decision-id> [--db <url>] [--json]`. */
import { parseArgs } from "node:util";
import type { DecisionRecord, RouteSignals } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL } from "../config.js";
import type { CliDeps } from "../deps.js";
import { formatProbability } from "../format.js";

export const help = `Usage: milo explain <decision-id> [options]

Print a plain-language explanation of one routing decision.

Options:
  --db <url>   Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  --json       Print the raw decision record as JSON
  -h, --help   Show this help
`;

function formatSignals(signals: RouteSignals): string {
  // RouteSignals carries one confidence per question (the winning answer's
  // own probability), not the full per-level distribution Jev computed --
  // that is not part of the DecisionRecord contract, so this is the most
  // detail `explain` can show for difficulty.
  const difficultyConfidence = signals.confidences["difficulty"];
  return [
    `  Task type: ${signals.taskType}`,
    `  Difficulty: ${signals.difficulty.toFixed(2)} (confidence ${formatProbability(difficultyConfidence)})`,
    `  Needs reasoning: ${formatProbability(signals.needsReasoning)}`,
    `  Long output: ${formatProbability(signals.longOutput)}`,
    `  Jev request id: ${signals.jevRequestId || "(none)"}`,
    `  Jev model: ${signals.jevModel || "(unknown)"}`,
    `  Jev latency: ${signals.latencyMs}ms`,
  ].join("\n");
}

function formatUpstream(upstream: DecisionRecord["upstream"]): string {
  if (!upstream) return "  Upstream: not recorded";
  const parts = [`status ${upstream.status}`, `latency ${upstream.latencyMs}ms`];
  if (upstream.inputTokens !== undefined || upstream.outputTokens !== undefined) {
    parts.push(`tokens in/out ${upstream.inputTokens ?? "?"}/${upstream.outputTokens ?? "?"}`);
  }
  if (upstream.costUsd !== undefined) {
    parts.push(`cost $${upstream.costUsd.toFixed(4)}`);
  }
  return `  Upstream: ${parts.join(", ")}`;
}

export function formatExplanation(record: DecisionRecord): string {
  const lines = [
    `Decision ${record.id}`,
    `  Chosen model: ${record.model} (tier: ${record.tier})`,
    `  Reason: ${record.reason}`,
  ];
  lines.push(
    record.signals ? formatSignals(record.signals) : "  Signals: unavailable (degraded fallback, no Jev call recorded)",
  );
  lines.push(`  Sticky: ${record.sticky ? "yes" : "no"}`);
  lines.push(`  Degraded: ${record.degraded ? "yes" : "no"}`);
  lines.push(formatUpstream(record.upstream));
  lines.push(`  Policy version: ${record.policyVersion}`);
  lines.push(`  Created: ${record.createdAt}`);
  return lines.join("\n");
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        db: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo explain: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const [id] = parsed.positionals;
  if (id === undefined) {
    deps.stderr.write("milo explain: missing <decision-id>\n\n");
    deps.stderr.write(help);
    return 1;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  const log = await deps.openLog(dbUrl);
  try {
    const record = await log.get(id);
    if (!record) {
      deps.stderr.write(`milo explain: no decision found with id "${id}"\n`);
      return 1;
    }
    deps.stdout.write(parsed.values.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatExplanation(record)}\n`);
    return 0;
  } finally {
    await log.close();
  }
}
