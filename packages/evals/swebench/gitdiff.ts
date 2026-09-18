/**
 * Capture the agent's edits to a checked-out repo as a unified diff, in the
 * exact shape the SWE-bench evaluator expects for `model_patch`.
 *
 * The capture is `git -C <workdir> add -A` followed by `git -C <workdir> diff
 * --cached` (staged diff against HEAD), so new, modified, and deleted files
 * are all included regardless of the repo's ignore rules for tracked paths.
 * A run that changed nothing yields an empty patch, reported as such rather
 * than as a failure.
 *
 * `git` runs synchronously here (the diff is small and local); the network- and
 * agent-driven parts of a run live in `generate.ts`. Because this only shells
 * out to a local repo, it is unit-tested against a real temporary git repo the
 * test creates, with no network.
 */

import { execFileSync } from "node:child_process";

export type CapturedPatch = {
  /** Normalized unified diff; "" when the working tree matched the base. */
  patch: string;
  /** True when the diff is empty (no changes to submit). */
  empty: boolean;
};

/**
 * Normalize a raw `git diff` into the stored patch: strip a leading BOM, drop
 * trailing whitespace, and guarantee a single trailing newline on a non-empty
 * diff (SWE-bench applies patches with `git apply`, which wants that newline).
 * An all-whitespace diff normalizes to "".
 */
export function normalizeDiff(raw: string): string {
  const stripped = raw.replace(/^﻿/, "").replace(/[ \t\r\n]+$/, "");
  return stripped === "" ? "" : stripped + "\n";
}

function git(workdir: string, args: string[]): string {
  return execFileSync("git", ["-C", workdir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Stage every change in `workdir` and return the staged diff against HEAD as a
 * normalized `model_patch`. Throws only if `git` itself fails (not a git repo,
 * git missing); an empty working tree is a normal `{ patch: "", empty: true }`.
 */
export function captureModelPatch(workdir: string): CapturedPatch {
  git(workdir, ["add", "-A"]);
  const raw = git(workdir, ["diff", "--cached"]);
  const patch = normalizeDiff(raw);
  return { patch, empty: patch === "" };
}
