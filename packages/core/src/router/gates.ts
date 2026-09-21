/**
 * The completeness gate (ADR-013 phase A): the Jev question that asks
 * whether a routed answer addresses every part of the request, and the
 * fixed retry template each failure type buys.
 *
 * Like `sampling.ts`, this module is the classification prompt's production
 * home: the gateway executes the gate (`packages/gateway`), but the wording
 * lives here next to the router and ranking questions it runs alongside.
 * Changing the wording changes verdicts; re-measure before editing.
 *
 * The gate fails toward serving, never toward failing the request: a Jev
 * error here means the answer goes out as-is (ADR-013 -- "each failing
 * toward more compute or disclosure, never silent acceptance" is about the
 * verdicts, and an unavailable gate is disclosed in the decision record).
 */

import type { JevClientLike, JevQuestion } from "../jev/types.js";
import type { ChatMessage, Roster, RouteDecision, Tier } from "../types.js";
import { TIERS } from "../types.js";
import { DEEPSEEK_BRANCH_MODEL, DEEPSEEK_ORCHESTRATOR_MODEL } from "./controller.js";
import { resolveModel } from "./roster.js";
import type { ResolveModelOptions } from "./roster.js";
import { rankState } from "./sampling.js";

/** The verdicts the completeness question can return. */
export const GATE_VERDICTS = ["complete", "incomplete", "off_task", "wrong_format"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** The failing verdicts: each buys exactly one retry with its template. */
export type GateFailureType = Exclude<GateVerdict, "complete">;

/**
 * The one question the gate asks about (task, answer). A `choice` rather
 * than a noul so a failing verdict arrives already typed: the type picks
 * the retry template, and a second call to classify the failure would
 * double the gate's latency for nothing.
 */
export const COMPLETENESS_QUESTIONS: Record<string, JevQuestion> = {
  completeness: {
    type: "choice",
    instructions:
      "A user sent the task below to an AI assistant and got the candidate answer. Judge whether the answer addresses everything the task explicitly asked for. Judge coverage of the request's stated parts, requirements and format -- not writing quality, and not correctness beyond whether the answer is doing the asked-for task at all.",
    criteria: {
      complete:
        "The answer addresses every explicitly requested part: each question asked, each item to produce, each named requirement and constraint. It may be imperfect, but nothing that was asked for is missing.",
      incomplete:
        "The answer is on the right task but omits one or more explicitly requested parts: an unanswered sub-question, a missing item from an enumerated list, a requirement or constraint it never addresses.",
      off_task:
        "The answer does a different task than the one asked: it answers another question, restates the problem without doing the work, or ignores the actual instruction.",
      wrong_format:
        "The answer covers the substance but not in the explicitly required output format: the task named a structure (JSON, a diff, a table, a fixed schema, 'only output X') and the answer does not follow it.",
    },
  },
};

/**
 * The fixed template a failure type appends -- as one final system message on
 * the original conversation -- for its single retry (ADR-013: exactly ONE,
 * per request, whatever the second verdict would say). The templates name
 * the failure class only; they quote nothing from the graded answer, so no
 * generated content rides the retry beyond the conversation the caller sent.
 */
export const RETRY_TEMPLATES: Record<GateFailureType, string> = {
  incomplete:
    "Your previous answer omitted one or more explicitly required parts. Answer again, covering every requirement, numbered item, sub-question, and constraint in the request, completely.",
  off_task:
    "Your previous answer did not do what the request actually asked. Re-read the latest request, then answer again, doing exactly the task it states -- not a related task, a summary of it, or a plan for it.",
  wrong_format:
    "Your previous answer was not in the output format the request requires. Answer again with the same substance, following the requested format exactly -- its structure, its fields, and any \"output only\" instruction -- with nothing extra.",
};

/** Total budget for one completeness call, ms: same habit as ranking. */
export const GATE_BUDGET_MS = 8_000;

/**
 * Below this confidence a `complete` verdict is SUSPECT rather than a pass.
 *
 * Live evidence (a long-horizon production run, read off `GET /v1/decisions`):
 * `complete` verdicts at confidence 0.31-0.57 sat on answers whose own
 * sampled `jevQuality` was 0.6-2.1, while genuinely complete answers were
 * called at 0.82-0.99. The verdict's own confidence separates the two
 * cleanly, and the gate was throwing it away. 0.6 sits in the empty gap
 * between the two clusters.
 *
 * A suspect verdict does not fail the request and does not buy a retry on its
 * own: the gateway rates the answer with the ranking question instead
 * (`rankAnswer`) and only escalates when that rating comes back below
 * `GATE_SUSPECT_QUALITY`.
 */
export const GATE_TRUST_CONFIDENCE = 0.6;

/**
 * Expected quality (0..3) at or above which a low-confidence `complete`
 * verdict is served anyway. 2.0 is the ranking question's "right in substance
 * with a minor flaw" level -- usable as it stands -- so anything below it is
 * the "partly right, the user still has work to do" band the retry exists for.
 */
export const GATE_SUSPECT_QUALITY = 2.0;

/**
 * The retry template a low-confidence `complete` verdict uses. The verdict
 * itself named no failure type (it claimed success), and what the evidence
 * showed under it was answers missing required parts, so the retry asks for
 * complete coverage.
 */
export const LOW_CONFIDENCE_FAILURE: GateFailureType = "incomplete";

/**
 * Where a warranted retry should run, when the decision knows about something
 * stronger than what actually answered. Returns `undefined` when nothing
 * stronger exists, and the caller re-prompts the same model.
 *
 * Live evidence: the one retry that fired in the long-horizon run re-prompted
 * the same fast model whose five samples had all rated 0.57-0.85; the retry
 * came back at 0.79. A same-model re-prompt cannot fix a capability miss, so
 * the retry now escalates wherever the decision already names a stronger
 * model:
 *
 *   - a decision carrying its own `unsampledModel` uses that when it differs
 *     from what answered;
 *   - a sampled roster decision (ADR-010) escalates to `unsampledTier`
 *     resolved against this caller's roster -- the tier the cell would have
 *     bought without sampling;
 *   - failing both, a compute-controller decision (ADR-012) below band 3
 *     answered on the branch model, and the measured mapping's own next step
 *     up is band 3's orchestrator. The roster's fast tier leads with the same
 *     model, so a roster-mode decision that got there with nothing else to
 *     name escalates within the family too, which is the right move anyway.
 *
 * `candidates` is the request's `milo.candidates`, so an explicit allow-list
 * still bounds the escalation.
 */
export type GateEscalation = { model: string; tier?: Tier };

export function escalationFor(
  decision: Pick<RouteDecision, "model" | "tier" | "unsampledTier" | "unsampledModel">,
  roster: Roster,
  candidates?: string[],
  opts?: ResolveModelOptions,
): GateEscalation | undefined {
  if (decision.unsampledModel !== undefined && decision.unsampledModel !== decision.model) {
    return { model: decision.unsampledModel };
  }

  const tier = decision.unsampledTier;
  if (tier !== undefined && TIERS.indexOf(tier) > TIERS.indexOf(decision.tier)) {
    let model: string | undefined;
    try {
      model = resolveModel(tier, roster, candidates, opts);
    } catch {
      // An unusable roster is not a reason to lose the retry.
      model = undefined;
    }
    if (model !== undefined && model !== decision.model) return { model, tier };
    return undefined;
  }

  if (decision.model === DEEPSEEK_BRANCH_MODEL) {
    if (candidates !== undefined && candidates.length > 0 && !candidates.includes(DEEPSEEK_ORCHESTRATOR_MODEL)) {
      return undefined;
    }
    return { model: DEEPSEEK_ORCHESTRATOR_MODEL };
  }
  return undefined;
}

export type GateCheck = {
  verdict: GateVerdict;
  confidence: number;
  latencyMs: number;
};

function isVerdict(value: string): value is GateVerdict {
  return (GATE_VERDICTS as readonly string[]).includes(value);
}

/**
 * Asks Jev for the completeness verdict over one (task, answer) pair. The
 * state is `rankState`'s: the clipped transcript and the clipped candidate
 * answer, exactly what ranking sends. Throws on a Jev failure or a malformed
 * answer; the caller decides what that means (the gateway serves the answer
 * as-is and records `error`).
 *
 * `apiKey` is the caller's forwarded OpenRouter key (ADR-022): under the
 * `"openrouter"` Jev transport it authenticates this call so it bills to the
 * user's key, not Milo's `JEV_API_KEY`. The TypeSafe transport ignores it, so
 * it can be passed unconditionally.
 */
export async function checkCompleteness(
  jev: JevClientLike,
  task: ChatMessage[],
  answer: string,
  budgetMs = GATE_BUDGET_MS,
  apiKey?: string,
): Promise<GateCheck> {
  const result = await jev.systemone(
    { state: rankState(task, answer), questions: COMPLETENESS_QUESTIONS },
    { budgetMs, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
  );
  const verdict = result.answers["completeness"];
  if (verdict?.type !== "choice" || !isVerdict(verdict.choice)) {
    throw new Error("jev returned a completeness answer of the wrong shape");
  }
  return { verdict: verdict.choice, confidence: verdict.confidence, latencyMs: result.latencyMs };
}

/**
 * The conversation the retry runs on: the original messages, untouched,
 * plus the failure type's fixed template as a final system message.
 */
export function retryMessages(messages: ChatMessage[], failure: GateFailureType): ChatMessage[] {
  return [...messages, { role: "system", content: RETRY_TEMPLATES[failure] }];
}
