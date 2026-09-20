import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookScript } from "./hook-script.js";

describe("hookScript", () => {
  const script = hookScript();

  it("is valid JavaScript (node --check passes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-hook-"));
    const path = join(dir, "milo-verify-hook.mjs");
    writeFileSync(path, script);
    // Throws (non-zero exit) if the generated script is not syntactically valid.
    expect(() => execFileSync(process.execPath, ["--check", path], { stdio: "pipe" })).not.toThrow();
  });

  it("posts to /v1/verify with a Milo key, never a TypeSafe key", () => {
    expect(script).toContain("/v1/verify");
    expect(script).toContain("MILO_KEY");
    expect(script).toContain("MILO_ENDPOINT");
    expect(script).not.toContain("TYPESAFE");
    expect(script).not.toContain("api.typesafe.ai");
  });

  it("runs read-only git probes", () => {
    expect(script).toContain("status --porcelain");
    expect(script).toContain("diff --numstat");
    expect(script).toContain("log --oneline");
  });

  it("is fail-open and warn-primary with an opt-in, capped block", () => {
    expect(script).toContain("MILO_VERIFY_BLOCK");
    expect(script).toContain("MAX_SESSION_BLOCKS = 2");
    expect(script).toContain("catch(() => process.exit(0))");
  });

  it("persists git-tracked case law", () => {
    expect(script).toContain("caselaw.json");
  });
});
