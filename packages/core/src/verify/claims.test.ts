import { describe, expect, it } from "vitest";
import { claimId, extractClaims } from "./claims.js";

describe("extractClaims", () => {
  it("extracts a confident test-pass claim", () => {
    const claims = extractClaims("I made the change. All tests pass now.");
    const test = claims.find((c) => c.category === "test");
    expect(test).toBeDefined();
    expect(test?.text).toContain("tests pass");
  });

  it("extracts implementation and completion claims", () => {
    const claims = extractClaims("I implemented the retry logic. The feature is done.");
    const categories = claims.map((c) => c.category);
    expect(categories).toContain("implementation");
    expect(categories).toContain("completion");
  });

  it("extracts a build claim", () => {
    const claims = extractClaims("The build passes and tsc is clean.");
    expect(claims.some((c) => c.category === "build")).toBe(true);
  });

  it("never flags honest uncertainty", () => {
    const hedged = [
      "I think the tests pass but I'd need to run them to be sure.",
      "This should work once wired up.",
      "The build probably compiles.",
      "I'll implement the parser next.",
      "This might be done.",
      "It seems to pass.",
      "We would need to benchmark this before claiming it is faster.",
    ];
    for (const line of hedged) {
      expect(extractClaims(line)).toEqual([]);
    }
  });

  it("does not treat a question as a claim", () => {
    expect(extractClaims("Do all tests pass?")).toEqual([]);
  });

  it("de-duplicates repeated claims and assigns stable ids", () => {
    const claims = extractClaims("All tests pass. All tests pass.");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe(claimId("All tests pass."));
  });

  it("returns nothing for an empty or claim-free turn", () => {
    expect(extractClaims("")).toEqual([]);
    expect(extractClaims("Here is some background on the problem domain.")).toEqual([]);
  });

  it("caps the number of claims", () => {
    const turn = Array.from({ length: 30 }, (_, i) => `I implemented feature number ${i} today.`).join(" ");
    expect(extractClaims(turn, 5)).toHaveLength(5);
  });

  it("pulls claims out of a markdown bullet list", () => {
    const turn = "Summary:\n- I added the endpoint.\n- All tests pass.\n- I might refactor later.";
    const claims = extractClaims(turn);
    expect(claims.some((c) => c.category === "implementation")).toBe(true);
    expect(claims.some((c) => c.category === "test")).toBe(true);
    // the hedged bullet is dropped
    expect(claims.every((c) => !/refactor later/i.test(c.text))).toBe(true);
  });
});

describe("claimId", () => {
  it("is stable under whitespace and case", () => {
    expect(claimId("All Tests   Pass")).toBe(claimId("all tests pass"));
  });
  it("differs for different claims", () => {
    expect(claimId("tests pass")).not.toBe(claimId("build passes"));
  });
});
