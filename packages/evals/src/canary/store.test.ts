import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "./snapshot.js";
import {
  appendSnapshot,
  averageSnapshots,
  loadPinnedBaseline,
  loadSnapshotHistory,
  rollingBaseline,
  savePinnedBaseline,
} from "./store.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "canary-store-"));
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    createdAt: "2026-09-20T00:00:00.000Z",
    policyVersion: "v4",
    posture: "balanced",
    requestedSize: 24,
    n: 24,
    scoredN: 24,
    unscoredN: 0,
    passRate: 0.9,
    meanCostUsd: 0.001,
    pricedN: 24,
    latencyP50Ms: 400,
    latencyP95Ms: 600,
    tierCounts: { fast: 10, mid: 8, frontier: 6 },
    modelCounts: { "deepseek/deepseek-v4-flash": 10 },
    ...over,
  };
}

describe("appendSnapshot / loadSnapshotHistory", () => {
  it("round-trips a snapshot, including NaN rate/latency/cost fields", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    const snap = makeSnapshot({ passRate: NaN, meanCostUsd: NaN, latencyP50Ms: NaN, latencyP95Ms: NaN, scoredN: 0, pricedN: 0 });

    appendSnapshot(path, snap);
    const [loaded] = loadSnapshotHistory(path);

    expect(loaded?.passRate).toBeNaN();
    expect(loaded?.meanCostUsd).toBeNaN();
    expect(loaded?.latencyP50Ms).toBeNaN();
    expect(loaded?.latencyP95Ms).toBeNaN();
    expect(loaded?.createdAt).toBe(snap.createdAt);
  });

  it("NaN fields serialize as JSON null, not a string or undefined", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    appendSnapshot(path, makeSnapshot({ passRate: NaN }));
    const raw = JSON.parse(readFileSync(path, "utf8")) as { snapshots: Array<{ passRate: unknown }> };
    expect(raw.snapshots[0]?.passRate).toBeNull();
  });

  it("appends in order and returns the full (trimmed) history", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    appendSnapshot(path, makeSnapshot({ createdAt: "2026-09-18T00:00:00.000Z" }));
    appendSnapshot(path, makeSnapshot({ createdAt: "2026-09-19T00:00:00.000Z" }));
    const history = loadSnapshotHistory(path);
    expect(history.map((s) => s.createdAt)).toEqual(["2026-09-18T00:00:00.000Z", "2026-09-19T00:00:00.000Z"]);
  });

  it("trims to maxHistory, dropping the oldest entries first", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    for (let i = 0; i < 5; i += 1) {
      appendSnapshot(path, makeSnapshot({ createdAt: `2026-09-1${i}T00:00:00.000Z` }), { maxHistory: 3 });
    }
    const history = loadSnapshotHistory(path);
    expect(history).toHaveLength(3);
    expect(history.map((s) => s.createdAt)).toEqual([
      "2026-09-12T00:00:00.000Z",
      "2026-09-13T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
    ]);
  });

  it("creates missing parent directories", () => {
    const dir = freshDir();
    const path = join(dir, "nested", "deep", "history.json");
    appendSnapshot(path, makeSnapshot());
    expect(loadSnapshotHistory(path)).toHaveLength(1);
  });

  it("reads a missing history file as empty, not an error", () => {
    const dir = freshDir();
    expect(loadSnapshotHistory(join(dir, "does-not-exist.json"))).toEqual([]);
  });

  it("throws on a history file that is not valid JSON", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    writeFileSync(path, "not json", "utf8");
    expect(() => loadSnapshotHistory(path)).toThrow(/not valid JSON/);
  });

  it("throws on a history file with no snapshots array", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    writeFileSync(path, JSON.stringify({ oops: [] }), "utf8");
    expect(() => loadSnapshotHistory(path)).toThrow(/snapshots/);
  });

  it("skips a malformed entry rather than failing the whole read", () => {
    const dir = freshDir();
    const path = join(dir, "history.json");
    writeFileSync(path, JSON.stringify({ snapshots: [{ notASnapshot: true }, makeSnapshot()] }), "utf8");
    const history = loadSnapshotHistory(path);
    expect(history).toHaveLength(1);
  });
});

describe("averageSnapshots / rollingBaseline", () => {
  it("averages the numeric fields and mean-tier-counts", () => {
    const a = makeSnapshot({ passRate: 0.8, meanCostUsd: 0.001, latencyP95Ms: 500, tierCounts: { fast: 10, mid: 10, frontier: 0 } });
    const b = makeSnapshot({ passRate: 1.0, meanCostUsd: 0.003, latencyP95Ms: 700, tierCounts: { fast: 20, mid: 0, frontier: 0 } });
    const avg = averageSnapshots([a, b]);
    expect(avg.passRate).toBeCloseTo(0.9, 10);
    expect(avg.meanCostUsd).toBeCloseTo(0.002, 10);
    expect(avg.latencyP95Ms).toBe(600);
    expect(avg.tierCounts).toEqual({ fast: 15, mid: 5, frontier: 0 });
  });

  it("ignores NaN entries when averaging (does not poison the mean)", () => {
    const a = makeSnapshot({ passRate: 0.8 });
    const b = makeSnapshot({ passRate: NaN, scoredN: 0 });
    expect(averageSnapshots([a, b]).passRate).toBeCloseTo(0.8, 10);
  });

  it("labels policyVersion 'mixed' when the window spans more than one version", () => {
    const a = makeSnapshot({ policyVersion: "v3" });
    const b = makeSnapshot({ policyVersion: "v4" });
    expect(averageSnapshots([a, b]).policyVersion).toBe("mixed");
    expect(averageSnapshots([a, a]).policyVersion).toBe("v3");
  });

  it("throws on an empty list", () => {
    expect(() => averageSnapshots([])).toThrow(/at least one/);
  });

  it("rollingBaseline is undefined for an empty history", () => {
    expect(rollingBaseline([], 5)).toBeUndefined();
  });

  it("rollingBaseline uses only the last `window` entries", () => {
    const old = makeSnapshot({ passRate: 0.5 });
    const recent1 = makeSnapshot({ passRate: 1.0 });
    const recent2 = makeSnapshot({ passRate: 1.0 });
    const baseline = rollingBaseline([old, recent1, recent2], 2);
    expect(baseline?.passRate).toBe(1.0);
  });

  it("rollingBaseline rejects a non-positive window", () => {
    expect(() => rollingBaseline([makeSnapshot()], 0)).toThrow(/positive integer/);
  });
});

describe("savePinnedBaseline / loadPinnedBaseline", () => {
  it("round-trips a pinned baseline", () => {
    const dir = freshDir();
    const path = join(dir, "baseline.json");
    const snap = makeSnapshot({ passRate: 0.77 });
    savePinnedBaseline(path, snap);
    expect(loadPinnedBaseline(path).passRate).toBe(0.77);
  });

  it("throws with a clear message for a missing file", () => {
    const dir = freshDir();
    expect(() => loadPinnedBaseline(join(dir, "missing.json"))).toThrow(/could not read pinned baseline/);
  });

  it("throws for a file that does not look like a snapshot", () => {
    const dir = freshDir();
    const path = join(dir, "baseline.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }), "utf8");
    expect(() => loadPinnedBaseline(path)).toThrow(/does not look like a snapshot/);
  });
});
