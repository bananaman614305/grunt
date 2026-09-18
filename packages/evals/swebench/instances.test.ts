import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadInstances, parseInstanceLine, selectInstances, swebenchInstanceSchema } from "./instances.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-instances.jsonl");

describe("swebenchInstanceSchema", () => {
  it("normalizes JSON-string test lists to arrays", () => {
    const parsed = swebenchInstanceSchema.parse({
      instance_id: "x__y-1",
      repo: "x/y",
      base_commit: "abc",
      problem_statement: "do the thing",
      FAIL_TO_PASS: '["t::a", "t::b"]',
      PASS_TO_PASS: "[]",
    });
    expect(parsed.FAIL_TO_PASS).toEqual(["t::a", "t::b"]);
    expect(parsed.PASS_TO_PASS).toEqual([]);
    expect(parsed.test_patch).toBe("");
    expect(parsed.patch).toBe("");
  });

  it("accepts test lists already given as arrays", () => {
    const parsed = swebenchInstanceSchema.parse({
      instance_id: "x__y-1",
      repo: "x/y",
      base_commit: "abc",
      problem_statement: "p",
      FAIL_TO_PASS: ["t::a"],
      PASS_TO_PASS: ["t::b"],
    });
    expect(parsed.FAIL_TO_PASS).toEqual(["t::a"]);
  });

  it("rejects a repo that is not owner/name", () => {
    const result = swebenchInstanceSchema.safeParse({
      instance_id: "x",
      repo: "no-slash",
      base_commit: "abc",
      problem_statement: "p",
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseInstanceLine", () => {
  it("tags a JSON syntax error with the line number", () => {
    expect(() => parseInstanceLine("{not json", 7)).toThrow(/line 7: not valid JSON/);
  });

  it("tags a validation error with the instance id", () => {
    const line = JSON.stringify({ instance_id: "bad-1", repo: "x/y", base_commit: "", problem_statement: "p", FAIL_TO_PASS: [], PASS_TO_PASS: [] });
    expect(() => parseInstanceLine(line, 3)).toThrow(/bad-1/);
  });
});

describe("loadInstances", () => {
  it("loads and validates the committed sample fixture", () => {
    const instances = loadInstances(FIXTURE);
    expect(instances.map((i) => i.instance_id)).toEqual([
      "mockorg__mocklib-1",
      "mockorg__mocklib-2",
      "otherorg__widget-9",
    ]);
    expect(instances[0]?.FAIL_TO_PASS).toEqual(["tests/test_slug.py::test_multiword"]);
    expect(instances[0]?.repo).toBe("mockorg/mocklib");
  });
});

describe("selectInstances", () => {
  const instances = loadInstances(FIXTURE);

  it("returns all instances in dataset order for 'all'", () => {
    expect(selectInstances(instances, "all").map((i) => i.instance_id)).toEqual([
      "mockorg__mocklib-1",
      "mockorg__mocklib-2",
      "otherorg__widget-9",
    ]);
  });

  it("keeps an explicit selection, deduplicated", () => {
    const ids = selectInstances(instances, ["otherorg__widget-9", "mockorg__mocklib-1", "otherorg__widget-9"]).map(
      (i) => i.instance_id,
    );
    expect(ids).toEqual(["otherorg__widget-9", "mockorg__mocklib-1"]);
  });

  it("applies --limit after selection", () => {
    expect(selectInstances(instances, "all", 2).map((i) => i.instance_id)).toEqual([
      "mockorg__mocklib-1",
      "mockorg__mocklib-2",
    ]);
  });

  it("fails loudly on an unknown id", () => {
    expect(() => selectInstances(instances, ["mockorg__mocklib-1", "nope-1"])).toThrow(/unknown instance id.*nope-1/);
  });
});
