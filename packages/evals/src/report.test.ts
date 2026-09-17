import { describe, expect, it } from "vitest";
import { formatMarkdown, tierAgreementRate } from "./report.js";
import type { EvalReport, ScoredExample, UnscoredExample } from "./report.js";

const scored: ScoredExample[] = [
  {
    kind: "scored",
    id: "s-1",
    taskType: "chat",
    predictedTaskType: "chat",
    difficultyBand: 0,
    predictedDifficulty: 0.2,
    needsReasoning: 0.1,
    expectedTier: "fast",
    predictedTier: "fast",
    reason: "difficulty 0.20 is below 1.00, so any posture routes to fast",
    latencyMs: 50,
    notes: "trivial small talk",
    agree: true,
  },
  {
    kind: "scored",
    id: "s-2",
    taskType: "edit",
    predictedTaskType: "edit",
    difficultyBand: 1,
    predictedDifficulty: 1.3,
    needsReasoning: 0.2,
    expectedTier: "mid",
    predictedTier: "mid",
    reason: "difficulty 1.30 with needs_reasoning 0.20 below 0.50 and balanced posture routes to mid",
    latencyMs: 80,
    notes: "small self-contained change",
    agree: true,
  },
  {
    kind: "scored",
    id: "s-3",
    taskType: "review",
    predictedTaskType: "debug",
    difficultyBand: 2,
    predictedDifficulty: 2.1,
    needsReasoning: 0.6,
    expectedTier: "frontier",
    predictedTier: "mid",
    reason: "difficulty 2.10 with balanced posture routes to frontier",
    latencyMs: 120,
    notes: "concurrency bug hiding in a routine-looking diff",
    agree: false,
  },
  {
    kind: "scored",
    id: "s-4",
    taskType: "feature",
    predictedTaskType: "feature",
    difficultyBand: 3,
    predictedDifficulty: 2.9,
    needsReasoning: 0.9,
    expectedTier: "frontier",
    predictedTier: "frontier",
    reason: "difficulty 2.90 with balanced posture routes to frontier",
    latencyMs: 200,
    notes: "multi-part, correctness-critical",
    agree: true,
  },
  {
    kind: "scored",
    id: "s-5",
    taskType: "chat",
    predictedTaskType: "chat",
    difficultyBand: 2,
    predictedDifficulty: 2.4,
    needsReasoning: 0.7,
    expectedTier: "mid",
    predictedTier: "frontier",
    reason: "difficulty 2.40 with balanced posture routes to frontier",
    latencyMs: 300,
    notes: "chat caps at mid below difficulty 2.5",
    agree: false,
  },
];

const unscored: UnscoredExample[] = [
  { kind: "unscored", id: "u-1", taskType: "ops", difficultyBand: 1, expectedTier: "fast", notes: "n6", errorClass: "timeout" },
  { kind: "unscored", id: "u-2", taskType: "docs", difficultyBand: 2, expectedTier: "mid", notes: "n7", errorClass: "network" },
];

const report: EvalReport = {
  posture: "balanced",
  policyVersion: "v1",
  generatedAt: "2026-09-17T00:00:00.000Z",
  scored,
  unscored,
};

describe("formatMarkdown", () => {
  const markdown = formatMarkdown(report);

  it("contains every required section", () => {
    const headings = [
      "# Routing eval report",
      "## Unscored",
      "## Tier agreement",
      "### By task type",
      "### By difficulty band",
      "## Task-type accuracy",
      "## Tier confusion matrix",
      "## Jev latency",
      "## Disagreements",
      "## Policy ceiling note",
    ];
    for (const heading of headings) {
      expect(markdown, `expected to find "${heading}"`).toContain(heading);
    }
  });

  it("formats overall tier agreement as a percentage with one decimal", () => {
    // 3 of 5 scored examples agree.
    expect(tierAgreementRate(report)).toBeCloseTo(3 / 5, 10);
    expect(markdown).toMatch(/Overall: \d+\.\d% \(n=5\)/);
  });

  it("renders a 3x3 confusion matrix whose cells sum to the scored count", () => {
    const start = markdown.indexOf("## Tier confusion matrix");
    const end = markdown.indexOf("## Jev latency");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| fast") || line.startsWith("| mid") || line.startsWith("| frontier"));
    expect(rows).toHaveLength(3);

    let sum = 0;
    for (const row of rows) {
      const cells = row
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      // First cell is the row label (the expected tier); the rest are counts.
      const counts = cells.slice(1).map(Number);
      expect(counts).toHaveLength(3);
      for (const count of counts) sum += count;
    }
    expect(sum).toBe(scored.length);
  });

  it("lists the disagreeing ids and not the agreeing ones", () => {
    const start = markdown.indexOf("## Disagreements");
    const section = markdown.slice(start);
    expect(section).toContain("s-3");
    expect(section).toContain("s-5");
    expect(section).not.toContain("s-1");
  });

  it("reports zero unscored cleanly", () => {
    const clean = formatMarkdown({ ...report, unscored: [] });
    expect(clean).toContain("Every example was scored.");
  });

  it("does not blow up with zero scored examples", () => {
    const empty = formatMarkdown({ ...report, scored: [] });
    expect(empty).toContain("## Tier agreement");
    expect(empty).toMatch(/Overall: n\/a \(n=0\)/);
  });
});
