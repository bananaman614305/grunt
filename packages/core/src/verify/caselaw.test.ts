import { describe, expect, it } from "vitest";
import { demandedOracles, demandOracle, openCaseLaw, updateCaseLaw } from "./caselaw.js";
import type { ClaimResult } from "./types.js";

const NOW = new Date("2026-09-18T00:00:00.000Z");

function result(id: string, verdict: ClaimResult["verdict"], category: ClaimResult["claim"]["category"] = "test"): ClaimResult {
  return { claim: { id, text: `claim ${id}`, category }, verdict, confidence: 0.5 };
}

describe("demandOracle", () => {
  it("produces an open entry with a category-specific recheck", () => {
    const entry = demandOracle(result("a", "unsupported", "build"), NOW);
    expect(entry.status).toBe("open");
    expect(entry.demandedAt).toBe(NOW.toISOString());
    expect(entry.recheck.toLowerCase()).toContain("build");
  });

  it("demands oracles only for unsupported claims", () => {
    const oracles = demandedOracles(
      [result("a", "unsupported"), result("b", "contradicted"), result("c", "supported")],
      NOW,
    );
    expect(oracles.map((o) => o.id)).toEqual(["a"]);
  });
});

describe("updateCaseLaw", () => {
  it("adds new demands and keeps them open", () => {
    const law = updateCaseLaw([], [result("a", "unsupported")], NOW);
    expect(openCaseLaw(law).map((e) => e.id)).toEqual(["a"]);
  });

  it("resolves an open entry when its claim is later supported", () => {
    const first = updateCaseLaw([], [result("a", "unsupported")], NOW);
    const later = new Date("2026-09-19T00:00:00.000Z");
    const second = updateCaseLaw(first, [result("a", "supported")], later);
    const entry = second.find((e) => e.id === "a");
    expect(entry?.status).toBe("resolved");
    expect(entry?.resolvedAt).toBe(later.toISOString());
    expect(openCaseLaw(second)).toEqual([]);
  });

  it("does not duplicate an already-open demand", () => {
    const first = updateCaseLaw([], [result("a", "unsupported")], NOW);
    const second = updateCaseLaw(first, [result("a", "unsupported")], NOW);
    expect(second.filter((e) => e.id === "a")).toHaveLength(1);
  });

  it("re-demands an oracle for a claim that had been resolved but is unsupported again", () => {
    const resolved = [{ id: "a", claim: "claim a", category: "test" as const, demandedAt: NOW.toISOString(), status: "resolved" as const, resolvedAt: NOW.toISOString(), recheck: "x" }];
    const reopened = updateCaseLaw(resolved, [result("a", "unsupported")], NOW);
    expect(reopened.find((e) => e.id === "a")?.status).toBe("open");
  });

  it("does not mutate its inputs", () => {
    const existing = updateCaseLaw([], [result("a", "unsupported")], NOW);
    const snapshot = JSON.stringify(existing);
    updateCaseLaw(existing, [result("a", "supported")], NOW);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});
