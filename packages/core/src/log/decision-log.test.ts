import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRecord } from "../types.js";
import { DecisionLog } from "./decision-log.js";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    fingerprint: "fp-a",
    tier: "mid",
    model: "anthropic/claude-sonnet-5",
    reason: "difficulty 1.4 with reasoning required",
    policyVersion: "v1",
    sticky: false,
    degraded: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("DecisionLog", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("round-trips insert/get, preserving every field including nested signals and upstream", async () => {
    const full = record({
      id: "rec-1",
      signals: {
        taskType: "debug",
        difficulty: 2.1,
        needsReasoning: 0.8,
        longOutput: 0.2,
        confidences: { debug: 0.91, review: 0.05 },
        jevRequestId: "req-abc",
        jevModel: "jev-latest",
        latencyMs: 87,
      },
      upstream: {
        status: 200,
        latencyMs: 640,
        inputTokens: 512,
        outputTokens: 128,
        costUsd: 0.0031,
      },
    });

    await log.insert(full);
    const fetched = await log.get("rec-1");

    expect(fetched).toEqual(full);
  });

  it("get returns undefined for a missing id", async () => {
    expect(await log.get("does-not-exist")).toBeUndefined();
  });

  it("listRecent orders newest first", async () => {
    await log.insert(record({ id: "a", createdAt: "2026-09-17T00:00:01.000Z" }));
    await log.insert(record({ id: "b", createdAt: "2026-09-17T00:00:03.000Z" }));
    await log.insert(record({ id: "c", createdAt: "2026-09-17T00:00:02.000Z" }));

    const rows = await log.listRecent();
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("listRecent respects limit, defaulting to 50 and capping at 500", async () => {
    for (let i = 0; i < 10; i++) {
      await log.insert(record({ id: `id-${i}`, createdAt: `2026-09-17T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    expect(await log.listRecent({ limit: 3 })).toHaveLength(3);
    expect(await log.listRecent({ limit: 10_000 })).toHaveLength(10);
    expect(await log.listRecent()).toHaveLength(10);
  });

  it("listRecent filters by fingerprint and degradedOnly", async () => {
    await log.insert(record({ id: "x1", fingerprint: "fp-x", createdAt: "2026-09-17T00:00:01.000Z" }));
    await log.insert(
      record({ id: "x2", fingerprint: "fp-x", degraded: true, createdAt: "2026-09-17T00:00:02.000Z" }),
    );
    await log.insert(record({ id: "y1", fingerprint: "fp-y", createdAt: "2026-09-17T00:00:03.000Z" }));

    const byFingerprint = await log.listRecent({ fingerprint: "fp-x" });
    expect(byFingerprint.map((r) => r.id).sort()).toEqual(["x1", "x2"]);

    const degradedOnly = await log.listRecent({ degradedOnly: true });
    expect(degradedOnly.map((r) => r.id)).toEqual(["x2"]);
  });

  it("setUpstream updates an existing record and is a no-op for a missing id", async () => {
    await log.insert(record({ id: "with-upstream" }));
    await log.setUpstream("with-upstream", { status: 200, latencyMs: 12 });
    expect((await log.get("with-upstream"))?.upstream).toEqual({ status: 200, latencyMs: 12 });

    await expect(log.setUpstream("missing-id", { status: 500, latencyMs: 1 })).resolves.toBeUndefined();
    expect(await log.get("missing-id")).toBeUndefined();
  });

  it("computes stats over a seeded set", async () => {
    await log.insert(
      record({
        id: "s1",
        tier: "fast",
        model: "anthropic/claude-haiku-4.5",
        sticky: true,
        createdAt: "2026-09-17T00:00:01.000Z",
        signals: {
          taskType: "chat",
          difficulty: 0.2,
          needsReasoning: 0.1,
          longOutput: 0.1,
          confidences: {},
          jevRequestId: "r1",
          jevModel: "jev-latest",
          latencyMs: 100,
        },
      }),
    );
    await log.insert(
      record({
        id: "s2",
        tier: "mid",
        model: "anthropic/claude-sonnet-5",
        createdAt: "2026-09-17T00:00:02.000Z",
        signals: {
          taskType: "feature",
          difficulty: 1.5,
          needsReasoning: 0.6,
          longOutput: 0.3,
          confidences: {},
          jevRequestId: "r2",
          jevModel: "jev-latest",
          latencyMs: 200,
        },
      }),
    );
    await log.insert(
      record({
        id: "s3",
        tier: "mid",
        model: "anthropic/claude-sonnet-5",
        degraded: true,
        createdAt: "2026-09-17T00:00:03.000Z",
      }),
    );

    const stats = await log.stats();
    expect(stats.total).toBe(3);
    expect(stats.byTier).toEqual({ fast: 1, mid: 2 });
    expect(stats.byModel).toEqual({
      "anthropic/claude-haiku-4.5": 1,
      "anthropic/claude-sonnet-5": 2,
    });
    expect(stats.degraded).toBe(1);
    expect(stats.sticky).toBe(1);
    // s3 has no signals, so only s1 (100ms) and s2 (200ms) count.
    expect(stats.avgJevLatencyMs).toBe(150);
  });

  it("stats reports avgJevLatencyMs as null when nothing has signals", async () => {
    await log.insert(record({ id: "no-signals", degraded: true }));
    const stats = await log.stats();
    expect(stats.avgJevLatencyMs).toBeNull();
  });

  it("stats can be scoped by sinceIso", async () => {
    await log.insert(record({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }));
    await log.insert(record({ id: "new", createdAt: "2026-09-20T00:00:00.000Z" }));

    const stats = await log.stats({ sinceIso: "2026-09-10T00:00:00.000Z" });
    expect(stats.total).toBe(1);
  });

  it("exportJsonl yields one line per record", async () => {
    for (let i = 0; i < 5; i++) {
      await log.insert(record({ id: `line-${i}`, createdAt: `2026-09-17T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }

    const lines: string[] = [];
    for await (const line of log.exportJsonl()) {
      lines.push(line);
    }

    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("rejects a record whose reason contains a bearer token", async () => {
    await expect(log.insert(record({ reason: "leaked Bearer x in the reason" }))).rejects.toThrow(
      /key or bearer token/,
    );
  });

  it("rejects a record whose signals contain a bearer token", async () => {
    await expect(
      log.insert(
        record({
          signals: {
            taskType: "chat",
            difficulty: 0,
            needsReasoning: 0,
            longOutput: 0,
            confidences: {},
            jevRequestId: "Bearer x",
            jevModel: "jev-latest",
            latencyMs: 1,
          },
        }),
      ),
    ).rejects.toThrow(/key or bearer token/);
  });

  it("rejects a record whose reason is over 2000 characters", async () => {
    await expect(log.insert(record({ reason: "a".repeat(2001) }))).rejects.toThrow(/2000/);
  });
});

describe("DecisionLog migrations", () => {
  it("are idempotent when open is called twice on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-decision-log-"));
    const path = join(dir, "milo.db");
    const url = `file:${path}`;

    try {
      const first = await DecisionLog.open(url);
      await first.insert(record({ id: "persisted" }));
      await first.close();

      const second = await DecisionLog.open(url);
      const fetched = await second.get("persisted");
      expect(fetched?.id).toBe("persisted");
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
