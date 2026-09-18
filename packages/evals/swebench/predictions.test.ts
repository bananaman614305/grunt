import { describe, expect, it } from "vitest";
import { formatPredictionsJsonl, toPrediction } from "./predictions.js";

describe("toPrediction", () => {
  it("shapes the exact keys the evaluator expects", () => {
    expect(toPrediction("x__y-1", "diff --git ...", "milo/auto")).toEqual({
      instance_id: "x__y-1",
      model_name_or_path: "milo/auto",
      model_patch: "diff --git ...",
    });
  });
});

describe("formatPredictionsJsonl", () => {
  it("writes one JSON object per line with a trailing newline", () => {
    const jsonl = formatPredictionsJsonl([
      toPrediction("a-1", "patch-a", "milo/auto"),
      toPrediction("b-2", "", "milo/auto"),
    ]);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(3); // two records + trailing empty
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] as string)).toEqual({
      instance_id: "a-1",
      model_name_or_path: "milo/auto",
      model_patch: "patch-a",
    });
    expect(JSON.parse(lines[1] as string).model_patch).toBe("");
  });

  it("emits nothing for an empty list", () => {
    expect(formatPredictionsJsonl([])).toBe("");
  });
});
