import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJudgeMessages,
  gradeMechanically,
  isMechanical,
  JUDGE_PASS_THRESHOLD,
  loadGraders,
  parseJudgeVerdict,
  validateGrader,
} from "./graders.js";
import type { Grader } from "./graders.js";

describe("mechanical graders", () => {
  it("regex matches anywhere, honoring flags", () => {
    const g: Grader = { type: "regex", pattern: "\\bnegative\\b", flags: "i" };
    expect(gradeMechanically(g, "Sentiment: NEGATIVE.")?.pass).toBe(true);
    expect(gradeMechanically(g, "It is not positive.")?.pass).toBe(false);
  });

  it("contains_all needs every value, case-insensitive", () => {
    const g: Grader = { type: "contains_all", values: ["userProfile", "render(userProfile)"] };
    expect(gradeMechanically(g, "const userProfile = 1; render(USERPROFILE);")?.pass).toBe(true);
    const failed = gradeMechanically(g, "const userProfile = 1;");
    expect(failed?.pass).toBe(false);
    expect(failed?.reason).toContain("render(userProfile)");
  });

  it("contains_any and not_contains", () => {
    expect(gradeMechanically({ type: "contains_any", values: ["yes", "valid"] }, "Yes.")?.pass).toBe(true);
    expect(gradeMechanically({ type: "not_contains", values: ["data"] }, "const data = 1")?.pass).toBe(false);
  });

  it("all passes only when every sub-grader passes and reports the first failure", () => {
    const g: Grader = {
      type: "all",
      graders: [
        { type: "contains_all", values: ["calculateTotal"] },
        { type: "not_contains", values: ["calc("] },
      ],
    };
    expect(gradeMechanically(g, "function calculateTotal() {}")?.pass).toBe(true);
    const failed = gradeMechanically(g, "function calculateTotal() { return calc(1); }");
    expect(failed?.pass).toBe(false);
    expect(failed?.reason).toContain("calc(");
  });

  it("returns undefined for a judge", () => {
    expect(gradeMechanically({ type: "judge", rubric: "x" }, "anything")).toBeUndefined();
    expect(isMechanical({ type: "judge", rubric: "x" })).toBe(false);
    expect(isMechanical({ type: "all", graders: [{ type: "regex", pattern: "a" }] })).toBe(true);
  });

  it("validation rejects a bad regex and a judge inside all", () => {
    expect(() => validateGrader({ type: "regex", pattern: "(" })).toThrow();
    expect(() => validateGrader({ type: "all", graders: [{ type: "judge", rubric: "x" }] })).toThrow(/judge/);
  });
});

describe("loadGraders", () => {
  it("reads rows, rejects duplicates and bad lines with a line number", () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-graders-"));
    const good = join(dir, "good.jsonl");
    writeFileSync(
      good,
      [
        JSON.stringify({ id: "r-001", grader: { type: "regex", pattern: "hi" }, why: "greets" }),
        "",
        JSON.stringify({ id: "r-002", grader: { type: "judge", rubric: "good docs", must: ["mentions install"] } }),
      ].join("\n"),
    );
    const rows = loadGraders(good);
    expect([...rows.keys()]).toEqual(["r-001", "r-002"]);

    const dup = join(dir, "dup.jsonl");
    writeFileSync(dup, [JSON.stringify({ id: "r-001", grader: { type: "regex", pattern: "a" } }), JSON.stringify({ id: "r-001", grader: { type: "regex", pattern: "b" } })].join("\n"));
    expect(() => loadGraders(dup)).toThrow(/dup.jsonl:2: duplicate id r-001/);

    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "{not json");
    expect(() => loadGraders(bad)).toThrow(/bad.jsonl:1: invalid JSON/);
  });
});

describe("judge", () => {
  it("builds a single user message carrying task, answer, rubric and must list", () => {
    const messages = buildJudgeMessages(
      [{ role: "system", content: "You are terse." }, { role: "user", content: "Write docs." }],
      "Here are docs.",
      { type: "judge", rubric: "Docs are complete.", must: ["mentions install", "mentions tests"] },
    );
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content as string;
    expect(text).toContain("[system]\nYou are terse.");
    expect(text).toContain("Here are docs.");
    expect(text).toContain("1. mentions install");
    expect(text).toContain('"score"');
  });

  it("parses a verdict, clamps the score, and tolerates prose around the JSON", () => {
    const grade = parseJudgeVerdict('Sure.\n{"score": 0.9, "pass": true, "reason": "complete"}\nDone.');
    expect(grade).toEqual({ score: 0.9, pass: true, by: "judge", reason: "complete" });
    expect(parseJudgeVerdict('{"score": 1.7, "pass": true}').score).toBe(1);
    expect(parseJudgeVerdict('{"score": 0.95, "pass": false}').pass).toBe(false);
    expect(parseJudgeVerdict(`{"score": ${JUDGE_PASS_THRESHOLD - 0.1}, "pass": true}`).pass).toBe(false);
    expect(parseJudgeVerdict("no json here")).toMatchObject({ score: 0, pass: false, by: "judge" });
  });
});

describe("committed graders", () => {
  it("cover every routing example, in order, and every regex compiles", async () => {
    const { loadRoutingSet } = await import("../schema.js");
    const rows = loadGraders();
    const ids = loadRoutingSet().map((e) => e.id);
    expect([...rows.keys()]).toEqual(ids);
    let mechanical = 0;
    for (const row of rows.values()) if (isMechanical(row.grader)) mechanical += 1;
    // The suite is meant to be mostly judged with a solid mechanical core; guard against either collapsing.
    expect(mechanical).toBeGreaterThanOrEqual(30);
    expect(rows.size - mechanical).toBeGreaterThanOrEqual(30);
  });
});
