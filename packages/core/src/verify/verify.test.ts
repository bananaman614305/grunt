import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import { extractClaims } from "./claims.js";
import { gitStateFromDiff } from "./probes.js";
import type { Claim, ClaimResult, ClaimVerdict, VerifyGroundTruth } from "./types.js";
import {
  aggregate,
  buildGroundState,
  emptyResult,
  isCrossFamily,
  modelFamily,
  verifyClaims,
  VERIFY_CONFIDENT,
} from "./verify.js";

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };

/** A fake Jev that returns a per-claim verdict from a lookup by claim id. */
function verdictJev(
  verdicts: Record<string, { choice: ClaimVerdict; confidence: number }>,
): JevClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    systemone: (req) => {
      calls.push(req);
      const answers: SystemOneResult["answers"] = {};
      for (const key of Object.keys(req.questions)) {
        const v = verdicts[key] ?? { choice: "unsupported" as ClaimVerdict, confidence: 0.4 };
        answers[key] = { type: "choice", choice: v.choice, confidence: v.confidence, probabilities: { [v.choice]: v.confidence } };
      }
      return Promise.resolve({
        model: "jev-latest",
        answers,
        usage: { input_tokens: 500, output_tokens: 9 },
        requestId: "req_verify",
        latencyMs: 40,
      } satisfies SystemOneResult);
    },
  };
}

const GROUND: VerifyGroundTruth = { git: gitStateFromDiff("diff --git a/x b/x\n+added\n") };

describe("modelFamily / isCrossFamily", () => {
  it("takes the vendor prefix", () => {
    expect(modelFamily("anthropic/claude-opus-4.8")).toBe("anthropic");
    expect(modelFamily("deepseek/deepseek-v4-flash")).toBe("deepseek");
    expect(modelFamily("jev-latest")).toBe("jev-latest");
  });

  it("Jev is cross-family to any code executor, and to none by default", () => {
    expect(isCrossFamily("anthropic/claude-opus-4.8")).toBe(true);
    expect(isCrossFamily("deepseek")).toBe(true);
    expect(isCrossFamily(undefined)).toBe(true);
    // a hypothetical same-family auditor would be caught
    expect(isCrossFamily("typesafe/jev", "typesafe")).toBe(false);
  });
});

describe("buildGroundState", () => {
  it("serializes git and receipts without message content", () => {
    const state = buildGroundState({
      git: gitStateFromDiff("diff --git a/f b/f\n+x\n"),
      receipts: [{ command: "pnpm test", exitCode: 0 }],
      note: "sandbox run",
    });
    expect((state["git"] as Record<string, unknown>)["filesChanged"]).toBe(1);
    expect(Array.isArray(state["receipts"])).toBe(true);
    expect((state["receipts"] as unknown[])).toHaveLength(1);
    expect(state["note"]).toBe("sandbox run");
  });
});

describe("aggregate", () => {
  const result = (verdict: ClaimVerdict, confidence: number): ClaimResult => ({
    claim: { id: "x", text: "t", category: "other" },
    verdict,
    confidence,
  });

  it("counts verdicts and finds clean", () => {
    const s = aggregate([result("supported", 0.9), result("supported", 0.8)]);
    expect(s.finding).toBe("clean");
    expect(s.blocking).toBe(false);
    expect(s.supported).toBe(2);
    expect(s.line).toContain("2 claims checked");
  });

  it("unsupported is adverse but never blocking", () => {
    const s = aggregate([result("unsupported", 0.99)]);
    expect(s.finding).toBe("unsupported");
    expect(s.blocking).toBe(false);
  });

  it("a confident contradiction blocks; a low-confidence one does not", () => {
    expect(aggregate([result("contradicted", VERIFY_CONFIDENT)]).blocking).toBe(true);
    expect(aggregate([result("contradicted", VERIFY_CONFIDENT - 0.01)]).blocking).toBe(false);
    expect(aggregate([result("contradicted", 0.9)]).finding).toBe("contradicted");
  });

  it("summarizes an empty pass", () => {
    expect(aggregate([]).line).toContain("No load-bearing claims");
  });
});

describe("verifyClaims: forwarded Jev key (ADR-022)", () => {
  const claims: Claim[] = [{ id: "c1", text: "All tests pass.", category: "test" }];

  /** Records the per-call `apiKey` opt each systemone call saw. */
  function keyCapturingAuditor(): JevClientLike & { keys: Array<string | undefined> } {
    const keys: Array<string | undefined> = [];
    return {
      keys,
      systemone: (_req, opts) => {
        keys.push(opts?.apiKey);
        return Promise.resolve({
          model: "jev-latest",
          answers: { c1: { type: "choice", choice: "supported", confidence: 0.9, probabilities: { supported: 0.9 } } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "req_verify",
          latencyMs: 5,
        } satisfies SystemOneResult);
      },
    };
  }

  it("threads the forwarded key to the systemone call as opts.apiKey", async () => {
    const jev = keyCapturingAuditor();
    await verifyClaims(jev, claims, GROUND, undefined, "sk-or-v1-forwarded");
    expect(jev.keys).toEqual(["sk-or-v1-forwarded"]);
  });

  it("passes no apiKey when none is threaded (TypeSafe default: Milo's key)", async () => {
    const jev = keyCapturingAuditor();
    await verifyClaims(jev, claims, GROUND);
    expect(jev.keys).toEqual([undefined]);
  });
});

describe("verifyClaims", () => {
  it("verifies one call carrying every claim as a question over shared ground truth", async () => {
    const claims = extractClaims("I implemented the parser. All tests pass.");
    const byId: Record<string, { choice: ClaimVerdict; confidence: number }> = {};
    for (const c of claims) byId[c.id] = { choice: "supported", confidence: 0.9 };
    const jev = verdictJev(byId);

    const out = await verifyClaims(jev, claims, GROUND);
    expect(jev.calls).toHaveLength(1); // ONE Jev call for all claims
    expect(out.results).toHaveLength(claims.length);
    expect(out.summary.finding).toBe("clean");
    expect(out.latencyMs).toBe(40);
    // the state carried the git ground truth, not any answer text
    expect((jev.calls[0]?.state as Record<string, unknown>)["git"]).toBeDefined();
  });

  it("surfaces a contradiction as a blocking finding", async () => {
    const claims: Claim[] = [{ id: "c1", text: "All tests pass.", category: "test" }];
    const jev = verdictJev({ c1: { choice: "contradicted", confidence: 0.85 } });
    const out = await verifyClaims(jev, claims, { receipts: [{ command: "pnpm test", exitCode: 1 }] });
    expect(out.summary.finding).toBe("contradicted");
    expect(out.summary.blocking).toBe(true);
  });

  it("returns an empty non-blocking result when there are no claims", async () => {
    const jev = verdictJev({});
    const out = await verifyClaims(jev, [], GROUND);
    expect(jev.calls).toHaveLength(0);
    expect(out.summary.blocking).toBe(false);
    expect(out.summary.checked).toBe(0);
  });

  it("skips an answer of the wrong shape rather than throwing", async () => {
    const claims: Claim[] = [{ id: "c1", text: "done", category: "completion" }];
    const jev: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: { c1: { type: "noul", noul: 1 } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "r",
          latencyMs: 5,
        } satisfies SystemOneResult),
    };
    const out = await verifyClaims(jev, claims, GROUND);
    expect(out.results).toHaveLength(0);
  });

  it("propagates a Jev failure to the caller (which fails open)", async () => {
    const claims: Claim[] = [{ id: "c1", text: "done", category: "completion" }];
    const jev: JevClientLike = { systemone: () => Promise.reject(new Error("jev down")) };
    await expect(verifyClaims(jev, claims, GROUND)).rejects.toThrow("jev down");
  });

  it("emptyResult is non-blocking", () => {
    expect(emptyResult().summary.blocking).toBe(false);
  });
});
