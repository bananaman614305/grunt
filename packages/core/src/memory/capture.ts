/**
 * The Jev questions that capture personal facts (ADR-017), and the pure
 * resolver that turns their answers into a fact to store. Classification only,
 * exactly like `router/questions.ts` and `preferences/questions.ts`: Jev is
 * never asked to produce text.
 *
 * Capture is one fire-and-forget Jev call the gateway makes off the response
 * path (a sibling of ADR-011's `maybeCapture`), asking two things about the
 * latest user turn:
 *
 *   1. **should this be remembered** -- a noul covering both the explicit
 *      "remember that X" / "my X is Y" and the opportunistic durable personal
 *      fact stated in passing;
 *   2. **as what category** -- a choice over the closed vocabulary, or "none".
 *
 * The fact *text* is then taken from the user's own message, not from Jev:
 * `resolveFactCapture(answers, message)` reads the two answers, and when both
 * clear their floors, returns `{ category, text }` with the text lifted from
 * the message (the explicit "remember that …" / "my … is …" clause when there
 * is one, else the whole turn). That extracted text is what the gateway
 * encrypts and stores. Nothing here throws on malformed answers: a capture
 * that cannot be read is a capture that did not happen.
 */

import type { JevAnswer, JevChoiceQuestion, JevNoulQuestion, JevQuestion } from "../jev/types.js";
import type { ChatMessage } from "../types.js";
import { messageText } from "../router/context.js";
import { FACT_CATEGORIES, isFactCategory } from "./store.js";
import type { FactCategory } from "./store.js";

// ---------------------------------------------------------------------------
// Answer keys and thresholds
// ---------------------------------------------------------------------------

/** noul: should the latest user turn be remembered as a durable personal fact? */
export const FACT_STATED_KEY = "fact_stated";
/** choice: which category the fact falls under (or "none"). */
export const FACT_CATEGORY_KEY = "fact_category";

/** The category choice's "nothing to remember" escape hatch. */
export const NO_FACT_CATEGORY = "none";

/**
 * Detection fires only when the noul is at least this sure. A fact is durable
 * PII: a false positive stores something the user never asked Milo to keep, so
 * the floor leans conservative -- a missed fact just waits to be said again.
 */
export const FACT_DETECTION_THRESHOLD = 0.7;
/** And only when the category choice is not a shrug. */
export const FACT_CATEGORY_CONFIDENCE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const factStatedQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Does the latest user turn state a durable personal fact worth remembering across sessions -- either explicitly asking to be remembered, or stating a lasting fact about the user, their accounts, people, or conventions?",
  criteria: {
    true:
      'The turn asks Milo to remember something, or states a durable personal fact: "remember that my deploy account is acct_4Q7", "my staging box is 10.2.0.7", "my co-founder is Dana, she owns billing", "we always spell it gray, never grey", "my timezone is CET". It also counts a durable CODING CONVENTION meant to keep applying -- "we use pnpm, not npm", "always run vitest before pushing", "our components go in src/ui" -- and a durable CODING CORRECTION or anti-pattern the user states to stop or never do -- "stop using var, always use const", "don\'t touch generated files", "you keep breaking the build, run the tests first". The fact, convention, or correction is meant to keep applying across sessions, not just this one.',
    false:
      "The turn is the task itself or a one-off: what to build, fix, or explain; a one-time fix or instruction that applies only to this request; an ephemeral value used only for this request; a preference about how to answer (that is ADR-011, not a fact); or anything not a lasting personal fact, convention, or correction.",
  },
};

const CATEGORY_CRITERIA: Record<string, string> = {
  address:
    "A place or network location: a postal address, an office, a hostname, an IP address, a URL that identifies the user's own resource.",
  contact:
    "A person and, usually, their relationship or role: a name, a teammate, a co-founder, an email or handle for a person.",
  identifier:
    "An account, project, org, or resource id: an account number, a project slug, a customer id, a ticket prefix, a repository.",
  "credential-hint":
    "A non-secret hint about a credential: which key or profile to use, where a token lives, a username -- never a secret value itself.",
  convention:
    'A standing "this is how we do it" convention, especially a CODING or project convention: a tool or command to use ("pnpm, not npm", "run vitest before pushing"), where code lives ("components go in src/ui"), or a naming or spelling rule. It states the positive rule to follow (not about answer shape, and distinct from a "stop/never/don\'t" correction).',
  correction:
    'A durable CODING correction or anti-pattern the user has told Milo to STOP or NEVER do, or a mistake they say Milo keeps making: "stop using var", "don\'t touch generated files", "never edit types.ts without an ADR", "you keep forgetting to run the tests". A lasting don\'t/never/stop instruction about how NOT to code, distinct from a positive convention.',
  other: "A durable personal fact that fits none of the categories above.",
  [NO_FACT_CATEGORY]: "No durable personal fact is stated, or nothing worth remembering.",
};

export const factCategoryQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    'If the latest user turn states a durable personal fact worth remembering, which category does it fall under? Choose "none" when there is no such fact.',
  criteria: CATEGORY_CRITERIA,
};

/** The two capture questions, keyed by their answer keys. */
export const FACT_CAPTURE_QUESTIONS: Record<string, JevQuestion> = {
  [FACT_STATED_KEY]: factStatedQuestion,
  [FACT_CATEGORY_KEY]: factCategoryQuestion,
};

/** Every category the choice can name, for tests and docs. */
export const FACT_CATEGORY_CHOICES = [...FACT_CATEGORIES, NO_FACT_CATEGORY] as const;

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

/** The latest user turn's text, flattened -- the source the fact is lifted from. */
export function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") {
      const text = messageText(message.content);
      if (text.length > 0) return text;
    }
  }
  return "";
}

/**
 * Lifts the fact text from the user's message. When the turn uses an explicit
 * "remember that <X>" / "my <thing> is <X>" / "note that <X>" frame, the clause
 * after the frame is the fact; otherwise the whole turn is. This is a
 * deterministic slice of the user's own words -- never generated -- and the
 * one value in Milo persisted from raw content, encrypted by the caller.
 */
export function extractFactText(message: string): string {
  const trimmed = message.trim();
  const framed = /^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget|fyi)[:,]?\s+(?:that\s+|this[:,]?\s+)?(.+)$/is.exec(
    trimmed,
  );
  const text = (framed?.[1] ?? trimmed).trim();
  // Bound it the same way the store does, so a resolver caller never has to.
  return text.length > 2_000 ? text.slice(0, 2_000).trim() : text;
}

/** What `resolveFactCapture` produces: the category and the text to encrypt. */
export type CapturedFact = {
  category: FactCategory;
  text: string;
};

/**
 * Turns the capture call's answers plus the user's message into a fact to
 * store, or undefined when the evidence is too weak: the noul below
 * `FACT_DETECTION_THRESHOLD`, the category "none" or below its confidence
 * floor or outside the vocabulary, or a message with no text to lift.
 */
export function resolveFactCapture(
  answers: Record<string, JevAnswer> | undefined,
  message: string,
): CapturedFact | undefined {
  if (answers === undefined) return undefined;

  const detection = readNoul(answers[FACT_STATED_KEY]);
  if (detection === undefined || detection < FACT_DETECTION_THRESHOLD) return undefined;

  const category = readChoice(answers[FACT_CATEGORY_KEY]);
  if (category === undefined || category.choice === NO_FACT_CATEGORY) return undefined;
  if (!isFactCategory(category.choice)) return undefined;
  if (category.confidence < FACT_CATEGORY_CONFIDENCE_THRESHOLD) return undefined;

  const text = extractFactText(message);
  if (text.length === 0) return undefined;

  return { category: category.choice, text };
}
