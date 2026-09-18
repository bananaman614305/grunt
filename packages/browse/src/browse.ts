/**
 * The browse task loop (ADR-016): drive a goal to completion through the gate
 * layer and a pluggable driver, or hand control back to a person.
 *
 * IMPORTANT framing (ADR-016, same philosophy as the fleet): this is a
 * CAPABILITY the frontier agent calls, not an agent of its own. The user's
 * frontier agent (or a fleet worker) decides what goal to pursue and stays in
 * charge; `runBrowseTask` is the muscle-plus-senses it delegates one bounded
 * objective to. Milo supplies the senses (the Jev gates); the driver supplies
 * the muscle; the caller supplies the judgment and any secret field values.
 *
 * Each loop step: observe the page, stop if the goal-kind is reached, pause if
 * a human wall gates it, locate the best element (escalate if unsure), pause if
 * the action is sensitive, act, and verify (retry once, then escalate). The
 * function is PURE over its injected `driver` and `jev`, so the whole loop is
 * fake-tested end to end with no browser and no network.
 *
 * It records a CONTENT-FREE trace: page-kinds, action kinds and opaque refs,
 * gate/sensitive verdicts, and confidences. Never a url, an element label, a
 * screenshot, or the text typed into a field.
 */

import type { JevClientLike } from "@milo/core";
import type { Driver } from "./driver.js";
import { gate, locate, observe, sensitive, verify, type VerifyResult } from "./gates.js";
import type {
  BrowseResult,
  BrowseStatus,
  BrowseStep,
  BrowseTrace,
  ElementCandidate,
  IntendedAction,
  NeedsHumanReason,
  PageKind,
} from "./types.js";

/** What the loop tells the caller when it pauses for a person. Content-free. */
export type NeedsHumanEvent = {
  reason: NeedsHumanReason;
  pageKind: PageKind;
  step: number;
  /** The opaque ref of the element in question, for a `sensitive` pause. */
  ref?: string;
};

export type BrowseTaskOptions = {
  driver: Driver;
  jev: JevClientLike;
  /** The plain-language objective. The only free text sent to a gate. */
  goal: string;
  /** Hard cap on loop iterations. */
  maxSteps: number;
  /** Called when the loop pauses for a human (a gate wall or a sensitive action). */
  onNeedsHuman?: (event: NeedsHumanEvent) => void | Promise<void>;
  /**
   * Field values for `type` actions, keyed by an element's testid (preferred)
   * or ref. Supplied by the caller out of band; NEVER sent to a gate and NEVER
   * written to the trace. Absent a value, an input element is clicked, not typed.
   */
  inputs?: Record<string, string>;
  /** A url to open before the first observation. */
  startUrl?: string;
  /** Locate confidence below this escalates instead of acting. Default 0.5. */
  minConfidence?: number;
  /** True means the observed page-kind satisfies the goal. Default: `result`. */
  doneWhen?: (kind: PageKind) => boolean;
  /** Retries of one action after a failed verify before escalating. Default 1. */
  maxRetries?: number;
  /** Budget passed to each Jev gate call, ms. */
  budgetMs?: number;
};

type PlannedAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string };

const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "input", "textfield"]);

/** The value the caller supplied for this input element, if any. */
function lookupInput(candidate: ElementCandidate, inputs: Record<string, string>): string | undefined {
  if (candidate.testid !== undefined) {
    const byTestid = inputs[candidate.testid];
    if (byTestid !== undefined) return byTestid;
  }
  return inputs[candidate.ref];
}

/**
 * Decide the one move to make on the located element: type a caller-supplied
 * value into an input, otherwise click. Milo never invents field values.
 */
function planAction(candidate: ElementCandidate, inputs: Record<string, string>): PlannedAction {
  if (INPUT_ROLES.has(candidate.role.toLowerCase())) {
    const value = lookupInput(candidate, inputs);
    if (value !== undefined) return { kind: "type", ref: candidate.ref, text: value };
  }
  return { kind: "click", ref: candidate.ref };
}

async function execute(driver: Driver, action: PlannedAction): Promise<void> {
  if (action.kind === "type") await driver.type(action.ref, action.text);
  else await driver.click(action.ref);
}

/**
 * Run one browse task. Returns how it ended (`done` / `needs_human` /
 * `escalated` / `max_steps`) and the content-free trace of every decision.
 */
export async function runBrowseTask(opts: BrowseTaskOptions): Promise<BrowseResult> {
  const { driver, jev, goal } = opts;
  const minConfidence = opts.minConfidence ?? 0.5;
  const maxRetries = opts.maxRetries ?? 1;
  const doneWhen = opts.doneWhen ?? ((k: PageKind) => k === "result");
  const gateOpts = opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {};
  const inputs = opts.inputs ?? {};
  const trace: BrowseTrace = [];

  let status: BrowseStatus = "max_steps";
  let needsHuman: BrowseResult["needsHuman"];
  let escalation: BrowseResult["escalation"];

  if (opts.startUrl !== undefined) await driver.navigate(opts.startUrl);

  for (let step = 0; step < opts.maxSteps; step++) {
    const obs = await driver.readback();
    const seen = await observe(jev, obs, gateOpts);
    const record: BrowseStep = {
      step,
      pageKind: seen.kind,
      observeConfidence: seen.confidence,
      gateBlocked: false,
      gateProbability: 0,
    };
    trace.push(record);

    if (doneWhen(seen.kind)) {
      status = "done";
      break;
    }

    const wall = await gate(jev, obs, gateOpts);
    record.gateBlocked = wall.blocked;
    record.gateProbability = wall.probability;
    if (wall.blocked) {
      status = "needs_human";
      needsHuman = { reason: "gate", step };
      await opts.onNeedsHuman?.({ reason: "gate", pageKind: seen.kind, step });
      break;
    }

    const found = await locate(jev, goal, obs.elements, gateOpts);
    if (!found.matched || found.ref === undefined) {
      record.escalation = "no_candidate";
      status = "escalated";
      escalation = { reason: "no_candidate", step };
      break;
    }
    record.located = { ref: found.ref, confidence: found.confidence };
    if (found.confidence < minConfidence) {
      record.escalation = "low_confidence";
      status = "escalated";
      escalation = { reason: "low_confidence", step };
      break;
    }

    const candidate = obs.elements.find((c) => c.ref === found.ref);
    if (candidate === undefined) {
      record.escalation = "no_candidate";
      status = "escalated";
      escalation = { reason: "no_candidate", step };
      break;
    }

    const danger = await sensitive(jev, goal, candidate, gateOpts);
    record.sensitive = { flagged: danger.flagged, probability: danger.probability };
    if (danger.flagged) {
      status = "needs_human";
      needsHuman = { reason: "sensitive", step };
      await opts.onNeedsHuman?.({ reason: "sensitive", pageKind: seen.kind, step, ref: candidate.ref });
      break;
    }

    const action = planAction(candidate, inputs);
    const intended: IntendedAction = {
      kind: action.kind,
      ref: candidate.ref,
      role: candidate.role,
      ...(candidate.text !== undefined ? { label: candidate.text } : {}),
    };
    record.action = { kind: action.kind, ref: candidate.ref };

    let retries = 0;
    let verified: VerifyResult = { success: false, confidence: 0 };
    for (;;) {
      await execute(driver, action);
      const after = await driver.readback();
      verified = await verify(jev, obs, after, intended, gateOpts);
      if (verified.success || retries >= maxRetries) break;
      retries += 1;
    }
    record.verify = { success: verified.success, confidence: verified.confidence };
    if (retries > 0) record.retries = retries;
    if (!verified.success) {
      record.escalation = "verify_failed";
      status = "escalated";
      escalation = { reason: "verify_failed", step };
      break;
    }
  }

  const result: BrowseResult = { status, steps: trace.length, trace };
  if (needsHuman !== undefined) result.needsHuman = needsHuman;
  if (escalation !== undefined) result.escalation = escalation;
  return result;
}
