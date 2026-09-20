/**
 * The questions Milo asks Jev about a browser page (ADR-016). This file is the
 * decision layer -- the whole Milo-native value of browse. The driver clicks;
 * these five gates are the cheap, calibrated senses that tell it what it is
 * looking at, which element to touch, whether a wall needs a human, whether an
 * action is dangerous, and whether the last move worked.
 *
 * The wording follows `packages/core/src/router/questions.ts` and the fleet's
 * `questions.ts`: describe the thing being judged, not its prose, and grade a
 * COMPACT, CONTENT-FREE state -- a candidate list (role/label/testid/bbox), a
 * goal string, url and title. Never raw HTML, never a screenshot, never the
 * text typed into a field. Changing this wording changes what the loop does;
 * re-check `gates.test.ts` after any edit.
 */

import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion } from "@milo/core";
import type { ElementCandidate, PageKind } from "./types.js";

// --- 1. observe: what kind of page is this --------------------------------

export const OBSERVE_KEYS = ["page_kind"] as const;

const PAGE_KIND_CRITERIA: Record<PageKind, string> = {
  login:
    "A sign-in or authentication page: username/email and password fields, an SSO button, or a 'sign in' / 'log in' prompt. The page's purpose is to prove who the user is.",
  form:
    "A data-entry page that is not a login: several inputs to fill and a submit, a checkout, an application, a settings pane the user is editing.",
  dashboard:
    "A landed, authenticated home or console: navigation, panels, tables, or account state on show, with actions to launch from. The user has arrived somewhere and can now do things.",
  result:
    "A page that presents the outcome of an action just taken: a confirmation, a receipt, a success message, a finished export or report, a search result set.",
  error:
    "The page reports that something went wrong: a 4xx/5xx page, a validation failure, an access-denied notice, a broken or empty state.",
  captcha:
    "A challenge the page uses to prove the visitor is human: a reCAPTCHA/hCaptcha widget, an image or puzzle challenge, a 'verify you are human' interstitial.",
  consent:
    "A wall demanding agreement before proceeding: a cookie/GDPR banner blocking the page, a terms-of-service acceptance, an age gate, a permissions prompt.",
  other:
    "None of the above fits: a plain content or marketing page, a document, or a page whose kind is not clear from the candidates.",
};

export const pageKindQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "Below is a browser page described only by its url, its title, and a compact list of its actionable elements (each with an accessibility role and a short label). No page body is included. Classify what kind of page this is, from the elements and title alone. Judge the page's purpose, not how many elements it has.",
  criteria: PAGE_KIND_CRITERIA,
};

export const OBSERVE_QUESTIONS: Record<string, JevQuestion> = {
  page_kind: pageKindQuestion,
};

// --- 2. locate: which element best serves the goal ------------------------

export const LOCATE_KEYS = ["element"] as const;

/** The reserved choice meaning "no listed element matches the goal". */
export const NONE_CHOICE = "__none__";

const LOCATE_INSTRUCTIONS =
  "You are helping an automation reach a goal on a web page. Below is the goal in plain language and a compact list of the page's actionable elements, each keyed by an opaque id and described by its role and short label. Choose the single element the automation should act on next to make progress toward the goal. Choose the reserved 'none' option if no listed element plausibly advances the goal -- it is better to abstain than to guess, because a wrong click is expensive. Judge fit to the goal, not label wording.";

/**
 * Build the `locate` choice over a specific candidate list. The choices are the
 * candidate ids plus a reserved 'none'; each id's criterion is the element's
 * role and label -- content-free. A low-confidence or 'none' answer is what the
 * loop escalates on, so the caller can hand control back to a person.
 */
export function buildLocateQuestion(candidates: readonly ElementCandidate[]): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    const label = c.text !== undefined && c.text !== "" ? ` labelled "${c.text}"` : "";
    const testid = c.testid !== undefined && c.testid !== "" ? ` (testid ${c.testid})` : "";
    criteria[c.ref] = `A ${c.role}${label}${testid}.`;
  }
  criteria[NONE_CHOICE] = "No listed element plausibly advances the goal; the automation should abstain.";
  return { type: "choice", instructions: LOCATE_INSTRUCTIONS, criteria };
}

// --- 3. verify: did the action achieve intent -----------------------------

export const VERIFY_KEYS = ["succeeded"] as const;

export const succeededQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "An automation just took one action on a web page toward a goal. Below is a description of the action it intended (its kind and the element's role and label -- never any text it typed), plus a content-free before/after summary of the page (url, title, element roles). Did the action achieve what it intended?",
  criteria: {
    true: "The page changed in a way consistent with the intended action succeeding: a new page or state was reached, the target element's effect is visible in the after-summary, or the flow advanced as intended.",
    false: "The action did not take effect, or left the page essentially unchanged, or produced an error or the same state -- the intent was not achieved and the automation should retry or escalate.",
  },
};

export const VERIFY_QUESTIONS: Record<string, JevQuestion> = {
  succeeded: succeededQuestion,
};

// --- 4. gate: is this a wall only a human can clear -----------------------

export const GATE_KEYS = ["human_gate"] as const;

export const humanGateQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Below is a content-free description of a web page (url, title, element roles and labels). Is this a wall that only a human can clear before the automation can continue -- a captcha or bot challenge, a two-factor / one-time-code prompt, or a consent/permission barrier blocking the flow? Answer for whether automation is blocked here, not for whether the page is merely a login the automation could fill itself.",
  criteria: {
    true: "The page presents a human-verification or explicit-consent barrier: a captcha or 'prove you are human' challenge, a 2FA/OTP entry the automation has no code for, or a consent/authorization wall that requires a person's agreement to pass.",
    false: "The page is an ordinary step the automation can handle: a normal form or login, a dashboard, a result, or content -- nothing that structurally requires a human to proceed.",
  },
};

export const GATE_QUESTIONS: Record<string, JevQuestion> = {
  human_gate: humanGateQuestion,
};

// --- 5. sensitive: does this action need human confirmation ---------------

export const SENSITIVE_KEYS = ["sensitive"] as const;

export const sensitiveQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "An automation is about to act on one element to pursue a goal. Below is the goal and a content-free description of the element (role and label). Is this action irreversible, money-moving, or destructive enough that a human must confirm it before it happens? Judge the consequence of the action, not how the label is phrased.",
  criteria: {
    true: "The action would move money, send or publish something irrevocably, delete or overwrite data, change security or access settings, or otherwise be hard or impossible to undo: pay, transfer, place an order, confirm, delete, deactivate, revoke, send.",
    false: "The action is safe and reversible: navigating, reading, searching, filtering, opening a menu, filling a field, or any step whose effect can be undone or that commits nothing on its own.",
  },
};

export const SENSITIVE_QUESTIONS: Record<string, JevQuestion> = {
  sensitive: sensitiveQuestion,
};
