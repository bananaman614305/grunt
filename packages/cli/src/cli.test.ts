import { describe, expect, it } from "vitest";
import { createTestDeps } from "./test-support.js";
import { runCli } from "./index.js";

describe("runCli", () => {
  it("prints top-level help and exits 0 on --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo <command>");
    expect(stdout.toString()).toContain("serve");
    expect(stdout.toString()).toContain("explain");
    expect(stdout.toString()).toContain("decisions");
    expect(stdout.toString()).toContain("stats");
    expect(stdout.toString()).toContain("roster");
  });

  it("prints top-level help and exits 0 on -h and on the bare 'help' command", async () => {
    const short = createTestDeps();
    expect(await runCli(["-h"], short.deps)).toBe(0);
    expect(short.stdout.toString()).toContain("Usage: milo <command>");

    const word = createTestDeps();
    expect(await runCli(["help"], word.deps)).toBe(0);
    expect(word.stdout.toString()).toContain("Usage: milo <command>");
  });

  it("prints help to stderr and exits 1 when no command is given", async () => {
    const { deps, stderr, stdout } = createTestDeps();
    const code = await runCli([], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("Usage: milo <command>");
    expect(stdout.toString()).toBe("");
  });

  it("exits 1 on an unknown command, naming it", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await runCli(["frobnicate"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain('unknown command "frobnicate"');
  });

  it("dispatches to the roster command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["roster", "--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo roster");
  });

  it("dispatches to the explain command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["explain", "--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo explain");
  });

  it("dispatches to the decisions command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["decisions", "--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo decisions");
  });

  it("dispatches to the stats command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["stats", "--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo stats");
  });

  it("dispatches to the serve command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["serve", "--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo serve");
  });
});
