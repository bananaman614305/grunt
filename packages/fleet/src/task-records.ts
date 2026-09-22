/**
 * Durable task records and compact Jev dossiers.
 *
 * Rubrics are compiled mechanically from planner-owned task input. This costs
 * no model call and never asks the worker to run another tool. The resulting
 * dossier is reused by the fleet's existing supervision and done-gate calls.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitStateFromDiff, normalizeReceipts } from "@milo/core";
import type { Receipt } from "@milo/core";
import type { DoneVerification } from "./done-gate.js";
import type { Task, WorkerClassification, WorkerLifecycle, WorkerResult } from "./types.js";

export const TASK_RECORD_VERSION = 1 as const;
export const MAX_RUBRIC_CRITERIA = 8;
export const MAX_CRITERION_CHARS = 240;
export const MAX_DOSSIER_PATHS = 24;
export const MAX_DOSSIER_RECEIPTS = 12;

export type TaskRubricCriterion = {
  id: string;
  text: string;
  source: "acceptance" | "prompt" | "fallback";
};

export type TaskRubric = {
  criteria: TaskRubricCriterion[];
};

export type TaskEvidence = {
  exitCode: number | null;
  timedOut: boolean;
  git: {
    clean: boolean;
    filesChanged: number;
    insertions: number;
    deletions: number;
    paths: string[];
  };
  receipts: Receipt[];
  verification?: Pick<DoneVerification, "verdict" | "confidence" | "contradicted" | "line">;
};

/** The bounded, task-specific state sent to Jev and persisted for review. */
export type TaskDossier = {
  task: {
    id: string;
    title?: string;
    goal: string;
  };
  rubric: TaskRubric;
  evidence?: TaskEvidence;
};

export type TaskRecord = {
  version: typeof TASK_RECORD_VERSION;
  task: Task;
  rubric: TaskRubric;
  dossier: TaskDossier;
  lifecycle: WorkerLifecycle;
  worktreePath: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  classification?: WorkerClassification;
};

function compactLine(value: string, max = MAX_CRITERION_CHARS): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function promptChecklist(prompt: string): string[] {
  const out: string[] = [];
  for (const raw of prompt.split("\n")) {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/.exec(raw);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Compile a stable, bounded rubric without a model call. */
export function compileTaskRubric(task: Task): TaskRubric {
  const candidates: Array<{ text: string; source: TaskRubricCriterion["source"] }> = [
    ...(task.acceptanceCriteria ?? [])
      .filter((text): text is string => typeof text === "string")
      .map((text) => ({ text, source: "acceptance" as const })),
    ...promptChecklist(task.prompt).map((text) => ({ text, source: "prompt" as const })),
  ];

  const seen = new Set<string>();
  const criteria: TaskRubricCriterion[] = [];
  for (const candidate of candidates) {
    const text = compactLine(candidate.text);
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    criteria.push({ id: `criterion-${criteria.length + 1}`, text, source: candidate.source });
    if (criteria.length === MAX_RUBRIC_CRITERIA) break;
  }
  if (criteria.length === 0) {
    const first = task.prompt.split("\n").find((line) => line.trim() !== "") ?? task.title ?? task.id;
    criteria.push({ id: "criterion-1", text: compactLine(`Complete the assigned task: ${first}`), source: "fallback" });
  }
  return { criteria };
}

function taskGoal(task: Task): string {
  const first = task.prompt.split("\n").find((line) => line.trim() !== "") ?? task.id;
  return compactLine(first);
}

/** Reduce real worker output to the evidence Jev and the durable record need. */
export function summarizeTaskEvidence(
  result: WorkerResult,
  verification?: DoneVerification,
): TaskEvidence {
  const git = gitStateFromDiff(result.diff);
  const evidence: TaskEvidence = {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    git: {
      clean: git.clean,
      filesChanged: git.filesChanged,
      insertions: git.insertions,
      deletions: git.deletions,
      paths: git.files.map((file) => file.path).slice(0, MAX_DOSSIER_PATHS),
    },
    receipts: normalizeReceipts(result.receipts ?? []).slice(0, MAX_DOSSIER_RECEIPTS),
  };
  if (verification !== undefined) {
    evidence.verification = {
      verdict: verification.verdict,
      confidence: verification.confidence,
      contradicted: verification.contradicted,
      line: verification.line,
    };
  }
  return evidence;
}

export function buildTaskDossier(
  task: Task,
  rubric = compileTaskRubric(task),
  evidence?: TaskEvidence,
): TaskDossier {
  return {
    task: {
      id: task.id,
      ...(task.title !== undefined && task.title.trim() !== "" ? { title: compactLine(task.title) } : {}),
      goal: taskGoal(task),
    },
    rubric,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

export interface TaskRecordStore {
  save(record: TaskRecord): void;
  get(taskId: string): TaskRecord | undefined;
  list(): TaskRecord[];
}

export class MemoryTaskRecordStore implements TaskRecordStore {
  private readonly records = new Map<string, TaskRecord>();

  save(record: TaskRecord): void {
    this.records.set(record.task.id, structuredClone(record));
  }

  get(taskId: string): TaskRecord | undefined {
    const record = this.records.get(taskId);
    return record === undefined ? undefined : structuredClone(record);
  }

  list(): TaskRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

/** One atomically replaced JSON file per task; ids are hashed for safe paths. */
export class JsonTaskRecordStore implements TaskRecordStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
  }

  private pathFor(taskId: string): string {
    const hash = createHash("sha256").update(taskId).digest("hex").slice(0, 16);
    return join(this.directory, `${hash}.json`);
  }

  save(record: TaskRecord): void {
    const path = this.pathFor(record.task.id);
    const temporary = join(this.directory, `.${basename(path)}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  get(taskId: string): TaskRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(taskId), "utf8")) as TaskRecord;
      return parsed.version === TASK_RECORD_VERSION && parsed.task?.id === taskId ? parsed : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  list(): TaskRecord[] {
    const records: TaskRecord[] = [];
    for (const name of readdirSync(this.directory).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as TaskRecord;
        if (parsed.version === TASK_RECORD_VERSION && typeof parsed.task?.id === "string") records.push(parsed);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.task.id.localeCompare(b.task.id));
  }
}
