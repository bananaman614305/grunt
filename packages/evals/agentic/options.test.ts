import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY, parseAgenticArgs, selectTasks } from "./options.js";

const OUT = "/reports";
const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tasks");

describe("parseAgenticArgs", () => {
  it("defaults to all tasks, the local gateway, and a 600s timeout", () => {
    const options = parseAgenticArgs([], OUT);
    expect(options).toEqual({
      tasks: "all",
      gateway: DEFAULT_GATEWAY,
      out: OUT,
      timeoutMs: 600_000,
      keep: false,
    });
  });

  it("parses every flag", () => {
    const options = parseAgenticArgs(
      // prettier-ignore
      ["--tasks", "at-002,at-001", "--gateway", "http://milo.test/v1", "--out", "/tmp/x",
        "--json", "/tmp/x/report.json", "--timeout", "30", "--keep", "--pi-agent-dir", "/tmp/pi"],
      OUT,
    );
    expect(options).toEqual({
      tasks: ["at-002", "at-001"],
      gateway: "http://milo.test/v1",
      out: "/tmp/x",
      json: "/tmp/x/report.json",
      timeoutMs: 30_000,
      keep: true,
      piAgentDir: "/tmp/pi",
    });
  });

  it("rejects unknown flags, missing values, and bad timeouts", () => {
    expect(() => parseAgenticArgs(["--frobnicate"], OUT)).toThrow(/unknown flag/);
    expect(() => parseAgenticArgs(["--gateway"], OUT)).toThrow(/needs a value/);
    expect(() => parseAgenticArgs(["--tasks", "--keep"], OUT)).toThrow(/needs a value/);
    expect(() => parseAgenticArgs(["--timeout", "-5"], OUT)).toThrow(/positive/);
    expect(() => parseAgenticArgs(["--tasks", ","], OUT)).toThrow(/empty list/);
  });
});

describe("selectTasks", () => {
  it("returns every task dir sorted for 'all'", () => {
    const ids = selectTasks(TASKS_DIR, "all");
    expect(ids).toEqual([
      "at-001", "at-002", "at-003", "at-004", "at-005",
      "at-006", "at-007", "at-008", "at-009", "at-010",
    ]);
  });

  it("keeps an explicit selection, deduplicated and sorted", () => {
    expect(selectTasks(TASKS_DIR, ["at-003", "at-001", "at-003"])).toEqual(["at-001", "at-003"]);
  });

  it("fails loudly on an unknown id", () => {
    expect(() => selectTasks(TASKS_DIR, ["at-001", "at-099"])).toThrow(/unknown task id.*at-099/);
  });
});
