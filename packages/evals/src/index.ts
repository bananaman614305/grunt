export const PACKAGE = "@milo/evals";

export * from "./schema.js";
export * from "./canary/index.js";

export { runRoutingEval } from "./run.js";
export type { RunRoutingEvalOptions } from "./run.js";

export { formatMarkdown, tierAgreementRate } from "./report.js";
export type { EvalExampleResult, EvalReport, ScoredExample, UnscoredExample } from "./report.js";

export {
  concurrencyForMode,
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_FIXTURES_DIR,
  JEV_SOURCE_MODES,
  makeJevClient,
} from "./jev-source.js";
export type { JevSourceMode, MakeJevClientOptions } from "./jev-source.js";

export {
  bandFor,
  buildRosterFile,
  diffRosterFiles,
  extractRankingRows,
  foldPermaslug,
  scrapeRankingRows,
  selectRoster,
  usdPerMillion,
  DEFAULT_RULES,
  DROPPED_VARIANTS,
  TIER_ORDER,
} from "./roster-select.js";
export type {
  OpenRouterModelEntry,
  OpenRouterModelsPayload,
  RankingRow,
  RankingSnapshot,
  RosterFile,
  SelectedModel,
  Selection,
  SelectionRules,
  SkippedModel,
} from "./roster-select.js";

export { formatReplayReport, runSubscriptionReplay, stratifiedSample } from "./subscription-replay.js";
export type { BackendSummary, ReplayOptions, ReplayReport, ReplayTask } from "./subscription-replay.js";
