/**
 * The relevance gate (ADR-017): the one Jev call that decides which stored
 * facts, if any, belong in *this* request, and the deterministic note the
 * relevant ones compile into.
 *
 * This gate is both controls at once. **Privacy:** a fact that is not relevant
 * never leaves the vault -- it is decrypted only to be judged, and if the
 * judge says no it is re-sealed and nothing reaches the model. **Cost:** input
 * tokens grow only on the requests a fact actually helps; the floor is one
 * Jev call per routed request when the caller has facts and injection is on.
 *
 * Everything here is pure and classification-only. `factRelevanceQuestions`
 * builds one noul per fact (the fact's text rides in the question, seen by
 * Jev -- Milo's own classifier -- never by the model unless selected);
 * `selectRelevantFacts` reads the nouls back above a floor; `compileFactNote`
 * turns the survivors into the single appended system note.
 */

import type { JevAnswer, JevNoulQuestion } from "../jev/types.js";
import type { FactCategory } from "./store.js";

/** The minimum a fact's relevance noul must reach to be injected. */
export const FACT_RELEVANCE_THRESHOLD = 0.6;

/** A fact as the gate sees it: an id, its category label, and its text. */
export type InjectableFact = {
  id: string;
  category: FactCategory;
  text: string;
};

/** The answer key a fact's relevance noul is filed under. Stable per fact id. */
export function relevanceKey(id: string): string {
  return `fact_relevant_${id}`;
}

/**
 * One noul per fact: "is this stored fact relevant to answering the latest
 * user turn?". The fact text is embedded in the question so Jev can judge it;
 * this is a call to Milo's own classifier, not to the model, so no fact leaks
 * to the model here -- only the ones this call selects are ever injected.
 */
export function factRelevanceQuestions(facts: InjectableFact[]): Record<string, JevNoulQuestion> {
  const questions: Record<string, JevNoulQuestion> = {};
  for (const fact of facts) {
    questions[relevanceKey(fact.id)] = {
      type: "noul",
      instructions:
        `Is the following stored fact about the user relevant and useful to answering the latest user turn? ` +
        `Fact (${fact.category}): ${fact.text}`,
      criteria: {
        true: "The fact would help answer the latest user turn -- it names something the turn is about or needs.",
        false: "The fact has no bearing on the latest user turn.",
      },
    };
  }
  return questions;
}

function readNoul(answer: JevAnswer | undefined): number | undefined {
  if (typeof answer !== "object" || answer === null || answer.type !== "noul") return undefined;
  const noul = (answer as { noul?: unknown }).noul;
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

/**
 * The facts whose relevance noul cleared `threshold`, in the order they were
 * given. A missing or malformed answer means "not relevant" -- the gate fails
 * closed, so an unreadable answer keeps a fact in the vault rather than
 * leaking it.
 */
export function selectRelevantFacts(
  answers: Record<string, JevAnswer> | undefined,
  facts: InjectableFact[],
  threshold: number = FACT_RELEVANCE_THRESHOLD,
): InjectableFact[] {
  if (answers === undefined) return [];
  return facts.filter((fact) => {
    const noul = readNoul(answers[relevanceKey(fact.id)]);
    return noul !== undefined && noul >= threshold;
  });
}

/** The longest fact note Milo will append, in characters. */
export const FACT_NOTE_CHAR_CAP = 1_600;

/**
 * The single system note the relevant facts compile into, or undefined when
 * none are relevant. Deterministic: a bulleted list under a fixed preamble,
 * each line the fact's category label and its text, capped so a large vault
 * cannot bloat a request. Appended alongside the ADR-011 brief; never an edit
 * to anything the client sent.
 */
export function compileFactNote(facts: InjectableFact[]): string | undefined {
  if (facts.length === 0) return undefined;
  const lines: string[] = [];
  for (const fact of facts) {
    const line = `- (${fact.category}) ${fact.text.replace(/\s+/g, " ").trim()}`;
    lines.push(line);
  }
  const body = lines.join("\n");
  const note =
    "The user has asked Milo to remember these facts, and they are relevant to this request. " +
    "Use them where they help; do not repeat them back unless asked.\n" +
    body;
  return note.length > FACT_NOTE_CHAR_CAP ? note.slice(0, FACT_NOTE_CHAR_CAP) : note;
}
