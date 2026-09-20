import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./verify.js";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "milo-verify-cli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.length = 0; // temp dirs are cleaned by the OS; no cross-test state kept here
});

describe("milo verify install", () => {
  it("prints help and exits 0 on --help", async () => {
    const { deps, stdout } = createTestDeps();
    expect(await run(["--help"], deps)).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo verify install");
  });

  it("rejects an unknown harness", async () => {
    const { deps, stderr } = createTestDeps();
    expect(await run(["install", "emacs"], deps)).toBe(1);
    expect(stderr.toString()).toContain("pick a harness");
  });

  it("rejects an unknown subcommand", async () => {
    const { deps, stderr } = createTestDeps();
    expect(await run(["frobnicate"], deps)).toBe(1);
    expect(stderr.toString()).toContain("unknown subcommand");
  });

  it("installs the hook script and wires claude-code settings.json", async () => {
    const root = tempRoot();
    const { deps, stdout } = createTestDeps();
    const code = await run(["install", "claude-code", "--dir", root], deps);
    expect(code).toBe(0);

    const hookPath = join(root, "milo-verify-hook.mjs");
    expect(existsSync(hookPath)).toBe(true);
    // executable bit set
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(hookPath, "utf8")).toContain("/v1/verify");

    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain("milo-verify-hook.mjs");
    expect(stdout.toString()).toContain("Installed the Milo ground-truth Stop hook for claude-code");
  });

  it("preserves an existing claude-code config and is idempotent", async () => {
    const root = tempRoot();
    const { deps } = createTestDeps();
    // Seed an existing settings.json with an unrelated key.
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "settings.json"), JSON.stringify({ model: "milo/auto" }));

    await run(["install", "claude-code", "--dir", root], deps);
    await run(["install", "claude-code", "--dir", root], deps); // twice

    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as {
      model: string;
      hooks: { Stop: unknown[] };
    };
    expect(settings.model).toBe("milo/auto");
    expect(settings.hooks.Stop).toHaveLength(1); // no duplicate
  });

  it("installs a codex TOML config", async () => {
    const root = tempRoot();
    const { deps } = createTestDeps();
    expect(await run(["install", "codex", "--dir", root], deps)).toBe(0);
    expect(existsSync(join(root, "milo-verify-hook.mjs"))).toBe(true);
    expect(readFileSync(join(root, "config.toml"), "utf8")).toContain("[hooks]");
  });

  it("installs a goose YAML config", async () => {
    const root = tempRoot();
    const { deps } = createTestDeps();
    expect(await run(["install", "goose", "--dir", root], deps)).toBe(0);
    expect(readFileSync(join(root, "config.yaml"), "utf8")).toContain("stop:");
  });

  it("errors clearly with neither --dir nor HOME", async () => {
    const { deps, stderr } = createTestDeps({ env: {} });
    expect(await run(["install", "claude-code"], deps)).toBe(1);
    expect(stderr.toString()).toContain("no HOME set");
  });
});
