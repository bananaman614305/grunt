/**
 * The canary's text report: a snapshot plus its drift comparison, rendered
 * for a terminal, a cron mailer, or a CI log. Pure formatting -- no I/O.
 */
import { TIERS } from "@milo/core";
import type { DriftResult, MetricCheck, TierShift } from "./drift.js";
import type { Snapshot } from "./snapshot.js";

/** Exit code for a clean run (no drift, or no baseline to compare against yet). */
export const CANARY_EXIT_OK = 0;
/** Exit code for a detected drift, mirroring `pnpm eval`'s gate-failure code (`packages/evals/src/cli.ts`). */
export const CANARY_EXIT_DRIFT = 2;

/** The process exit code for `drift`: non-zero (2) only when drift was actually detected. */
export function canaryExitCode(drift: DriftResult): number {
  return drift.drifted ? CANARY_EXIT_DRIFT : CANARY_EXIT_OK;
}

function pct(value: number): string {
  return Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function pp(value: number): string {
  if (Number.isNaN(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
}

function pctChange(value: number): string {
  if (Number.isNaN(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function usd(value: number): string {
  if (Number.isNaN(value)) return "n/a";
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function ms(value: number): string {
  return Number.isNaN(value) ? "n/a" : `${value.toFixed(0)} ms`;
}

function checkLine(check: MetricCheck): string {
  const unit = check.metric === "pass_rate" ? pp(check.delta) : pctChange(check.delta);
  const thresholdLabel =
    check.metric === "pass_rate" ? `${check.threshold.toFixed(1)} pp drop` : `${check.threshold.toFixed(1)}% up`;
  const mark = check.breached ? "DRIFT" : "ok";
  const currentLabel = check.metric === "pass_rate" ? pct(check.current) : usd(check.current);
  const baselineLabel = check.metric === "pass_rate" ? pct(check.baseline) : usd(check.baseline);
  const valueLabel = check.metric === "p95_latency" ? `${ms(check.current)} (baseline ${ms(check.baseline)})` : `${currentLabel} (baseline ${baselineLabel})`;
  return `  ${check.label.padEnd(14)} ${valueLabel.padEnd(28)} ${unit.padEnd(9)} threshold ${thresholdLabel.padEnd(14)} ${mark}`;
}

function tierShiftLine(shift: TierShift): string {
  const mark = shift.breached ? "DRIFT" : "ok";
  return (
    `  ${shift.tier.padEnd(10)} ${pct(shift.currentPct / 100).padStart(6)} ` +
    `(baseline ${pct(shift.baselinePct / 100).padStart(6)})  ${pp(shift.deltaPts).padStart(9)}  ` +
    `threshold ${shift.threshold.toFixed(1)} pp  ${mark}`
  );
}

function sortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export type CanaryReportMeta = {
  /** The Jev source mode the run used ("fixtures", "record", or "live"). */
  mode: string;
  /** How the baseline was chosen: e.g. "rolling (window 5)" or "pinned (<path>)". */
  baselineSource: string;
};

/** Renders a snapshot and its drift comparison as plain text. */
export function formatCanaryReport(snapshot: Snapshot, drift: DriftResult, meta: CanaryReportMeta): string {
  const lines: string[] = [];

  lines.push(`Milo canary -- ${snapshot.createdAt}`);
  lines.push(
    `Mode: ${meta.mode}  Posture: ${snapshot.posture}  Policy: ${snapshot.policyVersion}  ` +
      `Subset: ${snapshot.requestedSize} requested, ${snapshot.n} run (${snapshot.scoredN} scored, ${snapshot.unscoredN} unscored)`,
  );
  lines.push("");

  lines.push("Snapshot");
  lines.push(`  Pass rate     ${pct(snapshot.passRate)} (${snapshot.scoredN} scored)`);
  lines.push(`  Mean cost     ${usd(snapshot.meanCostUsd)} (n=${snapshot.pricedN} priced, estimated)`);
  lines.push(`  Latency       p50 ${ms(snapshot.latencyP50Ms)}, p95 ${ms(snapshot.latencyP95Ms)}`);
  lines.push(
    `  Tiers         ${TIERS.map((tier) => `${tier} ${snapshot.tierCounts[tier]}`).join(", ")}`,
  );
  const models = sortedCounts(snapshot.modelCounts);
  lines.push(`  Models        ${models.length === 0 ? "(none scored)" : models.map(([m, n]) => `${m} ${n}`).join(", ")}`);
  lines.push("");

  if (!drift.hasBaseline) {
    lines.push("Baseline: none yet -- this is the first recorded run, so nothing to drift against.");
    lines.push("");
    lines.push("Result: PASS (no baseline)");
    return lines.join("\n");
  }

  lines.push(`Baseline (${meta.baselineSource})`);
  for (const check of drift.checks) lines.push(checkLine(check));
  if (drift.checks.length === 0) lines.push("  (no comparable metrics -- baseline and current run share no priced data)");
  lines.push("");
  if (drift.tierShifts.length > 0) {
    lines.push("Tier mix");
    for (const shift of drift.tierShifts) lines.push(tierShiftLine(shift));
    lines.push("");
  }

  if (drift.drifted) {
    const breachedChecks = drift.checks.filter((c) => c.breached);
    const breachedTiers = drift.tierShifts.filter((t) => t.breached);
    lines.push("Result: DRIFT DETECTED");
    for (const check of breachedChecks) {
      const unit = check.metric === "pass_rate" ? pp(check.delta) : pctChange(check.delta);
      lines.push(`  - ${check.label} moved ${unit} (threshold ${check.threshold})`);
    }
    for (const shift of breachedTiers) {
      lines.push(`  - ${shift.tier} tier share moved ${pp(shift.deltaPts)} (threshold ${shift.threshold} pp)`);
    }
  } else {
    lines.push("Result: PASS (no drift)");
  }

  return lines.join("\n");
}
