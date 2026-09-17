import { describe, expect, it } from "vitest";
import { choice, noul, score } from "./questions.js";

describe("questions", () => {
  it("noul without criteria omits the criteria key entirely", () => {
    const q = noul("Is this urgent?");
    expect(q).toEqual({ type: "noul", instructions: "Is this urgent?" });
    expect("criteria" in q).toBe(false);
  });

  it("noul with criteria includes it", () => {
    const q = noul("Is this urgent?", { true: "Needs same-day response", false: "Can wait" });
    expect(q).toEqual({
      type: "noul",
      instructions: "Is this urgent?",
      criteria: { true: "Needs same-day response", false: "Can wait" },
    });
  });

  it("choice carries instructions and criteria verbatim", () => {
    const q = choice("What is the tone?", { angry: "Upset or hostile", calm: null });
    expect(q).toEqual({
      type: "choice",
      instructions: "What is the tone?",
      criteria: { angry: "Upset or hostile", calm: null },
    });
  });

  it("score keeps the ordered rubric", () => {
    const q = score("How difficult?", ["trivial", "easy", "hard"]);
    expect(q).toEqual({
      type: "score",
      instructions: "How difficult?",
      criteria: ["trivial", "easy", "hard"],
    });
  });
});
