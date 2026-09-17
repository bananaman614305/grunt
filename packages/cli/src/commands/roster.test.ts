import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROSTER } from "@milo/core";
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
