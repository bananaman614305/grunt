import { describe, expect, it } from "vitest";
import { gitStateFromDiff, normalizeReceipts, parseGitProbes } from "./probes.js";

describe("parseGitProbes", () => {
  it("parses porcelain status into staged/unstaged/untracked", () => {
    const status = "M  src/a.ts\n M src/b.ts\n?? src/c.ts\nA  src/d.ts";
    const state = parseGitProbes({ status });
    expect(state.clean).toBe(false);
    expect(state.untracked).toBe(1);
    expect(state.filesChanged).toBe(3); // a, b, d — the untracked c is not "changed"
    const a = state.files.find((f) => f.path === "src/a.ts");
    expect(a?.staged).toBe(true);
    const b = state.files.find((f) => f.path === "src/b.ts");
    expect(b?.staged).toBe(false);
    const c = state.files.find((f) => f.path === "src/c.ts");
    expect(c?.status).toBe("??");
  });

  it("reports a clean tree", () => {
    const state = parseGitProbes({ status: "", diff: "" });
    expect(state.clean).toBe(true);
    expect(state.filesChanged).toBe(0);
    expect(state.diff).toBeUndefined();
  });

  it("counts insertions/deletions from numstat and attaches them per file", () => {
    const status = "M  src/a.ts";
    const numstat = "10\t2\tsrc/a.ts\n3\t0\tsrc/new.ts";
    const state = parseGitProbes({ status, numstat });
    expect(state.insertions).toBe(13);
    expect(state.deletions).toBe(2);
    expect(state.files.find((f) => f.path === "src/a.ts")?.insertions).toBe(10);
  });

  it("counts +/- lines from a raw unified diff when no numstat is given", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1;",
      "+const y = 2;",
      "-const z = 3;",
    ].join("\n");
    const state = parseGitProbes({ diff });
    expect(state.insertions).toBe(1);
    expect(state.deletions).toBe(1);
    expect(state.filesChanged).toBe(1);
    expect(state.diff).toContain("const y = 2;");
  });

  it("parses commit subjects from oneline and format logs", () => {
    expect(parseGitProbes({ log: "a1b2c3d Add the verify module\ne4f5a6b Fix the parser" }).recentCommits).toEqual([
      "Add the verify module",
      "Fix the parser",
    ]);
    expect(parseGitProbes({ log: "Add the verify module\nFix the parser" }).recentCommits).toEqual([
      "Add the verify module",
      "Fix the parser",
    ]);
  });

  it("clips a very large diff", () => {
    const huge = `diff --git a/x b/x\n${"+line\n".repeat(5000)}`;
    const state = parseGitProbes({ diff: huge });
    expect(state.diff?.endsWith("…[truncated]")).toBe(true);
  });

  it("gitStateFromDiff builds a state from a captured diff (the fleet path)", () => {
    const state = gitStateFromDiff("diff --git a/f b/f\n+added\n");
    expect(state.filesChanged).toBe(1);
    expect(state.insertions).toBe(1);
    expect(gitStateFromDiff("").clean).toBe(true);
  });
});

describe("normalizeReceipts", () => {
  it("derives ok from exit code and drops command-less receipts", () => {
    const receipts = normalizeReceipts([
      { command: "pnpm test", exitCode: 0 },
      { command: "pnpm build", exitCode: 1 },
      { command: "manual", ok: true },
      { command: "   ", exitCode: 0 },
    ]);
    expect(receipts).toHaveLength(3);
    expect(receipts[0]?.ok).toBe(true);
    expect(receipts[1]?.ok).toBe(false);
    expect(receipts[2]?.ok).toBe(true);
  });
});
