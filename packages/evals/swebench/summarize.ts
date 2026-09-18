#!/usr/bin/env node
/**
 * Join the official evaluator's report JSON with our generation `run.json` and
 * print the solve rate next to pi/gateway efficiency, keyed by instance_id.
 * Reads files only; it does NOT run the evaluator (that is the operator's step,
 * documented in swebench/run-evaluation.sh and docs/swebench.md).
 *
 *   pnpm --filter @milo/evals exec tsx swebench/summarize.ts \
 *     --report ./logs/run_evaluation/<run_id>/milo__auto/results.json \
 *     --run ./reports/run.json
 */

import { readFileSync } from "node:fs";
import { formatJoinedMarkdown, joinEfficiency, parseEvaluationReport } from "./evaluate.js";
import type { RunReport } from "./run-report.js";

function take(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  if (i === -1 || argv[i + 1] === undefined) throw new Error(`${flag} <path> is required`);
  return argv[i + 1] as string;
}

function main(): void {
  const argv = process.argv.slice(2);
  const reportPath = take(argv, "--report");
  const runPath = take(argv, "--run");
  const runIdArg = argv.indexOf("--run-id");
  const report = parseEvaluationReport(JSON.parse(readFileSync(reportPath, "utf8")));
  const run = JSON.parse(readFileSync(runPath, "utf8")) as RunReport;
  const runId = runIdArg !== -1 && argv[runIdArg + 1] !== undefined ? (argv[runIdArg + 1] as string) : "swebench";
  const joined = joinEfficiency(report, run);
  console.log(formatJoinedMarkdown(joined, { runId, dataset: run.dataset }));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
