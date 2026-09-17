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
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

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
};

export type RouteRequest = {
  messages: ChatMessage[];
  tools?: unknown[];
  posture: CostPosture;
  candidates?: string[];
  forcedTier?: Tier;
  fingerprint: string;
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

export const POLICY_VERSION = "v2";

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

export type DecisionRecord = RouteDecision & {
  /** Set by the gateway after the upstream call completes. */
  upstream?: {
    status: number;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
};
