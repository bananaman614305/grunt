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

export const DEFAULT_ROSTER: Roster = {
  fast: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
  mid: ["anthropic/claude-sonnet-5"],
  frontier: ["anthropic/claude-opus-5"],
};

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
};

export type RouteDecision = {
  id: string; // ulid
  fingerprint: string;
  signals?: RouteSignals; // absent when degraded or forced
  tier: Tier;
  model: string;
  reason: string; // one sentence, human readable
  policyVersion: string;
  sticky: boolean; // served from the fingerprint cache
  degraded: boolean; // Jev unavailable; fell back to mid
  createdAt: string; // ISO 8601
};

/** Hard limits the router must respect. */
export const ROUTER_LIMITS = {
  jevTimeoutMs: 800, // default; cold TLS to api.typesafe.ai is ~350 ms from us-east, configurable per Router/Gateway
  jevRetries: 1,
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
