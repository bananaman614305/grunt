/**
 * Claim extraction (ADR-019): pull the load-bearing, CONFIDENT assertions out
 * of an agent's turn text, and -- just as importantly -- leave honest
 * uncertainty alone.
 *
 * This is deliberately mechanical and pure (no model, no I/O): the auditor
 * (Jev) does the judging; extraction only decides what is worth judging.
 * A sentence becomes a claim when it asserts something checkable against git
 * or receipts ("the tests pass", "I implemented the parser", "this is done")
 * AND is not hedged. Hedged or forward-looking sentences ("I think this is
 * right", "I'd need to benchmark it", "this should work", "next I will…") are
 * never claims, so a careful agent that flags its own uncertainty is never
 * penalised for it -- exactly the veritaserum rule that confident, unbacked
 * assertions are the only thing flagged.
 */

import type { Claim, ClaimCategory } from "./types.js";

/** A tiny deterministic hash (FNV-1a, 32-bit) as 8 hex chars. Pure, no deps. */
export function claimId(text: string): string {
  let h = 0x811c9dc5;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hedge and forward-looking markers. A sentence carrying any of these is NOT a
 * confident claim, so it is dropped whatever else it matches. This is the
 * "honest uncertainty is never flagged" guarantee, enforced at extraction.
 */
const HEDGE = new RegExp(
  [
    "\\bi think\\b",
    "\\bi believe\\b",
    "\\bi suspect\\b",
    "\\bi assume\\b",
    "\\bi'?d (?:need|have) to\\b",
    "\\bwould need to\\b",
    "\\bwe(?:'?d| would) need to\\b",
    "\\bneeds? (?:more )?(?:testing|verification|benchmark)",
    "\\bnot (?:sure|certain|verified|tested)\\b",
    "\\bunsure\\b",
    "\\buntested\\b",
    "\\bprobably\\b",
    "\\bpossibly\\b",
    "\\bperhaps\\b",
    "\\bmaybe\\b",
    "\\blikely\\b",
    "\\bmight\\b",
    "\\bmay\\b",
    "\\bcould\\b",
    "\\bshould\\b", // "should work" -- a prediction, not a claim
    "\\bseems? to\\b",
    "\\bappears? to\\b",
    "\\bi'?ll\\b",
    "\\bwe'?ll\\b",
    "\\bnext,?\\b",
    "\\bgoing to\\b",
    "\\bplan to\\b",
    "\\bwill (?:now |then )?(?:add|implement|write|run|check|verify|test|build|fix)",
  ].join("|"),
  "i",
);

/** Confident-assertion patterns per category. Order matters: first match wins. */
const CATEGORY_PATTERNS: Array<{ category: ClaimCategory; pattern: RegExp }> = [
  {
    category: "test",
    pattern:
      /\b(?:all |the )?tests?(?: suite)?\s+(?:now )?(?:pass(?:es|ing)?|are passing|is passing|are green|is green|succeed|went green)\b|\ball tests green\b|\btests? green\b|\b\d+\s+tests? pass(?:ing|ed)?\b/i,
  },
  {
    category: "build",
    pattern:
      /\b(?:the )?(?:build|compilation|type ?check(?:er|ing)?|tsc|lint(?:er|ing)?)\s+(?:now )?(?:pass(?:es)?|passed|succeed(?:s|ed)?|is clean|are clean|compiles?(?: cleanly)?|is green)\b|\b(?:builds?|compiles?|type ?checks?)\s+(?:cleanly|successfully|without (?:any )?errors)\b/i,
  },
  {
    category: "completion",
    pattern:
      /\b(?:this is|it'?s|that'?s|the (?:task|work|change|feature|fix|implementation) is)\s+(?:now )?(?:done|complete|completed|finished|ready(?: to (?:merge|ship))?)\b|\b(?:done|completed|finished) (?:it|this|the \w+)\b|\bready to (?:merge|ship)\b|\bfully (?:implemented|working)\b/i,
  },
  {
    category: "implementation",
    pattern:
      /\bi\s+(?:have\s+)?(?:implemented|added|created|wrote|written|built|refactored|updated|removed|deleted|fixed|resolved|migrated|renamed|replaced|wired(?: up)?)\b|\b(?:implemented|added|created|fixed|resolved) (?:the|a|an|support for)\b/i,
  },
];

/** Split a block of text into rough sentences for per-sentence judging. */
function sentences(text: string): string[] {
  return text
    // break on sentence punctuation, newlines, and list-item boundaries
    .split(/(?<=[.!?])\s+|\n+|(?:^|\s)[-*]\s+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Whether one sentence is a confident, checkable claim; its category if so. */
function categorize(sentence: string): ClaimCategory | undefined {
  if (sentence.includes("?")) return undefined; // a question asserts nothing
  if (HEDGE.test(sentence)) return undefined;
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(sentence)) return category;
  }
  return undefined;
}

/**
 * Extract the load-bearing claims from an agent's turn text. Returns at most
 * `max` claims (default 20), de-duplicated by normalized text, in the order
 * they appear. An empty or hedge-only turn yields no claims -- and no claims
 * means a clean, non-blocking verification, never a false alarm.
 */
export function extractClaims(turn: string, max = 20): Claim[] {
  const seen = new Set<string>();
  const claims: Claim[] = [];
  for (const sentence of sentences(turn)) {
    if (sentence.length > 400) continue; // a paragraph is not one claim
    const category = categorize(sentence);
    if (category === undefined) continue;
    const text = sentence.replace(/\s+/g, " ").trim();
    const id = claimId(text);
    if (seen.has(id)) continue;
    seen.add(id);
    claims.push({ id, text, category });
    if (claims.length >= max) break;
  }
  return claims;
}
