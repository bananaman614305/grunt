/**
 * Closed-loop policy tuning: read the decision log, roll it up into the cells
 * the routing policy is written in, and propose a tuned policy for a human to
 * review. Phase 1 proposes only -- see `override.ts`.
 */

export { aggregateDecisions, sampleQualityLift, COMPUTE_BANDS, MIN_ARM_N } from "./aggregate.js";
export type {
  AggregateOptions,
  BandStats,
  CellStats,
  CostStats,
  GateStats,
  OutcomeStats,
  SamplingStats,
  TuningInputDecision,
  TuningReport,
} from "./aggregate.js";

export { propose, proposedProfile, DEFAULT_THRESHOLDS, TUNABLE_THRESHOLDS, TUNING_CAVEATS } from "./propose.js";
export type {
  ChangeEvidence,
  PolicyChange,
  PolicyProposal,
  ProposeOptions,
  SkippedCell,
  TunableThreshold,
  TuningThresholds,
} from "./propose.js";

export {
  buildOverride,
  checkApplicable,
  parsePolicyOverride,
  policyOverrideSchema,
  DEFAULT_OVERRIDE_PATH,
  OVERRIDE_NOTE,
  POLICY_OVERRIDE_VERSION,
} from "./override.js";
export type { ApplyCheck, ApplyRefusal, PolicyOverride } from "./override.js";
