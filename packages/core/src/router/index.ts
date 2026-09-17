/**
 * The router: Jev question set, Policy v1, roster resolution, stickiness.
 * See docs/adr/002-routing-signals-and-policy.md.
 */

export { buildJevState, messageText, CHARS_PER_TOKEN, TRUNCATION_MARKER } from "./context.js";
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
  POLICY_VERSION,
  DIFFICULTY_MID,
  DIFFICULTY_HIGH,
  DIFFICULTY_CAP_OVERRIDE,
  REASONING_THRESHOLD,
  CAPPED_TASK_TYPES,
} from "./policy.js";

export { resolveModel, tierSearchOrder, LONG_OUTPUT_THRESHOLD, DEFAULT_SMALL_OUTPUT_MODELS } from "./roster.js";
export type { ResolveModelOptions } from "./roster.js";

export { StickyCache, STICKY_MAX_ENTRIES } from "./sticky.js";
export type { StickyCacheOptions } from "./sticky.js";

export { Router, toSignals, classifyFailure, degradedDecision } from "./router.js";
export type { RouterOptions, DegradeCause, DegradedDecisionInput } from "./router.js";
