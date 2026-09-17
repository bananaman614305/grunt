import { describe, expect, it } from "vitest";
import type { Roster } from "../types.js";
import { DEFAULT_ROSTER } from "../types.js";
import { resolveModel, tierSearchOrder } from "./roster.js";

const ROSTER: Roster = {
  fast: ["fast-a", "fast-b"],
  mid: ["mid-a", "mid-b"],
  frontier: ["frontier-a"],
};

describe("tierSearchOrder", () => {
  it("tries the tier, then up, then down", () => {
    expect(tierSearchOrder("fast")).toEqual(["fast", "mid", "frontier"]);
    expect(tierSearchOrder("mid")).toEqual(["mid", "frontier", "fast"]);
    expect(tierSearchOrder("frontier")).toEqual(["frontier", "mid", "fast"]);
  });
});

describe("resolveModel", () => {
  it("takes the first entry for the tier", () => {
    expect(resolveModel("fast", ROSTER)).toBe("fast-a");
    expect(resolveModel("mid", ROSTER)).toBe("mid-a");
    expect(resolveModel("frontier", ROSTER)).toBe("frontier-a");
  });

  it("uses the default roster the gateway ships", () => {
    expect(resolveModel("fast", DEFAULT_ROSTER)).toBe("deepseek/deepseek-v4-flash");
    expect(resolveModel("mid", DEFAULT_ROSTER)).toBe("openai/gpt-5.6-luna");
    expect(resolveModel("frontier", DEFAULT_ROSTER)).toBe("z-ai/glm-5.3");
  });

  it("restricts the roster to the request's candidates", () => {
    expect(resolveModel("fast", ROSTER, ["fast-b", "mid-a"])).toBe("fast-b");
    expect(resolveModel("mid", ROSTER, ["mid-b"])).toBe("mid-b");
  });

  it("ignores an empty candidates list rather than eliminating every model", () => {
    expect(resolveModel("fast", ROSTER, [])).toBe("fast-a");
  });

  it("falls back to the next tier up when candidates rule out the whole tier", () => {
    expect(resolveModel("fast", ROSTER, ["mid-b"])).toBe("mid-b");
  });

  it("falls back downwards once there is no higher tier left", () => {
    expect(resolveModel("frontier", ROSTER, ["fast-b"])).toBe("fast-b");
    expect(resolveModel("mid", ROSTER, ["fast-a"])).toBe("fast-a");
  });

  it("prefers up over down when both would work", () => {
    expect(resolveModel("mid", ROSTER, ["fast-a", "frontier-a"])).toBe("frontier-a");
  });

  it("skips small-output models when long_output is at or above 0.7", () => {
    const opts = { longOutput: 0.7, smallOutputModels: ["fast-a"] };
    expect(resolveModel("fast", ROSTER, undefined, opts)).toBe("fast-b");
  });

  it("keeps small-output models when long_output is below 0.7", () => {
    const opts = { longOutput: 0.69, smallOutputModels: ["fast-a"] };
    expect(resolveModel("fast", ROSTER, undefined, opts)).toBe("fast-a");
  });

  it("falls back a tier when long_output excludes every model in it", () => {
    const opts = { longOutput: 0.95, smallOutputModels: ["fast-a", "fast-b"] };
    expect(resolveModel("fast", ROSTER, undefined, opts)).toBe("mid-a");
  });

  it("applies candidates and the long-output exclusion together", () => {
    const opts = { longOutput: 0.9, smallOutputModels: ["mid-a"] };
    expect(resolveModel("mid", ROSTER, ["mid-a", "mid-b"], opts)).toBe("mid-b");
  });

  it("excludes nothing by default for a roster of unknown models", () => {
    expect(resolveModel("fast", ROSTER, undefined, { longOutput: 1 })).toBe("fast-a");
  });

  describe("the default roster's own max-output data", () => {
    it("skips a default-roster model whose max output is below 64k", () => {
      const candidates = ["google/gemini-3.8-flash", "tencent/hy4-preview"];
      // hy4-preview caps at 64,000 and gemini-3.8-flash at 65,536, so only
      // one of them can hold a long answer.
      expect(resolveModel("frontier", DEFAULT_ROSTER, candidates, { longOutput: 0.9 })).toBe(
        "google/gemini-3.8-flash",
      );
      expect(resolveModel("frontier", DEFAULT_ROSTER, candidates, { longOutput: 0.1 })).toBe(
        "google/gemini-3.8-flash",
      );
      // The exclusion is absolute: with only the short one allowed, there is
      // nothing eligible anywhere and the caller hears about it rather than
      // getting a truncated answer.
      expect(() =>
        resolveModel("frontier", DEFAULT_ROSTER, ["tencent/hy4-preview"], { longOutput: 0.9 }),
      ).toThrow(/no eligible model for tier frontier/);
    });

    it("keeps every large-output default eligible at any long_output", () => {
      for (const longOutput of [0, 0.69, 0.7, 1]) {
        expect(resolveModel("fast", DEFAULT_ROSTER, undefined, { longOutput })).toBe(
          "deepseek/deepseek-v4-flash",
        );
        expect(resolveModel("mid", DEFAULT_ROSTER, undefined, { longOutput })).toBe("openai/gpt-5.6-luna");
        expect(resolveModel("frontier", DEFAULT_ROSTER, undefined, { longOutput })).toBe("z-ai/glm-5.3");
      }
    });

    it("drops a small-output model from its tier once the answer will be long", () => {
      const candidates = ["nvidia/nemotron-3-ultra-550b-a55b", "z-ai/glm-5.3"];
      expect(resolveModel("frontier", DEFAULT_ROSTER, candidates, { longOutput: 0.7 })).toBe("z-ai/glm-5.3");
      expect(
        resolveModel("frontier", DEFAULT_ROSTER, ["nvidia/nemotron-3-ultra-550b-a55b", "tencent/hy3"], {
          longOutput: 0.7,
        }),
      ).toBe("tencent/hy3");
    });
  });

  it("throws only when nothing is eligible anywhere, and says why", () => {
    expect(() => resolveModel("mid", ROSTER, ["nothing-we-have"])).toThrow(/no eligible model for tier mid/);
    expect(() => resolveModel("mid", ROSTER, ["nothing-we-have"])).toThrow(/candidates \[nothing-we-have\]/);

    const empty: Roster = { fast: [], mid: [], frontier: [] };
    expect(() => resolveModel("frontier", empty)).toThrow(/no eligible model for tier frontier/);
  });
});
