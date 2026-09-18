import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEvaluationCommand,
  DATASET_NAME,
  formatCommand,
  joinEfficiency,
  parseEvaluationReport,
} from "./evaluate.js";
import type { InstanceRun, RunReport } from "./run-report.js";
import { buildRunReport } from "./run-report.js";

const REPORT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "official-report.json");

const emptyPi = { turns: 0, toolCalls: {}, toolCallTotal: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, malformedLines: 0 };
const gw = (costUsd: number) => ({ method: "approximate (time-window)" as const, decisions: [], costUsd });

function runFor(ids: Array<{ id: string; turns: number; tools: number; cost: number }>): RunReport {
  const instances: InstanceRun[] = ids.map((x) => ({
    instance_id: x.id,
    repo: "mockorg/mocklib",
    base_commit: "abc",
    status: "generated",
    emptyPatch: false,
    wallTimeMs: 1000,
    pi: { ...emptyPi, turns: x.turns, toolCallTotal: x.tools },
    gateway: gw(x.cost),
  }));
  return buildRunReport(instances, { gateway: "http://milo.test/v1", dataset: DATASET_NAME, modelName: "milo/auto", timeoutMs: 1800000 });
}

describe("buildEvaluationCommand", () => {
  it("produces the canonical run_evaluation argv", () => {
    const argv = buildEvaluationCommand({ predictionsPath: "./predictions.jsonl", runId: "pilot-01", maxWorkers: 4 });
    expect(argv).toEqual([
      "python", "-m", "swebench.harness.run_evaluation",
      "--predictions_path", "./predictions.jsonl",
      "--dataset_name", DATASET_NAME,
      "--run_id", "pilot-01",
      "--max_workers", "4",
    ]);
  });

  it("defaults dataset to Verified and workers to 8", () => {
    const argv = buildEvaluationCommand({ predictionsPath: "p.jsonl", runId: "r" });
    expect(argv).toContain("princeton-nlp/SWE-bench_Verified");
    expect(argv[argv.length - 1]).toBe("8");
    expect(formatCommand(argv)).toContain("python -m swebench.harness.run_evaluation");
  });
});

describe("parseEvaluationReport", () => {
  it("reads the fixture and computes the solve rate", () => {
    const report = parseEvaluationReport(JSON.parse(readFileSync(REPORT, "utf8")));
    expect(report.total).toBe(3);
    expect(report.resolved).toBe(2);
    expect(report.solveRate).toBeCloseTo(2 / 3, 10);
    expect(report.resolvedIds).toEqual(["mockorg__mocklib-1", "mockorg__mocklib-2"]);
    expect(report.unresolvedIds).toEqual(["otherorg__widget-9"]);
  });

  it("falls back to id-list lengths when counts are absent", () => {
    const report = parseEvaluationReport({ resolved_ids: ["a"], unresolved_ids: ["b", "c"] });
    expect(report.resolved).toBe(1);
    expect(report.total).toBe(3);
    expect(report.solveRate).toBeCloseTo(1 / 3, 10);
  });
});

describe("joinEfficiency", () => {
  it("joins verdicts onto run metrics by instance_id", () => {
    const report = parseEvaluationReport(JSON.parse(readFileSync(REPORT, "utf8")));
    const run = runFor([
      { id: "mockorg__mocklib-1", turns: 5, tools: 12, cost: 0.02 },
      { id: "mockorg__mocklib-2", turns: 3, tools: 7, cost: 0.01 },
      { id: "otherorg__widget-9", turns: 8, tools: 20, cost: 0.03 },
    ]);
    const joined = joinEfficiency(report, run);
    expect(joined.summary.evaluated).toBe(3);
    expect(joined.summary.resolved).toBe(2);
    expect(joined.summary.solveRate).toBeCloseTo(2 / 3, 10);
    expect(joined.summary.turns).toBe(16);
    expect(joined.summary.toolCalls).toBe(39);
    expect(joined.summary.gatewayCostUsd).toBeCloseTo(0.06, 10);
    expect(joined.rows.find((r) => r.instance_id === "otherorg__widget-9")?.resolved).toBe(false);
    expect(joined.summary.onlyInEvaluation).toEqual([]);
    expect(joined.summary.onlyInRun).toEqual([]);
  });

  it("surfaces instances present in only one side", () => {
    const report = parseEvaluationReport({ resolved_ids: ["graded-only"], unresolved_ids: [] });
    const run = runFor([{ id: "generated-only", turns: 1, tools: 1, cost: 0 }]);
    const joined = joinEfficiency(report, run);
    expect(joined.summary.onlyInEvaluation).toEqual(["graded-only"]);
    expect(joined.summary.onlyInRun).toEqual(["generated-only"]);
    expect(joined.summary.evaluated).toBe(0);
  });
});
