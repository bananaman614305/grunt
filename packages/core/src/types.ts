/**
 * Core contracts for the Milo MVP. Fixed before parallel work starts.
 * Changing anything here requires an ADR update (docs/adr) merged before
 * dependent tasks begin. See docs/PLAN.md "Core contracts".
 */

// ---------------------------------------------------------------------------
// Routing vocabulary
// ---------------------------------------------------------------------------

export const TASK_TYPES = [
  "chat",
  "edit",
  "feature",
  "debug",
  "research",
  "review",
  "docs",
  "ops",
  "classify",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TIERS = ["fast", "mid", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

export const COST_POSTURES = ["low", "balanced", "quality"] as const;
export type CostPosture = (typeof COST_POSTURES)[number];

/** Ordered OpenRouter model ids per tier. The first entry is the default. */
export type Roster = Record<Tier, string[]>;

/**
 * The shipped default roster, derived from
 * `router/roster-default.json` -- popular OpenRouter models within price
 * bands, never anything at or above the JSON's `excludedAbove` output price
 * (ADR-006). `DEFAULT_ROSTER` is the ids alone, unchanged in shape;
 * `DEFAULT_ROSTER_INFO` carries the prices, usage ranks, band rules and
 * provenance that the disclosure surfaces print.
 */
export {
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  DEFAULT_SMALL_OUTPUT_MODELS,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  ROSTER_POSTURE_POLICY,
  SMALL_OUTPUT_BELOW_TOKENS,
  defaultRosterModel,
  defaultRosterModels,
  isSmallOutput,
} from "./router/roster-default.js";
export type { RosterBand, RosterInfo, RosterModel } from "./router/roster-default.js";

export const ROUTED_MODEL_ID = "milo/auto";

// ---------------------------------------------------------------------------
// OpenAI chat shapes (only what the router reads)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string | Array<{ type: string; text?: string }> | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

/** Optional per-request extension. Stripped before forwarding to OpenRouter. */
export type MiloRequestExtension = {
  posture?: CostPosture;
  candidates?: string[];
  /** Force a tier and skip Jev. Recorded as a decision with reason "forced". */
  tier?: Tier;
  /**
   * Best-of-N override (ADR-010): `1` disables sampling for this request,
   * any larger value sets the sample count on cells the policy samples,
   * capped at 8. Absent means the policy's own default applies.
   */
  samples?: number;
  /**
   * `false` skips the injected preference brief for this one request
   * (ADR-011). Absent means "inject when the caller has stored
   * output-shaping preferences"; there is no `true` opt-in because
   * injection is the default.
   */
  brief?: boolean;
  /**
   * `false` skips the agentic gates (ADR-013 phase A: the completeness
   * check and its failure-typed retry) for this one request. Absent means
   * the gates run where they apply; there is no `true` opt-in because
   * running is the default.
   */
  gates?: boolean;
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * What the capture questions riding the routing systemone call detected
 * (ADR-011): the latest user turn stated a durable preference, and which
 * closed-vocabulary field it concerns. Carries a field *name* and two
 * probabilities, never message content. `field` is a string here rather
 * than the `PreferenceField` union so this pinned file does not depend on
 * the preferences module; `preferences/questions.ts` only ever writes
 * members of its closed vocabulary into it.
 */
export type PreferenceCaptureSignal = {
  field: string;
  /** The detection noul, already at or above the capture threshold. */
  detection: number;
  /** Confidence of the field choice. */
  fieldConfidence: number;
};

export type RouteSignals = {
  taskType: TaskType;
  difficulty: number; // 0..3 expected score
  /**
   * Probability mass per difficulty level, ordered 0..3, summing to about 1.
   * Empty when the decision backend reports no per-level distribution -- the
   * policy then falls back to the expected-score rule (ADR-002 revision 2).
   */
  difficultyLevels: number[];
  needsReasoning: number; // noul
  longOutput: number; // noul
  confidences: Record<string, number>;
  jevRequestId: string;
  jevModel: string;
  latencyMs: number;
  /**
   * Set only when the preference-capture detection fired on this call
   * (ADR-011). The gateway's `maybeCapture` then runs the second, targeted
   * resolution call; absence means "no durable preference stated", which is
   * almost every request.
   */
  capture?: PreferenceCaptureSignal;
};

export type RouteRequest = {
  messages: ChatMessage[];
  tools?: unknown[];
  posture: CostPosture;
  candidates?: string[];
  forcedTier?: Tier;
  fingerprint: string;
  /**
   * Per-request best-of-N override (ADR-010), from `milo.samples`: `1`
   * disables sampling, larger values set the count on cells the policy
   * samples (capped at `MAX_SAMPLE_COUNT`). Absent means the policy decides.
   */
  samples?: number;
  /**
   * The tier-to-model table to resolve this one request against, overriding
   * the Router's own. Set by the gateway when the caller's key has a roster
   * stored against it (ADR-008); absent means "use the Router's", which is
   * the deployment's config roster, else `DEFAULT_ROSTER`. `candidates` still
   * filters within whichever table is used.
   */
  roster?: Roster;
};

export type RouteDecision = {
  id: string; // ulid
  fingerprint: string;
  signals?: RouteSignals; // absent only when the tier was forced by the request
  tier: Tier;
  model: string;
  reason: string; // one sentence, human readable
  policyVersion: string;
  /**
   * The decision was reused rather than freshly decided: a sticky-cache or
   * sticky-store hit, or a caller that shared an in-flight Jev call with an
   * identical concurrent ask. A sticky decision carries the same `signals`
   * (and the same `jevRequestId`) as the call that produced it.
   */
  sticky: boolean;
  /**
   * Best-of-N sampling (ADR-010). When set (always > 1), the gateway fans out
   * this many upstream calls on `tier` (always `fast`) and returns the answer
   * Jev ranks best. `unsampledTier` is what the policy would have picked
   * without sampling, and is what the eval gate measures.
   */
  samples?: number;
  unsampledTier?: Tier;
  /**
   * What a single unsampled call should run on when this decision's sampled
   * model is not tier-derived (ADR-012: the deepseek compute controller
   * samples a fixed family model, not the roster's fast tier). Read by the
   * gateway's all-samples-failed fallback and by the sticky `milo.samples: 1`
   * override; absent means "resolve `unsampledTier` against the roster",
   * which is the ADR-010 behaviour, unchanged.
   */
  unsampledModel?: string;
  createdAt: string; // ISO 8601
};

/** Hard limits the router must respect. */
export const ROUTER_LIMITS = {
  /**
   * Total budget for getting an answer out of Jev, retries and backoff
   * included -- not the budget for one HTTP attempt. Raised from 800 ms when
   * the fallback tier was removed (ADR-002 revision 3): with no degraded
   * answer to fall back on, a request is better served by a second attempt
   * 200 ms later than by a 503, and a cold TLS handshake to api.typesafe.ai
   * is about 350 ms of the first attempt on its own. Configurable per
   * Router/Gateway.
   */
  jevTimeoutMs: 3_000,
  /** Retries after the first attempt, inside `jevTimeoutMs`. */
  jevRetries: 3,
  stickyTtlMs: 30 * 60 * 1000,
  contextTokenBudget: 8_000,
  recentUserTurns: 3,
} as const;

export const POLICY_VERSION = "v4";

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

/**
 * One sample of a best-of-N fan-out as the decision log stores it (ADR-010):
 * token counts, cost, Jev's scores, and the pick -- never content.
 */
export type SampleUpstream = {
  index: number;
  status: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Jev's expected 0..3 quality score for this sample's answer. */
  jevQuality?: number;
  /** Jev's probability that this sample's answer is correct. */
  jevCorrect?: number;
  /** Failure class only ("timeout", "network", "http_500", "rank_failed"...). */
  error?: string;
  picked?: boolean;
};

/**
 * What the completeness gate did to one routed answer (ADR-013 phase A):
 * the verdict, whether the failure-typed retry fired, and which answer was
 * served. The retry's tokens and cost are folded into the row's aggregate
 * usage alongside its own sub-record here. Never content.
 */
export type GateUpstream = {
  /** `complete`, `incomplete`, `off_task`, `wrong_format` -- or `error` when the check itself failed and the answer was served as-is. */
  verdict: string;
  /** Jev's confidence on the verdict, when the check answered. */
  confidence?: number;
  /** The failure-typed retry fired (at most once). */
  retried?: boolean;
  /** Which answer was served after a retry. */
  pick?: "original" | "retry";
  /** Jev's expected quality for each answer, when both were rated. */
  originalQuality?: number;
  retryQuality?: number;
  /** The retry call's own outcome; its usage is also in the aggregate. */
  retry?: { status: number; latencyMs: number; inputTokens?: number; outputTokens?: number; costUsd?: number; error?: string };
};

export type DecisionRecord = RouteDecision & {
  /**
   * Set by the gateway after the upstream call completes. On a sampled
   * decision (ADR-010) the token counts and cost aggregate across every
   * sample, `samples` carries the per-sample metadata, `samplePick` the
   * chosen index, and `sampleNote` marks a degraded pick: `ranking_failed`
   * (Jev could not rank, first success returned) or `all_samples_failed`
   * (one ordinary call on `unsampledTier` answered instead).
   */
  upstream?: {
    status: number;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    samples?: SampleUpstream[];
    samplePick?: number;
    sampleNote?: "ranking_failed" | "all_samples_failed";
    /**
     * The completeness gate's outcome (ADR-013 phase A), present only when
     * the gate ran. On a retried answer the aggregate tokens/cost above
     * include the retry's usage: the row bills what was actually generated.
     */
    gate?: GateUpstream;
  };
};
