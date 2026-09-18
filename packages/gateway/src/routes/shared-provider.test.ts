import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER_INFO } from "@milo/core";
import { applyProviderStrategy, maxPriceFor } from "./shared.js";

describe("applyProviderStrategy", () => {
  it("sorts by throughput for balanced and quality", () => {
    expect(applyProviderStrategy({ model: "m" }, "balanced")).toEqual({ model: "m", provider: { sort: "throughput" } });
    expect(applyProviderStrategy({ model: "m" }, "quality")).toEqual({ model: "m", provider: { sort: "throughput" } });
  });

  it("leaves low posture on OpenRouter's price-first default", () => {
    expect(applyProviderStrategy({ model: "m" }, "low")).toEqual({ model: "m" });
  });

  it("caps the sort at the roster's listed price with 10% headroom", () => {
    const fast = DEFAULT_ROSTER_INFO.tiers.fast[0]!;
    const out = applyProviderStrategy({ model: fast.id }, "balanced", fast.id) as Record<string, unknown>;
    expect(out["provider"]).toEqual({
      sort: "throughput",
      max_price: { prompt: fast.inputUsdPerM * 1.1, completion: fast.outputUsdPerM * 1.1 },
    });
    expect(maxPriceFor("not/in-roster")).toEqual({});
    expect(maxPriceFor(undefined)).toEqual({});
  });

  it("never overrides a caller-supplied provider field", () => {
    const body = { model: "m", provider: { order: ["mine"] } };
    expect(applyProviderStrategy(body, "quality")).toBe(body);
  });
});
