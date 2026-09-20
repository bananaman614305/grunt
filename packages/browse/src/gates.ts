/**
 * The Jev gate layer (ADR-016): the five senses, one pure function each, one
 * `/v1/systemone` call each. This is Milo's contribution to browser
 * automation -- cheap, calibrated classification over a content-free state.
 * The driver does the clicking; these decide what the clicking should be.
 *
 * Each function mirrors `packages/fleet/src/supervisor.ts`: build a
 * content-free state, send it with the matching question set from
 * `questions.ts`, and map Jev's answer to a small typed result with no
 * heuristic of its own -- so a fake Jev that grades the state makes fixtures
 * flow end-to-end and the mapping is trivially testable.
 *
 * INVARIANT (ADR-016): every state built here carries only a compact candidate
 * list (ref/role/label/testid/bbox), a goal string, url, and title. There is no
 * code path that puts raw HTML, a screenshot, or a typed field value into a
 * gate call -- `candidateSummary` is the only element serialiser and it has no
 * such fields to copy.
 */

import type { JevClientLike } from "@milo/core";
import {
  buildLocateQuestion,
  GATE_QUESTIONS,
  NONE_CHOICE,
  OBSERVE_QUESTIONS,
  SENSITIVE_QUESTIONS,
  VERIFY_QUESTIONS,
} from "./questions.js";
import type {
  ElementCandidate,
  IntendedAction,
  PageKind,
  PageObservation,
} from "./types.js";
import { PAGE_KINDS } from "./types.js";

/** Total budget for one gate call, ms. Same habit as the router's gate. */
export const GATE_BUDGET_MS = 8_000;

/** Options shared by every gate. */
export type GateOptions = { budgetMs?: number };

function isPageKind(value: string): value is PageKind {
  return (PAGE_KINDS as readonly string[]).includes(value);
}

/**
 * Reduce one element to the compact, content-free shape a gate sees. The ONLY
 * element serialiser in the package: role and short label, an opaque ref, an
 * optional testid and layout box. No innerHTML, no value, no screenshot.
 */
export function candidateSummary(c: ElementCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = { ref: c.ref, role: c.role };
  if (c.text !== undefined) out["label"] = c.text;
  if (c.testid !== undefined) out["testid"] = c.testid;
  if (c.bbox !== undefined) out["bbox"] = c.bbox;
  return out;
}

/** Reduce a page to the content-free state the observe/gate calls grade. */
export function observationState(obs: PageObservation): Record<string, unknown> {
  return {
    url: obs.url,
    title: obs.title,
    elements: obs.elements.map(candidateSummary),
  };
}

// --- 1. observe ------------------------------------------------------------

export type ObserveResult = { kind: PageKind; confidence: number };

/** Classify the page kind and how sure Jev is of it. */
export async function observe(
  jev: JevClientLike,
  obs: PageObservation,
  opts: GateOptions = {},
): Promise<ObserveResult> {
  const result = await jev.systemone(
    { state: observationState(obs), questions: OBSERVE_QUESTIONS },
    { budgetMs: opts.budgetMs ?? GATE_BUDGET_MS },
  );
  const ans = result.answers["page_kind"];
  if (ans?.type !== "choice" || !isPageKind(ans.choice)) {
    throw new Error("jev returned a page_kind answer of the wrong shape");
  }
  return { kind: ans.choice, confidence: ans.confidence };
}

// --- 2. locate -------------------------------------------------------------

export type LocateResult = { ref?: string; matched: boolean; confidence: number };

/**
 * Choose the candidate that best serves the goal. Returns `matched: false` with
 * a confidence when Jev abstains (`__none__`) or there are no candidates, so
 * the loop can escalate to a human instead of guessing.
 */
export async function locate(
  jev: JevClientLike,
  goal: string,
  candidates: readonly ElementCandidate[],
  opts: GateOptions = {},
): Promise<LocateResult> {
  if (candidates.length === 0) return { matched: false, confidence: 0 };
  const state: Record<string, unknown> = {
    goal,
    candidates: candidates.map(candidateSummary),
  };
  const result = await jev.systemone(
    { state, questions: { element: buildLocateQuestion(candidates) } },
    { budgetMs: opts.budgetMs ?? GATE_BUDGET_MS },
  );
  const ans = result.answers["element"];
  if (ans?.type !== "choice") {
    throw new Error("jev returned an element answer of the wrong shape");
  }
  if (ans.choice === NONE_CHOICE) return { matched: false, confidence: ans.confidence };
  if (!candidates.some((c) => c.ref === ans.choice)) {
    throw new Error("jev returned an unknown element ref");
  }
  return { matched: true, ref: ans.choice, confidence: ans.confidence };
}

// --- 3. verify -------------------------------------------------------------

export type VerifyResult = { success: boolean; confidence: number };

/**
 * Judge whether the action achieved intent. `intended` carries the action kind
 * and the element's role/label -- never the text typed into a field. Confidence
 * is how decisive the verdict is: `noul` when it says success, `1 - noul` when
 * it says failure.
 */
export async function verify(
  jev: JevClientLike,
  before: PageObservation,
  after: PageObservation,
  intended: IntendedAction,
  opts: GateOptions = {},
): Promise<VerifyResult> {
  const state: Record<string, unknown> = {
    intendedAction: { ...intended },
    before: observationState(before),
    after: observationState(after),
  };
  const result = await jev.systemone(
    { state, questions: VERIFY_QUESTIONS },
    { budgetMs: opts.budgetMs ?? GATE_BUDGET_MS },
  );
  const ans = result.answers["succeeded"];
  if (ans?.type !== "noul") {
    throw new Error("jev returned a succeeded answer of the wrong shape");
  }
  const success = ans.noul >= 0.5;
  return { success, confidence: success ? ans.noul : 1 - ans.noul };
}

// --- 4. gate ---------------------------------------------------------------

export type GateResult = { blocked: boolean; probability: number };

/** Is this a captcha / 2FA / consent wall a human must clear? */
export async function gate(
  jev: JevClientLike,
  obs: PageObservation,
  opts: GateOptions = {},
): Promise<GateResult> {
  const result = await jev.systemone(
    { state: observationState(obs), questions: GATE_QUESTIONS },
    { budgetMs: opts.budgetMs ?? GATE_BUDGET_MS },
  );
  const ans = result.answers["human_gate"];
  if (ans?.type !== "noul") {
    throw new Error("jev returned a human_gate answer of the wrong shape");
  }
  return { blocked: ans.noul >= 0.5, probability: ans.noul };
}

// --- 5. sensitive ----------------------------------------------------------

export type SensitiveResult = { flagged: boolean; probability: number };

/**
 * The safety gate: is acting on this candidate irreversible, money-moving, or
 * destructive enough to need a human's confirmation first?
 */
export async function sensitive(
  jev: JevClientLike,
  goal: string,
  candidate: ElementCandidate,
  opts: GateOptions = {},
): Promise<SensitiveResult> {
  const state: Record<string, unknown> = { goal, candidate: candidateSummary(candidate) };
  const result = await jev.systemone(
    { state, questions: SENSITIVE_QUESTIONS },
    { budgetMs: opts.budgetMs ?? GATE_BUDGET_MS },
  );
  const ans = result.answers["sensitive"];
  if (ans?.type !== "noul") {
    throw new Error("jev returned a sensitive answer of the wrong shape");
  }
  return { flagged: ans.noul >= 0.5, probability: ans.noul };
}
