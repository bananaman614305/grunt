import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTaskDossier,
  compileTaskRubric,
  decideDossier,
  JsonTaskRecordStore,
  summarizeTaskEvidence,
  TASK_RECORD_VERSION,
  updateTaskObligations,
} from "./task-records.js";
import type { TaskRecord } from "./task-records.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("task records", () => {
  it("compiles explicit and checklist requirements without a model call", () => {
    const rubric = compileTaskRubric({
      id: "retry",
      prompt: "Add retries\n- preserve aborts\n- add a regression test",
      acceptanceCriteria: ["Use bounded backoff", "preserve aborts"],
    });
    expect(rubric.criteria.map((criterion) => criterion.text)).toEqual([
      "Use bounded backoff",
      "preserve aborts",
      "add a regression test",
    ]);
    expect(rubric.criteria.map((criterion) => criterion.id)).toEqual([
      "criterion-1",
      "criterion-2",
      "criterion-3",
    ]);
    expect(rubric.hierarchy).toEqual([
      { level: "truth_contract", criterionIds: ["criterion-1", "criterion-2"] },
      { level: "regression_integration_scope", criterionIds: ["criterion-3"] },
    ]);
    expect(rubric.criteria.map((criterion) => criterion.decision)).toEqual(["veto", "veto", "required"]);
  });

  it("falls back when supplied criteria are blank", () => {
    const rubric = compileTaskRubric({ id: "x", prompt: "Ship the change", acceptanceCriteria: ["  "] });
    expect(rubric.criteria).toEqual([{
      id: "criterion-1",
      text: "Complete the assigned task: Ship the change",
      source: "fallback",
      level: "task_preference",
      decision: "required",
      question: "Does the available evidence show that this is satisfied: Complete the assigned task: Ship the change",
    }]);
  });

  it("applies vetoes before unknowns and preferences", () => {
    const rubric = compileTaskRubric({
      id: "secure",
      prompt: "Ship it\n- keep the code readable",
      acceptanceCriteria: ["Never expose the token"],
    });
    const results = rubric.criteria.map((criterion) => ({
      claim: { id: `done:secure:${criterion.id}`, text: criterion.text, category: "completion" as const },
      verdict: criterion.decision === "veto" ? "contradicted" as const : "unsupported" as const,
      confidence: 0.9,
    }));
    expect(decideDossier(rubric, results)).toMatchObject({ outcome: "reject", reason: "veritaserum_veto" });
  });

  it("persists unknown required criteria as obligations until supported", () => {
    const rubric = compileTaskRubric({ id: "x", prompt: "Ship it" });
    const claim = { id: "done:x:criterion-1", text: "Tests pass", category: "completion" as const };
    const open = updateTaskObligations([], [{ claim, verdict: "unsupported", confidence: 0.8 }], rubric, new Date(0));
    expect(open).toMatchObject([{ id: claim.id, status: "open" }]);
    const resolved = updateTaskObligations(open, [{ claim, verdict: "supported", confidence: 0.9 }], rubric, new Date(1));
    expect(resolved).toMatchObject([{ id: claim.id, status: "resolved" }]);
  });

  it("keeps the dossier compact while integrating receipts and git evidence", () => {
    const task = { id: "x", prompt: "Change x" };
    const result = {
      exitCode: 0,
      timedOut: false,
      diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n-old\n+new\n",
      stats: {
        turns: 0,
        toolCalls: {},
        toolCallTotal: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        malformedLines: 0,
      },
      receipts: [{ command: "pnpm test", exitCode: 0 }],
    };
    const dossier = buildTaskDossier(task, undefined, summarizeTaskEvidence(result));
    expect(dossier.evidence?.git).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1 });
    expect(dossier.evidence?.receipts[0]).toMatchObject({ command: "pnpm test", ok: true });
    expect(JSON.stringify(dossier)).not.toContain("-old");
  });

  it("atomically persists and reloads one versioned record per task", () => {
    const directory = mkdtempSync(join(tmpdir(), "milo-task-records-"));
    temporary.push(directory);
    const store = new JsonTaskRecordStore(directory);
    const task = { id: "task/unsafe", prompt: "Do the work" };
    const rubric = compileTaskRubric(task);
    const record: TaskRecord = {
      version: TASK_RECORD_VERSION,
      task,
      rubric,
      dossier: buildTaskDossier(task, rubric),
      lifecycle: "running",
      worktreePath: "/work/task",
      branch: "fleet/task",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:01.000Z",
      obligations: [],
    };
    store.save(record);
    expect(store.get(task.id)).toEqual(record);
    expect(store.list()).toEqual([record]);
    const names = readFileSync(join(directory, `${requireHash(task.id)}.json`), "utf8");
    expect(names).toContain('"version": 2');
  });
});

function requireHash(value: string): string {
  // Kept local so the assertion also proves task ids never become path names.
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
