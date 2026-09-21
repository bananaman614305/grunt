import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionLog, parsePolicyOverride } from "@milo/core";
import type { DecisionRecord, RouteSignals, TaskType } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./tune.js";

/** Level distributions that land a decision in each band under JEV_PROFILE. */
const LEVELS: Record<0 | 1 | 2 | 3, number[]> = {
  0: [0.9, 0.1, 0, 0],
  1: [0.1, 0.6, 0.28, 0.02],
  2: [0.1, 0.2, 0.68, 0.02],
  3: [0.1, 0.3, 0.3, 0.3],
};

function signals(band: 0 | 1 | 2 | 3, taskType: TaskType): RouteSignals {
  return {
    taskType,
    difficulty: band,
    difficultyLevels: LEVELS[band],
    needsReasoning: 0.4,
    longOutput: 0.2,
    confidences: {},
    jevRequestId: "req",
    jevModel: "jev-latest",
    latencyMs: 300,
  };
}

type RowOptions = {
  id: string;
  band: 0 | 1 | 2 | 3;
  taskType?: TaskType;
  samples?: number;
  pass?: boolean;
  createdAt?: string;
};

function record(opts: RowOptions): DecisionRecord {
  const decision: DecisionRecord = {
    id: opts.id,
    fingerprint: `fp-${opts.id}`,
    tier: "fast",
    model: "deepseek/deepseek-v4-flash",
    reason: "banded",
    policyVersion: "v4",
    sticky: false,
    createdAt: opts.createdAt ?? "2026-09-19T00:00:00.000Z",
    signals: signals(opts.band, opts.taskType ?? "feature"),
  };
  if (opts.samples !== undefined) decision.samples = opts.samples;
  return decision;
}

/** Inserts `count` rows in one cell, `passing` of which the gate called complete. */
async function insertCell(
  log: DecisionLog,
  prefix: string,
  count: number,
  passing: number,
  opts: Omit<RowOptions, "id">,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}-${i}`;
    await log.insert(record({ ...opts, id }));
    await log.setUpstream(id, {
      status: 200,
      latencyMs: 300,
      costUsd: 0.0001,
      gate: { verdict: i < passing ? "complete" : "incomplete", confidence: 0.9 },
    });
  }
}

describe("milo tune", () => {
  let log: DecisionLog;
  let dir: string;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
    dir = mkdtempSync(join(tmpdir(), "milo-tune-"));
  });

  afterEach(async () => {
    await log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints help and exits 0 on --help", async () => {
    const { deps, stdout } = createTestDeps();
    expect(await run(["--help"], deps)).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo tune");
    expect(stdout.toString()).toContain("--apply");
  });

  it("prints the per-band and per-task tables with the proposal and its caveats", async () => {
    await insertCell(log, "b1", 120, 72, { band: 1, taskType: "feature" });
    await insertCell(log, "b0", 60, 58, { band: 0, taskType: "chat" });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run([], deps);

    expect(code).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("Decisions read:  180");
    expect(out).toContain("Per difficulty band:");
    expect(out).toContain("Per band and task type:");
    expect(out).toMatch(/^1 +feature +120 /m);
    expect(out).toMatch(/^0 +60 +0 +1x deepseek-v4-flash/m);
    // Band 1 is budgeted at one call and passes only 60%: R1 fires.
    expect(out).toContain("Proposal: 1 change");
    expect(out).toContain("[R1] band 1");
    expect(out).toContain("60.0%");
    expect(out).toContain("Read these numbers with their caveats:");
    expect(out).toContain("not ground truth");
  });

  it("says so plainly when nothing should change", async () => {
    await insertCell(log, "ok", 120, 118, { band: 1 });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    expect(await run([], deps)).toBe(0);
    expect(stdout.toString()).toContain("Proposal: no change");
  });

  it("flags a cell it will not judge instead of dropping it", async () => {
    await insertCell(log, "thin", 10, 2, { band: 1 });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    expect(await run([], deps)).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("Not judged (under 50 graded requests):");
    expect(out).toContain("band 1");
    expect(out).toContain("low-n");
  });

  it("emits a machine-readable proposal, override and statistics under --json", async () => {
    await insertCell(log, "b1", 120, 72, { band: 1 });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    expect(await run(["--json"], deps)).toBe(0);

    const payload = JSON.parse(stdout.toString()) as {
      proposal: { changes: Array<{ rule: string; band: number; from: number; to: number; lowN: boolean }>; caveats: string[] };
      apply: { ok: boolean; blockers?: string[] };
      override: { requiresBenchmark: boolean; bandSamples?: Record<string, number> };
      report: { total: number; bands: Array<{ band: number; n: number }> };
    };

    expect(payload.proposal.changes[0]).toMatchObject({ rule: "R1", band: 1, from: 1, to: 5 });
    expect(payload.proposal.caveats.length).toBeGreaterThan(0);
    // 120 graded is under the 200 --apply demands, so the machine reader sees
    // the same refusal the flag would give.
    expect(payload.apply.ok).toBe(false);
    expect(payload.override.requiresBenchmark).toBe(true);
    expect(payload.override.bandSamples).toEqual({ "1": 5 });
    expect(payload.report.total).toBe(120);
  });

  it("--apply refuses when a proposed change rests on too few graded requests", async () => {
    await insertCell(log, "b1", 120, 72, { band: 1 });
    const out = join(dir, "override.json");

    const { deps, stderr, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run(["--apply", "--out", out], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--apply refused");
    expect(stderr.toString()).toContain("under the 200 --apply requires");
    expect(stdout.toString()).toBe("");
    expect(existsSync(out)).toBe(false);
  });

  it("--apply refuses when there is nothing to apply", async () => {
    await insertCell(log, "ok", 120, 118, { band: 1 });
    const out = join(dir, "override.json");

    const { deps, stderr } = createTestDeps({ openLog: async () => log });
    expect(await run(["--apply", "--out", out], deps)).toBe(1);
    expect(stderr.toString()).toContain("no changes");
    expect(existsSync(out)).toBe(false);
  });

  it("--apply writes a benchmark-pending override once the evidence clears the floor", async () => {
    await insertCell(log, "b1", 120, 72, { band: 1 });
    const out = join(dir, "override.json");

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    const code = await run(["--apply", "--apply-min-n", "100", "--out", out], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain(`Wrote 1 proposed change(s) to ${out}`);
    expect(stdout.toString()).toContain("Nothing reads this file at runtime");
    expect(stdout.toString()).toContain("pnpm bench");

    const doc = parsePolicyOverride(JSON.parse(readFileSync(out, "utf8")));
    expect(doc.requiresBenchmark).toBe(true);
    expect(doc.bandSamples).toEqual({ "1": 5 });
    expect(doc.note).toContain("NOT in force");
  });

  it("--since filters the rows it reads", async () => {
    await insertCell(log, "old", 120, 0, { band: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    await insertCell(log, "new", 60, 58, { band: 1, createdAt: "2026-09-19T00:00:00.000Z" });

    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    expect(await run(["--since", "2026-06-01T00:00:00.000Z"], deps)).toBe(0);
    expect(stdout.toString()).toContain("Decisions read:  60");
    expect(stdout.toString()).toContain("Proposal: no change");
  });

  it("rejects a bad --since and a bad --min-n", async () => {
    const bad = createTestDeps();
    expect(await run(["--since", "yesterday"], bad.deps)).toBe(1);
    expect(bad.stderr.toString()).toContain("not a valid ISO 8601");

    const worse = createTestDeps();
    expect(await run(["--min-n", "0"], worse.deps)).toBe(1);
    expect(worse.stderr.toString()).toContain("--min-n must be a positive integer");
  });

  it("reads an empty log without inventing a proposal", async () => {
    const { deps, stdout } = createTestDeps({ openLog: async () => log });
    expect(await run([], deps)).toBe(0);
    expect(stdout.toString()).toContain("Decisions read:  0");
    expect(stdout.toString()).toContain("(no banded decisions)");
  });
});
