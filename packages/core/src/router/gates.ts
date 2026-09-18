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
import type { ChatMessage } from "../types.js";
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

export type GateCheck = {
  verdict: GateVerdict;
  confidence: number;
  latencyMs: number;
};

function isVerdict(value: string): value is GateVerdict {
  return (GATE_VERDICTS as readonly string[]).includes(value);
}

/**
 * Asks Jev (on Milo's key) for the completeness verdict over one (task,
 * answer) pair. The state is `rankState`'s: the clipped transcript and the
 * clipped candidate answer, exactly what ranking sends. Throws on a Jev
 * failure or a malformed answer; the caller decides what that means (the
 * gateway serves the answer as-is and records `error`).
 */
export async function checkCompleteness(
  jev: JevClientLike,
  task: ChatMessage[],
  answer: string,
  budgetMs = GATE_BUDGET_MS,
): Promise<GateCheck> {
  const result = await jev.systemone(
    { state: rankState(task, answer), questions: COMPLETENESS_QUESTIONS },
    { budgetMs },
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
