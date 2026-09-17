export const PACKAGE = "@milo/evals";

export * from "./schema.js";

export { runRoutingEval } from "./run.js";
export type { RunRoutingEvalOptions } from "./run.js";

export { formatMarkdown, tierAgreementRate } from "./report.js";
export type { EvalExampleResult, EvalReport, ScoredExample, UnscoredExample } from "./report.js";

export {
  backendForMode,
  concurrencyForMode,
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_FIXTURES_DIR,
  DEFAULT_SYSTEM_ONE_OPEN_FIXTURES_DIR,
  EVAL_BACKENDS,
  JEV_SOURCE_MODES,
  makeJevClient,
  routerTimeoutForMode,
  SYSTEM_ONE_OPEN_EVAL_CONCURRENCY,
  SYSTEM_ONE_OPEN_EVAL_TIMEOUT_MS,
  warmupBackend,
} from "./jev-source.js";
export type { EvalBackend, JevSourceMode, MakeJevClientOptions } from "./jev-source.js";
