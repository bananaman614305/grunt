/**
 * `POST /v1/verify` (ADR-019) against a stub Jev: claim extraction from a turn,
 * the per-claim verdicts, the case-law the endpoint demands, and -- above all --
 * that every failure path is a 200 with a non-blocking verdict, never a 5xx
 * that could stall the agent being checked.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DecisionLog, OpenRouterClient } from "@milo/core";
import type { ClaimVerdict, JevClientLike, Router, SystemOneResult } from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import type { AppDeps } from "../app.js";
import { RateLimiter } from "../rate-limit.js";
import { parseVerifyInput } from "./verify.js";

const AUTH = { authorization: "Bearer sk-or-v1-VERIFYTEST0123456789abcdef", "content-type": "application/json" };

/** A Jev that answers every claim question with a verdict from a map by claim text. */
function verifyJev(
  verdicts: Record<string, { choice: ClaimVerdict; confidence: number }>,
): JevClientLike & { calls: number; keys: Array<string | undefined> } {
  const jev = {
    calls: 0,
    keys: [] as Array<string | undefined>,
    systemone(req: { questions: Record<string, { instructions?: string }> }, opts?: { apiKey?: string }) {
      jev.calls += 1;
      jev.keys.push(opts?.apiKey);
      const answers: SystemOneResult["answers"] = {};
      for (const [key, q] of Object.entries(req.questions)) {
        const match = Object.entries(verdicts).find(([text]) => (q.instructions ?? "").includes(text));
        const v = match?.[1] ?? { choice: "unsupported" as ClaimVerdict, confidence: 0.4 };
        answers[key] = { type: "choice", choice: v.choice, confidence: v.confidence, probabilities: { [v.choice]: v.confidence } };
      }
      return Promise.resolve({
        model: "jev-latest",
        answers,
        usage: { input_tokens: 300, output_tokens: 6 },
        requestId: "req_v",
        latencyMs: 30,
      } satisfies SystemOneResult);
    },
  };
  return jev;
}

const logs: DecisionLog[] = [];
afterEach(async () => {
  for (const log of logs) await log.close();
  logs.length = 0;
});

async function app(opts: { jev?: JevClientLike; forwardJevKey?: boolean } = {}): Promise<Hono> {
  const log = await DecisionLog.open(":memory:");
  logs.push(log);
  const deps: AppDeps = {
    router: { route: async () => { throw new Error("router unused"); } } as unknown as Router,
    roster: { fast: ["test/fast"], mid: ["test/mid"], frontier: ["test/frontier"] },
    openRouter: new OpenRouterClient({ fetch: (() => { throw new Error("no upstream"); }) as unknown as typeof fetch }),
    anthropic: new AnthropicUpstream({ fetch: (() => { throw new Error("no upstream"); }) as unknown as typeof fetch }),
    log,
    rateLimiter: new RateLimiter(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: Date.now,
    recordUpstream: () => undefined,
    ...(opts.jev !== undefined ? { jev: opts.jev } : {}),
    ...(opts.forwardJevKey !== undefined ? { forwardJevKey: opts.forwardJevKey } : {}),
  };
  return createApp(deps);
}

function post(body: unknown): Request {
  return new Request("http://milo.test/v1/verify", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

describe("parseVerifyInput", () => {
  it("extracts claims from a turn and parses git probes", () => {
    const input = parseVerifyInput({
      turn: "I implemented the parser. All tests pass.",
      git: { status: "M  src/p.ts", diff: "diff --git a/src/p.ts b/src/p.ts\n+x\n" },
      receipts: [{ command: "pnpm test", exitCode: 0 }],
    });
    expect(input.claims.length).toBeGreaterThanOrEqual(2);
    expect(input.ground.git?.filesChanged).toBe(1);
    expect(input.ground.receipts).toHaveLength(1);
  });

  it("accepts pre-extracted claim strings and objects", () => {
    const input = parseVerifyInput({ claims: ["All tests pass", { text: "Build is clean", category: "build" }] });
    expect(input.claims.map((c) => c.text)).toEqual(["All tests pass", "Build is clean"]);
    expect(input.claims[1]?.category).toBe("build");
  });

  it("treats a raw diff string as git ground truth", () => {
    const input = parseVerifyInput({ turn: "done", git: "diff --git a/f b/f\n+y\n" });
    expect(input.ground.git?.filesChanged).toBe(1);
  });

  it("yields no claims and empty ground for an empty body", () => {
    const input = parseVerifyInput({});
    expect(input.claims).toEqual([]);
    expect(input.ground.git).toBeUndefined();
  });
});

describe("POST /v1/verify", () => {
  it("requires a key", async () => {
    const res = await (await app()).request("http://milo.test/v1/verify", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("verifies a turn's claims against git and returns verdicts + summary", async () => {
    const jev = verifyJev({
      "implemented the parser": { choice: "supported", confidence: 0.9 },
      "tests pass": { choice: "supported", confidence: 0.95 },
    });
    const res = await (await app({ jev })).request(
      post({ turn: "I implemented the parser. All tests pass.", git: "diff --git a/p b/p\n+x\n" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdicts: unknown[]; summary: { finding: string }; blocking: boolean; crossFamily: boolean };
    expect(body.verdicts.length).toBeGreaterThanOrEqual(2);
    expect(body.summary.finding).toBe("clean");
    expect(body.blocking).toBe(false);
    expect(body.crossFamily).toBe(true);
    expect(jev.calls).toBe(1);
  });

  it("threads the caller's forwarded key to the verification call under forwardJevKey (ADR-022)", async () => {
    const jev = verifyJev({ "tests pass": { choice: "supported", confidence: 0.95 } });
    const res = await (await app({ jev, forwardJevKey: true })).request(
      post({ turn: "All tests pass.", git: "diff --git a/p b/p\n+x\n" }),
    );
    expect(res.status).toBe(200);
    expect(jev.keys).toEqual(["sk-or-v1-VERIFYTEST0123456789abcdef"]);
  });

  it("threads NO key to the verification call under the default TypeSafe transport (ADR-022)", async () => {
    const jev = verifyJev({ "tests pass": { choice: "supported", confidence: 0.95 } });
    const res = await (await app({ jev })).request(
      post({ turn: "All tests pass.", git: "diff --git a/p b/p\n+x\n" }),
    );
    expect(res.status).toBe(200);
    expect(jev.keys).toEqual([undefined]);
  });

  it("flags a confident contradiction as blocking and demands no oracle for it", async () => {
    const jev = verifyJev({ "tests pass": { choice: "contradicted", confidence: 0.9 } });
    const res = await (await app({ jev })).request(
      post({ turn: "All tests pass.", receipts: [{ command: "pnpm test", exitCode: 1 }] }),
    );
    const body = (await res.json()) as { summary: { finding: string }; blocking: boolean; caseLaw: unknown[] };
    expect(body.summary.finding).toBe("contradicted");
    expect(body.blocking).toBe(true);
    expect(body.caseLaw).toEqual([]); // a contradiction is a present finding, not a missing oracle
  });

  it("demands case law for an unsupported claim", async () => {
    const jev = verifyJev({ "implemented the cache": { choice: "unsupported", confidence: 0.5 } });
    const res = await (await app({ jev })).request(post({ turn: "I implemented the cache layer." }));
    const body = (await res.json()) as { caseLaw: Array<{ status: string }>; blocking: boolean };
    expect(body.caseLaw).toHaveLength(1);
    expect(body.caseLaw[0]?.status).toBe("open");
    expect(body.blocking).toBe(false);
  });

  it("fails open with a non-blocking 200 when Jev errors", async () => {
    const jev: JevClientLike = { systemone: () => Promise.reject(new Error("jev down")) };
    const res = await (await app({ jev })).request(post({ turn: "All tests pass." }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocking: boolean; unavailable: boolean; verdicts: unknown[] };
    expect(body.blocking).toBe(false);
    expect(body.unavailable).toBe(true);
    expect(body.verdicts).toEqual([]);
  });

  it("fails open when no auditor is configured", async () => {
    const res = await (await app()).request(post({ turn: "All tests pass." }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocking: boolean; unavailable: boolean };
    expect(body.blocking).toBe(false);
    expect(body.unavailable).toBe(true);
  });

  it("returns a clean non-blocking verdict for a turn with no claims", async () => {
    const jev = verifyJev({});
    const res = await (await app({ jev })).request(post({ turn: "Here is some background." }));
    const body = (await res.json()) as { summary: { checked: number }; blocking: boolean };
    expect(body.summary.checked).toBe(0);
    expect(body.blocking).toBe(false);
    expect(jev.calls).toBe(0); // no claims, no Jev call
  });

  it("fails open on an unreadable body", async () => {
    const res = await (await app({ jev: verifyJev({}) })).request(
      new Request("http://milo.test/v1/verify", { method: "POST", headers: AUTH, body: "not json" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unavailable: boolean }).unavailable).toBe(true);
  });
});
