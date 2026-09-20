/**
 * The Jev questions that capture preferences (ADR-011), in the same style as
 * `router/questions.ts`: classification only, never generation.
 *
 * Capture is two-phase so the common path stays one Jev call:
 *
 *   1. **Detection rides the routing call.** `CAPTURE_QUESTIONS` -- one noul
 *      ("does the latest user turn state a durable preference") and one
 *      choice over the field vocabulary -- are spread into the routing
 *      systemone request (`ROUTER_QUESTIONS_WITH_CAPTURE`). `detectCapture`
 *      reads those answers back and fires only above the thresholds.
 *   2. **Resolution is a second, targeted call**, made by the gateway's
 *      `maybeCapture` only when detection fired: `resolutionQuestions(field)`
 *      asks for the value as a choice over that field's closed vocabulary,
 *      plus whether the preference is global or limited to this task type.
 *      `resolveCapture` turns its answers into a candidate row, or undefined
 *      when the evidence is too weak to store.
 *
 * Everything here is pure and never throws on malformed answers: a capture
 * that cannot be read is a capture that did not happen, never a failed
 * request.
 */

import type { JevAnswer, JevChoiceQuestion, JevNoulQuestion, JevQuestion } from "../jev/types.js";
import { ROUTER_QUESTIONS } from "../router/questions.js";
import type { PreferenceCaptureSignal, TaskType } from "../types.js";
import { GLOBAL_SCOPE, PREFERENCE_FIELDS, PREFERENCE_VALUES, isPreferenceField } from "./store.js";
import type { PreferenceField, PreferenceScope } from "./store.js";

// ---------------------------------------------------------------------------
// Answer keys and thresholds
// ---------------------------------------------------------------------------

/** noul on the routing call: is a durable preference being stated at all? */
export const PREFERENCE_STATED_KEY = "preference_stated";
/** choice on the routing call: which field it concerns (or "none"). */
export const PREFERENCE_FIELD_KEY = "preference_field";
/** choice on the resolution call: the value, from the field's vocabulary. */
export const PREFERENCE_VALUE_KEY = "preference_value";
/** choice on the resolution call: global, or limited to this task type. */
export const PREFERENCE_SCOPE_KEY = "preference_scope";

/** The field choice's "nothing here" escape hatch. */
export const NO_PREFERENCE_FIELD = "none";

/**
 * Detection fires only when the noul is at least this sure. Preferences are
 * durable state: a false positive writes a row the user never asked for, a
 * false negative just waits for the user to say it again, so the threshold
 * leans conservative.
 */
export const CAPTURE_DETECTION_THRESHOLD = 0.7;
/** And only when the field choice is not a shrug. */
export const CAPTURE_FIELD_CONFIDENCE_THRESHOLD = 0.5;
/** A resolution value below this confidence is dropped, not stored. */
export const CAPTURE_VALUE_CONFIDENCE_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// Detection questions (ride the routing systemone call)
// ---------------------------------------------------------------------------

export const preferenceStatedQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Does the latest user turn state a durable preference about how answers should be produced or presented -- a standing instruction meant to hold beyond this one request?",
  criteria: {
    true:
      'The turn lays down a lasting rule about the answers themselves: "always be concise", "never add tests unless I ask", "stop giving me bullet lists", "prefer the cheapest model", "from now on show the code first". The rule is about how to answer, and it is meant to keep applying.',
    false:
      "The turn is the task itself, or a one-off instruction scoped to it: what to build, fix, or explain; a formatting request for this answer only; feedback on one result; or anything that does not read as a standing rule about future answers.",
  },
};

const FIELD_CRITERIA: Record<string, string> = {
  posture_default:
    'A standing cost-versus-quality stance: "always use the cheapest model that works", "I care about quality, not cost", "stop economising on my requests".',
  tier_floor:
    'A standing minimum capability: "never route me to the fast tier", "always use at least a mid model", "small models keep failing me, stop using them".',
  sampling:
    'A standing rule about best-of-N sampling: "never fan out multiple attempts on my budget", "one answer is enough", or the reverse, "sample more if it helps accuracy".',
  verbosity:
    'How long or terse answers should be, as a rule: "be concise", "skip the preamble", "always explain in detail", "give me thorough answers".',
  format:
    'The shape answers should take, as a rule: prose versus bullet points, "show the code first", "stop using tables", "write in full sentences".',
  evidence_style:
    'How claims should be supported, as a rule: "always cite your sources", "give me a concrete example", "just state the conclusion, skip the justification".',
  testing_depth:
    'How much testing should accompany changes, as a rule: "always write tests", "a smoke test is enough", "never add tests unless I ask".',
  tone:
    'The personality or tone answers should carry, as a rule: "be more casual", "just be direct", "keep it professional", "lighten up a bit".',
  working_style:
    'How work should be sequenced, as a rule: "write the tests first", "just start coding", "always plan before you code", "skip the ceremony and just do it".',
  change_autonomy:
    'Whether to act without confirmation, as a rule: "always ask before big changes", "just go ahead and do it without checking with me".',
  verification_depth:
    'How much to verify changes before finishing, as a rule: "always run the tests and lint", "a quick check is fine", "don\'t bother running the whole suite".',
  explanation_style:
    'How much explanation should accompany code, as a rule: "just give me the code", "show the code first", "explain the approach before the code".',
  [NO_PREFERENCE_FIELD]:
    "No durable preference is stated, or what is stated fits none of the fields above.",
};

export const preferenceFieldQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    'If the latest user turn states a durable preference about how answers should be produced or presented, which of these does it concern? Judge only the latest user turn; choose "none" when no such preference is stated or it fits no field.',
  criteria: FIELD_CRITERIA,
};

/** The two detection questions, keyed by their answer keys. */
export const CAPTURE_QUESTIONS: Record<string, JevQuestion> = {
  [PREFERENCE_STATED_KEY]: preferenceStatedQuestion,
  [PREFERENCE_FIELD_KEY]: preferenceFieldQuestion,
};

/**
 * The routing question set with capture detection riding along. This is what
 * the router's systemone call sends instead of `ROUTER_QUESTIONS` once
 * capture is wired in (the ADR-011 "no extra call on the common path" rule).
 */
export const ROUTER_QUESTIONS_WITH_CAPTURE: Record<string, JevQuestion> = {
  ...ROUTER_QUESTIONS,
  ...CAPTURE_QUESTIONS,
};

// ---------------------------------------------------------------------------
// Resolution questions (the second, targeted call)
// ---------------------------------------------------------------------------

/**
 * When a value applies. Written as behaviours rather than the bare label, so
 * the choice classifies the user's words instead of matching tokens.
 */
const VALUE_CRITERIA: Record<PreferenceField, Record<string, string>> = {
  posture_default: {
    low: "Cost wins: prefer the cheapest capable model, economise by default.",
    balanced: "No strong lean either way; the default trade-off is fine.",
    quality: "Quality wins: prefer the more capable model even when it costs more.",
  },
  tier_floor: {
    fast: "No floor worth the name: the cheapest tier is acceptable.",
    mid: "Never below a mid-capability model.",
    frontier: "Only the most capable models are acceptable.",
  },
  sampling: {
    on: "Sampling several attempts and picking the best is welcome when it helps.",
    off: "Never fan out multiple attempts; one answer per request.",
  },
  verbosity: {
    concise: "Short answers: the result, minimal explanation, no filler.",
    balanced: "Moderate detail: explain what matters, skip the obvious.",
    detailed: "Thorough answers: context, reasoning, alternatives, edge cases.",
  },
  format: {
    prose: "Flowing prose and full sentences; avoid bullet lists.",
    bullets: "Bullet points and short sections over long paragraphs.",
    code_first: "Lead with the code or command; explain after, briefly.",
  },
  evidence_style: {
    citations: "Back claims with sources: file paths, documentation, links.",
    examples: "Support points with a concrete example rather than abstract description.",
    assertions: "State conclusions directly; skip supporting evidence unless asked.",
  },
  testing_depth: {
    none: "Do not add tests unless explicitly asked.",
    smoke: "A minimal smoke test for changed behaviour; nothing exhaustive.",
    thorough: "Cover changes with thorough tests, including edge cases.",
  },
  tone: {
    friendly: "Warm and approachable; encouraging in tone.",
    direct: "Blunt and concise; no pleasantries or hedging.",
    jovial: "Light-hearted and good-humoured; a little wit welcome.",
    professional: "Measured, neutral, and businesslike.",
  },
  working_style: {
    test_first: "Write or update tests before implementing; the failing test first.",
    code_first: "Implement first, then add tests afterwards.",
    plan_first: "Lay out a plan and confirm the approach before coding.",
    just_do: "Skip planning; make the change directly.",
  },
  change_autonomy: {
    ask_first: "Confirm before large or destructive changes; plan first.",
    autonomous: "Proceed without asking; decide and report afterwards.",
  },
  verification_depth: {
    light: "A quick sanity check is enough; no full suite.",
    standard: "Build and run the affected tests before finishing.",
    thorough: "Run the full tests and lint, and report results, before finishing.",
  },
  explanation_style: {
    code_first: "Lead with the code or diff; brief prose after.",
    explain_then_code: "Explain the approach briefly, then show the code.",
    code_only: "Just the code or diff, with minimal explanation.",
  },
};

/** The scope the preference was stated with. */
const SCOPE_TASK_ONLY = "task_only";

const scopeQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "Is the stated preference meant to apply to everything the user asks for, or only to the kind of task in this conversation?",
  criteria: {
    [GLOBAL_SCOPE]:
      'The preference reads as a general rule about all answers: "always", "never", "from now on", or no qualifier at all.',
    [SCOPE_TASK_ONLY]:
      'The preference is explicitly limited to work like the current task: "when you review code...", "for docs...", "on debugging tasks...".',
  },
};

/**
 * The question set for the resolution call: the value as a choice over
 * `field`'s closed vocabulary, and the scope. Classification only -- Jev is
 * never asked to produce text, so nothing the user wrote can round-trip into
 * a stored row.
 */
export function resolutionQuestions(field: PreferenceField): Record<string, JevQuestion> {
  const valueQuestion: JevChoiceQuestion = {
    type: "choice",
    instructions:
      `The latest user turn states a durable preference about ${field.replace(/_/g, " ")}. ` +
      "Which of these does it ask for? Judge only what the user stated.",
    criteria: VALUE_CRITERIA[field],
  };
  return {
    [PREFERENCE_VALUE_KEY]: valueQuestion,
    [PREFERENCE_SCOPE_KEY]: scopeQuestion,
  };
}

// ---------------------------------------------------------------------------
// Reading answers back
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNoul(answer: JevAnswer | undefined): number | undefined {
  if (!isRecord(answer) || answer["type"] !== "noul") return undefined;
  const noul = answer["noul"];
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

function readChoice(answer: JevAnswer | undefined): { choice: string; confidence: number } | undefined {
  if (!isRecord(answer) || answer["type"] !== "choice") return undefined;
  const choice = answer["choice"];
  if (typeof choice !== "string") return undefined;
  const confidence = answer["confidence"];
  return {
    choice,
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
  };
}

/**
 * Reads the detection answers off a routing call's answer set. Returns the
 * capture signal when the noul clears `CAPTURE_DETECTION_THRESHOLD` and the
 * field choice names a real field with confidence at or above
 * `CAPTURE_FIELD_CONFIDENCE_THRESHOLD`; undefined otherwise, malformed
 * answers included -- detection must never break routing.
 */
export function detectCapture(
  answers: Record<string, JevAnswer> | undefined,
): PreferenceCaptureSignal | undefined {
  if (answers === undefined) return undefined;
  const detection = readNoul(answers[PREFERENCE_STATED_KEY]);
  if (detection === undefined || detection < CAPTURE_DETECTION_THRESHOLD) return undefined;

  const field = readChoice(answers[PREFERENCE_FIELD_KEY]);
  if (field === undefined || field.choice === NO_PREFERENCE_FIELD) return undefined;
  if (!isPreferenceField(field.choice)) return undefined;
  if (field.confidence < CAPTURE_FIELD_CONFIDENCE_THRESHOLD) return undefined;

  return { field: field.choice, detection, fieldConfidence: field.confidence };
}

/** What `resolveCapture` produces: a candidate row, minus provenance. */
export type CapturedPreference = {
  field: PreferenceField;
  scope: PreferenceScope;
  value: string;
  /** Initial row confidence: the weaker of detection and value confidence. */
  confidence: number;
};

/**
 * Turns the resolution call's answers into a candidate preference row, or
 * undefined when the evidence is too weak to store: a missing or malformed
 * value answer, a value outside the field's vocabulary, or a value
 * confidence below `CAPTURE_VALUE_CONFIDENCE_THRESHOLD`.
 *
 * The row's confidence is the *weaker* of the detection noul and the value
 * choice's confidence -- the chain is only as strong as its weakest answer.
 * Scope defaults to global; `task_only` narrows to `taskType` when the
 * routing call classified one, and falls back to global when it did not.
 */
export function resolveCapture(
  answers: Record<string, JevAnswer> | undefined,
  detected: PreferenceCaptureSignal,
  opts: { taskType?: TaskType } = {},
): CapturedPreference | undefined {
  if (answers === undefined || !isPreferenceField(detected.field)) return undefined;

  const value = readChoice(answers[PREFERENCE_VALUE_KEY]);
  if (value === undefined) return undefined;
  if (!PREFERENCE_VALUES[detected.field].includes(value.choice)) return undefined;
  if (value.confidence < CAPTURE_VALUE_CONFIDENCE_THRESHOLD) return undefined;

  const scopeAnswer = readChoice(answers[PREFERENCE_SCOPE_KEY]);
  const scope: PreferenceScope =
    scopeAnswer?.choice === SCOPE_TASK_ONLY && opts.taskType !== undefined ? opts.taskType : GLOBAL_SCOPE;

  return {
    field: detected.field,
    scope,
    value: value.choice,
    confidence: Math.min(detected.detection, value.confidence),
  };
}

/** Every field the detection choice can name, for tests and docs. */
export const CAPTURE_FIELD_CHOICES = [...PREFERENCE_FIELDS, NO_PREFERENCE_FIELD] as const;
