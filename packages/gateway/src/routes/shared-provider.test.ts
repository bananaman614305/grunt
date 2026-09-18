import { describe, expect, it } from "vitest";
import { applyProviderStrategy } from "./shared.js";

describe("applyProviderStrategy", () => {
  it("sorts by throughput for balanced and quality", () => {
    expect(applyProviderStrategy({ model: "m" }, "balanced")).toEqual({ model: "m", provider: { sort: "throughput" } });
    expect(applyProviderStrategy({ model: "m" }, "quality")).toEqual({ model: "m", provider: { sort: "throughput" } });
  });

  it("leaves low posture on OpenRouter's price-first default", () => {
    expect(applyProviderStrategy({ model: "m" }, "low")).toEqual({ model: "m" });
  });

  it("never overrides a caller-supplied provider field", () => {
    const body = { model: "m", provider: { order: ["mine"] } };
    expect(applyProviderStrategy(body, "quality")).toBe(body);
  });
});
