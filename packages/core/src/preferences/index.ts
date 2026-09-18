/**
 * Preference memory (ADR-011): the closed vocabulary and store contract,
 * the Jev capture questions, and the brief compiler.
 */

export {
  GLOBAL_SCOPE,
  OUTPUT_SHAPING_FIELDS,
  PREFERENCE_FIELDS,
  PREFERENCE_VALUES,
  ROUTING_SHAPING_FIELDS,
  assertPreferenceCandidate,
  isOutputShapingField,
  isPreferenceField,
  isPreferenceScope,
  isRoutingShapingField,
  mergeCandidate,
  reinforcedConfidence,
} from "./store.js";
export type {
  MergedPreference,
  OutputShapingField,
  PreferenceCandidate,
  PreferenceField,
  PreferenceRow,
  PreferenceScope,
  PreferenceSettings,
  PreferenceStore,
  RoutingShapingField,
} from "./store.js";

export {
  CAPTURE_DETECTION_THRESHOLD,
  CAPTURE_FIELD_CHOICES,
  CAPTURE_FIELD_CONFIDENCE_THRESHOLD,
  CAPTURE_QUESTIONS,
  CAPTURE_VALUE_CONFIDENCE_THRESHOLD,
  NO_PREFERENCE_FIELD,
  PREFERENCE_FIELD_KEY,
  PREFERENCE_SCOPE_KEY,
  PREFERENCE_STATED_KEY,
  PREFERENCE_VALUE_KEY,
  ROUTER_QUESTIONS_WITH_CAPTURE,
  detectCapture,
  preferenceFieldQuestion,
  preferenceStatedQuestion,
  resolutionQuestions,
  resolveCapture,
} from "./questions.js";
export type { CapturedPreference } from "./questions.js";

export {
  BRIEF_CHARS_PER_TOKEN,
  BRIEF_CHAR_CAP,
  BRIEF_PREAMBLE,
  BRIEF_TEMPLATES,
  BRIEF_TOKEN_CAP,
  compileBrief,
  effectiveRows,
  routingDefaults,
} from "./brief.js";
export type { CompiledBrief, RoutingDefaults } from "./brief.js";
