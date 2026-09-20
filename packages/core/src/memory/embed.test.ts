import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_SIM_FLOOR,
  RETRIEVAL_TOP_K,
  cosineSimilarity,
  selectCandidates,
  unvectoredIds,
  type EmbeddableFact,
} from "./embed.js";

function fact(id: string, embedding?: number[]): EmbeddableFact {
  const f: EmbeddableFact = { id, category: "other", text: `fact ${id}` };
  if (embedding !== undefined) f.embedding = embedding;
  return f;
}

describe("cosineSimilarity", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposite direction", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("returns 0 rather than NaN for a zero vector or a length mismatch", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("selectCandidates", () => {
  it("keeps only vectored facts above the floor, closest first", () => {
    const query = [1, 0];
    const facts = [
      fact("near", [0.99, 0.14]), // ~cos 0.99
      fact("far", [0, 1]), // cos 0, below floor
      fact("mid", [0.7, 0.7]), // ~cos 0.70
    ];
    const out = selectCandidates(query, facts);
    expect(out.map((c) => c.fact.id)).toEqual(["near", "mid"]);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score!);
  });

  it("passes unvectored facts through as fail-open candidates with no score", () => {
    const out = selectCandidates([1, 0], [fact("novec"), fact("hit", [1, 0])]);
    const ids = out.map((c) => c.fact.id).sort();
    expect(ids).toEqual(["hit", "novec"]);
    expect(out.find((c) => c.fact.id === "novec")!.score).toBeUndefined();
  });

  it("returns every fact fail-open when there is no query vector", () => {
    const facts = [fact("a", [1, 0]), fact("b"), fact("c", [0, 1])];
    const out = selectCandidates(undefined, facts);
    expect(out.map((c) => c.fact.id)).toEqual(["a", "b", "c"]);
    expect(out.every((c) => c.score === undefined)).toBe(true);
  });

  it("returns nothing when nothing clears the floor and all facts are vectored", () => {
    // An orthogonal query against vectored facts: zero candidates, so zero Jev.
    const out = selectCandidates([1, 0], [fact("a", [0, 1]), fact("b", [0, 1])]);
    expect(out).toEqual([]);
  });

  it("caps the vectored candidates at topK, keeping the closest", () => {
    const query = [1, 0];
    const facts: EmbeddableFact[] = [];
    for (let i = 0; i < RETRIEVAL_TOP_K + 5; i++) {
      // Decreasing similarity: a small angle that grows with i.
      const t = 0.01 * (i + 1);
      facts.push(fact(`f${i}`, [Math.cos(t), Math.sin(t)]));
    }
    const out = selectCandidates(query, facts);
    expect(out).toHaveLength(RETRIEVAL_TOP_K);
    expect(out[0]!.fact.id).toBe("f0"); // closest kept
    expect(out.some((c) => c.fact.id === `f${RETRIEVAL_TOP_K + 4}`)).toBe(false); // farthest dropped
  });

  it("respects an explicit floor", () => {
    const out = selectCandidates([1, 0], [fact("a", [0.7, 0.7])], { floor: 0.9 });
    expect(out).toEqual([]);
    expect(RETRIEVAL_SIM_FLOOR).toBeLessThan(0.9);
  });
});

describe("unvectoredIds", () => {
  it("lists exactly the facts missing a usable vector", () => {
    expect(unvectoredIds([fact("a", [1, 0]), fact("b"), fact("c", [])])).toEqual(["b", "c"]);
  });
});
