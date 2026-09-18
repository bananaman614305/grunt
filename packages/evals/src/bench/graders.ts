/**
 * Outcome graders for the benchmark, keyed by routing-set example id and
 * committed at `packages/evals/data/graders.jsonl`.
 *
 * A grader is either mechanical (regex, substring checks, or an `all` of
 * those), which scores 0 or 1 with no model involved, or a `judge`, which a
 * grading model scores 0..1 against a rubric and a `must` list. Mechanical
 * graders are preferred wherever a correct answer has an unambiguous token;
 * the judge is for docs, review, research and open-ended engineering work.
 * A `judge` may not sit inside an `all`, so a grader is either entirely
 * mechanical or entirely judged.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChatMessage } from "@milo/core";
import type { Grade } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the committed graders. */
export const DEFAULT_GRADERS_PATH = resolve(__dirname, "../../data/graders.jsonl");

/** A judge score at or above this passes. */
export const JUDGE_PASS_THRESHOLD = 0.7;

export type Grader =
  | { type: "regex"; pattern: string; flags?: string | undefined }
  | { type: "contains_all"; values: string[] }
  | { type: "contains_any"; values: string[] }
  | { type: "not_contains"; values: string[] }
  | { type: "all"; graders: Grader[] }
  | { type: "judge"; rubric: string; must?: string[] | undefined };

const values = z.array(z.string().min(1)).min(1);

export const graderSchema: z.ZodType<Grader> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("regex"), pattern: z.string().min(1), flags: z.string().optional() }),
    z.object({ type: z.literal("contains_all"), values }),
    z.object({ type: z.literal("contains_any"), values }),
    z.object({ type: z.literal("not_contains"), values }),
    z.object({ type: z.literal("all"), graders: z.array(graderSchema).min(1) }),
    z.object({ type: z.literal("judge"), rubric: z.string().min(1), must: z.array(z.string().min(1)).optional() }),
  ]),
);

export const graderRowSchema = z.object({
  id: z.string().min(1),
  grader: graderSchema,
  why: z.string().optional(),
});

export type GraderRow = z.infer<typeof graderRowSchema>;

/** True when no model is needed to score this grader. */
export function isMechanical(grader: Grader): boolean {
  if (grader.type === "judge") return false;
  if (grader.type === "all") return grader.graders.every(isMechanical);
  return true;
}

/** Throws if a regex will not compile or a judge is nested inside an `all`. */
export function validateGrader(grader: Grader, path = "grader"): void {
  switch (grader.type) {
    case "regex":
      new RegExp(grader.pattern, grader.flags);
      return;
    case "all":
      if (grader.graders.some((g) => !isMechanical(g))) {
        throw new Error(`${path}: a judge cannot be combined inside "all"`);
      }
      grader.graders.forEach((g, i) => validateGrader(g, `${path}.graders[${i}]`));
      return;
    default:
      return;
  }
}

/** Reads and validates the graders file. Throws with the line number on a bad row. */
export function loadGraders(path: string = DEFAULT_GRADERS_PATH): Map<string, GraderRow> {
  const rows = new Map<string, GraderRow>();
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const where = `${path}:${index + 1}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`${where}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      const result = graderRowSchema.safeParse(parsed);
      if (!result.success) throw new Error(`${where}: ${result.error.message}`);
      try {
        validateGrader(result.data.grader);
      } catch (error) {
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (rows.has(result.data.id)) throw new Error(`${where}: duplicate id ${result.data.id}`);
      rows.set(result.data.id, result.data);
    });
  return rows;
}

// ---------------------------------------------------------------------------
// Mechanical grading
// ---------------------------------------------------------------------------

function includes(text: string, value: string): boolean {
  return text.toLowerCase().includes(value.toLowerCase());
}

/** Scores `text` against a mechanical grader. Returns `undefined` for a judge. */
export function gradeMechanically(grader: Grader, text: string): Grade | undefined {
  switch (grader.type) {
    case "regex": {
      const pass = new RegExp(grader.pattern, grader.flags).test(text);
      return { score: pass ? 1 : 0, pass, by: "mechanical", reason: pass ? "pattern matched" : "pattern did not match" };
    }
    case "contains_all": {
      const missing = grader.values.filter((v) => !includes(text, v));
      const pass = missing.length === 0;
      return { score: pass ? 1 : 0, pass, by: "mechanical", reason: pass ? "all values present" : `missing: ${missing.join(", ")}` };
    }
    case "contains_any": {
      const pass = grader.values.some((v) => includes(text, v));
      return { score: pass ? 1 : 0, pass, by: "mechanical", reason: pass ? "a value was present" : "none of the values present" };
    }
    case "not_contains": {
      const found = grader.values.filter((v) => includes(text, v));
      const pass = found.length === 0;
      return { score: pass ? 1 : 0, pass, by: "mechanical", reason: pass ? "no forbidden value" : `found: ${found.join(", ")}` };
    }
    case "all": {
      const grades = grader.graders.map((g) => gradeMechanically(g, text));
      const failed = grades.find((g) => g !== undefined && !g.pass);
      if (grades.some((g) => g === undefined)) return undefined;
      const pass = failed === undefined;
      return { score: pass ? 1 : 0, pass, by: "mechanical", reason: pass ? "every check passed" : (failed.reason ?? "a check failed") };
    }
    case "judge":
      return undefined;
    default: {
      const exhaustive: never = grader;
      throw new Error(`unknown grader: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  return "";
}

/** The judge's conversation: the task, the answer, the rubric, and a strict JSON verdict format. */
export function buildJudgeMessages(
  task: ChatMessage[],
  answer: string,
  grader: Extract<Grader, { type: "judge" }>,
): ChatMessage[] {
  const transcript = task.map((m) => `[${m.role}]\n${messageText(m)}`).join("\n\n");
  const must = (grader.must ?? []).map((m, i) => `${i + 1}. ${m}`).join("\n");
  const user = [
    "You are grading an AI assistant's answer to a task. Be strict and concrete.",
    "",
    "## Task (the conversation the assistant received)",
    transcript,
    "",
    "## Assistant's answer",
    answer.trim() === "" ? "(empty answer)" : answer,
    "",
    "## Rubric",
    grader.rubric,
    must === "" ? "" : `\n## Must (missing any one of these fails the answer)\n${must}`,
    "",
    "Reply with exactly one JSON object and nothing else:",
    '{"score": <number 0 to 1>, "pass": <true|false>, "reason": "<one sentence>"}',
    `Score 1 means fully correct and high quality; below ${JUDGE_PASS_THRESHOLD} means it fails.`,
  ].join("\n");
  return [{ role: "user", content: user }];
}

/** Parses the judge's verdict. A malformed reply scores 0 and says so. */
export function parseJudgeVerdict(text: string): Grade {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { score: 0, pass: false, by: "judge", reason: "judge returned no JSON" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { score: 0, pass: false, by: "judge", reason: "judge returned invalid JSON" };
  }
  const verdict = parsed as { score?: unknown; pass?: unknown; reason?: unknown };
  const score = typeof verdict.score === "number" && Number.isFinite(verdict.score) ? Math.min(1, Math.max(0, verdict.score)) : 0;
  const pass = typeof verdict.pass === "boolean" ? verdict.pass && score >= JUDGE_PASS_THRESHOLD : score >= JUDGE_PASS_THRESHOLD;
  const reason = typeof verdict.reason === "string" ? verdict.reason : undefined;
  return { score, pass, by: "judge", ...(reason !== undefined ? { reason } : {}) };
}
