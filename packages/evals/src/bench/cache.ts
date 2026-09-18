/**
 * The judge verdict cache, and the deterministic audit pick.
 *
 * A judge verdict is a temperature-0 call determined entirely by what the
 * judge saw: the example, the grader's content, the judge model, and the
 * answer text. Caching it by a hash of those four makes a rerun over
 * unchanged answers free, which is what makes the benchmark cheap to iterate
 * on. Mechanical grades cost nothing and are never cached.
 *
 * One JSON file per verdict under `packages/evals/.judge-cache/` (gitignored),
 * named by the sha256 key, so entries are inspectable and individually
 * deletable. A stored file keeps the verdict's original cost for inspection,
 * but `get` strips it: a hit is free, so summing `judgeCostUsd` over a report
 * counts fresh calls only.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Grader } from "./graders.js";
import type { Grade } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default cache location: inside the package, out of git. */
export const DEFAULT_JUDGE_CACHE_DIR = resolve(__dirname, "../../.judge-cache");

/** sha256 hex of the grader's JSON: any change to the rubric invalidates its cached verdicts. */
export function graderContentHash(grader: Grader): string {
  return createHash("sha256").update(JSON.stringify(grader)).digest("hex");
}

export type VerdictKeyInput = {
  exampleId: string;
  /** From `graderContentHash`. */
  graderHash: string;
  judgeModel: string;
  /** The answer text being judged. */
  answer: string;
};

/** The cache key: sha256 over everything that determines a verdict. */
export function verdictKey(input: VerdictKeyInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.exampleId, input.graderHash, input.judgeModel, input.answer]))
    .digest("hex");
}

/**
 * Deterministic audit pick: an answer slot (example id plus arm) hashes to a
 * point in [0, 1) and is audited when that point falls below the fraction.
 * The same slot is picked in every run, so reruns audit the same answers,
 * and raising the fraction only ever adds slots, never swaps them.
 */
export function auditSelected(exampleId: string, armKey: string, fraction: number): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  const hash = createHash("sha256").update(`${exampleId}\n${armKey}`).digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000 < fraction;
}

/** What the runner needs from a cache; `JudgeCache` is the on-disk one. */
export type JudgeCacheLike = {
  get(key: string): Grade | undefined;
  set(key: string, grade: Grade): void;
};

export class JudgeCache implements JudgeCacheLike {
  constructor(readonly dir: string = DEFAULT_JUDGE_CACHE_DIR) {}

  private path(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`not a verdict key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  /** The cached verdict without its original cost (a hit is free), or undefined on a miss or an unreadable entry. */
  get(key: string): Grade | undefined {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const stored = parsed as { score?: unknown; pass?: unknown; reason?: unknown };
    if (typeof stored.score !== "number" || typeof stored.pass !== "boolean") return undefined;
    return {
      score: stored.score,
      pass: stored.pass,
      by: "judge",
      ...(typeof stored.reason === "string" ? { reason: stored.reason } : {}),
    };
  }

  /** Stores a verdict, cost included for inspection; any audit on the grade is not part of the verdict and is dropped. */
  set(key: string, grade: Grade): void {
    mkdirSync(this.dir, { recursive: true });
    const verdict: Record<string, unknown> = { score: grade.score, pass: grade.pass, by: grade.by };
    if (grade.reason !== undefined) verdict["reason"] = grade.reason;
    if (grade.judgeCostUsd !== undefined) verdict["judgeCostUsd"] = grade.judgeCostUsd;
    writeFileSync(this.path(key), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }
}
