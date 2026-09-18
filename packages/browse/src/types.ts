/**
 * The Milo browse vocabulary (ADR-016). Strict terms, used everywhere:
 *
 *   - goal        one plain-language objective the caller hands the loop
 *   - driver      the pluggable muscle that actually observes and acts on a page
 *   - candidate   one actionable element on the page, described content-free
 *   - observation a page reduced to url + title + a candidate list (never HTML)
 *   - gate        one Jev classification over a content-free state (the senses)
 *   - trace       the content-free record of what the loop decided and did
 *
 * Milo's contribution is the gate layer -- the cheap, calibrated senses. The
 * clicking is the driver's job (ADR-016). Nothing in this vocabulary implies
 * Milo ships or forks a browser.
 */

/**
 * The page kinds `observe` classifies a page into. Deliberately coarse: the
 * loop routes on the kind (is this a wall to pause on, a result to stop on),
 * it does not need a fine taxonomy.
 */
export const PAGE_KINDS = [
  "login",
  "form",
  "dashboard",
  "result",
  "error",
  "captcha",
  "consent",
  "other",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** A rectangle in CSS pixels. Layout, not content. */
export type BBox = { x: number; y: number; width: number; height: number };

/**
 * One actionable element, described content-free. This is the ONLY shape the
 * driver hands up and the ONLY element shape any Jev gate ever sees:
 *
 *   - `ref`    an opaque, stable handle the driver resolves back to a real
 *              element for `click`/`type`. Not page content.
 *   - `role`   the element's accessibility role (button, link, textbox, ...).
 *   - `text`   the element's short accessible label ("Sign in", "Export"),
 *              never its raw innerHTML and never a field's typed value.
 *   - `testid` an optional stable test id, used to match caller-supplied input
 *              values to fields without inventing or logging the values.
 *   - `bbox`   optional layout box, for a driver that locates by geometry.
 *
 * There is no `html` and no `screenshot` field by construction: a driver cannot
 * smuggle raw markup or pixels into a gate through this type.
 */
export type ElementCandidate = {
  ref: string;
  role: string;
  text?: string;
  testid?: string;
  bbox?: BBox;
};

/**
 * A page reduced to what a gate can reason over: its url, its title, and the
 * candidate list. NEVER the DOM, NEVER a screenshot. The driver is responsible
 * for producing this reduction; the gates only ever see this.
 */
export type PageObservation = {
  url: string;
  title: string;
  elements: ElementCandidate[];
};

/** The four things a driver can be asked to do. */
export const BROWSE_ACTION_KINDS = ["navigate", "click", "type", "readback"] as const;
export type BrowseActionKind = (typeof BROWSE_ACTION_KINDS)[number];

/**
 * A content-free description of the action the loop intends, handed to `verify`
 * so it can judge whether the action achieved intent. It carries the element's
 * ref, role, and label -- NEVER the text typed into a field, because that text
 * may be a credential and never reaches a gate or the trace.
 */
export type IntendedAction = {
  kind: BrowseActionKind;
  ref?: string;
  role?: string;
  label?: string;
};

/** Why the loop stopped without finishing: an escalation for the caller. */
export const ESCALATION_REASONS = ["low_confidence", "no_candidate", "verify_failed"] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** Why the loop paused for a person rather than escalating. */
export const NEEDS_HUMAN_REASONS = ["gate", "sensitive"] as const;
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];

/** How a browse task ended. */
export const BROWSE_STATUSES = ["done", "needs_human", "escalated", "max_steps"] as const;
export type BrowseStatus = (typeof BROWSE_STATUSES)[number];

/**
 * One step of the content-free trace. Every field is a decision, a confidence,
 * or an opaque ref -- never a url, an element label, or a typed value. This is
 * what keeps credentials and page content out of the record entirely.
 */
export type BrowseStep = {
  step: number;
  /** The page-kind `observe` returned, and how sure it was. */
  pageKind: PageKind;
  observeConfidence: number;
  /** The `gate` verdict: is this a wall a human must clear. */
  gateBlocked: boolean;
  gateProbability: number;
  /** Which candidate `locate` chose (opaque ref only) and its confidence. */
  located?: { ref: string; confidence: number };
  /** The `sensitive` verdict on the chosen candidate. */
  sensitive?: { flagged: boolean; probability: number };
  /** The action taken -- kind and target ref only, NEVER the typed text. */
  action?: { kind: BrowseActionKind; ref?: string };
  /** The `verify` verdict on the action. */
  verify?: { success: boolean; confidence: number };
  /** How many times the action was retried after a failed verify. */
  retries?: number;
  /** Set on the step where the loop escalated. */
  escalation?: EscalationReason;
};

export type BrowseTrace = BrowseStep[];

/** The result the caller reads back. Content-free throughout. */
export type BrowseResult = {
  status: BrowseStatus;
  /** How many loop iterations ran. */
  steps: number;
  trace: BrowseTrace;
  /** Present when `status` is `needs_human`. */
  needsHuman?: { reason: NeedsHumanReason; step: number };
  /** Present when `status` is `escalated`. */
  escalation?: { reason: EscalationReason; step: number };
};
