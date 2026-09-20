/**
 * Wire types for TypeSafe's /v1/systemone endpoint, mirrored from
 * https://api.typesafe.ai/openapi.json (v0.2.0). Shared by the Jev client
 * and the router so they can be built in parallel. Do not change without
 * an ADR.
 */

export type JevNoulQuestion = {
  type: "noul";
  instructions?: string;
  criteria?: { true?: string; false?: string };
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions?: string;
  /** choice name -> description of when it applies (null = name only). */
  criteria: Record<string, string | null>;
};

export type JevScoreQuestion = {
  type: "score";
  instructions?: string;
  /** Ordered level descriptions; index is the score, starting at 0. */
  criteria: string[];
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type SystemOneRequest = {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
};

export type SystemOneResponse = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

/** What the client returns: the response plus transport metadata. */
export type SystemOneResult = SystemOneResponse & {
  requestId: string; // from the x-typesafe-request-id header
  latencyMs: number;
};

export type JevModelMetadata = { name: string; description: string; release_date: string };

/**
 * The surface the router depends on. The real client implements it; tests
 * and the router's fixtures can stub it.
 */
export interface JevClientLike {
  systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    /**
     * `signal` aborts the call; `budgetMs` is the total time the caller will
     * wait for an answer, retries and backoff included. The router passes its
     * own `jevTimeoutMs` as the budget so a retrying client cannot outlive the
     * router's promise to answer within it.
     *
     * `apiKey` is a per-call bearer used **only** by the OpenRouter transport
     * (ADR-021): it is the caller's forwarded OpenRouter key, so the Jev
     * classification call is billed to the user's own OpenRouter key rather
     * than Milo's Jev key. The default TypeSafe transport **ignores** it and
     * always authenticates with its configured Jev key, so a forwarded user
     * key can never be sent to `api.typesafe.ai`.
     */
    opts?: { signal?: AbortSignal; budgetMs?: number; apiKey?: string },
  ): Promise<SystemOneResult>;
}

export const JEV_BASE_URL = "https://api.typesafe.ai";

/**
 * The only model Milo asks routing questions of. TypeSafe also publishes a
 * preview model whose calibration changes without notice; the policy profile
 * in `router/policy.ts` is fitted against this one, and a profile does not
 * transfer between scorers, so Milo pins it (ADR-002 revision 3).
 */
export const JEV_DEFAULT_MODEL = "jev-latest";

/**
 * The OpenRouter transport (ADR-021). TypeSafe's Jev is also served through
 * OpenRouter's alpha "Decisions" router with the same systemone wire shape
 * (`{ model, state, questions }` in, `{ model, answers, usage }` out, question
 * types `noul`/`choice`/`score`). Routing the classification call through it
 * on the caller's forwarded OpenRouter key offloads Jev spend to the user's
 * single key and removes Milo's single-Jev-key outage risk. Selected by
 * config; the direct TypeSafe path stays the default.
 */
export const JEV_OPENROUTER_BASE_URL = "https://openrouter.ai";
/** OpenRouter's alpha Decisions endpoint path (the systemone protocol). */
export const JEV_OPENROUTER_DECISIONS_PATH = "/api/alpha/decisions";
/**
 * The OpenRouter slug for the latest Jev. The `~typesafe/jev-latest` alias
 * always resolves to the newest released Jev (observed: `typesafe/jev-1.13-20260917`)
 * and never to a preview, so it honours the `jev-latest`-only rule the policy
 * profile is fitted against. The bare `typesafe/jev-latest` (no tilde) is not
 * a valid slug; the tilde alias is required for "latest".
 */
export const JEV_OPENROUTER_MODEL = "~typesafe/jev-latest";

/** Which endpoint the Jev client talks to (ADR-021). */
export type JevTransport = "typesafe" | "openrouter";
