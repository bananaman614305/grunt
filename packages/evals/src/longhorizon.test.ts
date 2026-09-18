import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraders, validateGrader } from "./bench/graders.js";
import type { Grader } from "./bench/graders.js";
import { loadRoutingSet } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SET_PATH = resolve(__dirname, "../data/longhorizon.jsonl");
const GRADERS_PATH = resolve(__dirname, "../data/longhorizon-graders.jsonl");

const EXPECTED_TOTAL = 16;
const MAX_TOTAL_BYTES = 400 * 1024;
const EXPECTED_IDS = Array.from(
  { length: EXPECTED_TOTAL },
  (_, i) => `lh-${String(i + 1).padStart(3, "0")}`,
);

const examples = loadRoutingSet(SET_PATH);
const graders = loadGraders(GRADERS_PATH);

function collectRegexes(grader: Grader): Array<{ pattern: string; flags?: string | undefined }> {
  if (grader.type === "regex") return [{ pattern: grader.pattern, flags: grader.flags }];
  if (grader.type === "all") return grader.graders.flatMap(collectRegexes);
  return [];
}

describe("long-horizon eval suite (packages/evals/data/longhorizon.jsonl)", () => {
  it("has exactly the 16 expected ids, in order", () => {
    expect(examples.map((e) => e.id)).toEqual(EXPECTED_IDS);
  });

  it("grader ids match the example ids, in the same order", () => {
    expect([...graders.keys()]).toEqual(EXPECTED_IDS);
  });

  it("every example is difficulty band 2 or 3", () => {
    for (const e of examples) {
      expect([2, 3], `${e.id} has band ${e.difficulty_band}`).toContain(e.difficulty_band);
    }
  });

  it("every expected tier is mid or frontier", () => {
    for (const e of examples) {
      expect(["mid", "frontier"], `${e.id} expects ${e.expected_tier_balanced}`).toContain(
        e.expected_tier_balanced,
      );
    }
  });

  it("every grader validates and every regex compiles", () => {
    for (const [id, row] of graders) {
      expect(() => validateGrader(row.grader), id).not.toThrow();
      for (const { pattern, flags } of collectRegexes(row.grader)) {
        expect(() => new RegExp(pattern, flags), `${id}: /${pattern}/${flags ?? ""}`).not.toThrow();
      }
    }
  });

  it("total JSONL size stays under 400KB", () => {
    const total = statSync(SET_PATH).size + statSync(GRADERS_PATH).size;
    expect(total, `${total} bytes`).toBeLessThan(MAX_TOTAL_BYTES);
  });
});
