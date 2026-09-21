/** The canary library: subset selection, the run, its snapshot, persistence, drift detection, and its report. */
export { DEFAULT_CANARY_SIZE, selectCanarySubset } from "./subset.js";

export { runCanary } from "./run.js";
export type { CanaryExampleResult, CanaryRun, CanaryScoredExample, CanaryUnscoredExample, RunCanaryOptions } from "./run.js";

export { CANARY_NOMINAL_INPUT_TOKENS, CANARY_NOMINAL_OUTPUT_TOKENS, computeSnapshot, estimatedCostUsd } from "./snapshot.js";
export type { Snapshot } from "./snapshot.js";

export {
  appendSnapshot,
  averageSnapshots,
  DEFAULT_MAX_HISTORY,
  loadPinnedBaseline,
  loadSnapshotHistory,
  rollingBaseline,
  savePinnedBaseline,
} from "./store.js";

export { compareToBaseline, DEFAULT_DRIFT_THRESHOLDS } from "./drift.js";
export type { DriftResult, DriftThresholds, MetricCheck, TierShift } from "./drift.js";

export { CANARY_EXIT_DRIFT, CANARY_EXIT_OK, canaryExitCode, formatCanaryReport } from "./report.js";
export type { CanaryReportMeta } from "./report.js";
