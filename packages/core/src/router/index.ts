/**
 * The router: Jev question set, Policy v2, roster resolution, stickiness.
 * See docs/adr/002-routing-signals-and-policy.md.
 */

export { buildJevState, countUserTurns, messageText, CHARS_PER_TOKEN, TRUNCATION_MARKER } from "./context.js";
export type { JevState } from "./context.js";

export { fingerprint } from "./fingerprint.js";

export {
  ROUTER_QUESTIONS,
  QUESTION_KEYS,
  taskTypeQuestion,
  difficultyQuestion,
  needsReasoningQuestion,
  longOutputQuestion,
} from "./questions.js";
export type { QuestionKey } from "./questions.js";

export {
  chooseTier,
  chooseTierFromExpectedScore,
  postureProfile,
  hardMass,
  upperMass,
  upperMassFromLevel1,
  fastGateMass,
  DEFAULT_PROFILE,
  JEV_PROFILE,
  LOW_POSTURE_FAST_MASS,
  QUALITY_MIN_FRONTIER_HARD_MASS,
  QUALITY_MIN_FRONTIER_UPPER_MASS,
  QUALITY_POSTURE_FRONTIER_MASS,
  QUALITY_POSTURE_FRONTIER_SHIFT,
  POLICY_VERSION,
  DIFFICULTY_MID,
  DIFFICULTY_HIGH,
  DIFFICULTY_CAP_OVERRIDE,
  REASONING_THRESHOLD,
  CAPPED_TASK_TYPES,
  chooseOutcome,
  clampSamples,
  SAMPLING_TASK_TYPES,
  DEFAULT_SAMPLE_COUNT,
  MAX_SAMPLE_COUNT,
} from "./policy.js";
export type { PolicyProfile, PolicyOutcome } from "./policy.js";

export {
  PROMPT_VARIANTS,
  applyVariant,
  variantFor,
  RANK_QUESTIONS,
  RANK_STATE_MAX_CHARS,
  RANK_BUDGET_MS,
  rankState,
  rankAnswer,
  compareRanked,
  pickBest,
} from "./sampling.js";
export type { RankScore } from "./sampling.js";

export {
  resolveModel,
  tierSearchOrder,
  LONG_OUTPUT_THRESHOLD,
  DEFAULT_SMALL_OUTPUT_MODELS,
  SMALL_OUTPUT_BELOW_TOKENS,
} from "./roster.js";
export type { ResolveModelOptions } from "./roster.js";

export { describeRoster, isDemoted, tierByPrice, tierForPrice } from "./roster-from-models.js";
export type { PricedModel, RosterPriceInfo, TierBands } from "./roster-from-models.js";

export {
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  ROSTER_POSTURE_POLICY,
  defaultRosterModel,
  defaultRosterModels,
  isSmallOutput,
} from "./roster-default.js";
export type { RosterBand, RosterInfo, RosterModel } from "./roster-default.js";

export { StickyCache, STICKY_MAX_ENTRIES } from "./sticky.js";
export type { StickyCacheOptions } from "./sticky.js";

export {
  CircuitBreaker,
  isTransportFailure,
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
} from "./breaker.js";
export type { BreakerState, BreakerStatus, CircuitBreakerOptions } from "./breaker.js";

export {
  computeBand,
  computeBudget,
  sizeCompute,
  DEEPSEEK_BRANCH_MODEL,
  DEEPSEEK_ORCHESTRATOR_MODEL,
  SIZING_BUDGET_MS,
} from "./controller.js";
export type { ComputeBand, ComputeBudget, ComputeSizing } from "./controller.js";

export {
  checkCompleteness,
  retryMessages,
  COMPLETENESS_QUESTIONS,
  RETRY_TEMPLATES,
  GATE_VERDICTS,
  GATE_BUDGET_MS,
} from "./gates.js";
export type { GateCheck, GateFailureType, GateVerdict } from "./gates.js";

export { Router, toSignals, classifyFailure, MAX_IN_FLIGHT } from "./router.js";
export type { RouterOptions, RoutingMode } from "./router.js";
export * from "./errors.js";
export * from "./sticky-store.js";
