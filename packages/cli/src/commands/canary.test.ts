import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "@milo/evals";
import { savePinnedBaseline } from "@milo/evals";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./canary.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "milo-canary-cli-"));
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    createdAt: "2026-09-19T00:00:00.000Z",
    policyVersion: "v4",
    posture: "balanced",
    requestedSize: 24,
    n: 24,
    scoredN: 24,
    unscoredN: 0,
    passRate: 0.99,
    meanCostUsd: 0.00001,
    pricedN: 24,
    latencyP50Ms: 100,
    latencyP95Ms: 150,
    tierCounts: { fast: 24, mid: 0, frontier: 0 },
    modelCounts: { "deepseek/deepseek-v4-flash": 24 },
    ...over,
  };
}

describe("milo canary: help and argument validation", () => {
  it("prints help with --help and does not run anything", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);
    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo canary");
  });

  it("rejects an unknown --mode", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await run(["--mode", "bogus"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--mode must be one of");
  });

  it("rejects an unknown --posture", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await run(["--posture", "bogus"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--posture must be one of");
  });

  it("rejects a non-positive --size", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await run(["--size", "0"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--size must be a positive integer");
  });

  it("rejects a negative drift threshold", async () => {
    const { deps, stderr } = createTestDeps();
    // `--flag=-5` (not `--flag -5`): node:util's parseArgs treats a bare
    // `-5` right after a value-taking flag as another (ambiguous) flag.
    const code = await run(["--max-pass-drop=-5"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--max-pass-drop must be a non-negative number");
  });

  it("rejects a non-numeric drift threshold", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await run(["--max-cost-increase", "a lot"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--max-cost-increase must be a non-negative number");
  });

  it("rejects --live combined with a conflicting --mode", async () => {
    const { deps, stderr } = createTestDeps();
    const code = await run(["--live", "--mode", "fixtures"], deps);
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("--live conflicts with --mode fixtures");
  });

  it("--live is opt-in: defaults to fixtures (no key needed), and --live alone requires JEV_API_KEY without ever touching the network", async () => {
    const dir = freshDir();
    const { deps: fixturesDeps, stdout } = createTestDeps({ env: {} });
    const code = await run(["--size", "4", "--history", join(dir, "history.json")], fixturesDeps);
    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Mode: fixtures");

    // --live with no JEV_API_KEY fails fast on the missing key (never reaches
    // fetch), which is exactly the evidence that --live actually switched the
    // mode: fixtures mode needs no key and would never hit this branch.
    const { deps: liveDeps, stderr } = createTestDeps({ env: {} });
    const liveCode = await run(["--live", "--history", join(dir, "history-live.json"), "--skip-save"], liveDeps);
    expect(liveCode).toBe(1);
    expect(stderr.toString()).toContain("JEV_API_KEY");
  });

  it("rejects a missing pinned baseline file", async () => {
    const dir = freshDir();
    const { deps, stderr } = createTestDeps();
    const code = await run(
      ["--history", join(dir, "history.json"), "--baseline", join(dir, "does-not-exist.json"), "--skip-save"],
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.toString()).toContain("could not read pinned baseline");
  });
});

describe("milo canary: a real fixtures-mode run", () => {
  it("runs the default subset against the committed fixtures, prints a report, and exits 0 on the first run (no baseline)", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const { deps, stdout } = createTestDeps();

    const code = await run(["--size", "8", "--history", historyPath, "--mode", "fixtures"], deps);

    expect(code).toBe(0);
    const out = stdout.toString();
    expect(out).toContain("Milo canary");
    expect(out).toContain("Mode: fixtures");
    expect(out).toContain("Baseline: none yet");
    expect(out).toContain("Result: PASS (no baseline)");

    // Appended to history by default.
    expect(existsSync(historyPath)).toBe(true);
    const history = JSON.parse(readFileSync(historyPath, "utf8")) as { snapshots: unknown[] };
    expect(history.snapshots).toHaveLength(1);
  }, 20000);

  it("--skip-save does not touch the history file", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const { deps } = createTestDeps();

    await run(["--size", "8", "--history", historyPath, "--skip-save"], deps);

    expect(existsSync(historyPath)).toBe(false);
  }, 20000);

  it("a second run against a rolling baseline of the first compares cleanly (identical fixtures replay)", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const { deps: deps1 } = createTestDeps();
    const { deps: deps2, stdout: stdout2 } = createTestDeps();

    await run(["--size", "8", "--history", historyPath], deps1);
    const code2 = await run(["--size", "8", "--history", historyPath], deps2);

    // Fixtures mode replays the exact same recorded exchange every time, so
    // the second run's snapshot is identical to the first: no drift.
    expect(code2).toBe(0);
    expect(stdout2.toString()).toContain("Result: PASS (no drift)");

    const history = JSON.parse(readFileSync(historyPath, "utf8")) as { snapshots: unknown[] };
    expect(history.snapshots).toHaveLength(2);
  }, 30000);

  it("--json writes the snapshot and drift result", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const jsonPath = join(dir, "out.json");
    const { deps } = createTestDeps();

    await run(["--size", "8", "--history", historyPath, "--json", jsonPath], deps);

    const written = JSON.parse(readFileSync(jsonPath, "utf8")) as { snapshot: { scoredN: number }; drift: { hasBaseline: boolean } };
    expect(written.snapshot.scoredN).toBeGreaterThan(0);
    expect(written.drift.hasBaseline).toBe(false);
  }, 20000);

  it("--save-baseline writes a pinned baseline that --baseline can then read back", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const baselinePath = join(dir, "baseline.json");
    const { deps: deps1, stdout: stdout1 } = createTestDeps();

    await run(["--size", "8", "--history", historyPath, "--save-baseline", baselinePath], deps1);
    expect(stdout1.toString()).toContain(`Saved pinned baseline to ${baselinePath}`);
    expect(existsSync(baselinePath)).toBe(true);

    const { deps: deps2, stdout: stdout2 } = createTestDeps();
    const code2 = await run(
      ["--size", "8", "--history", join(dir, "history2.json"), "--baseline", baselinePath],
      deps2,
    );
    expect(code2).toBe(0);
    expect(stdout2.toString()).toContain("Baseline (pinned");
  }, 30000);
});

describe("milo canary: drift against a crafted pinned baseline", () => {
  it("exits 2 and reports DRIFT DETECTED when the run regresses past the threshold", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const baselinePath = join(dir, "baseline.json");
    // An unreachable baseline (99% pass, near-zero cost) guarantees the real
    // fixtures run looks worse than it by some margin; a zero threshold makes
    // any negative delta count as drift, so this cannot flake.
    savePinnedBaseline(baselinePath, makeSnapshot());

    const { deps, stdout } = createTestDeps();
    const code = await run(
      [
        "--size",
        "8",
        "--history",
        historyPath,
        "--baseline",
        baselinePath,
        "--max-pass-drop",
        "0",
        "--skip-save",
      ],
      deps,
    );

    expect(code).toBe(2);
    expect(stdout.toString()).toContain("Result: DRIFT DETECTED");
  }, 20000);

  it("does not flag drift when thresholds are wide open", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.json");
    const baselinePath = join(dir, "baseline.json");
    savePinnedBaseline(baselinePath, makeSnapshot({ passRate: 0 }));

    const { deps, stdout } = createTestDeps();
    const code = await run(
      [
        "--size",
        "8",
        "--history",
        historyPath,
        "--baseline",
        baselinePath,
        "--max-pass-drop",
        "100",
        "--max-cost-increase",
        "100000",
        "--max-latency-increase",
        "100000",
        "--max-tier-shift",
        "100",
        "--skip-save",
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Result: PASS (no drift)");
  }, 20000);
});
