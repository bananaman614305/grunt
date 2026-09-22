/**
 * Core contracts for the Milo MVP. Fixed before parallel work starts.
 * Changing anything here requires an ADR update (docs/adr) merged before
 * dependent tasks begin. See docs/PLAN.md "Core contracts".
 */

import type { CriterionEvidence, TaskRecord } from "./tasks/types.js";

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

/**
 * Input modality a request carries, read straight off its message content
 * parts by the multimodal pre-gate (ADR-020). `"text"` is the ordinary case;
 * the others mean a non-text media part was present and pinned a capable
 * model. Output is always text -- this names *input* only.
 */
export const MODALITIES = ["text", "image", "audio", "video"] as const;
export type Modality = (typeof MODALITIES)[number];

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
  /** Canonical task intent used by criterion-aware best-of-N selection. */
  task?: TaskRecord;
  /** Source-linked deterministic or harness evidence for task criteria. */
  evidence?: CriterionEvidence[];
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
  /**
   * `false` skips the relevance-gated personal-fact note for this one request
   * (ADR-017). Absent means "inject relevant facts when the caller has any
   * stored and the key's kill switch is on"; there is no `true` opt-in
   * because injection is the default. The per-key kill switch
   * (`PUT /v1/memory/settings`) turns it off for every request.
   */
  facts?: boolean;
  /**
   * Context pruning (ADR-014, ADR-013 phase C): `true` opts this request in
   * to shedding safe older context before it is forwarded, `false` opts it
   * out. Unlike `brief`/`gates`, BOTH values are meaningful, because pruning
   * is off by default: it edits the caller's own message history, so a
   * deployment enables it with `pruning.enabled` and any request can force it
   * on or off, with `false` always winning.
   */
  prune?: boolean;
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
  /**
   * The caller's forwarded OpenRouter key, used only when the router's Jev
   * client runs the `"openrouter"` transport (ADR-021): the classification
   * call is then billed to the user's own OpenRouter key. The default
   * TypeSafe client ignores it and authenticates with Milo's Jev key, so this
   * can be set unconditionally by the gateway. Never stored or logged: it is
   * read once to authenticate the Jev call and never placed on a
   * `RouteDecision`.
   */
  jevKey?: string;
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
  /**
   * The input modality that drove this route (ADR-020's multimodal gate),
   * set only when a non-text media part pinned a vision- or omni-capable
   * model instead of the compute controller's text-only branch model. Absent
   * means the request was text and the band's own budget stood; the gateway
   * then discloses `x-milo-modality: text`. Carries a closed-vocabulary
   * label, never message content.
   */
  modality?: Modality;
  /**
   * Set only when this decision's `signals` were served from the router's
   * short-TTL classification cache (ADR-023) rather than a fresh Jev call --
   * distinct from `sticky`, which also covers a sticky-cache/store hit and an
   * in-flight-coalescing join. Unlike those, a `cached` decision still ran
   * policy fresh against the reused signals, so its tier/model can differ
   * from whatever request first produced them. Absent (never `false`) means
   * the classification came from Jev on this call, or `signals` is absent
   * because the tier was forced. The gateway discloses it as
   * `x-milo-cache: hit|miss`; it is not persisted to the decision log.
   */
  cached?: boolean;
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
  /** Canonical selector outcome when the request supplied `milo.task`. */
  selectionOutcome?: "accept" | "reject" | "abstain";
  /** Per-criterion decisions and provenance; summaries and candidate content are omitted. */
  criterionEvidence?: Array<{
    criterionId: string;
    verdict: "satisfied" | "violated" | "unknown";
    confidence: number;
    source: "evidence" | "jev" | "missing";
    sourceRef?: string;
  }>;
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

/**
 * What context pruning did to a routed request before it was forwarded
 * (ADR-014, ADR-013 phase C): how many older messages a contiguous range
 * dropped, the approximate input tokens that saved, the range itself, and
 * the verdict that authorised it. Counts only, never content -- the dropped
 * messages leave no trace but a marker in the forwarded body and these
 * numbers here.
 */
export type PruneUpstream = {
  /** Messages dropped (replaced by one summary note). */
  pruned: number;
  /** Approximate input tokens saved: dropped characters minus the note, / 4. */
  tokensSaved: number;
  /** The dropped range as indices into the request's original `messages`. */
  from: number;
  to: number;
  /** Jev's `oldest_finished` confidence, which cleared the sliding floor. */
  confidence: number;
  /** The sliding floor at this context fill. */
  floor: number;
  /** Estimated input tokens over the model's context window. */
  fillRatio: number;
};

export type DecisionRecord = RouteDecision & {
  /**
   * Set by the gateway after the upstream call completes. On a sampled
   * decision (ADR-010) the token counts and cost aggregate across every
   * sample, `samples` carries the per-sample metadata, `samplePick` the
   * chosen index, and `sampleNote` marks a degraded pick: `ranking_failed`
   * (Jev could not rank), `ranking_abstained` (required evidence was unknown),
   * or `all_samples_failed`
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
    sampleNote?: "ranking_failed" | "ranking_abstained" | "all_samples_failed";
    /**
     * The completeness gate's outcome (ADR-013 phase A), present only when
     * the gate ran. On a retried answer the aggregate tokens/cost above
     * include the retry's usage: the row bills what was actually generated.
     */
    gate?: GateUpstream;
    /**
     * Context pruning's outcome (ADR-014), present only when the gate ran
     * and dropped a range. Counts only, no content.
     */
    prune?: PruneUpstream;
  };
};
