import { describe, expect, it } from "vitest";
import { ATTRIBUTION_METHOD } from "./decisions.js";
import type { TaskResult } from "./report.js";
import { buildReport, formatAgenticMarkdown, summarize } from "./report.js";

const task = (id: string, overrides: Partial<TaskResult> = {}): TaskResult => ({
  id,
  verdict: "pass",
  testExitCode: 0,
  wallTimeMs: 30_000,
  pi: {
    turns: 4,
    toolCalls: { bash: 3, edit: 2 },
    toolCallTotal: 5,
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    malformedLines: 0,
  },
  gateway: { method: ATTRIBUTION_METHOD, decisions: [], costUsd: 0.01 },
  ...overrides,
});

const TASKS: TaskResult[] = [
  task("at-001"),
  task("at-002", { verdict: "fail", testExitCode: 1 }),
  task("at-003", {
    verdict: "timeout",
    testExitCode: null,
    note: "pi exceeded 600s",
    gateway: { method: ATTRIBUTION_METHOD, decisions: [], costUsd: 0, error: "decisions fetch failed: HTTP 401" },
  }),
];

describe("summarize", () => {
  it("totals the per-task numbers and computes the solve rate", () => {
    expect(summarize(TASKS)).toEqual({
      tasks: 3,
      solved: 1,
      solveRate: 1 / 3,
      turns: 12,
      toolCalls: 15,
      wallTimeMs: 90_000,
      tokens: { input: 3000, output: 600 },
      gatewayCostUsd: 0.02,
    });
  });

  it("handles an empty run without dividing by zero", () => {
    expect(summarize([]).solveRate).toBe(0);
  });
});

describe("buildReport / formatAgenticMarkdown", () => {
  const report = buildReport(TASKS, {
    gateway: "http://127.0.0.1:8787/v1",
    timeoutMs: 600_000,
    generatedAt: "2026-09-18T12:00:00.000Z",
  });

  it("records the gateway, timeout, and the approximate-attribution label", () => {
    expect(report.gateway).toBe("http://127.0.0.1:8787/v1");
    expect(report.timeoutMs).toBe(600_000);
    expect(report.attribution).toContain("approximate (time-window)");
  });

  it("renders one row per task plus summary totals", () => {
    const md = formatAgenticMarkdown(report);
    expect(md).toContain("Gateway: http://127.0.0.1:8787/v1");
    expect(md).toContain("approximate (time-window)");
    expect(md).toContain("| at-001 | pass | 4 | bash:3 edit:2 | 30.0s | 1000/200 | $0.0100 |");
    expect(md).toContain("| at-002 | fail |");
    expect(md).toContain("| at-003 | timeout (pi exceeded 600s) |");
    expect(md).toContain("Solve rate: **1/3** (33%)");
    expect(md).toContain("Tokens: 3000 in / 600 out");
    expect(md).toContain("- at-003: decisions fetch failed: HTTP 401");
  });
});
