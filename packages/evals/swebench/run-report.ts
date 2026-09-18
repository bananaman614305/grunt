/**
 * The generation-side sidecar (`run.json`): per-instance pi metrics and gateway
 * decision attribution, written next to `predictions.jsonl`. Grading is not our
 * job (the official evaluator does that from predictions.jsonl); this file is
 * how we later join efficiency numbers back onto the evaluator's verdicts by
 * `instance_id`. Like the agentic report, it holds counters and decision-log
 * metadata only -- never message content.
 */

import type { TaskAttribution } from "../agentic/decisions.js";
import type { PiRunStats } from "../agentic/pi-events.js";

/**
 * Outcome of the generation attempt for one instance. Note this is a
 * *generation* status, not a grade: `generated` means we produced a non-empty
 * patch to hand the evaluator, not that it will resolve the instance.
 */
export type InstanceStatus =
  | "generated" // non-empty patch captured
  | "empty-patch" // pi ran but changed nothing; empty patch submitted, marked
  | "clone-failed" // repo clone/checkout failed; no patch
  | "timeout" // pi exceeded the per-instance budget
  | "error"; // pi failed to start, or the diff capture failed

export type InstanceRun = {
  instance_id: string;
  repo: string;
  base_commit: string;
  status: InstanceStatus;
  /** True whenever the submitted patch is empty (whatever the cause). */
  emptyPatch: boolean;
  wallTimeMs: number;
  pi: PiRunStats;
  gateway: TaskAttribution;
  /** Retained temp workdir (only with --keep). */
  workdir?: string;
  /** Short human note for non-`generated` statuses. */
  note?: string;
};

export type RunSummary = {
  instances: number;
  generated: number;
  emptyPatches: number;
  failures: number;
  turns: number;
  toolCalls: number;
  wallTimeMs: number;
  tokens: { input: number; output: number };
  gatewayCostUsd: number;
};

export type RunReport = {
  generatedAt: string;
  gateway: string;
  dataset: string;
  modelName: string;
  timeoutMs: number;
  attribution: string;
  instances: InstanceRun[];
  summary: RunSummary;
};

export function summarizeRun(instances: InstanceRun[]): RunSummary {
  return {
    instances: instances.length,
    generated: instances.filter((r) => r.status === "generated").length,
    emptyPatches: instances.filter((r) => r.emptyPatch).length,
    failures: instances.filter((r) => r.status === "clone-failed" || r.status === "timeout" || r.status === "error")
      .length,
    turns: instances.reduce((n, r) => n + r.pi.turns, 0),
    toolCalls: instances.reduce((n, r) => n + r.pi.toolCallTotal, 0),
    wallTimeMs: instances.reduce((n, r) => n + r.wallTimeMs, 0),
    tokens: {
      input: instances.reduce((n, r) => n + r.pi.usage.input, 0),
      output: instances.reduce((n, r) => n + r.pi.usage.output, 0),
    },
    gatewayCostUsd: instances.reduce((n, r) => n + r.gateway.costUsd, 0),
  };
}

export function buildRunReport(
  instances: InstanceRun[],
  meta: { gateway: string; dataset: string; modelName: string; timeoutMs: number; generatedAt?: string },
): RunReport {
  return {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    gateway: meta.gateway,
    dataset: meta.dataset,
    modelName: meta.modelName,
    timeoutMs: meta.timeoutMs,
    attribution: "gateway cost/tier/samples are approximate (time-window)",
    instances,
    summary: summarizeRun(instances),
  };
}
