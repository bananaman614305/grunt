import { describe, expect, it } from "vitest";
import { TASK_TYPES } from "@milo/core";
import { loadRoutingSet } from "./schema.js";

const MIN_PER_TASK_TYPE = 8;
const MIN_PER_BAND = 20;
const EXPECTED_TOTAL = 120;
const BANDS = [0, 1, 2, 3] as const;

const examples = loadRoutingSet();

describe("routing eval set (packages/evals/data/routing.jsonl)", () => {
  it("loads and parses every row against the schema", () => {
    expect(examples.length).toBe(EXPECTED_TOTAL);
  });

  it("has unique ids", () => {
    const ids = new Set(examples.map((e) => e.id));
    expect(ids.size).toBe(examples.length);
  });

  it("covers every task type with at least the minimum count", () => {
    for (const taskType of TASK_TYPES) {
      const count = examples.filter((e) => e.task_type === taskType).length;
      expect(count, `task_type "${taskType}" has ${count} examples`).toBeGreaterThanOrEqual(
        MIN_PER_TASK_TYPE,
      );
    }
  });

  it("covers every difficulty band with at least the minimum count", () => {
    for (const band of BANDS) {
      const count = examples.filter((e) => e.difficulty_band === band).length;
      expect(count, `band ${band} has ${count} examples`).toBeGreaterThanOrEqual(MIN_PER_BAND);
    }
  });

  it("bands and totals sum back to the whole set", () => {
    const total = BANDS.reduce(
      (sum, band) => sum + examples.filter((e) => e.difficulty_band === band).length,
      0,
    );
    expect(total).toBe(examples.length);
  });

  // the labeling rule in data/README.md, as applied to a discrete 0..3 band:
  //   band 0            -> fast
  //   band 1            -> fast or mid (little reasoning vs some reasoning)
  //   band 2            -> mid or frontier (reasoning-dependent), but
  //                        task_type chat/classify caps at mid
  //   band 3            -> frontier always, including chat/classify (the
  //                        cap lifts "in spirit" at the top band)

  it("band 0 examples are always routed to fast", () => {
    for (const e of examples.filter((e) => e.difficulty_band === 0)) {
      expect(e.expected_tier_balanced, e.id).toBe("fast");
    }
  });

  it("band 1 examples are routed to fast or mid", () => {
    for (const e of examples.filter((e) => e.difficulty_band === 1)) {
      expect(["fast", "mid"], e.id).toContain(e.expected_tier_balanced);
    }
  });

  it("band 2 examples are mid or frontier, with chat/classify capped at mid", () => {
    for (const e of examples.filter((e) => e.difficulty_band === 2)) {
      if (e.task_type === "chat" || e.task_type === "classify") {
        expect(e.expected_tier_balanced, e.id).toBe("mid");
      } else {
        expect(["mid", "frontier"], e.id).toContain(e.expected_tier_balanced);
      }
    }
  });

  it("band 3 examples are always routed to frontier, cap lifted for chat/classify", () => {
    for (const e of examples.filter((e) => e.difficulty_band === 3)) {
      expect(e.expected_tier_balanced, e.id).toBe("frontier");
    }
  });

  it("every example has at least one message and non-empty notes", () => {
    for (const e of examples) {
      expect(e.messages.length, e.id).toBeGreaterThan(0);
      expect(e.notes.length, e.id).toBeGreaterThan(0);
    }
  });
});
