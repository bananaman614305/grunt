import { describe, expect, it } from "vitest";
import {
  appendHookBlock,
  defaultRoot,
  hookCommand,
  isHarness,
  mergeClaudeSettings,
  planInstall,
} from "./config.js";

describe("isHarness / defaultRoot", () => {
  it("recognizes the three harnesses", () => {
    expect(isHarness("claude-code")).toBe(true);
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("goose")).toBe(true);
    expect(isHarness("nope")).toBe(false);
  });

  it("has a default root per harness", () => {
    expect(defaultRoot("claude-code", "/home/a")).toBe("/home/a/.claude");
    expect(defaultRoot("codex", "/home/a")).toBe("/home/a/.codex");
    expect(defaultRoot("goose", "/home/a")).toBe("/home/a/.config/goose");
  });
});

describe("mergeClaudeSettings", () => {
  const cmd = hookCommand("/root/milo-verify-hook.mjs");

  it("adds a Stop hook to an empty config", () => {
    const text = mergeClaudeSettings(undefined, cmd);
    const config = JSON.parse(text) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    expect(config.hooks.Stop[0]?.hooks[0]?.command).toBe(cmd);
  });

  it("preserves existing keys and other hooks", () => {
    const existing = JSON.stringify({ model: "milo/auto", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } });
    const config = JSON.parse(mergeClaudeSettings(existing, cmd)) as {
      model: string;
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(config.model).toBe("milo/auto");
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it("is idempotent: re-merging does not duplicate the hook", () => {
    const once = mergeClaudeSettings(undefined, cmd);
    const twice = mergeClaudeSettings(once, cmd);
    const config = JSON.parse(twice) as { hooks: { Stop: unknown[] } };
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it("does not throw on a malformed existing file", () => {
    expect(() => mergeClaudeSettings("{not json", cmd)).not.toThrow();
  });
});

describe("appendHookBlock", () => {
  const cmd = hookCommand("/root/milo-verify-hook.mjs");

  it("appends a codex TOML block", () => {
    const text = appendHookBlock("model = \"milo/auto\"\n", "codex", cmd);
    expect(text).toContain("model = \"milo/auto\"");
    expect(text).toContain("[hooks]");
    expect(text).toContain("stop =");
    expect(text).toContain("milo-verify-hook.mjs");
  });

  it("appends a goose YAML block", () => {
    const text = appendHookBlock(undefined, "goose", cmd);
    expect(text).toContain("hooks:");
    expect(text).toContain("stop:");
  });

  it("is idempotent: re-appending replaces the block, not stacks it", () => {
    const once = appendHookBlock("base: 1\n", "codex", cmd);
    const twice = appendHookBlock(once, "codex", cmd);
    expect(twice.match(/\[hooks\]/g)).toHaveLength(1);
    expect(twice).toContain("base: 1");
  });
});

describe("planInstall", () => {
  it("computes the full claude-code install", () => {
    const plan = planInstall("claude-code", "/cfg", undefined);
    expect(plan.hookScriptPath).toBe("/cfg/milo-verify-hook.mjs");
    expect(plan.configPath).toBe("/cfg/settings.json");
    expect(plan.command).toContain("milo-verify-hook.mjs");
    expect(() => JSON.parse(plan.configText)).not.toThrow();
    expect(plan.notes.some((n) => n.includes("MILO_ENDPOINT"))).toBe(true);
  });

  it("computes a codex install with a TOML config", () => {
    const plan = planInstall("codex", "/cfg", undefined);
    expect(plan.configPath).toBe("/cfg/config.toml");
    expect(plan.configText).toContain("[hooks]");
  });
});
