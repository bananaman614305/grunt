/**
 * The per-key roster store (ADR-008), as implemented by `DecisionLog`.
 *
 * The invariant these tests exist for is the one in `assertKeyHash`: the
 * table holds a hash of the user's OpenRouter key and never the key itself.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Roster } from "../types.js";
import { DecisionLog } from "./decision-log.js";
import { assertKeyHash, rosterModelCount } from "./roster-store.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const HASH = createHash("sha256").update(`Bearer ${KEY}`, "utf8").digest("hex");
const OTHER_HASH = createHash("sha256").update("Bearer sk-or-v1-someone-else", "utf8").digest("hex");

const ROSTER: Roster = {
  fast: ["deepseek/deepseek-v4-flash"],
  mid: ["openai/gpt-5.6-luna"],
  frontier: ["anthropic/claude-opus-5", "z-ai/glm-5.3"],
};

describe("assertKeyHash", () => {
  it("accepts a SHA-256 hex digest", () => {
    expect(() => assertKeyHash(HASH)).not.toThrow();
  });

  it("refuses anything that is not one, a raw key most of all", () => {
    for (const bad of [KEY, `Bearer ${KEY}`, "", "abc", HASH.toUpperCase(), `${HASH}0`]) {
      expect(() => assertKeyHash(bad)).toThrow(/SHA-256/);
    }
  });
});

describe("rosterModelCount", () => {
  it("counts ids across every tier", () => {
    expect(rosterModelCount(ROSTER)).toBe(4);
    expect(rosterModelCount({ fast: [], mid: [], frontier: [] })).toBe(0);
  });
});

describe("DecisionLog roster store", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("returns undefined for a key that stored nothing", async () => {
    expect(await log.getRoster(HASH)).toBeUndefined();
  });

  it("round-trips a roster with its source and timestamps", async () => {
    const stored = await log.setRoster(HASH, ROSTER, { now: "2026-09-17T10:00:00.000Z" });

    expect(stored).toEqual({
      keyHash: HASH,
      roster: ROSTER,
      source: "user",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
    });
    expect(await log.getRoster(HASH)).toEqual(stored);
  });

  it("replaces on a second write but keeps the first createdAt", async () => {
    await log.setRoster(HASH, ROSTER, { now: "2026-09-17T10:00:00.000Z" });
    const next: Roster = { fast: ["x/one"], mid: [], frontier: [] };
    const stored = await log.setRoster(HASH, next, { now: "2026-09-18T10:00:00.000Z" });

    expect(stored.roster).toEqual(next);
    expect(stored.createdAt).toBe("2026-09-17T10:00:00.000Z");
    expect(stored.updatedAt).toBe("2026-09-18T10:00:00.000Z");
  });

  it("keeps one key's roster invisible to another", async () => {
    await log.setRoster(HASH, ROSTER);
    expect(await log.getRoster(OTHER_HASH)).toBeUndefined();
  });

  it("deletes, and says whether there was anything to delete", async () => {
    await log.setRoster(HASH, ROSTER);
    expect(await log.deleteRoster(HASH)).toBe(true);
    expect(await log.getRoster(HASH)).toBeUndefined();
    expect(await log.deleteRoster(HASH)).toBe(false);
  });

  it("lists stored rosters newest first, as shapes rather than contents", async () => {
    await log.setRoster(HASH, ROSTER, { now: "2026-09-17T10:00:00.000Z" });
    await log.setRoster(OTHER_HASH, { fast: ["a/b"], mid: [], frontier: [] }, { now: "2026-09-18T10:00:00.000Z" });

    const list = await log.listRosters();
    expect(list).toEqual([
      {
        keyHash: OTHER_HASH,
        modelCount: 1,
        source: "user",
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:00:00.000Z",
      },
      {
        keyHash: HASH,
        modelCount: 4,
        source: "user",
        createdAt: "2026-09-17T10:00:00.000Z",
        updatedAt: "2026-09-17T10:00:00.000Z",
      },
    ]);
  });

  it("clamps the list limit", async () => {
    await log.setRoster(HASH, ROSTER);
    await log.setRoster(OTHER_HASH, ROSTER);
    expect(await log.listRosters({ limit: 1 })).toHaveLength(1);
    expect(await log.listRosters({ limit: 0 })).toHaveLength(1);
  });

  it("refuses a raw credential in place of a hash, on every method", async () => {
    await expect(log.getRoster(KEY)).rejects.toThrow(/SHA-256/);
    await expect(log.setRoster(KEY, ROSTER)).rejects.toThrow(/SHA-256/);
    await expect(log.deleteRoster(KEY)).rejects.toThrow(/SHA-256/);
  });

  it("refuses a roster that carries a key-shaped model id", async () => {
    await expect(
      log.setRoster(HASH, { fast: [`Bearer ${KEY}`], mid: [], frontier: [] }),
    ).rejects.toThrow(/key or bearer token/);
  });

  it("stores only the hash: the key appears nowhere in the table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-roster-store-"));
    try {
      const url = `file:${join(dir, "rosters.db")}`;
      const persistent = await DecisionLog.open(url);
      await persistent.setRoster(HASH, ROSTER);
      await persistent.close();

      const db = createClient({ url });
      try {
        const rs = await db.execute("SELECT * FROM rosters");
        expect(rs.rows).toHaveLength(1);
        const dumped = JSON.stringify(rs.rows.map((row) => ({ ...row })));
        expect(dumped).toContain(HASH);
        expect(dumped).not.toContain(KEY);
        expect(dumped).not.toContain("sk-or-");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
