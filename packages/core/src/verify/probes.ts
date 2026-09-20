/**
 * Git-probe and receipt parsing (ADR-019): turn the raw output of read-only
 * git commands and the harness's receipts into the structured `GitProbeState`
 * and normalized `Receipt[]` the auditor reasons over. All pure, no I/O -- the
 * caller (a hook, the fleet, a request) runs the commands; this only parses.
 *
 * The probes are the "cannot lie" half of ground truth: `git status`,
 * `git diff`, `git log` taken at the instant of the check. Parsing is tolerant
 * -- unfamiliar lines are ignored rather than rejected -- because a probe that
 * fails to parse must never fail the check (fail-open, ADR-019).
 */

import type { GitFileChange, GitProbeState, Receipt } from "./types.js";

/** How much raw diff to keep in the ground-truth state, chars. */
export const MAX_DIFF_CHARS = 12_000;

/** The raw probe strings a caller collects and hands in. */
export type GitProbeInput = {
  /** `git status --porcelain` (preferred) or `git status`. */
  status?: string;
  /** `git diff` (unified) and/or `git diff --numstat`; either is parsed. */
  diff?: string;
  /** `git diff --numstat`, when collected separately from the unified diff. */
  numstat?: string;
  /** `git log --oneline -n` or `git log --format=%s`. */
  log?: string;
};

function clip(s: string, max = MAX_DIFF_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

/** Parse `git status --porcelain` lines into per-file changes. */
function parsePorcelain(status: string): { files: GitFileChange[]; untracked: number } {
  const files: GitFileChange[] = [];
  let untracked = 0;
  for (const raw of status.split("\n")) {
    if (raw.trim() === "") continue;
    // Porcelain v1: XY<space>path, where X is staged, Y is worktree.
    const code = raw.slice(0, 2);
    const path = raw.slice(3).trim();
    if (path === "" || code.trim() === "") continue;
    if (code === "??") {
      untracked += 1;
      files.push({ path, status: "??", staged: false });
      continue;
    }
    const staged = code[0] !== " " && code[0] !== "?";
    files.push({ path, status: code.trim(), staged });
  }
  return { files, untracked };
}

/** Parse `git diff --numstat` ("<ins>\t<del>\t<path>") into per-file counts. */
function parseNumstat(numstat: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>();
  for (const raw of numstat.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const parts = line.split(/\t+/);
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "", 10);
    const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "", 10);
    const path = parts.slice(2).join("\t").trim();
    if (path === "") continue;
    out.set(path, { insertions: Number.isFinite(ins) ? ins : 0, deletions: Number.isFinite(del) ? del : 0 });
  }
  return out;
}

/** Count +/- lines in a raw unified diff (ignoring the +++/--- headers). */
function countUnified(diff: string): { insertions: number; deletions: number; files: Set<string> } {
  let insertions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("diff --git")) {
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m?.[2] !== undefined) files.add(m[2]);
      continue;
    }
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions, files };
}

/** Parse `git log --oneline` / `--format=%s` into a list of commit subjects. */
function parseLog(log: string): string[] {
  return log
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    // `--oneline` prefixes a short hash; drop it if present, keep the subject.
    .map((l) => l.replace(/^[0-9a-f]{7,40}\s+/i, ""));
}

/**
 * Parse the raw git probes into a `GitProbeState`. Every field degrades
 * gracefully: a missing probe just leaves its part empty, never throws.
 */
export function parseGitProbes(input: GitProbeInput): GitProbeState {
  const { files, untracked } = input.status !== undefined ? parsePorcelain(input.status) : { files: [], untracked: 0 };

  let insertions = 0;
  let deletions = 0;
  const numstat = input.numstat !== undefined ? parseNumstat(input.numstat) : new Map();
  if (numstat.size > 0) {
    for (const [path, counts] of numstat) {
      insertions += counts.insertions;
      deletions += counts.deletions;
      const file = files.find((f) => f.path === path);
      if (file !== undefined) {
        file.insertions = counts.insertions;
        file.deletions = counts.deletions;
      }
    }
  } else if (input.diff !== undefined) {
    const counted = countUnified(input.diff);
    insertions = counted.insertions;
    deletions = counted.deletions;
  }

  const changedPaths = new Set(files.filter((f) => f.status !== "??").map((f) => f.path));
  // A diff with no status probe still tells us files changed.
  if (input.diff !== undefined && changedPaths.size === 0) {
    for (const p of countUnified(input.diff).files) changedPaths.add(p);
  }

  const recentCommits = input.log !== undefined ? parseLog(input.log) : [];
  const filesChanged = changedPaths.size;
  const clean = files.length === 0 && input.diff !== undefined ? input.diff.trim() === "" : files.length === 0;

  const state: GitProbeState = {
    clean: filesChanged === 0 && untracked === 0 && clean,
    files,
    filesChanged,
    insertions,
    deletions,
    untracked,
    recentCommits,
  };
  if (input.diff !== undefined && input.diff.trim() !== "") state.diff = clip(input.diff);
  return state;
}

/** Build a `GitProbeState` from an already-captured unified diff (the fleet). */
export function gitStateFromDiff(diff: string): GitProbeState {
  return parseGitProbes({ diff });
}

/** Normalize a receipt: fill `ok` from `exitCode` when it was not stated. */
export function normalizeReceipt(receipt: Receipt): Receipt {
  const ok = receipt.ok ?? (receipt.exitCode === undefined ? undefined : receipt.exitCode === 0);
  return ok === undefined ? { ...receipt } : { ...receipt, ok };
}

/** Normalize an array of receipts, dropping ones with no command. */
export function normalizeReceipts(receipts: readonly Receipt[]): Receipt[] {
  return receipts.filter((r) => typeof r.command === "string" && r.command.trim() !== "").map(normalizeReceipt);
}
