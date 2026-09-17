import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER_INFO } from "./roster-default.js";
import { describeRoster, isDemoted, tierByPrice, tierForPrice } from "./roster-from-models.js";
import type { PricedModel } from "./roster-from-models.js";

const BANDS = DEFAULT_ROSTER_INFO.bands;

function model(id: string, outputUsdPerM: number, extra: Partial<PricedModel> = {}): PricedModel {
  return { id, outputUsdPerM, ...extra };
}

describe("tierForPrice", () => {
  it("cuts on the same bands the default roster uses", () => {
    expect(BANDS.fast.maxOutputUsdPerM).toBe(0.35);
    expect(BANDS.mid.maxOutputUsdPerM).toBe(1.5);
    expect(BANDS.frontier.maxOutputUsdPerM).toBe(5);

    expect(tierForPrice(0)).toBe("fast");
    expect(tierForPrice(0.14)).toBe("fast");
    expect(tierForPrice(0.35)).toBe("fast"); // "at most", so the edge is in
    expect(tierForPrice(0.36)).toBe("mid");
    expect(tierForPrice(1.5)).toBe("mid");
    expect(tierForPrice(1.51)).toBe("frontier");
    expect(tierForPrice(5)).toBe("frontier");
  });

  it("puts a model above the top band on frontier rather than dropping it", () => {
    // The default-roster rule rejects anything at or above $5/M. A user who
    // names Opus chose it, so it lands on frontier instead (ADR-007).
    expect(tierForPrice(75)).toBe("frontier");
  });

  it("treats an unreadable price as expensive", () => {
    expect(tierForPrice(Number.NaN)).toBe("frontier");
    expect(tierForPrice(Number.POSITIVE_INFINITY)).toBe("frontier");
  });

  it("takes custom bands", () => {
    const rules = {
      fast: { maxOutputUsdPerM: 1 },
      mid: { maxOutputUsdPerM: 2 },
      frontier: { maxOutputUsdPerM: 3 },
    };
    expect(tierForPrice(0.9, rules)).toBe("fast");
    expect(tierForPrice(1.9, rules)).toBe("mid");
    expect(tierForPrice(2.9, rules)).toBe("frontier");
  });
});

describe("isDemoted", () => {
  it("demotes a model that cannot hold a long answer", () => {
    expect(isDemoted(model("a", 1, { maxOutputTokens: 32_768 }))).toBe(true);
    expect(isDemoted(model("a", 1, { maxOutputTokens: 64_000 }))).toBe(false);
    expect(isDemoted(model("a", 1))).toBe(false);
  });

  it("demotes a model that cannot call a tool", () => {
    expect(isDemoted(model("a", 1, { supportsTools: false }))).toBe(true);
    expect(isDemoted(model("a", 1, { supportsTools: true }))).toBe(false);
  });
});

describe("tierByPrice", () => {
  it("assigns each model to the tier its output price falls in", () => {
    const roster = tierByPrice([
      model("cheap/one", 0.14),
      model("mid/one", 1.2),
      model("top/one", 4.4),
      model("cheap/two", 0.3),
    ]);

    expect(roster).toEqual({
      fast: ["cheap/one", "cheap/two"],
      mid: ["mid/one"],
      frontier: ["top/one"],
    });
  });

  it("keeps the user's order inside a tier", () => {
    const roster = tierByPrice([model("b", 0.2), model("a", 0.1), model("c", 0.3)]);
    expect(roster.fast).toEqual(["b", "a", "c"]);
  });

  it("sorts small-output models last in their tier, in their own order", () => {
    const roster = tierByPrice([
      model("short/one", 0.2, { maxOutputTokens: 8_000 }),
      model("long/one", 0.2, { maxOutputTokens: 128_000 }),
      model("short/two", 0.2, { maxOutputTokens: 4_000 }),
      model("long/two", 0.2),
    ]);
    expect(roster.fast).toEqual(["long/one", "long/two", "short/one", "short/two"]);
  });

  it("sorts a tool-less model last too", () => {
    const roster = tierByPrice([
      model("no-tools", 2, { supportsTools: false }),
      model("tools", 2, { supportsTools: true }),
    ]);
    expect(roster.frontier).toEqual(["tools", "no-tools"]);
  });

  it("keeps a premium model the user asked for, on frontier", () => {
    const roster = tierByPrice([model("anthropic/claude-opus-5", 75)]);
    expect(roster).toEqual({ fast: [], mid: [], frontier: ["anthropic/claude-opus-5"] });
  });

  it("keeps a duplicate id once, at its first position", () => {
    const roster = tierByPrice([model("a", 0.1), model("b", 0.1), model("a", 4)]);
    expect(roster.fast).toEqual(["a", "b"]);
    expect(roster.frontier).toEqual([]);
  });

  it("returns every tier, empty ones included", () => {
    expect(tierByPrice([])).toEqual({ fast: [], mid: [], frontier: [] });
  });

  it("reproduces the shipped roster's tiers from the shipped prices", () => {
    // The strongest statement that this is the *same* rule: feed it the
    // default roster's own models, in usage order, and the tiers come back
    // as shipped.
    const models = (["fast", "mid", "frontier"] as const).flatMap((tier) =>
      DEFAULT_ROSTER_INFO.tiers[tier].map((m) => ({
        id: m.id,
        outputUsdPerM: m.outputUsdPerM,
        ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
      })),
    );
    const roster = tierByPrice(models);

    expect(roster.fast).toEqual(DEFAULT_ROSTER_INFO.tiers.fast.map((m) => m.id));
    expect(roster.mid).toEqual(DEFAULT_ROSTER_INFO.tiers.mid.map((m) => m.id));
    expect(roster.frontier).toEqual(DEFAULT_ROSTER_INFO.tiers.frontier.map((m) => m.id));
  });
});

describe("describeRoster", () => {
  it("renders one row per model with the prices it was given", () => {
    const table = describeRoster({ fast: ["cheap/one"], mid: [], frontier: ["top/one"] }, [
      { id: "cheap/one", inputUsdPerM: 0.07, outputUsdPerM: 0.14, maxOutputTokens: 128_000 },
      { id: "top/one", inputUsdPerM: 3, outputUsdPerM: 15 },
    ]);

    expect(table.split("\n")).toEqual([
      "| Tier | Model | In $/M | Out $/M | Max output |",
      "|---|---|---|---|---|",
      "| fast | `cheap/one` | 0.07 | 0.14 | 128000 |",
      "| frontier | `top/one` | 3 | 15 | - |",
    ]);
  });

  it("falls back to the shipped numbers for an id it was given no price for", () => {
    const table = describeRoster({ fast: ["deepseek/deepseek-v4-flash"], mid: [], frontier: [] });
    expect(table).toContain("| fast | `deepseek/deepseek-v4-flash` | 0.07 | 0.14 | 384000 |");
  });

  it("prints a dash rather than guessing a price it does not know", () => {
    const table = describeRoster({ fast: [], mid: ["who/knows"], frontier: [] });
    expect(table).toContain("| mid | `who/knows` | - | - | - |");
  });
});
