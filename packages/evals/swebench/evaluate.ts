/**
 * Grading is delegated to the official `swebench` Python harness -- we do not
 * reimplement it. This module holds the pure pieces around that boundary:
 *
 *   - `buildEvaluationCommand`: the canonical `python -m
 *     swebench.harness.run_evaluation ...` invocation, as an argv the wrapper
 *     script prints and/or execs.
 *   - `parseEvaluationReport`: reads the report JSON the harness writes and
 *     pulls out the solve rate and the resolved/unresolved id sets, tolerantly.
 *   - `joinEfficiency`: joins that verdict onto our generation-side `run.json`
 *     by `instance_id`, so the solve rate is reported next to pi turns/tool
 *     calls and gateway cost.
 */

import { z } from "zod";
import type { RunReport } from "./run-report.js";

export const DATASET_NAME = "princeton-nlp/SWE-bench_Verified";

export type EvaluationCommandOptions = {
  predictionsPath: string;
  runId: string;
  datasetName?: string;
  maxWorkers?: number;
};

/**
 * The exact command the official evaluator is run with. Returned as an argv
 * (program + args) so the wrapper can either print it verbatim or exec it.
 */
export function buildEvaluationCommand(opts: EvaluationCommandOptions): string[] {
  return [
    "python",
    "-m",
    "swebench.harness.run_evaluation",
    "--predictions_path",
    opts.predictionsPath,
    "--dataset_name",
    opts.datasetName ?? DATASET_NAME,
    "--run_id",
    opts.runId,
    "--max_workers",
    String(opts.maxWorkers ?? 8),
  ];
}

/** Shell-quote an argv for display in docs/logs (POSIX single-quoting). */
export function formatCommand(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/**
 * The subset of the official run-evaluation report JSON we read. The harness
 * writes more (id lists for every bucket, a schema version); we accept unknown
 * keys and default the id lists so an older/newer report still parses.
 */
const evaluationReportSchema = z
  .object({
    total_instances: z.number().optional(),
    submitted_instances: z.number().optional(),
    completed_instances: z.number().optional(),
    resolved_instances: z.number().optional(),
    unresolved_instances: z.number().optional(),
    empty_patch_instances: z.number().optional(),
    error_instances: z.number().optional(),
    resolved_ids: z.array(z.string()).default([]),
    unresolved_ids: z.array(z.string()).default([]),
    empty_patch_ids: z.array(z.string()).default([]),
    error_ids: z.array(z.string()).default([]),
  })
  .passthrough();

export type EvaluationReport = {
  total: number;
  submitted: number;
  resolved: number;
  emptyPatches: number;
  errors: number;
  solveRate: number;
  resolvedIds: string[];
  unresolvedIds: string[];
};

/**
 * Parse the evaluator's report JSON. The solve rate is resolved / total; if the
 * report omits a count we fall back to the length of the matching id list, so a
 * report that carries only id lists still yields a rate.
 */
export function parseEvaluationReport(json: unknown): EvaluationReport {
  const r = evaluationReportSchema.parse(json);
  const resolved = r.resolved_instances ?? r.resolved_ids.length;
  const total = r.total_instances ?? r.submitted_instances ?? resolved + r.unresolved_ids.length;
  return {
    total,
    submitted: r.submitted_instances ?? total,
    resolved,
    emptyPatches: r.empty_patch_instances ?? r.empty_patch_ids.length,
    errors: r.error_instances ?? r.error_ids.length,
    solveRate: total === 0 ? 0 : resolved / total,
    resolvedIds: r.resolved_ids,
    unresolvedIds: r.unresolved_ids,
  };
}

export type JoinedInstance = {
  instance_id: string;
  resolved: boolean;
  turns: number;
  toolCalls: number;
  emptyPatch: boolean;
  gatewayCostUsd: number;
};

export type JoinedSummary = {
  evaluated: number;
  resolved: number;
  solveRate: number;
  turns: number;
  toolCalls: number;
  gatewayCostUsd: number;
  /** Instance ids in one report but not the other. */
  onlyInEvaluation: string[];
  onlyInRun: string[];
};

export type Joined = { rows: JoinedInstance[]; summary: JoinedSummary };

/**
 * Join the evaluator's verdicts onto our generation `run.json` by instance_id.
 * Rows come from the run report (the instances we generated); an instance graded
 * but not in the run, or generated but not graded, is surfaced in the summary
 * so a mismatch is visible rather than silently dropped.
 */
export function joinEfficiency(report: EvaluationReport, run: RunReport): Joined {
  const resolved = new Set(report.resolvedIds);
  const graded = new Set([...report.resolvedIds, ...report.unresolvedIds]);
  const runIds = new Set(run.instances.map((r) => r.instance_id));

  const rows: JoinedInstance[] = run.instances.map((r) => ({
    instance_id: r.instance_id,
    resolved: resolved.has(r.instance_id),
    turns: r.pi.turns,
    toolCalls: r.pi.toolCallTotal,
    emptyPatch: r.emptyPatch,
    gatewayCostUsd: r.gateway.costUsd,
  }));

  const resolvedCount = rows.filter((row) => row.resolved).length;
  const evaluated = rows.filter((row) => graded.has(row.instance_id)).length;

  return {
    rows,
    summary: {
      evaluated,
      resolved: resolvedCount,
      solveRate: evaluated === 0 ? 0 : resolvedCount / evaluated,
      turns: rows.reduce((n, row) => n + row.turns, 0),
      toolCalls: rows.reduce((n, row) => n + row.toolCalls, 0),
      gatewayCostUsd: rows.reduce((n, row) => n + row.gatewayCostUsd, 0),
      onlyInEvaluation: [...graded].filter((id) => !runIds.has(id)).sort(),
      onlyInRun: run.instances.map((r) => r.instance_id).filter((id) => !graded.has(id)).sort(),
    },
  };
}

const fmtUsd = (usd: number): string => `$${usd.toFixed(4)}`;
const fmtPct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** Render the joined result as markdown for the summarize CLI. */
export function formatJoinedMarkdown(joined: Joined, meta: { runId: string; dataset: string }): string {
  const lines: string[] = [];
  lines.push(`# SWE-bench result: ${meta.runId}`);
  lines.push("");
  lines.push(`- Dataset: ${meta.dataset}`);
  lines.push(`- Agent: pi driving DeepSeek via Milo (\`milo/auto\`)`);
  lines.push("");
  lines.push("| instance | resolved | turns | tool calls | empty patch | gateway cost |");
  lines.push("|---|---|---:|---:|---|---:|");
  for (const row of joined.rows) {
    lines.push(
      `| ${row.instance_id} | ${row.resolved ? "yes" : "no"} | ${row.turns} | ${row.toolCalls} | ` +
        `${row.emptyPatch ? "yes" : "no"} | ${fmtUsd(row.gatewayCostUsd)} |`,
    );
  }
  lines.push("");
  const s = joined.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Solve rate: **${s.resolved}/${s.evaluated}** (${fmtPct(s.solveRate)})`);
  lines.push(`- pi: ${s.turns} turns, ${s.toolCalls} tool calls`);
  lines.push(`- Gateway cost: ${fmtUsd(s.gatewayCostUsd)} (approximate, time-window)`);
  if (s.onlyInEvaluation.length > 0) lines.push(`- Graded but not in run.json: ${s.onlyInEvaluation.join(", ")}`);
  if (s.onlyInRun.length > 0) lines.push(`- Generated but not graded: ${s.onlyInRun.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}
