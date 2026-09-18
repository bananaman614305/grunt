/**
 * SWE-bench (Verified) instance schema, JSONL loader, and subset selection.
 *
 * Milo's SWE-bench harness never downloads the dataset itself: the operator
 * supplies a local JSONL export (`--dataset <path>`), and this module reads,
 * validates, and subsets it. We keep only the fields the generator needs to
 * drive the agent plus the grading fields the official evaluator will consume,
 * carried through untouched for reference.
 *
 * `FAIL_TO_PASS` / `PASS_TO_PASS` arrive in the wild either as JSON arrays or
 * as JSON-encoded strings (the Verified parquet export stringifies them), so
 * the schema accepts both and normalizes to `string[]`.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** A JSON list of test ids that may be given inline or as a JSON string. */
const testListSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return value; // let the array check below produce a readable error
  }
}, z.array(z.string()));

/**
 * The slice of a SWE-bench instance the harness uses. `instance_id`, `repo`,
 * `base_commit`, and `problem_statement` drive generation; the rest are the
 * grading fields, validated and carried through so a prediction can be traced
 * back to its instance without re-reading the dataset.
 */
export const swebenchInstanceSchema = z.object({
  instance_id: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be '<owner>/<name>'"),
  base_commit: z.string().min(1),
  problem_statement: z.string().min(1),
  FAIL_TO_PASS: testListSchema,
  PASS_TO_PASS: testListSchema,
  test_patch: z.string().default(""),
  patch: z.string().default(""),
});

export type SwebenchInstance = z.infer<typeof swebenchInstanceSchema>;

/** Parse one JSONL line into a validated instance, tagging errors with context. */
export function parseInstanceLine(line: string, lineNumber: number): SwebenchInstance {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    throw new Error(`dataset line ${lineNumber}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = swebenchInstanceSchema.safeParse(json);
  if (!parsed.success) {
    const id = typeof (json as { instance_id?: unknown })?.instance_id === "string"
      ? (json as { instance_id: string }).instance_id
      : `line ${lineNumber}`;
    throw new Error(`dataset instance ${id}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Load and validate a SWE-bench JSONL dataset from disk. Blank lines are
 * skipped; any malformed or invalid instance aborts the load with a message
 * naming the offending line/instance, so a bad export cannot silently shrink
 * the run. Duplicate `instance_id`s are rejected for the same reason.
 */
export function loadInstances(path: string): SwebenchInstance[] {
  const text = readFileSync(path, "utf8");
  const instances: SwebenchInstance[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    const instance = parseInstanceLine(raw, i + 1);
    if (seen.has(instance.instance_id)) {
      throw new Error(`dataset instance ${instance.instance_id}: duplicate instance_id`);
    }
    seen.add(instance.instance_id);
    instances.push(instance);
  }
  if (instances.length === 0) throw new Error(`dataset ${path} contained no instances`);
  return instances;
}

/**
 * Narrow a loaded dataset to the requested subset. `selection` is a list of
 * `instance_id`s or "all"; an unknown id is an error rather than a silent skip.
 * `limit`, when set, keeps at most the first N of the (already selected,
 * dataset-ordered) instances.
 */
export function selectInstances(
  instances: SwebenchInstance[],
  selection: string[] | "all",
  limit?: number,
): SwebenchInstance[] {
  let chosen: SwebenchInstance[];
  if (selection === "all") {
    chosen = [...instances];
  } else {
    const byId = new Map(instances.map((inst) => [inst.instance_id, inst]));
    const missing = selection.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`unknown instance id(s): ${missing.join(", ")}`);
    const wanted = [...new Set(selection)];
    chosen = wanted.map((id) => byId.get(id) as SwebenchInstance);
  }
  if (limit !== undefined && limit >= 0 && limit < chosen.length) {
    chosen = chosen.slice(0, limit);
  }
  return chosen;
}
