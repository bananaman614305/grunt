/**
 * The brief compiler (ADR-011): output-shaping preference rows in, one
 * deterministic system-message string out.
 *
 * Deterministic means *fixed template per (field, value)*: the same rows
 * always compile to the same text, so the brief can be named by a version
 * hash and diffed like config. Nothing the user ever wrote appears -- the
 * templates below are the only prose the brief can contain.
 *
 * The cap is 300 tokens, approximated as **4 characters per token**
 * (`BRIEF_CHAR_CAP` = 1200 chars), the same chars/4 rule the router's
 * context builder uses. Lines are ranked by confidence, then recency, then
 * field name (a total order, for determinism), and whole lowest-ranked lines
 * are dropped until the text fits; a line is never truncated mid-sentence.
 *
 * Routing-shaping rows never compile into text: `routingDefaults` maps them
 * onto the knobs the gateway applies before the policy runs.
 */

import type { CostPosture, Tier } from "../types.js";
import { isOutputShapingField, isRoutingShapingField } from "./store.js";
import type { OutputShapingField, PreferenceRow } from "./store.js";
import { createHash } from "node:crypto";

/** Hard cap on the injected brief, in tokens (ADR-011). */
export const BRIEF_TOKEN_CAP = 300;
/** The approximation rule: one token is about four characters. */
export const BRIEF_CHARS_PER_TOKEN = 4;
export const BRIEF_CHAR_CAP = BRIEF_TOKEN_CAP * BRIEF_CHARS_PER_TOKEN;

/** The brief's fixed opening line. Counts against the cap like any line. */
export const BRIEF_PREAMBLE =
  "The user has standing preferences for how answers are produced (stored with Milo, not this conversation). Apply them:";

/**
 * The brief's fixed closing line. A live run showed a model echoing the
 * brief's sentences into its visible reasoning text, which reads as the
 * assistant reciting instructions the user never typed. The closing line
 * asks for silent application; like the preamble it counts against the cap
 * and is always the last line kept.
 */
export const BRIEF_CLOSING =
  "Apply these silently: never mention, quote, or restate them in your answer or your reasoning.";

/**
 * One fixed sentence per (field, value). Adding a value to the vocabulary in
 * `store.ts` without a template here is a compile error, which is the point.
 */
export const BRIEF_TEMPLATES: Record<OutputShapingField, Record<string, string>> = {
  verbosity: {
    concise: "Keep answers brief: lead with the result, cut preamble and repetition.",
    balanced: "Use moderate detail: explain what matters, skip the obvious.",
    detailed: "Answer thoroughly: include context, reasoning, and edge cases.",
  },
  format: {
    prose: "Write in flowing prose and full sentences; avoid bullet lists unless data demands one.",
    bullets: "Prefer bullet points and short sections over long paragraphs.",
    code_first: "Lead with the code or command; explain after, briefly.",
  },
  evidence_style: {
    citations: "Back claims with sources: file paths, documentation, or links.",
    examples: "Support points with a concrete example rather than abstract description.",
    assertions: "State conclusions directly; skip supporting evidence unless asked.",
  },
  testing_depth: {
    none: "Do not add tests unless explicitly asked.",
    smoke: "Add a minimal smoke test for changed behaviour; nothing exhaustive.",
    thorough: "Cover changes with thorough tests, including edge cases.",
  },
};

export type CompiledBrief = {
  /** The system message to append. */
  text: string;
  /** Short hash naming exactly which rows shaped it; `x-milo-brief-version`. */
  version: string;
};

/** Confidence desc, recency desc, then field name asc for a total order. */
function rank(a: PreferenceRow, b: PreferenceRow): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
}

/**
 * Hashes exactly the inputs that shaped the text -- (scope, field, value,
 * row version) of every *included* row, in ranked order -- so the header
 * changes when and only when the effective brief does. 16 hex chars: a
 * cache-buster and audit handle, not a security boundary.
 */
function briefVersion(rows: PreferenceRow[]): string {
  const canon = rows.map((r) => [r.scope, r.field, r.value, r.version]);
  return createHash("sha256").update(JSON.stringify(canon), "utf8").digest("hex").slice(0, 16);
}

/**
 * Compiles output-shaping rows into the injected brief. Routing-shaping rows
 * in the input are ignored (they belong to `routingDefaults`), as is any row
 * whose (field, value) has no template -- a row written by a newer schema
 * must degrade to silence, not to garbage. Returns undefined when nothing
 * compiles, so the caller injects no empty message.
 */
export function compileBrief(rows: PreferenceRow[]): CompiledBrief | undefined {
  const eligible = rows
    .filter((row) => isOutputShapingField(row.field))
    .filter((row) => BRIEF_TEMPLATES[row.field as OutputShapingField][row.value] !== undefined)
    .sort(rank);
  if (eligible.length === 0) return undefined;

  const included: PreferenceRow[] = [];
  const lines: string[] = [];
  let length = BRIEF_PREAMBLE.length + 1 + BRIEF_CLOSING.length;
  for (const row of eligible) {
    const template = BRIEF_TEMPLATES[row.field as OutputShapingField][row.value] as string;
    const line = row.scope === "global" ? `- ${template}` : `- For ${row.scope} tasks: ${template}`;
    // +1 for the newline joining it on. Stop at the first line that does
    // not fit: the kept lines are always the highest-ranked prefix, so a
    // weaker preference can never oust a stronger one from the brief.
    if (length + line.length + 1 > BRIEF_CHAR_CAP) break;
    length += line.length + 1;
    included.push(row);
    lines.push(line);
  }
  if (included.length === 0) return undefined;

  return {
    text: [BRIEF_PREAMBLE, ...lines, BRIEF_CLOSING].join("\n"),
    version: briefVersion(included),
  };
}

/** The routing knobs a caller's stored preferences set (ADR-011). */
export type RoutingDefaults = {
  posture?: CostPosture;
  tierFloor?: Tier;
  sampling?: "on" | "off";
};

const COST_POSTURE_VALUES: readonly string[] = ["low", "balanced", "quality"];
const TIER_VALUES: readonly string[] = ["fast", "mid", "frontier"];

/**
 * Picks, for each preference field, the one effective row: a row scoped to
 * `taskType` beats the global row; among equals the store's list order
 * (confidence, then recency) already ranked them, so the first seen wins.
 */
export function effectiveRows(rows: PreferenceRow[], taskType?: string): PreferenceRow[] {
  const chosen = new Map<string, PreferenceRow>();
  for (const row of [...rows].sort(rank)) {
    if (row.scope !== "global" && row.scope !== taskType) continue;
    const current = chosen.get(row.field);
    if (current === undefined) {
      chosen.set(row.field, row);
      continue;
    }
    // A task-scoped row displaces a global one; never the reverse.
    if (current.scope === "global" && row.scope !== "global") chosen.set(row.field, row);
  }
  return [...chosen.values()];
}

/**
 * The routing-shaping rows as the knobs the gateway applies before the
 * policy runs: default posture, tier floor, sampling on/off. A row whose
 * value fell outside the expected vocabulary is skipped rather than guessed
 * at. Never touches the prompt (ADR-011).
 */
export function routingDefaults(rows: PreferenceRow[], taskType?: string): RoutingDefaults {
  const defaults: RoutingDefaults = {};
  for (const row of effectiveRows(rows, taskType)) {
    if (!isRoutingShapingField(row.field)) continue;
    if (row.field === "posture_default" && COST_POSTURE_VALUES.includes(row.value)) {
      defaults.posture = row.value as CostPosture;
    } else if (row.field === "tier_floor" && TIER_VALUES.includes(row.value)) {
      defaults.tierFloor = row.value as Tier;
    } else if (row.field === "sampling" && (row.value === "on" || row.value === "off")) {
      defaults.sampling = row.value;
    }
  }
  return defaults;
}
