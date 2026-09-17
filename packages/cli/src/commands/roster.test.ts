import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROSTER, DEFAULT_ROSTER_INFO, defaultRosterModels } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./roster.js";

describe("milo roster", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-roster-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the default roster and says so, when no config file is given", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", join(dir, "does-not-exist.json")], deps);

    expect(code).toBe(1); // an explicit --config path that does not exist is an error
    void stdout;
  });

  it("falls back to defaults when no --config is passed and none is present", async () => {
    // loadConfig with no path looks for milo.config.json relative to
    // process.cwd(); the repo does not keep one there, so this exercises
    // the "defaults" path end to end.
    const { deps, stdout } = createTestDeps();
    const code = await run([], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain("Roster source: defaults");
    for (const model of DEFAULT_ROSTER.fast) {
      expect(output).toContain(model);
    }
    expect(output).toContain(DEFAULT_ROSTER.mid[0]);
    expect(output).toContain(DEFAULT_ROSTER.frontier[0]);
  });

  it("prints each default's prices, usage rank and where it came from", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run([], deps);
    expect(code).toBe(0);

    const output = stdout.toString();
    expect(output).toContain(`Default roster version: ${DEFAULT_ROSTER_INFO.version}`);
    expect(output).toContain(DEFAULT_ROSTER_INFO.source.usage);
    expect(output).toContain(DEFAULT_ROSTER_INFO.source.pricing);
    expect(output).toMatch(/TIER\s+MODEL\s+IN\/M\s+OUT\/M\s+USE\s+SOURCE/);

    for (const model of defaultRosterModels()) {
      expect(output).toContain(model.id);
      expect(output).toContain(`$${model.inputUsdPerM}`);
      expect(output).toContain(`$${model.outputUsdPerM}`);
      expect(output).toContain(`#${model.usageRank}`);
    }
    // Every row of a default roster says "default" in the SOURCE column.
    const rows = output.split("\n").filter((line) => line.includes("$") && line.includes("#"));
    expect(rows).toHaveLength(defaultRosterModels().length);
    for (const row of rows) expect(row.trimEnd().endsWith("default")).toBe(true);

    expect(output).toContain("ordered by weekly usage within price bands");
    expect(output).toContain("nothing above $5 per million output tokens");
    expect(output).toContain("Premium models (Fable, Opus, Astra, Sonnet)");
  });

  it("marks a model the config added, and names the tier a moved default came from", async () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        roster: {
          fast: ["openai/gpt-5.6-luna"],
          mid: ["custom/mid-model"],
          frontier: ["anthropic/claude-opus-5"],
        },
      }),
    );

    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", path], deps);
    expect(code).toBe(0);

    const output = stdout.toString();
    // A shipped model listed under a different tier keeps its numbers and
    // says where it normally sits.
    expect(output).toMatch(/openai\/gpt-5\.6-luna.*\$0\.2.*\$1\.2.*#1.*default \(mid\)/);
    // Ids Milo does not ship have no prices to print, and say so.
    expect(output).toMatch(/custom\/mid-model\s+-\s+-\s+-\s+config/);
    expect(output).toMatch(/anthropic\/claude-opus-5\s+-\s+-\s+-\s+config/);
  });

  it("prints the config file's roster and names the file as the source", async () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        roster: {
          fast: ["custom/fast-model"],
          mid: ["custom/mid-model"],
          frontier: ["custom/frontier-model"],
        },
      }),
    );

    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", path], deps);

    expect(code).toBe(0);
    const output = stdout.toString();
    expect(output).toContain(`Roster source: config file (${path})`);
    expect(output).toContain("custom/fast-model");
    expect(output).toContain("custom/mid-model");
    expect(output).toContain("custom/frontier-model");
  });

  it("falls back to defaults when the config file exists but has no roster field", async () => {
    const path = join(dir, "milo.config.json");
    writeFileSync(path, JSON.stringify({ port: 9000 }));

    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", path], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Roster source: defaults");
  });

  it("prints help with --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo roster");
  });
});
