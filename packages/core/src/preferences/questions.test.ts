/**
 * The capture mapping (ADR-011): fixture-shaped Jev answers in, a capture
 * signal or candidate row out, with weak or malformed evidence dropped.
 */

import { describe, expect, it } from "vitest";
import type { JevAnswer } from "../jev/types.js";
import {
  CAPTURE_DETECTION_THRESHOLD,
  CAPTURE_QUESTIONS,
  CAPTURE_VALUE_CONFIDENCE_THRESHOLD,
  NO_PREFERENCE_FIELD,
  PREFERENCE_FIELD_KEY,
  PREFERENCE_SCOPE_KEY,
  PREFERENCE_STATED_KEY,
  PREFERENCE_VALUE_KEY,
  ROUTER_QUESTIONS_WITH_CAPTURE,
  detectCapture,
  preferenceFieldQuestion,
  resolutionQuestions,
  resolveCapture,
} from "./questions.js";
import { PREFERENCE_FIELDS, PREFERENCE_VALUES } from "./store.js";
import type { PreferenceField } from "./store.js";

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function choice(value: string, confidence: number): JevAnswer {
  return { type: "choice", choice: value, confidence, probabilities: { [value]: confidence } };
}

/** Fixture answers for a routing call where a verbosity preference is stated. */
const DETECTION_FIRED: Record<string, JevAnswer> = {
  [PREFERENCE_STATED_KEY]: noul(0.93),
  [PREFERENCE_FIELD_KEY]: choice("verbosity", 0.88),
};

const SIGNAL = { field: "verbosity", detection: 0.93, fieldConfidence: 0.88 } as const;

describe("question shapes", () => {
  it("rides the routing call: the merged set keeps every routing key and adds the two capture keys", () => {
    const keys = Object.keys(ROUTER_QUESTIONS_WITH_CAPTURE);
    for (const key of ["task_type", "difficulty", "needs_reasoning", "long_output"]) {
      expect(keys).toContain(key);
    }
    expect(keys).toContain(PREFERENCE_STATED_KEY);
    expect(keys).toContain(PREFERENCE_FIELD_KEY);
    expect(Object.keys(CAPTURE_QUESTIONS)).toHaveLength(2);
  });

  it('offers every field plus "none" in the detection choice', () => {
    const offered = Object.keys(preferenceFieldQuestion.criteria);
    for (const field of PREFERENCE_FIELDS) expect(offered).toContain(field);
    expect(offered).toContain(NO_PREFERENCE_FIELD);
  });

  it("resolution asks the value over exactly the field's closed vocabulary, plus scope", () => {
    for (const field of PREFERENCE_FIELDS) {
      const questions = resolutionQuestions(field);
      const value = questions[PREFERENCE_VALUE_KEY];
      expect(value?.type).toBe("choice");
      if (value?.type === "choice") {
        expect(Object.keys(value.criteria).sort()).toEqual([...PREFERENCE_VALUES[field]].sort());
      }
      expect(questions[PREFERENCE_SCOPE_KEY]?.type).toBe("choice");
    }
  });
});

describe("detectCapture", () => {
  it("fires on a confident detection with a real field", () => {
    expect(detectCapture(DETECTION_FIRED)).toEqual(SIGNAL);
  });

  it("stays silent below the detection threshold", () => {
    expect(
      detectCapture({
        ...DETECTION_FIRED,
        [PREFERENCE_STATED_KEY]: noul(CAPTURE_DETECTION_THRESHOLD - 0.01),
      }),
    ).toBeUndefined();
  });

  it('stays silent when the field choice is "none", unknown, or unconfident', () => {
    expect(
      detectCapture({ ...DETECTION_FIRED, [PREFERENCE_FIELD_KEY]: choice(NO_PREFERENCE_FIELD, 0.9) }),
    ).toBeUndefined();
    expect(
      detectCapture({ ...DETECTION_FIRED, [PREFERENCE_FIELD_KEY]: choice("mood", 0.9) }),
    ).toBeUndefined();
    expect(
      detectCapture({ ...DETECTION_FIRED, [PREFERENCE_FIELD_KEY]: choice("verbosity", 0.3) }),
    ).toBeUndefined();
  });

  it("never throws on malformed or missing answers", () => {
    expect(detectCapture(undefined)).toBeUndefined();
    expect(detectCapture({})).toBeUndefined();
    expect(
      detectCapture({
        [PREFERENCE_STATED_KEY]: choice("yes", 0.9), // wrong shape for a noul
        [PREFERENCE_FIELD_KEY]: noul(0.9), // wrong shape for a choice
      }),
    ).toBeUndefined();
  });
});

describe("resolveCapture", () => {
  const RESOLVED: Record<string, JevAnswer> = {
    [PREFERENCE_VALUE_KEY]: choice("concise", 0.82),
    [PREFERENCE_SCOPE_KEY]: choice("global", 0.9),
  };

  it("maps confident answers onto a candidate row", () => {
    expect(resolveCapture(RESOLVED, SIGNAL)).toEqual({
      field: "verbosity",
      scope: "global",
      value: "concise",
      // The weaker of detection (0.93) and value confidence (0.82).
      confidence: 0.82,
    });
  });

  it("takes the detection noul when it is the weaker link", () => {
    const weakDetection = { ...SIGNAL, detection: 0.71 };
    expect(resolveCapture(RESOLVED, weakDetection)?.confidence).toBe(0.71);
  });

  it("narrows scope to the routed task type on task_only, and falls back to global without one", () => {
    const taskScoped = { ...RESOLVED, [PREFERENCE_SCOPE_KEY]: choice("task_only", 0.8) };
    expect(resolveCapture(taskScoped, SIGNAL, { taskType: "review" })?.scope).toBe("review");
    expect(resolveCapture(taskScoped, SIGNAL)?.scope).toBe("global");
  });

  it("drops a value below the confidence threshold", () => {
    const weak = {
      ...RESOLVED,
      [PREFERENCE_VALUE_KEY]: choice("concise", CAPTURE_VALUE_CONFIDENCE_THRESHOLD - 0.01),
    };
    expect(resolveCapture(weak, SIGNAL)).toBeUndefined();
  });

  it("drops a value outside the field's vocabulary", () => {
    const alien = { ...RESOLVED, [PREFERENCE_VALUE_KEY]: choice("shakespearean", 0.99) };
    expect(resolveCapture(alien, SIGNAL)).toBeUndefined();
  });

  it("never throws on malformed or missing answers", () => {
    expect(resolveCapture(undefined, SIGNAL)).toBeUndefined();
    expect(resolveCapture({}, SIGNAL)).toBeUndefined();
    expect(resolveCapture({ [PREFERENCE_VALUE_KEY]: noul(1) }, SIGNAL)).toBeUndefined();
    expect(resolveCapture(RESOLVED, { ...SIGNAL, field: "mood" })).toBeUndefined();
  });
});

describe("capture for the new output-shaping fields", () => {
  // One representative (field, value) per newly added field: detection fires
  // on that field, resolution maps the fixture answer onto the right row.
  const cases: Array<{ field: PreferenceField; value: string }> = [
    { field: "tone", value: "direct" },
    { field: "working_style", value: "test_first" },
    { field: "change_autonomy", value: "ask_first" },
    { field: "verification_depth", value: "thorough" },
    { field: "explanation_style", value: "code_first" },
  ];

  for (const { field, value } of cases) {
    it(`detects and resolves ${field} -> ${value}`, () => {
      const signal = detectCapture({
        [PREFERENCE_STATED_KEY]: noul(0.9),
        [PREFERENCE_FIELD_KEY]: choice(field, 0.85),
      });
      expect(signal).toEqual({ field, detection: 0.9, fieldConfidence: 0.85 });

      // The resolution value must be a member of exactly this field's vocab.
      expect(PREFERENCE_VALUES[field]).toContain(value);
      const resolved = resolveCapture(
        {
          [PREFERENCE_VALUE_KEY]: choice(value, 0.8),
          [PREFERENCE_SCOPE_KEY]: choice("global", 0.9),
        },
        signal!,
      );
      expect(resolved).toEqual({ field, scope: "global", value, confidence: 0.8 });
    });
  }
});
