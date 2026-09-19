import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER_INFO } from "@milo/core";
import {
  applyProviderStrategy,
  applyReasoningExclusion,
  maxPriceFor,
  retargetProviderStrategy,
} from "./shared.js";

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

describe("applyReasoningExclusion", () => {
  it("excludes reasoning from the response without disabling model reasoning", () => {
    const body = { model: "m" };
    expect(applyReasoningExclusion(body)).toEqual({ model: "m", reasoning: { exclude: true } });
    expect(body).toEqual({ model: "m" });
  });

  it("preserves reasoning options while adding the safe visibility default", () => {
    expect(applyReasoningExclusion({ reasoning: { effort: "high", summary: "auto" } })).toEqual({
      reasoning: { effort: "high", summary: "auto", exclude: true },
    });
  });

  it("never overrides an explicit current or legacy visibility choice", () => {
    const visible = { reasoning: { effort: "high", exclude: false } };
    const legacy = { include_reasoning: true };
    expect(applyReasoningExclusion(visible)).toBe(visible);
    expect(applyReasoningExclusion(legacy)).toBe(legacy);
  });

  it("leaves invalid reasoning values for OpenRouter to validate", () => {
    const body = { reasoning: null };
    expect(applyReasoningExclusion(body)).toBe(body);
  });
});

describe("retargetProviderStrategy", () => {
  const fast = DEFAULT_ROSTER_INFO.tiers.fast[0]!;
  const frontier = DEFAULT_ROSTER_INFO.tiers.frontier[0]!;

  it("recomputes Milo's own ceiling for the model actually being called", () => {
    const body = applyProviderStrategy({ model: fast.id }, "balanced", fast.id);
    const out = retargetProviderStrategy(body, fast.id, frontier.id) as Record<string, unknown>;
    expect(out["provider"]).toEqual({
      sort: "throughput",
      max_price: { prompt: frontier.inputUsdPerM * 1.1, completion: frontier.outputUsdPerM * 1.1 },
    });
  });

  it("drops the ceiling entirely for a model the default roster does not price", () => {
    const body = applyProviderStrategy({ model: fast.id }, "balanced", fast.id);
    const out = retargetProviderStrategy(body, fast.id, "off/roster") as Record<string, unknown>;
    expect(out["provider"]).toEqual({ sort: "throughput" });
  });

  it("never touches a caller-supplied provider field, or a body with none", () => {
    const caller = { model: fast.id, provider: { order: ["mine"], max_price: { prompt: 0, completion: 0 } } };
    expect(retargetProviderStrategy(caller, fast.id, frontier.id)).toBe(caller);
    // A ceiling that is not the one Milo would have applied is the caller's.
    const theirs = { model: fast.id, provider: { sort: "throughput", max_price: { prompt: 9, completion: 9 } } };
    expect(retargetProviderStrategy(theirs, fast.id, frontier.id)).toBe(theirs);
    const bare = { model: fast.id };
    expect(retargetProviderStrategy(bare, fast.id, frontier.id)).toBe(bare);
  });

  it("re-points a low-posture body's absent strategy not at all", () => {
    const low = applyProviderStrategy({ model: fast.id }, "low", fast.id);
    expect(retargetProviderStrategy(low, fast.id, frontier.id)).toBe(low);
  });
});
