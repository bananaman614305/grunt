/**
 * `milo tune [--since <iso>] [--db <url>] [--json] [--min-n <n>] [--apply [--out <path>]]`.
 *
 * Closed-loop policy tuning, the operator end: walk the decision log, roll it
 * up per difficulty band and per task type, and print a proposed policy diff
 * with the evidence behind each line. The analysis lives in `@milo/core`
 * (`tuning/`); this file is the argument parsing and the rendering, the same
 * split `milo cost` uses.
 *
 * Human-in-the-loop by default: the command PROPOSES. `--apply` writes the
 * proposal to an override document (`.milo/policy-override.json`) that nothing
 * reads at runtime, and refuses outright when any proposed change rests on too
 * few graded requests. ADR-012's band budgets were measured against a
 * benchmark; a tuned number is a hypothesis until another benchmark or a canary
 * agrees with it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  aggregateDecisions,
  buildOverride,
  checkApplicable,
  DEFAULT_OVERRIDE_PATH,
  DEFAULT_THRESHOLDS,
  propose,
  proposedProfile,
} from "@milo/core";
import type { BandStats, CellStats, PolicyProposal, TuningInputDecision, TuningReport } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL } from "../config.js";
import type { CliDeps } from "../deps.js";
import { formatTable } from "../format.js";

export const help = `Usage: milo tune [options]

Learn better routing-policy settings from the decision log and propose them.

Reads every decision (or those since --since), recomputes each one's difficulty
band from its stored Jev signals, and reports per band and per task type: how
many requests, the completeness-gate pass rate, the gate's retry rate, average
cost, and what best-of-N sampling actually bought. From that it proposes sample
counts and difficulty thresholds, with the evidence and the sample sizes.

This command PROPOSES. It never edits the measured band->budget table in
packages/core/src/router/controller.ts (ADR-012: "Do not change a band's budget
without re-running the benchmark"). --apply writes the proposal to a separate
override document, which nothing reads at runtime: validate it with a benchmark
run (pnpm bench) or a canary before changing the policy in source.

Options:
  --since <iso>   Only include decisions at or after this ISO 8601 timestamp
  --db <url>      Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  --min-n <n>     Graded requests a cell needs before a rule judges it (default: ${DEFAULT_THRESHOLDS.minCellN})
  --apply-min-n <n>  Graded requests --apply demands per change (default: ${DEFAULT_THRESHOLDS.applyMinN})
  --json          Print the machine-readable proposal and statistics instead of tables
  --apply         Write the proposal to an override file (refuses on low sample sizes)
  --out <path>    Override file --apply writes (default: ${DEFAULT_OVERRIDE_PATH})
  -h, --help      Show this help
`;

/** Six-decimal dollars, matching `milo cost`. */
function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number | null, digits = 2): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function signedPct(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** The flags that qualify one cell's numbers, shortest first. */
function cellFlags(cell: CellStats, minCellN: number): string {
  const flags: string[] = [];
  if (cell.gate.answered < minCellN) flags.push("low-n");
  if (cell.gate.answered === 0) flags.push("ungraded");
  else if (cell.gate.ungraded > cell.gate.answered) flags.push("mostly-ungraded");
  if (cell.sampling.sampled.n > 0 && !cell.sampling.comparable) flags.push("no-control");
  if (cell.degraded > 0) flags.push(`${cell.degraded} degraded`);
  return flags.join(" ");
}

function bandTable(report: TuningReport, minCellN: number): string {
  const rows = report.bands.map((band: BandStats) => [
    String(band.band),
    count(band.n),
    count(band.sticky),
    `${band.configuredSamples}x ${band.configuredModel.split("/").pop() ?? band.configuredModel}`,
    count(band.gate.answered),
    pct(band.gate.passRate),
    pct(band.gate.trustedPassRate),
    pct(band.gate.retryRate),
    usd(band.cost.avgUsd),
    band.sampling.qualityLift === null ? "n/a" : signed(band.sampling.qualityLift),
    cellFlags(band, minCellN),
  ]);
  rows.push([
    "all",
    count(report.overall.n),
    count(report.overall.sticky),
    "-",
    count(report.overall.gate.answered),
    pct(report.overall.gate.passRate),
    pct(report.overall.gate.trustedPassRate),
    pct(report.overall.gate.retryRate),
    usd(report.overall.cost.avgUsd),
    report.overall.sampling.qualityLift === null ? "n/a" : signed(report.overall.sampling.qualityLift),
    "",
  ]);
  return formatTable(
    ["band", "reqs", "sticky", "budget", "graded", "pass", "trusted", "retry", "avg cost", "lift", "flags"],
    rows,
  );
}

function cellTable(report: TuningReport, minCellN: number): string {
  const rows = report.cells.map((cell) => [
    String(cell.band),
    cell.taskType ?? "-",
    count(cell.n),
    String(cell.observedSamples),
    count(cell.gate.answered),
    pct(cell.gate.passRate),
    `${count(cell.sampling.sampled.n)}/${count(cell.sampling.single.n)}`,
    signedPct(cell.sampling.passRateDelta),
    cell.sampling.qualityLift === null ? "n/a" : signed(cell.sampling.qualityLift),
    cell.sampling.costRatio === null ? "n/a" : `${cell.sampling.costRatio.toFixed(1)}x`,
    cellFlags(cell, minCellN),
  ]);
  return formatTable(
    ["band", "task", "reqs", "obs N", "graded", "pass", "smpl/single", "d pass", "lift", "cost", "flags"],
    rows,
  );
}

function proposalSection(proposal: PolicyProposal, report: TuningReport): string[] {
  const lines: string[] = [];
  if (proposal.changes.length === 0) {
    lines.push("Proposal: no change -- every cell with enough evidence matches its current budget.");
    return lines;
  }

  lines.push(`Proposal: ${proposal.changes.length} change${proposal.changes.length === 1 ? "" : "s"}`);
  const rows = proposal.changes.map((change) => [
    change.rule,
    change.target,
    change.kind === "profile-threshold" ? `${change.from} -> ${change.to}` : `${change.from} -> ${change.to} calls`,
    count(change.evidence.gradedN),
    pct(change.evidence.passRate),
    change.evidence.qualityLift === null ? "n/a" : signed(change.evidence.qualityLift),
    change.lowN ? "LOW-N (blocks --apply)" : "",
  ]);
  lines.push(formatTable(["rule", "target", "change", "graded", "pass", "lift", "note"], rows));
  lines.push("");
  for (const change of proposal.changes) {
    lines.push(`  [${change.rule}] ${change.target}: ${change.rationale}`);
  }

  const profile = proposedProfile(report, proposal);
  const moved = proposal.changes.some((c) => c.kind === "profile-threshold");
  if (moved) {
    lines.push("");
    lines.push(
      `  proposed profile: fastBelowMass ${profile["fastBelowMass"]}, frontierHardMass ${profile["frontierHardMass"]}`,
    );
  }
  return lines;
}

/** The whole human-readable report: statistics, then proposal, then caveats. */
export function formatTuning(report: TuningReport, proposal: PolicyProposal): string {
  const minCellN = proposal.thresholds.minCellN;
  const lines: string[] = [
    `Decisions read:  ${count(report.total)} (${count(report.banded)} banded, ${count(report.unbanded)} without signals)`,
  ];
  if (report.from !== undefined && report.to !== undefined) {
    lines.push(`Window:          ${report.from} .. ${report.to}`);
  }
  lines.push(
    `Policy:          ${proposal.policyVersion} (fastBelowMass ${report.profile.fastBelowMass}, frontierHardMass ${report.profile.frontierHardMass})`,
  );

  lines.push("", "Per difficulty band:");
  lines.push(report.bands.length > 0 ? bandTable(report, minCellN) : "  (no banded decisions)");

  lines.push("", "Per band and task type:");
  lines.push(report.cells.length > 0 ? cellTable(report, minCellN) : "  (no banded decisions)");

  lines.push("");
  lines.push(...proposalSection(proposal, report));

  if (proposal.lowNCells.length > 0) {
    lines.push("", `Not judged (under ${minCellN} graded requests):`);
    for (const cell of proposal.lowNCells) {
      lines.push(`  ${cell.target}: ${cell.why} (${count(cell.n)} requests)`);
    }
  }

  lines.push("", "Read these numbers with their caveats:");
  for (const caveat of proposal.caveats) lines.push(`  - ${caveat}`);

  return lines.join("\n");
}

function parseCount(raw: string | undefined, flag: string): number | Error {
  if (raw === undefined) return new Error("unreachable");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        since: { type: "string" },
        db: { type: "string" },
        "min-n": { type: "string" },
        "apply-min-n": { type: "string" },
        json: { type: "boolean" },
        apply: { type: "boolean" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo tune: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const since = parsed.values.since;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    deps.stderr.write(`milo tune: --since is not a valid ISO 8601 timestamp: "${since}"\n`);
    return 1;
  }

  const thresholds: { minCellN?: number; applyMinN?: number } = {};
  if (parsed.values["min-n"] !== undefined) {
    const value = parseCount(parsed.values["min-n"], "--min-n");
    if (value instanceof Error) {
      deps.stderr.write(`milo tune: ${value.message}\n`);
      return 1;
    }
    thresholds.minCellN = value;
  }
  if (parsed.values["apply-min-n"] !== undefined) {
    const value = parseCount(parsed.values["apply-min-n"], "--apply-min-n");
    if (value instanceof Error) {
      deps.stderr.write(`milo tune: ${value.message}\n`);
      return 1;
    }
    thresholds.applyMinN = value;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  const log = await deps.openLog(dbUrl);
  let report: TuningReport;
  try {
    const decisions: TuningInputDecision[] = [];
    for await (const decision of log.iterate(since !== undefined ? { sinceIso: since } : undefined)) {
      decisions.push(decision);
    }
    report = aggregateDecisions(decisions);
  } finally {
    await log.close();
  }

  const proposal = propose(report, {
    thresholds,
    ...(since !== undefined ? { sinceIso: since } : {}),
  });

  if (parsed.values.apply === true) {
    const check = checkApplicable(proposal);
    if (!check.ok) {
      deps.stderr.write("milo tune: --apply refused, the evidence is too thin:\n");
      for (const blocker of check.blockers) deps.stderr.write(`  - ${blocker}\n`);
      deps.stderr.write(
        `Run without --apply to read the proposal, collect more decisions, or lower --apply-min-n deliberately.\n`,
      );
      return 1;
    }

    const outPath = resolve(parsed.values.out ?? DEFAULT_OVERRIDE_PATH);
    const document = buildOverride(proposal);
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    } catch (error) {
      deps.stderr.write(`milo tune: could not write ${outPath}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    deps.stdout.write(`Wrote ${proposal.changes.length} proposed change(s) to ${outPath}\n`);
    deps.stdout.write(
      "Nothing reads this file at runtime. Validate it with a benchmark run (pnpm bench) or a canary\n" +
        "before changing the policy in source; ADR-012's band budgets are measured, not guessed.\n",
    );
    return 0;
  }

  if (parsed.values.json === true) {
    // `apply` rides along so a machine reader sees the same refusal `--apply`
    // would give rather than inferring applicability from the document.
    const payload = { proposal, apply: checkApplicable(proposal), override: buildOverride(proposal), report };
    deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  deps.stdout.write(`${formatTuning(report, proposal)}\n`);
  return 0;
}
