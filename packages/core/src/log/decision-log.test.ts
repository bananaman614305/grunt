import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StickyEntry } from "../router/sticky-store.js";
import type { DecisionRecord, RouteDecision } from "../types.js";
import { DecisionLog } from "./decision-log.js";
import { applyMigrations, MIGRATIONS } from "./schema.js";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    fingerprint: "fp-a",
    tier: "mid",
    model: "anthropic/claude-sonnet-5",
    reason: "difficulty 1.4 with reasoning required",
    policyVersion: "v1",
    sticky: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function entry(decision: RouteDecision, userTurns = 1, expiresAt = Date.now() + 60_000): StickyEntry {
  return { decision, userTurns, expiresAt };
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
    const fetched = await log.getDecision("rec-1");

    expect(fetched).toEqual(full);
  });

  it("getDecision returns undefined for a missing id", async () => {
    expect(await log.getDecision("does-not-exist")).toBeUndefined();
  });

  it("round-trips the modality of a multimodal route, and reads a text row as undefined", async () => {
    await log.insert(record({ id: "img", modality: "image" }));
    await log.insert(record({ id: "aud", modality: "audio" }));
    await log.insert(record({ id: "txt" }));
    expect((await log.getDecision("img"))?.modality).toBe("image");
    expect((await log.getDecision("aud"))?.modality).toBe("audio");
    expect((await log.getDecision("txt"))?.modality).toBeUndefined();
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

  it("listRecent filters by fingerprint", async () => {
    await log.insert(record({ id: "x1", fingerprint: "fp-x", createdAt: "2026-09-17T00:00:01.000Z" }));
    await log.insert(record({ id: "x2", fingerprint: "fp-x", createdAt: "2026-09-17T00:00:02.000Z" }));
    await log.insert(record({ id: "y1", fingerprint: "fp-y", createdAt: "2026-09-17T00:00:03.000Z" }));

    const byFingerprint = await log.listRecent({ fingerprint: "fp-x" });
    expect(byFingerprint.map((r) => r.id).sort()).toEqual(["x1", "x2"]);
  });

  it("setUpstream updates an existing record and is a no-op for a missing id", async () => {
    await log.insert(record({ id: "with-upstream" }));
    await log.setUpstream("with-upstream", { status: 200, latencyMs: 12 });
    expect((await log.getDecision("with-upstream"))?.upstream).toEqual({ status: 200, latencyMs: 12 });

    await expect(log.setUpstream("missing-id", { status: 500, latencyMs: 1 })).resolves.toBeUndefined();
    expect(await log.getDecision("missing-id")).toBeUndefined();
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
    expect(stats.sticky).toBe(1);
    // s3 has no signals, so only s1 (100ms) and s2 (200ms) count.
    expect(stats.avgJevLatencyMs).toBe(150);
  });

  it("stats reports avgJevLatencyMs as null when nothing has signals", async () => {
    await log.insert(record({ id: "no-signals" }));
    const stats = await log.stats();
    expect(stats.avgJevLatencyMs).toBeNull();
  });

  it("stats can be scoped by sinceIso", async () => {
    await log.insert(record({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }));
    await log.insert(record({ id: "new", createdAt: "2026-09-20T00:00:00.000Z" }));

    const stats = await log.stats({ sinceIso: "2026-09-10T00:00:00.000Z" });
    expect(stats.total).toBe(1);
  });

  it("rolls the stored per-request cost up into stats.cost, sampling tax and all", async () => {
    await log.insert(record({ id: "c1", tier: "fast", model: "anthropic/claude-haiku-4.5" }));
    await log.setUpstream("c1", { status: 200, latencyMs: 100, costUsd: 0.0002 });

    await log.insert(record({ id: "c2", tier: "frontier", model: "anthropic/claude-opus-4.8" }));
    await log.setUpstream("c2", { status: 200, latencyMs: 900, costUsd: 0.02 });

    // A best-of-3 sampled decision: the aggregate cost covers all three calls.
    await log.insert(record({ id: "c3", tier: "fast", model: "anthropic/claude-haiku-4.5", samples: 3 }));
    await log.setUpstream("c3", { status: 200, latencyMs: 300, costUsd: 0.0009 });

    // A decision that never reported a cost is counted nowhere in cost.
    await log.insert(record({ id: "c4", tier: "mid" }));

    const stats = await log.stats();
    expect(stats.total).toBe(4);
    expect(stats.cost.total).toBe(0.0211);
    expect(stats.cost.withCost).toBe(3);
    expect(stats.cost.byTier).toEqual({ fast: 0.0011, frontier: 0.02 });
    expect(stats.cost.samplingTax).toBe(0.0006);
    // 0.0211 / 3 = 0.0070333..., rounded to six decimals.
    expect(stats.cost.avgPerRequest).toBe(0.007033);
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

  it("iterate walks every row oldest first, across page boundaries", async () => {
    for (let i = 0; i < 7; i++) {
      await log.insert(record({ id: `it-${i}`, createdAt: `2026-09-17T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }

    const ids: string[] = [];
    // A page size under the row count exercises the cursor, not just one query.
    for await (const decision of log.iterate({ pageSize: 3 })) {
      ids.push(decision.id);
    }

    expect(ids).toEqual(["it-0", "it-1", "it-2", "it-3", "it-4", "it-5", "it-6"]);
  });

  it("iterate filters on --since's cut-off", async () => {
    await log.insert(record({ id: "before", createdAt: "2026-01-01T00:00:00.000Z" }));
    await log.insert(record({ id: "after", createdAt: "2026-09-17T00:00:00.000Z" }));

    const ids: string[] = [];
    for await (const decision of log.iterate({ sinceIso: "2026-06-01T00:00:00.000Z" })) {
      ids.push(decision.id);
    }

    expect(ids).toEqual(["after"]);
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

describe("DecisionLog and accounts", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("stamps an account on a decision and filters lists and stats by it", async () => {
    await log.insert(record({ id: "a1", fingerprint: "fp-a" }));
    await log.insert(record({ id: "b1", fingerprint: "fp-b" }));
    await log.insert(record({ id: "x1", fingerprint: "fp-x" }));
    await log.setAccount("a1", "acc_1");
    await log.setAccount("b1", "acc_2");

    expect((await log.getDecision("a1"))?.accountId).toBe("acc_1");
    // A row nobody claimed carries no account, which is what a BYOK request
    // leaves behind.
    expect((await log.getDecision("x1"))?.accountId).toBeUndefined();

    expect((await log.listRecent({ accountId: "acc_1" })).map((r) => r.id)).toEqual(["a1"]);
    expect((await log.listRecent()).map((r) => r.id).sort()).toEqual(["a1", "b1", "x1"]);
    expect((await log.stats({ accountId: "acc_2" })).total).toBe(1);
    expect((await log.stats()).total).toBe(3);
  });

  it("ignores an account stamp for a decision that does not exist", async () => {
    await expect(log.setAccount("missing", "acc_1")).resolves.toBeUndefined();
  });
});

describe("DecisionLog as a StickyStore", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("round-trips an entry, decision and all", async () => {
    const decision = record({ id: "sticky-1", fingerprint: "fp-1" });
    await log.set("fp-1", entry(decision, 2, 4_102_444_800_000));

    expect(await log.get("fp-1")).toEqual({
      decision,
      userTurns: 2,
      expiresAt: 4_102_444_800_000,
    });
  });

  it("returns undefined for a fingerprint that was never pinned", async () => {
    expect(await log.get("never-seen")).toBeUndefined();
  });

  it("replaces the entry when a fingerprint is re-pinned", async () => {
    await log.set("fp-1", entry(record({ id: "first" }), 1));
    await log.set("fp-1", entry(record({ id: "second" }), 2));

    const hit = await log.get("fp-1");
    expect(hit?.decision.id).toBe("second");
    expect(hit?.userTurns).toBe(2);
  });

  it("does not return an expired entry, and drops it on the way past", async () => {
    await log.set("fp-1", entry(record({ id: "stale" }), 1, Date.now() - 1));
    expect(await log.get("fp-1")).toBeUndefined();
    // Deleted rather than left to accumulate.
    expect(await log.get("fp-1")).toBeUndefined();
  });

  it("deletes, and deleting something absent is a no-op", async () => {
    await log.set("fp-1", entry(record({ id: "d" }), 1));
    await log.delete("fp-1");
    expect(await log.get("fp-1")).toBeUndefined();
    await expect(log.delete("fp-1")).resolves.toBeUndefined();
  });

  it("can be pinned before the decision is logged", async () => {
    // The router writes through before onDecision has run; an entry that
    // needed its decision row to exist would miss on the very turn it is
    // meant to serve.
    const decision = record({ id: "not-yet-logged", fingerprint: "fp-early" });
    await log.set("fp-early", entry(decision, 1));

    expect((await log.get("fp-early"))?.decision.id).toBe("not-yet-logged");
    expect(await log.getDecision("not-yet-logged")).toBeUndefined();
  });

  it("applies the no-secrets guard to a sticky write too", async () => {
    await expect(
      log.set("fp-leak", entry(record({ reason: "leaked Bearer x in the reason" }), 1)),
    ).rejects.toThrow(/key or bearer token/);
  });

  it("keeps sticky entries separate from decisions", async () => {
    await log.insert(record({ id: "a-decision", fingerprint: "fp-1" }));
    await log.set("fp-1", entry(record({ id: "a-decision", fingerprint: "fp-1" }), 1));

    // Pinning does not add a decision row.
    expect(await log.listRecent()).toHaveLength(1);
  });
});

describe("DecisionLog migrations", () => {
  async function withFile<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "milo-decision-log-"));
    try {
      return await fn(`file:${join(dir, "milo.db")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("are idempotent when open is called twice on the same file", async () => {
    await withFile(async (url) => {
      const first = await DecisionLog.open(url);
      await first.insert(record({ id: "persisted" }));
      await first.set("fp-persisted", entry(record({ id: "persisted" }), 1));
      await first.close();

      const second = await DecisionLog.open(url);
      expect((await second.getDecision("persisted"))?.id).toBe("persisted");
      expect((await second.get("fp-persisted"))?.decision.id).toBe("persisted");
      await second.close();
    });
  });

  it("stay idempotent over many opens, without losing or duplicating data", async () => {
    await withFile(async (url) => {
      for (let i = 0; i < 5; i += 1) {
        const log = await DecisionLog.open(url);
        await log.insert(record({ id: `row-${i}`, createdAt: `2026-09-17T00:00:0${i}.000Z` }));
        await log.close();
      }

      const log = await DecisionLog.open(url);
      const rows = await log.listRecent();
      expect(rows.map((r) => r.id).sort()).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"]);
      await log.close();
    });
  });

  it("re-applying a migration's SQL does not break the schema or lose rows", async () => {
    // The runner re-applies a migration whose bookkeeping insert did not land
    // (a crash between the two), so every statement has to tolerate a second
    // run.
    await withFile(async (url) => {
      const log = await DecisionLog.open(url);
      await log.insert(record({ id: "survivor" }));
      await log.set("fp-s", entry(record({ id: "survivor" }), 1));
      await log.close();

      const db = createClient({ url });
      const second = MIGRATIONS.find((m) => m.version === 2);
      expect(second).toBeDefined();
      await db.executeMultiple(second!.sql);
      db.close();

      const reopened = await DecisionLog.open(url);
      expect((await reopened.getDecision("survivor"))?.id).toBe("survivor");
      expect((await reopened.get("fp-s"))?.decision.id).toBe("survivor");
      await reopened.close();
    });
  });

  it("carries a v1 database forward: degraded is dropped and the rows survive", async () => {
    await withFile(async (url) => {
      // Stand up exactly the shipped v1 schema, with a row that has the
      // column, then let the runner migrate it.
      const first = MIGRATIONS.find((m) => m.version === 1);
      expect(first).toBeDefined();

      const db = createClient({ url });
      await db.executeMultiple(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      await db.executeMultiple(first!.sql);
      await db.execute({
        sql: "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        args: [1, first!.description, "2026-09-01T00:00:00.000Z"],
      });
      await db.execute({
        sql: `INSERT INTO decisions
                (id, fingerprint, tier, model, reason, policy_version, sticky, degraded, created_at,
                 signals_json, upstream_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["legacy-1", "fp-legacy", "mid", "m", "why", "v2", 0, 1, "2026-09-01T00:00:00.000Z", null, null],
      });
      db.close();

      const log = await DecisionLog.open(url);
      const rows = await log.listRecent();
      expect(rows.map((r) => r.id)).toEqual(["legacy-1"]);
      // The flag is gone from the contract, degraded row or not.
      expect(rows[0]).not.toHaveProperty("degraded");
      expect(rows[0]?.tier).toBe("mid");

      // And the new table is there.
      await log.set("fp-new", entry(record({ id: "after-migration" }), 1));
      expect((await log.get("fp-new"))?.decision.id).toBe("after-migration");
      await log.close();
    });
  });

  it("runs both migrations on a fresh database and records them", async () => {
    await withFile(async (url) => {
      const db = createClient({ url });
      await applyMigrations(db);
      const rs = await db.execute("SELECT version FROM schema_migrations ORDER BY version");
      expect(rs.rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));

      // Re-running adds nothing.
      await applyMigrations(db);
      const again = await db.execute("SELECT version FROM schema_migrations ORDER BY version");
      expect(again.rows).toHaveLength(MIGRATIONS.length);
      db.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Sampled decisions (ADR-010)
// ---------------------------------------------------------------------------

describe("sampled decisions in the log", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("round-trips samples and unsampledTier", async () => {
    const sampled = record({ id: "rec-sampled", tier: "fast", samples: 5, unsampledTier: "mid" });
    await log.insert(sampled);
    const fetched = await log.getDecision("rec-sampled");
    expect(fetched?.samples).toBe(5);
    expect(fetched?.unsampledTier).toBe("mid");
    expect(fetched).toEqual(sampled);
  });

  it("leaves both fields absent on an unsampled decision", async () => {
    await log.insert(record({ id: "rec-plain" }));
    const fetched = await log.getDecision("rec-plain");
    expect(fetched?.samples).toBeUndefined();
    expect(fetched?.unsampledTier).toBeUndefined();
  });

  it("round-trips the per-sample upstream metadata and the pick", async () => {
    await log.insert(record({ id: "rec-up", tier: "fast", samples: 3, unsampledTier: "mid" }));
    const upstream: NonNullable<DecisionRecord["upstream"]> = {
      status: 200,
      latencyMs: 4200,
      inputTokens: 900,
      outputTokens: 450,
      costUsd: 0.0009,
      samples: [
        { index: 0, status: 200, latencyMs: 1800, inputTokens: 300, outputTokens: 150, costUsd: 0.0003, jevQuality: 2.4, jevCorrect: 0.9, picked: true },
        { index: 1, status: 200, latencyMs: 2100, inputTokens: 300, outputTokens: 150, costUsd: 0.0003, jevQuality: 1.1, jevCorrect: 0.4 },
        { index: 2, status: 0, latencyMs: 60_000, error: "timeout" },
      ],
      samplePick: 0,
    };
    await log.setUpstream("rec-up", upstream);
    const fetched = await log.getDecision("rec-up");
    expect(fetched?.upstream).toEqual(upstream);
  });
});
