import { describe, expect, it } from "vitest";
import { loadRoutingSet } from "../schema.js";
import { DEFAULT_CANARY_SIZE, selectCanarySubset } from "./subset.js";

const examples = loadRoutingSet();

describe("selectCanarySubset", () => {
  it("picks the default size and is stratified across every difficulty band", () => {
    const subset = selectCanarySubset(examples);
    expect(subset).toHaveLength(DEFAULT_CANARY_SIZE);

    const byBand = new Map<number, number>();
    for (const example of subset) {
      byBand.set(example.difficulty_band, (byBand.get(example.difficulty_band) ?? 0) + 1);
    }
    // Round-robin over 4 bands with a size that divides evenly gives an even split.
    expect([...byBand.keys()].sort()).toEqual([0, 1, 2, 3]);
    for (const band of [0, 1, 2, 3] as const) {
      expect(byBand.get(band)).toBe(DEFAULT_CANARY_SIZE / 4);
    }
  });

  it("is deterministic: the same input produces the same subset, in id order", () => {
    const first = selectCanarySubset(examples, 24).map((e) => e.id);
    const second = selectCanarySubset(examples, 24).map((e) => e.id);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });

  it("never returns duplicate ids", () => {
    const subset = selectCanarySubset(examples, 24);
    const ids = new Set(subset.map((e) => e.id));
    expect(ids.size).toBe(subset.length);
  });

  it("honors a custom size", () => {
    expect(selectCanarySubset(examples, 8)).toHaveLength(8);
    expect(selectCanarySubset(examples, 40)).toHaveLength(40);
  });

  it("caps at the example count when size exceeds it, without throwing", () => {
    const subset = selectCanarySubset(examples, examples.length + 1000);
    expect(subset).toHaveLength(examples.length);
    expect(new Set(subset.map((e) => e.id)).size).toBe(examples.length);
  });

  it("rejects a non-positive or non-integer size", () => {
    expect(() => selectCanarySubset(examples, 0)).toThrow(/positive integer/);
    expect(() => selectCanarySubset(examples, -3)).toThrow(/positive integer/);
    expect(() => selectCanarySubset(examples, 2.5)).toThrow(/positive integer/);
  });

  it("a smaller subset is not just a truncation of a larger one (round-robin, not first-N)", () => {
    // With 24 picked round-robin 6-per-band and 8 picked round-robin 2-per-band,
    // the smaller set is a subset of the larger one banded the same way.
    const large = new Set(selectCanarySubset(examples, 24).map((e) => e.id));
    const small = selectCanarySubset(examples, 8);
    for (const example of small) {
      expect(large.has(example.id)).toBe(true);
    }
  });
});
