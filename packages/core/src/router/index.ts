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
} from "./policy.js";
export type { PolicyProfile } from "./policy.js";

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

export { Router, toSignals, classifyFailure, MAX_IN_FLIGHT } from "./router.js";
export type { RouterOptions } from "./router.js";
export * from "./errors.js";
export * from "./sticky-store.js";
