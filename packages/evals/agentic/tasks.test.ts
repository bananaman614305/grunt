/**
 * The shipped task fixtures are the benchmark's ground truth: each must be a
 * self-contained broken project whose own `test.js` proves it broken. A task
 * whose test passes as committed measures nothing.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tasks");
const EXPECTED_IDS = [
  "at-001", "at-002", "at-003", "at-004", "at-005",
  "at-006", "at-007", "at-008", "at-009", "at-010",
];

describe("agentic task fixtures", () => {
  it("ships exactly at-001..at-010", () => {
    expect(readdirSync(TASKS_DIR).sort()).toEqual(EXPECTED_IDS);
  });

  for (const id of EXPECTED_IDS) {
    describe(id, () => {
      it("has a non-empty task.md and a test.js", () => {
        const files = readdirSync(join(TASKS_DIR, id));
        expect(files).toContain("task.md");
        expect(files).toContain("test.js");
        expect(readFileSync(join(TASKS_DIR, id, "task.md"), "utf8").trim().length).toBeGreaterThan(0);
      });

      it("fails its own test in the shipped (broken) state", () => {
        const run = spawnSync("node", ["test.js"], {
          cwd: join(TASKS_DIR, id),
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(run.error).toBeUndefined();
        expect(run.status).not.toBe(0);
        expect(run.status).not.toBeNull();
      });
    });
  }
});
