/**
 * `milo canary [options]`: the continuous eval canary (`docs/PLAN.md`).
 *
 * Runs a small, deterministic subset of the labeled routing set through the
 * router, reduces it to a snapshot (pass rate, cost, latency, tier/model
 * mix), compares it to a baseline, and exits non-zero when a metric drifts
 * beyond its threshold. Fixtures-only and network-free by default, so it is
 * safe to run from a cron job or a CI step; there is no scheduler in here --
 * this command runs once and reports what it found.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CostPosture } from "@milo/core";
import { COST_POSTURES } from "@milo/core";
import {
  appendSnapshot,
  canaryExitCode,
  compareToBaseline,
  computeSnapshot,
  DEFAULT_CANARY_SIZE,
  DEFAULT_DRIFT_THRESHOLDS,
  formatCanaryReport,
  JEV_SOURCE_MODES,
  loadPinnedBaseline,
  loadSnapshotHistory,
  makeJevClient,
  rollingBaseline,
  runCanary,
  savePinnedBaseline,
} from "@milo/evals";
import type { DriftThresholds, JevSourceMode, Snapshot } from "@milo/evals";
import type { CliDeps } from "../deps.js";

export const DEFAULT_HISTORY_PATH = "./.milo/canary-history.json";
const DEFAULT_BASELINE_WINDOW = 5;

export const help = `Usage: milo canary [options]

Run a small labeled subset of the routing eval set through the router,
record a snapshot (pass rate, cost, latency p50/p95, tier/model mix),
compare it to a baseline, and exit non-zero when a metric drifts beyond its
threshold. There is no scheduler here -- point cron or a CI step at this
command; see the examples below.

Options:
  --mode <fixtures|record|live>     Jev source (default: fixtures)
  --live                            Shorthand for --mode live
  --size <n>                        Subset size (default: ${DEFAULT_CANARY_SIZE})
  --posture <low|balanced|quality>  Cost posture (default: balanced)
  --history <path>                  Snapshot history file (default: ${DEFAULT_HISTORY_PATH})
  --baseline <rolling|path>         "rolling" (default), or a path to a pinned baseline snapshot
  --baseline-window <n>             Rolling baseline window, in prior runs (default: ${DEFAULT_BASELINE_WINDOW})
  --save-baseline <path>            After this run, save its snapshot as a pinned baseline at <path>
  --max-pass-drop <pts>             Drift threshold: pass-rate drop, in points (default: ${DEFAULT_DRIFT_THRESHOLDS.maxPassRateDropPts})
  --max-cost-increase <pct>         Drift threshold: mean-cost increase, in percent (default: ${DEFAULT_DRIFT_THRESHOLDS.maxCostIncreasePct})
  --max-latency-increase <pct>      Drift threshold: p95-latency increase, in percent (default: ${DEFAULT_DRIFT_THRESHOLDS.maxP95LatencyIncreasePct})
  --max-tier-shift <pts>            Drift threshold: any tier's share moving, in points (default: ${DEFAULT_DRIFT_THRESHOLDS.maxTierShiftPts})
  --skip-save                       Do not append this run to the history file
  --json <path>                     Also write the snapshot and drift result as JSON
  -h, --help                        Show this help

Fixtures-only by default (deterministic, no network): safe for CI and cron.
--live hits the real gateway/Jev and needs JEV_API_KEY set (Milo's own key,
same as \`milo serve\`); --mode record does the same but also grows the
fixture set. See docs/evals.md for the shared fixtures/record/live
conventions.

Exit codes: 0 pass (or no baseline yet), 1 usage/setup error, 2 drift
detected.

Cron (every 15 minutes, mirrors .github/workflows/roster-refresh.yml's
schedule style):
  */15 * * * *  cd /path/to/milo && JEV_API_KEY=\${JEV_API_KEY} \\
    node packages/cli/dist/cli.js canary >> canary.log 2>&1

CI (a job step; a non-zero exit fails the job, same as the pnpm eval gate in
.github/workflows/ci.yml):
  - run: node packages/cli/dist/cli.js canary --mode fixtures
`;

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** Parses a required flag value as a non-negative finite number, or throws. */
function nonNegativeNumber(flag: string, raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function positiveInt(flag: string, raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        mode: { type: "string" },
        live: { type: "boolean" },
        size: { type: "string" },
        posture: { type: "string" },
        history: { type: "string" },
        baseline: { type: "string" },
        "baseline-window": { type: "string" },
        "save-baseline": { type: "string" },
        "max-pass-drop": { type: "string" },
        "max-cost-increase": { type: "string" },
        "max-latency-increase": { type: "string" },
        "max-tier-shift": { type: "string" },
        "skip-save": { type: "boolean" },
        json: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo canary: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }
  const v = parsed.values;

  let mode: JevSourceMode = "fixtures";
  let size: number = DEFAULT_CANARY_SIZE;
  let posture: CostPosture = "balanced";
  let historyPath: string;
  let baselineWindow: number;
  let thresholds: DriftThresholds;
  try {
    if (v.mode !== undefined) {
      if (!isOneOf(JEV_SOURCE_MODES, v.mode)) {
        throw new Error(`--mode must be one of ${JEV_SOURCE_MODES.join("|")}, got "${v.mode}"`);
      }
      mode = v.mode;
    }
    if (v.live === true) {
      if (v.mode !== undefined && v.mode !== "live") {
        throw new Error(`--live conflicts with --mode ${v.mode}`);
      }
      mode = "live";
    }

    if (v.size !== undefined) size = positiveInt("--size", v.size);

    if (v.posture !== undefined) {
      if (!isOneOf(COST_POSTURES, v.posture)) {
        throw new Error(`--posture must be one of ${COST_POSTURES.join("|")}, got "${v.posture}"`);
      }
      posture = v.posture;
    }

    historyPath = resolve(process.cwd(), v.history ?? DEFAULT_HISTORY_PATH);
    baselineWindow = v["baseline-window"] !== undefined ? positiveInt("--baseline-window", v["baseline-window"]) : DEFAULT_BASELINE_WINDOW;

    thresholds = {
      maxPassRateDropPts:
        v["max-pass-drop"] !== undefined
          ? nonNegativeNumber("--max-pass-drop", v["max-pass-drop"])
          : DEFAULT_DRIFT_THRESHOLDS.maxPassRateDropPts,
      maxCostIncreasePct:
        v["max-cost-increase"] !== undefined
          ? nonNegativeNumber("--max-cost-increase", v["max-cost-increase"])
          : DEFAULT_DRIFT_THRESHOLDS.maxCostIncreasePct,
      maxP95LatencyIncreasePct:
        v["max-latency-increase"] !== undefined
          ? nonNegativeNumber("--max-latency-increase", v["max-latency-increase"])
          : DEFAULT_DRIFT_THRESHOLDS.maxP95LatencyIncreasePct,
      maxTierShiftPts:
        v["max-tier-shift"] !== undefined
          ? nonNegativeNumber("--max-tier-shift", v["max-tier-shift"])
          : DEFAULT_DRIFT_THRESHOLDS.maxTierShiftPts,
    };
  } catch (error) {
    deps.stderr.write(`milo canary: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Baseline: "rolling" (default) reads the history file written by prior
  // runs; anything else is a path to a pinned snapshot (`--save-baseline`
  // writes one in that same shape).
  let priorHistory: Snapshot[];
  try {
    priorHistory = loadSnapshotHistory(historyPath);
  } catch (error) {
    deps.stderr.write(`milo canary: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const baselineFlag = v.baseline ?? "rolling";
  let baseline: Snapshot | undefined;
  let baselineSource: string;
  if (baselineFlag === "rolling") {
    baseline = rollingBaseline(priorHistory, baselineWindow);
    baselineSource = `rolling (window ${baselineWindow}, ${Math.min(priorHistory.length, baselineWindow)} prior run(s) available)`;
  } else {
    const baselinePath = resolve(process.cwd(), baselineFlag);
    try {
      baseline = loadPinnedBaseline(baselinePath);
    } catch (error) {
      deps.stderr.write(`milo canary: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    baselineSource = `pinned (${baselinePath})`;
  }

  let snapshot: Snapshot;
  try {
    const jev = makeJevClient(mode, { env: deps.env });
    const canaryRun = await runCanary({ jev, size, posture });
    snapshot = computeSnapshot(canaryRun);
  } catch (error) {
    deps.stderr.write(`milo canary: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const drift = compareToBaseline(snapshot, baseline, thresholds);
  const report = formatCanaryReport(snapshot, drift, { mode, baselineSource });
  deps.stdout.write(`${report}\n`);

  if (v["skip-save"] !== true) {
    appendSnapshot(historyPath, snapshot);
  }

  if (v["save-baseline"] !== undefined) {
    const savePath = resolve(process.cwd(), v["save-baseline"]);
    savePinnedBaseline(savePath, snapshot);
    deps.stdout.write(`Saved pinned baseline to ${savePath}\n`);
  }

  if (v.json !== undefined) {
    const jsonPath = resolve(process.cwd(), v.json);
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify({ snapshot, drift }, null, 2)}\n`, "utf8");
  }

  return canaryExitCode(drift);
}
