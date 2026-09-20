/**
 * The relevance gate (ADR-017): the cost AND privacy control. These tests pin
 * the claim the ADR sells -- a relevant fact is injected, an irrelevant fact
 * is NOT -- so an irrelevant fact never reaches the model and never grows the
 * prompt.
 */

import { describe, expect, it } from "vitest";
import type { JevAnswer } from "../jev/types.js";
import {
  compileFactNote,
  factRelevanceQuestions,
  relevanceKey,
  selectRelevantFacts,
} from "./inject.js";
import type { InjectableFact } from "./inject.js";

const FACTS: InjectableFact[] = [
  { id: "f_addr", category: "address", text: "my staging box is 10.2.0.7" },
  { id: "f_person", category: "contact", text: "my co-founder is Dana, she owns billing" },
];

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

describe("factRelevanceQuestions", () => {
  it("asks one noul per fact, keyed by the fact id, carrying its text", () => {
    const q = factRelevanceQuestions(FACTS);
    expect(Object.keys(q)).toEqual([relevanceKey("f_addr"), relevanceKey("f_person")]);
    expect(q[relevanceKey("f_addr")]?.instructions).toContain("10.2.0.7");
  });
});

describe("selectRelevantFacts", () => {
  it("injects the relevant fact and NOT the irrelevant one", () => {
    // Jev says the staging-box fact is relevant, the co-founder fact is not.
    const answers: Record<string, JevAnswer> = {
      [relevanceKey("f_addr")]: noul(0.92),
      [relevanceKey("f_person")]: noul(0.05),
    };
    const relevant = selectRelevantFacts(answers, FACTS);
    expect(relevant.map((f) => f.id)).toEqual(["f_addr"]);

    const note = compileFactNote(relevant);
    expect(note).toContain("10.2.0.7"); // the relevant fact is in the note
    expect(note).not.toContain("Dana"); // the irrelevant fact is NOT
  });

  it("injects nothing when no fact clears the floor", () => {
    const answers: Record<string, JevAnswer> = {
      [relevanceKey("f_addr")]: noul(0.3),
      [relevanceKey("f_person")]: noul(0.1),
    };
    expect(selectRelevantFacts(answers, FACTS)).toEqual([]);
    expect(compileFactNote(selectRelevantFacts(answers, FACTS))).toBeUndefined();
  });

  it("fails closed: a missing or malformed answer keeps the fact in the vault", () => {
    expect(selectRelevantFacts({}, FACTS)).toEqual([]);
    expect(selectRelevantFacts(undefined, FACTS)).toEqual([]);
  });
});

describe("a stored correction rides the same relevance gate", () => {
  // A JS anti-pattern correction. It must be injected on a relevant JS task and
  // withheld on an unrelated one -- so a Python task never sees a JS correction,
  // exactly as ADR-017 promises corrections/conventions ride the gate unchanged.
  const CORRECTION: InjectableFact = {
    id: "f_corr",
    category: "correction",
    text: "stop using var, always use const",
  };

  it("injects the correction on a relevant coding request", () => {
    // Jev judges the correction relevant to a JS refactor turn.
    const answers: Record<string, JevAnswer> = { [relevanceKey("f_corr")]: noul(0.9) };
    const relevant = selectRelevantFacts(answers, [CORRECTION]);
    expect(relevant.map((f) => f.id)).toEqual(["f_corr"]);
    expect(compileFactNote(relevant)).toContain("const");
  });

  it("does NOT inject the correction on an unrelated request", () => {
    // Jev judges the JS correction irrelevant (e.g. a Python task): withheld.
    const answers: Record<string, JevAnswer> = { [relevanceKey("f_corr")]: noul(0.1) };
    expect(selectRelevantFacts(answers, [CORRECTION])).toEqual([]);
    expect(compileFactNote(selectRelevantFacts(answers, [CORRECTION]))).toBeUndefined();
  });
});
