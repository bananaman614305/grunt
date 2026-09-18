import { describe, expect, it } from "vitest";
import { BASELINE_MODEL_ID, costFromTokens, estimateCostUsd, pricesFromCatalogue } from "./prices.js";

describe("prices", () => {
  it("reads per-million prices for the requested ids only", () => {
    const payload = {
      data: [
        { id: BASELINE_MODEL_ID, pricing: { prompt: "0.00001", completion: "0.00005" } },
        { id: "deepseek/deepseek-v4-flash", pricing: { prompt: "0.000000088606", completion: "0.000000177212" } },
        { id: "other/model", pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "broken/model", pricing: { prompt: null, completion: "x" } },
      ],
    };
    const prices = pricesFromCatalogue(payload, [BASELINE_MODEL_ID, "deepseek/deepseek-v4-flash", "broken/model"]);
    expect(prices.get(BASELINE_MODEL_ID)).toEqual({ id: BASELINE_MODEL_ID, inputUsdPerM: 10, outputUsdPerM: 50 });
    expect(prices.get("deepseek/deepseek-v4-flash")).toEqual({ id: "deepseek/deepseek-v4-flash", inputUsdPerM: 0.0886, outputUsdPerM: 0.1772 });
    expect(prices.has("other/model")).toBe(false);
    expect(prices.has("broken/model")).toBe(false);
  });

  it("estimates the baseline from token counts, with an output multiplier", () => {
    const fable = { id: BASELINE_MODEL_ID, inputUsdPerM: 10, outputUsdPerM: 50 };
    expect(estimateCostUsd(fable, 1_000_000, 0)).toBe(10);
    expect(estimateCostUsd(fable, 100, 200)).toBeCloseTo(0.011, 9);
    expect(estimateCostUsd(fable, 100, 200, 2)).toBeCloseTo(0.021, 9);
    expect(costFromTokens(undefined, 1, 1)).toBeUndefined();
    expect(costFromTokens(fable, undefined, 1)).toBeUndefined();
  });
});
