import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureModelPatch, normalizeDiff } from "./gitdiff.js";

/**
 * These tests exercise the real `git` binary against a temporary local repo the
 * test builds from scratch -- no network, no clone, no remote. That is exactly
 * how the harness captures a patch in production, minus the agent that makes the
 * edit, so the diff shape is validated end to end.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

describe("normalizeDiff", () => {
  it("guarantees a single trailing newline on a non-empty diff", () => {
    expect(normalizeDiff("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")).toBe("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(normalizeDiff("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n\n\n")).toBe("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n");
  });

  it("maps an all-whitespace diff to the empty string", () => {
    expect(normalizeDiff("")).toBe("");
    expect(normalizeDiff("   \n\n")).toBe("");
  });
});

describe("captureModelPatch", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "milo-swebench-git-"));
    git(repo, ["init", "--quiet", "-b", "main"]);
    writeFileSync(join(repo, "app.py"), "def greet():\n    return 'hi'\n");
    writeFileSync(join(repo, "keep.txt"), "unchanged\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "base"]);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns an empty patch for a no-op run (working tree matches base)", () => {
    const captured = captureModelPatch(repo);
    expect(captured.empty).toBe(true);
    expect(captured.patch).toBe("");
  });

  it("captures a correct unified diff for a modified file", () => {
    writeFileSync(join(repo, "app.py"), "def greet():\n    return 'hello'\n");
    const captured = captureModelPatch(repo);
    expect(captured.empty).toBe(false);
    expect(captured.patch).toContain("diff --git a/app.py b/app.py");
    expect(captured.patch).toContain("-    return 'hi'");
    expect(captured.patch).toContain("+    return 'hello'");
    // Untouched files must not appear in the diff.
    expect(captured.patch).not.toContain("keep.txt");
    // Normalized: ends with exactly one newline.
    expect(captured.patch.endsWith("\n")).toBe(true);
    expect(captured.patch.endsWith("\n\n")).toBe(false);
  });

  it("includes a newly added file (git add -A stages new paths)", () => {
    writeFileSync(join(repo, "new_module.py"), "VALUE = 42\n");
    const captured = captureModelPatch(repo);
    expect(captured.patch).toContain("new file mode");
    expect(captured.patch).toContain("new_module.py");
    expect(captured.patch).toContain("+VALUE = 42");
  });
});
