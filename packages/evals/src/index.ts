export const PACKAGE = "@milo/evals";

export * from "./schema.js";

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
