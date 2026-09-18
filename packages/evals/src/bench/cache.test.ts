import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditSelected, graderContentHash, JudgeCache, verdictKey } from "./cache.js";
import type { Grader } from "./graders.js";
import type { Grade } from "./types.js";

const grader: Grader = { type: "judge", rubric: "clear docs" };

function key(over: Partial<Parameters<typeof verdictKey>[0]> = {}): string {
  return verdictKey({ exampleId: "r-1", graderHash: graderContentHash(grader), judgeModel: "judge/cheap", answer: "the answer", ...over });
}

const verdict: Grade = { score: 0.9, pass: true, by: "judge", reason: "fine", judgeCostUsd: 0.002 };

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "judge-cache-"));
}

describe("verdictKey", () => {
  it("is stable for identical input and shaped like sha256 hex", () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the answer changes", () => {
    expect(key({ answer: "another answer" })).not.toBe(key());
  });

  it("changes when the judge model changes", () => {
    expect(key({ judgeModel: "judge/strong" })).not.toBe(key());
  });

  it("changes when the grader content changes", () => {
    const edited = graderContentHash({ type: "judge", rubric: "clear docs, with examples" });
    expect(edited).not.toBe(graderContentHash(grader));
    expect(key({ graderHash: edited })).not.toBe(key());
  });

  it("changes when the example id changes", () => {
    expect(key({ exampleId: "r-2" })).not.toBe(key());
  });
});

describe("JudgeCache", () => {
  it("misses when empty, hits after set, and strips the cost on a hit", () => {
    const cache = new JudgeCache(freshDir());
    const k = key();
    expect(cache.get(k)).toBeUndefined();
    cache.set(k, verdict);
    expect(cache.get(k)).toEqual({ score: 0.9, pass: true, by: "judge", reason: "fine" });
  });

  it("misses under a different key: a changed answer or judge model finds nothing", () => {
    const cache = new JudgeCache(freshDir());
    cache.set(key(), verdict);
    expect(cache.get(key({ answer: "another answer" }))).toBeUndefined();
    expect(cache.get(key({ judgeModel: "judge/strong" }))).toBeUndefined();
  });

  it("stores one file per verdict, named by the key, and keeps the cost in the file", () => {
    const dir = freshDir();
    const cache = new JudgeCache(dir);
    const k = key();
    cache.set(k, verdict);
    expect(readdirSync(dir)).toEqual([`${k}.json`]);
  });

  it("treats an unreadable or malformed entry as a miss", () => {
    const dir = freshDir();
    const cache = new JudgeCache(dir);
    const k = key();
    writeFileSync(join(dir, `${k}.json`), "not json", "utf8");
    expect(cache.get(k)).toBeUndefined();
    writeFileSync(join(dir, `${k}.json`), JSON.stringify({ score: "high" }), "utf8");
    expect(cache.get(k)).toBeUndefined();
  });

  it("refuses a name that is not a verdict key", () => {
    const cache = new JudgeCache(freshDir());
    expect(() => cache.get("../evil")).toThrow(/not a verdict key/);
  });
});

describe("auditSelected", () => {
  it("is deterministic: the same slot gives the same answer every time", () => {
    for (const [id, arm] of [["r-1", "milo"], ["r-2", "fast"], ["r-3", "sample-0"]] as const) {
      expect(auditSelected(id, arm, 0.3)).toBe(auditSelected(id, arm, 0.3));
    }
  });

  it("selects nothing at 0 and everything at 1", () => {
    expect(auditSelected("r-1", "milo", 0)).toBe(false);
    expect(auditSelected("r-1", "milo", 1)).toBe(true);
  });

  it("only ever adds slots when the fraction rises", () => {
    for (let i = 0; i < 200; i += 1) {
      if (auditSelected(`r-${i}`, "milo", 0.1)) {
        expect(auditSelected(`r-${i}`, "milo", 0.5)).toBe(true);
      }
    }
  });

  it("picks roughly the asked-for fraction over many slots", () => {
    let picked = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (auditSelected(`r-${i}`, "milo", 0.1)) picked += 1;
    }
    expect(picked).toBeGreaterThan(50);
    expect(picked).toBeLessThan(160);
  });

  it("distinguishes arms of the same example", () => {
    const arms = ["milo", "fast", "mid", "frontier", "sample-0", "sample-1"];
    const picks = new Set(arms.map((arm) => auditSelected("r-42", arm, 0.5)));
    expect(picks.size).toBe(2); // some in, some out — the arm is part of the hash
  });
});
