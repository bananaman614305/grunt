/**
 * Layer 3 (ADR-019): the completeness gate's ground-truth extension. When a
 * coding/agentic request supplies git/receipts via `milo: { verify: {...} }`,
 * the gate checks the answer's load-bearing claims against that ground truth,
 * discloses the finding on `x-milo-verify`, and lets a CONFIDENT contradiction
 * take the gate's one retry. With no ground truth supplied the gate behaves
 * exactly as before (covered by gate.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DecisionLog, OpenRouterClient } from "@milo/core";
import type { ChatMessage, JevClientLike, RouteDecision, Router, SystemOneResult } from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import type { AppDeps } from "../app.js";
import { RateLimiter } from "../rate-limit.js";

const AUTH = { authorization: "Bearer sk-or-v1-GATEVERIFY0123456789abcdef", "content-type": "application/json" };
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a coding sub-agent." },
  { role: "user", content: "Add a retry to the client and make the tests pass." },
];

class FakeOpenRouter {
  calls = 0;
  content = "All tests pass. I implemented the retry.";
  readonly fetch: typeof fetch = (async () => {
    this.calls += 1;
    const body = {
      id: `gen-${this.calls}`,
      object: "chat.completion",
      created: 1_700_000_000,
      model: "test/mid",
      choices: [{ index: 0, message: { role: "assistant", content: this.content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0001 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/**
 * A Jev that answers completeness (always `complete`), rank (level 0), and the
 * ground-truth claim questions with `verdict`/`confidence`. It dispatches by
 * question/state shape: a verify call carries git/receipts in its state.
 */
function gateJev(verify: { verdict: string; confidence?: number } = { verdict: "supported" }): JevClientLike & {
  verifyCalls: number;
} {
  const stub = {
    verifyCalls: 0,
    systemone(req: { state: unknown; questions: Record<string, unknown> }): Promise<SystemOneResult> {
      const state = req.state as Record<string, unknown>;
      if ("git" in state || "receipts" in state) {
        stub.verifyCalls += 1;
        const answers: SystemOneResult["answers"] = {};
        const conf = verify.confidence ?? 0.9;
        for (const key of Object.keys(req.questions)) {
          answers[key] = { type: "choice", choice: verify.verdict, confidence: conf, probabilities: { [verify.verdict]: conf } };
        }
        return Promise.resolve({ model: "jev-latest", answers, usage: { input_tokens: 400, output_tokens: 6 }, requestId: "req_v", latencyMs: 30 });
      }
      if ("completeness" in req.questions) {
        return Promise.resolve({
          model: "jev-latest",
          answers: { completeness: { type: "choice", choice: "complete", confidence: 0.95, probabilities: { complete: 0.95 } } },
          usage: { input_tokens: 400, output_tokens: 6 },
          requestId: "req_c",
          latencyMs: 20,
        });
      }
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: { "1": 1 } },
          correct: { type: "noul", noul: 0.3 },
        },
        usage: { input_tokens: 300, output_tokens: 8 },
        requestId: "req_r",
        latencyMs: 25,
      });
    },
  };
  return stub;
}

function decision(): RouteDecision {
  return {
    id: "01GATEVERIFYDEC0000000000",
    fingerprint: "fp-gv",
    signals: {
      taskType: "feature",
      difficulty: 0.69,
      difficultyLevels: [0.5, 0.35, 0.11, 0.04],
      needsReasoning: 0.4,
      longOutput: 0.1,
      confidences: { task_type: 0.9 },
      jevRequestId: "req_route",
      jevModel: "jev-latest",
      latencyMs: 60,
    },
    tier: "mid",
    model: "test/mid",
    reason: "feature task, routed to mid",
    policyVersion: "v4",
    sticky: false,
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

const logs: DecisionLog[] = [];
let openRouter: FakeOpenRouter;

beforeEach(() => {
  openRouter = new FakeOpenRouter();
});
afterEach(async () => {
  for (const log of logs) await log.close();
  logs.length = 0;
});

async function app(jev: JevClientLike): Promise<Hono> {
  const log = await DecisionLog.open(":memory:");
  logs.push(log);
  const fixed = decision();
  await log.insert(fixed);
  const deps: AppDeps = {
    router: { route: async () => fixed } as unknown as Router,
    roster: { fast: ["test/fast"], mid: ["test/mid"], frontier: ["test/frontier"] },
    openRouter: new OpenRouterClient({ fetch: openRouter.fetch }),
    anthropic: new AnthropicUpstream({ fetch: openRouter.fetch }),
    log,
    rateLimiter: new RateLimiter(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: Date.now,
    recordUpstream: (id, upstream) => void log.setUpstream(id, upstream),
    jev,
  };
  return createApp(deps);
}

function chat(milo?: Record<string, unknown>): Request {
  return new Request("http://milo.test/v1/chat/completions", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ model: "milo/auto", messages: MESSAGES, ...(milo !== undefined ? { milo } : {}) }),
  });
}

const GROUND = { verify: { git: "diff --git a/c.ts b/c.ts\n+retry\n", receipts: [{ command: "pnpm test", exitCode: 0 }] } };

describe("the completeness gate's ground-truth extension (ADR-019)", () => {
  it("discloses a clean finding and serves as-is when ground truth backs the claims", async () => {
    const jev = gateJev({ verdict: "supported" });
    const res = await (await app(jev)).request(chat(GROUND));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-verify")).toBe("clean");
    expect(res.headers.get("x-milo-retry")).toBeNull(); // clean -> no retry
    expect(jev.verifyCalls).toBe(1);
    expect(openRouter.calls).toBe(1); // one upstream call, no retry
  });

  it("takes the one retry on a confident contradiction, disclosing x-milo-verify", async () => {
    const jev = gateJev({ verdict: "contradicted", confidence: 0.9 });
    const res = await (await app(jev)).request(chat(GROUND));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-verify")).toBe("contradicted");
    expect(res.headers.get("x-milo-retry")).toBe("1"); // the contradiction forced the retry
    expect(openRouter.calls).toBe(2); // original + one retry, never more
  });

  it("does not retry on a low-confidence contradiction (disclosure only)", async () => {
    const jev = gateJev({ verdict: "contradicted", confidence: 0.3 });
    const res = await (await app(jev)).request(chat(GROUND));
    expect(res.headers.get("x-milo-verify")).toBe("contradicted");
    expect(res.headers.get("x-milo-retry")).toBeNull(); // below the confidence bar
    expect(openRouter.calls).toBe(1);
  });

  it("does not run the verification when no ground truth is supplied", async () => {
    const jev = gateJev({ verdict: "contradicted", confidence: 0.99 });
    const res = await (await app(jev)).request(chat()); // no milo.verify
    expect(res.headers.get("x-milo-verify")).toBeNull();
    expect(res.headers.get("x-milo-completeness")).toBe("complete");
    expect(jev.verifyCalls).toBe(0);
    expect(openRouter.calls).toBe(1);
  });

  it("fails open: a verify Jev error leaves the completeness flow unchanged", async () => {
    // A jev whose verify calls throw but completeness answers `complete`.
    const jev: JevClientLike = {
      systemone(req: { state: unknown; questions: Record<string, unknown> }) {
        const state = req.state as Record<string, unknown>;
        if ("git" in state || "receipts" in state) return Promise.reject(new Error("verify down"));
        return Promise.resolve({
          model: "jev-latest",
          answers: { completeness: { type: "choice", choice: "complete", confidence: 0.95, probabilities: { complete: 0.95 } } },
          usage: { input_tokens: 400, output_tokens: 6 },
          requestId: "req_c",
          latencyMs: 20,
        } satisfies SystemOneResult);
      },
    };
    const res = await (await app(jev)).request(chat(GROUND));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-verify")).toBeNull(); // nothing disclosed on a hiccup
    expect(res.headers.get("x-milo-completeness")).toBe("complete"); // served as-is
    expect(openRouter.calls).toBe(1);
  });
});
