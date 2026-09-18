/**
 * Fact capture resolution (ADR-017): the pure `resolveFactCapture` and the
 * deterministic text lift, classification-only, with a confidence floor.
 */

import { describe, expect, it } from "vitest";
import type { JevAnswer } from "../jev/types.js";
import {
  FACT_CATEGORY_KEY,
  FACT_STATED_KEY,
  extractFactText,
  latestUserText,
  resolveFactCapture,
} from "./capture.js";

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}
function choice(name: string, confidence: number): JevAnswer {
  return { type: "choice", choice: name, confidence, probabilities: { [name]: confidence } };
}

const MESSAGE = "Remember that my deploy account is acct_4Q7 on the west cluster";

describe("extractFactText", () => {
  it("lifts the clause after an explicit remember/note frame", () => {
    expect(extractFactText("remember that my staging box is 10.2.0.7")).toBe("my staging box is 10.2.0.7");
    expect(extractFactText("Please note: we always spell it gray")).toBe("we always spell it gray");
    expect(extractFactText("FYI my co-founder is Dana")).toBe("my co-founder is Dana");
  });
  it("keeps the whole turn when there is no frame", () => {
    expect(extractFactText("my timezone is CET")).toBe("my timezone is CET");
  });
});

describe("latestUserText", () => {
  it("returns the newest user turn with text", () => {
    expect(
      latestUserText([
        { role: "user", content: "old" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "newest" },
      ]),
    ).toBe("newest");
  });
});

describe("resolveFactCapture", () => {
  it("resolves category and lifted text when detection and category clear their floors", () => {
    const answers: Record<string, JevAnswer> = {
      [FACT_STATED_KEY]: noul(0.9),
      [FACT_CATEGORY_KEY]: choice("identifier", 0.8),
    };
    expect(resolveFactCapture(answers, MESSAGE)).toEqual({
      category: "identifier",
      text: "my deploy account is acct_4Q7 on the west cluster",
    });
  });

  it("resolves category correction with the text lifted from the user's message, never Jev-generated", () => {
    // A bare "stop/always" coding correction: no remember/note frame, so the
    // whole turn is the fact text -- and it is the user's words, not Jev's.
    const message = "stop using var, always use const";
    const answers: Record<string, JevAnswer> = {
      [FACT_STATED_KEY]: noul(0.9),
      [FACT_CATEGORY_KEY]: choice("correction", 0.85),
    };
    expect(resolveFactCapture(answers, message)).toEqual({
      category: "correction",
      text: "stop using var, always use const",
    });
  });

  it("drops a weak detection (noul below the floor)", () => {
    const answers: Record<string, JevAnswer> = {
      [FACT_STATED_KEY]: noul(0.5),
      [FACT_CATEGORY_KEY]: choice("identifier", 0.9),
    };
    expect(resolveFactCapture(answers, MESSAGE)).toBeUndefined();
  });

  it("drops a shrug category and a low-confidence category", () => {
    expect(
      resolveFactCapture({ [FACT_STATED_KEY]: noul(0.95), [FACT_CATEGORY_KEY]: choice("none", 0.99) }, MESSAGE),
    ).toBeUndefined();
    expect(
      resolveFactCapture({ [FACT_STATED_KEY]: noul(0.95), [FACT_CATEGORY_KEY]: choice("address", 0.2) }, MESSAGE),
    ).toBeUndefined();
  });

  it("returns undefined on missing or malformed answers rather than throwing", () => {
    expect(resolveFactCapture(undefined, MESSAGE)).toBeUndefined();
    expect(resolveFactCapture({}, MESSAGE)).toBeUndefined();
    expect(
      resolveFactCapture({ [FACT_STATED_KEY]: noul(0.9), [FACT_CATEGORY_KEY]: choice("identifier", 0.9) }, "   "),
    ).toBeUndefined();
  });
});
