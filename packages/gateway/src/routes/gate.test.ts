/**
 * The completeness gate (ADR-013 phase A) against a mocked OpenRouter and a
 * stub Jev: when it fires, the failure-typed single retry, the better-answer
 * pick, every serve-the-original failure path, the disclosure headers, and
 * the buffered streaming replay.
 *
 * The router is stubbed to return a fixed decision -- the band the gate
 * reads comes off the decision's own signals -- so this file is only about
 * what the gateway does after the answer is in hand.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  DecisionLog,
  DEEPSEEK_BRANCH_MODEL,
  DEEPSEEK_ORCHESTRATOR_MODEL,
  DEFAULT_ROSTER_INFO,
  OpenRouterClient,
  RETRY_TEMPLATES,
} from "@milo/core";
import type {
  ChatMessage,
  DecisionRecord,
  JevClientLike,
  RouteDecision,
  Router,
  SystemOneResult,
} from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import type { AppDeps } from "../app.js";
import { RateLimiter } from "../rate-limit.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

type Upstream = NonNullable<DecisionRecord["upstream"]>;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type Call = { url: URL; body: Record<string, unknown> };

class FakeOpenRouter {
  readonly calls: Call[] = [];
  handler: (body: Record<string, unknown>, index: number) => Response = () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const call: Call = { url: new URL(href), body };
    this.calls.push(call);
    return this.handler(body, this.calls.length - 1);
  }) as typeof fetch;
}

function completionBody(content: string, tokens = 10) {
  return {
    id: `gen-${content}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "test/mid",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: tokens, total_tokens: 100 + tokens, cost: 0.0001 },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "or-req-1" },
  });
}

/**
 * A Jev that answers whichever question the call asks: the completeness
 * check gets `verdict`, and a ranking call reads the candidate's quality off
 * the digit after "q" in its text, so a test declares both in its fixture.
 */
function gateJev(
  opts: { verdict?: string; confidence?: number; failCheck?: boolean; failRank?: boolean } = {},
): JevClientLike & { checks: number; ranked: string[] } {
  const stub = {
    checks: 0,
    ranked: [] as string[],
    systemone: (req: {
      state: string | Record<string, unknown> | unknown[];
      questions: Record<string, unknown>;
    }): Promise<SystemOneResult> => {
      if ("completeness" in req.questions) {
        stub.checks += 1;
        if (opts.failCheck === true) return Promise.reject(new Error("jev down"));
        const choice = opts.verdict ?? "complete";
        const confidence = opts.confidence ?? 0.9;
        return Promise.resolve({
          model: "jev-latest",
          answers: {
            completeness: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
          },
          usage: { input_tokens: 400, output_tokens: 6 },
          requestId: "req_check",
          latencyMs: 20,
        });
      }
      const state = req.state as Record<string, unknown>;
      const candidate = String(state["candidate_answer"] ?? "");
      stub.ranked.push(candidate);
      if (opts.failRank === true) return Promise.reject(new Error("rank down"));
      const match = /q([0-3])/.exec(candidate);
      const level = match === null ? 0 : Number(match[1]);
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: level, confidence: 0.8, legend: {}, probabilities: { [String(level)]: 1 } },
          correct: { type: "noul", noul: level / 3 },
        },
        usage: { input_tokens: 300, output_tokens: 8 },
        requestId: "req_rank",
        latencyMs: 25,
      });
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "List the three risks and propose a mitigation for each." },
];

/** Band-1 signals: over the gate's bar without being a sampled cell. */
function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    id: "01GATEDECISION00000000000",
    fingerprint: "fp-gate",
    signals: {
      taskType: "feature",
      difficulty: 0.69,
      difficultyLevels: [0.5, 0.35, 0.11, 0.04],
      needsReasoning: 0.4,
      longOutput: 0.1,
      confidences: { task_type: 0.9, difficulty: 0.7 },
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
    ...overrides,
  };
}

/** The same decision with band-0 signals: under the gate's bar. */
function band0Decision(): RouteDecision {
  const d = decision();
  return {
    ...d,
    signals: { ...(d.signals as NonNullable<RouteDecision["signals"]>), difficulty: 0.1, difficultyLevels: [0.9, 0.1, 0, 0] },
  };
}

let openRouter: FakeOpenRouter;
let logs: DecisionLog[];
let recorded: Array<{ id: string; upstream: Upstream }>;

beforeEach(() => {
  openRouter = new FakeOpenRouter();
  logs = [];
  recorded = [];
});

afterEach(async () => {
  for (const log of logs) await log.close();
});

async function app(
  opts: { jev?: JevClientLike; decision?: RouteDecision; forwardJevKey?: boolean } = {},
): Promise<Hono> {
  const log = await DecisionLog.open(":memory:");
  logs.push(log);
  const fixed = opts.decision ?? decision();
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
    recordUpstream: (id, upstream) => {
      recorded.push({ id, upstream });
      void log.setUpstream(id, upstream);
    },
    ...(opts.jev !== undefined ? { jev: opts.jev } : {}),
    ...(opts.forwardJevKey !== undefined ? { forwardJevKey: opts.forwardJevKey } : {}),
  };
  return createApp(deps);
}

function chatRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("http://milo.test/v1/chat/completions", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ model: "milo/auto", messages: MESSAGES, ...extra }),
  });
}

/** The original answer, then the retry, whatever order the calls arrive. */
function originalThenRetry(original: string, retry: string): void {
  openRouter.handler = (_body, index) => ok(completionBody(index === 0 ? original : retry, 10 + index));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the completeness gate", () => {
  it("serves a complete answer as-is, disclosing the verdict, off one buffered upstream call", async () => {
    openRouter.handler = () => ok(completionBody("original q2"));
    const jev = gateJev({ verdict: "complete" });
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-completeness")).toBe("complete");
    expect(res.headers.get("x-milo-retry")).toBeNull();
    expect(res.headers.get("x-milo-gate-pick")).toBeNull();

    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("original q2");

    // One upstream call, buffered so the gate can read it.
    expect(openRouter.calls).toHaveLength(1);
    expect(openRouter.calls[0]?.body["stream"]).toBe(false);
    expect(jev.checks).toBe(1);
    expect(jev.ranked).toHaveLength(0);

    expect(recorded[0]?.upstream.gate).toEqual({ verdict: "complete", confidence: 0.9 });
    expect(recorded[0]?.upstream).toMatchObject({ status: 200, inputTokens: 100, outputTokens: 10 });
  });

  it("buys one retry on a failing verdict, rates both answers, and serves the better one", async () => {
    originalThenRetry("original q1", "retry q3");
    const jev = gateJev({ verdict: "incomplete" });
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-completeness")).toBe("incomplete");
    expect(res.headers.get("x-milo-retry")).toBe("1");
    expect(res.headers.get("x-milo-gate-pick")).toBe("retry");

    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("retry q3");

    // Exactly two upstream calls: the answer and its one retry, same model,
    // buffered, the original messages plus the incomplete template as one
    // final system message.
    expect(openRouter.calls).toHaveLength(2);
    const retry = openRouter.calls[1]?.body as Record<string, unknown>;
    expect(retry["model"]).toBe("test/mid");
    expect(retry["stream"]).toBe(false);
    expect(retry).not.toHaveProperty("milo");
    const retryMessages = retry["messages"] as ChatMessage[];
    expect(retryMessages).toHaveLength(MESSAGES.length + 1);
    expect(retryMessages.at(-1)).toEqual({ role: "system", content: RETRY_TEMPLATES.incomplete });

    // One check, two ratings, never a second check of the retried answer.
    expect(jev.checks).toBe(1);
    expect(jev.ranked).toHaveLength(2);

    // The record carries the verdict, the pick and both qualities; the
    // aggregate bills both generations (10 + 11 output tokens).
    const upstream = recorded[0]?.upstream;
    expect(upstream?.gate).toMatchObject({
      verdict: "incomplete",
      retried: true,
      pick: "retry",
      originalQuality: 1,
      retryQuality: 3,
      retry: { status: 200, inputTokens: 100, outputTokens: 11 },
    });
    expect(upstream).toMatchObject({ inputTokens: 200, outputTokens: 21, costUsd: 0.0002 });
    const record = JSON.stringify(upstream);
    expect(record).not.toContain("original q1");
    expect(record).not.toContain("retry q3");
  });

  it("keeps the original when it rates at least as well as the retry", async () => {
    originalThenRetry("original q2", "retry q0");
    const a = await app({ jev: gateJev({ verdict: "wrong_format" }) });

    const res = await a.fetch(chatRequest());
    expect(res.headers.get("x-milo-completeness")).toBe("wrong_format");
    expect(res.headers.get("x-milo-retry")).toBe("1");
    expect(res.headers.get("x-milo-gate-pick")).toBe("original");

    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("original q2");

    const retry = openRouter.calls[1]?.body["messages"] as ChatMessage[];
    expect(retry.at(-1)?.content).toBe(RETRY_TEMPLATES.wrong_format);

    // The retry was still generated, so it is still on the bill.
    expect(recorded[0]?.upstream).toMatchObject({ outputTokens: 21 });
    expect(recorded[0]?.upstream.gate).toMatchObject({ pick: "original", retried: true });
  });

  it("serves the answer as a passing one when the check itself fails, and records the error", async () => {
    openRouter.handler = () => ok(completionBody("original q1"));
    const a = await app({ jev: gateJev({ failCheck: true }) });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-completeness")).toBe("complete");
    expect(res.headers.get("x-milo-retry")).toBeNull();
    expect(openRouter.calls).toHaveLength(1);
    expect(recorded[0]?.upstream.gate).toEqual({ verdict: "error" });
  });

  it("serves the original when the retry call fails upstream", async () => {
    openRouter.handler = (_body, index) =>
      index === 0 ? ok(completionBody("original q1")) : new Response("boom", { status: 500 });
    const a = await app({ jev: gateJev({ verdict: "off_task" }) });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("original q1");
    expect(res.headers.get("x-milo-gate-pick")).toBe("original");
    expect(recorded[0]?.upstream.gate).toMatchObject({
      verdict: "off_task",
      pick: "original",
      retry: { status: 500, error: "http_500" },
    });
  });

  it("serves the original when rating fails, keeping the retry on the bill", async () => {
    originalThenRetry("original q1", "retry q3");
    const a = await app({ jev: gateJev({ verdict: "incomplete", failRank: true }) });

    const res = await a.fetch(chatRequest());
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("original q1");
    expect(res.headers.get("x-milo-gate-pick")).toBe("original");
    expect(recorded[0]?.upstream).toMatchObject({ outputTokens: 21 });
  });

  it("skips band 0, low posture, an opted-out request, and a decision without signals", async () => {
    const cases: Array<{ decision?: RouteDecision; milo?: Record<string, unknown> }> = [
      { decision: band0Decision() },
      { milo: { posture: "low" } },
      { milo: { gates: false } },
      { decision: decision({ signals: undefined as never, reason: "forced to the mid tier by the request" }) },
    ];
    for (const c of cases) {
      openRouter = new FakeOpenRouter();
      openRouter.handler = () => ok(completionBody("hello"));
      const jev = gateJev({ verdict: "incomplete" });
      const a = await app({ jev, ...(c.decision !== undefined ? { decision: c.decision } : {}) });

      const res = await a.fetch(chatRequest(c.milo !== undefined ? { milo: c.milo } : {}));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-milo-completeness")).toBeNull();
      expect(jev.checks).toBe(0);
      expect(openRouter.calls).toHaveLength(1);
      // The ungated single forward passes the body through untouched.
      expect(openRouter.calls[0]?.body["stream"]).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Fix 1: a `complete` verdict Jev is not sure of is suspect, not a pass
  // -------------------------------------------------------------------------

  it("re-rates a low-confidence complete verdict and serves a good answer with its own header", async () => {
    openRouter.handler = () => ok(completionBody("original q3"));
    const jev = gateJev({ verdict: "complete", confidence: 0.42 });
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-completeness")).toBe("complete-low-confidence");
    expect(res.headers.get("x-milo-retry")).toBeNull();

    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("original q3");

    // One generation, one check, one rating -- and no retry, because the
    // answer rated above the suspect bar.
    expect(openRouter.calls).toHaveLength(1);
    expect(jev.checks).toBe(1);
    expect(jev.ranked).toHaveLength(1);
    expect(recorded[0]?.upstream.gate).toEqual({
      verdict: "complete",
      confidence: 0.42,
      lowConfidence: true,
      originalQuality: 3,
    });
  });

  it("retries a low-confidence complete verdict whose answer rates below the suspect bar", async () => {
    originalThenRetry("original q1", "retry q3");
    const jev = gateJev({ verdict: "complete", confidence: 0.31 });
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.headers.get("x-milo-completeness")).toBe("complete-low-confidence");
    expect(res.headers.get("x-milo-retry")).toBe("1");
    expect(res.headers.get("x-milo-gate-pick")).toBe("retry");

    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message.content).toBe("retry q3");

    const retryMsgs = openRouter.calls[1]?.body["messages"] as ChatMessage[];
    expect(retryMsgs.at(-1)?.content).toBe(RETRY_TEMPLATES.incomplete);

    // The suspect rating is reused, so the pick costs one rating, not two.
    expect(jev.ranked).toHaveLength(2);
    expect(recorded[0]?.upstream.gate).toMatchObject({
      verdict: "complete",
      confidence: 0.31,
      lowConfidence: true,
      retried: true,
      pick: "retry",
      originalQuality: 1,
      retryQuality: 3,
    });
  });

  it("serves a low-confidence complete answer as-is when the re-rating itself fails", async () => {
    openRouter.handler = () => ok(completionBody("original q1"));
    const a = await app({ jev: gateJev({ verdict: "complete", confidence: 0.5, failRank: true }) });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-completeness")).toBe("complete-low-confidence");
    expect(res.headers.get("x-milo-retry")).toBeNull();
    expect(openRouter.calls).toHaveLength(1);
    expect(recorded[0]?.upstream.gate).toEqual({ verdict: "complete", confidence: 0.5, lowConfidence: true });
  });

  it("trusts a complete verdict at or above the confidence bar without paying for a rating", async () => {
    openRouter.handler = () => ok(completionBody("original q0"));
    const jev = gateJev({ verdict: "complete", confidence: 0.6 });
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.headers.get("x-milo-completeness")).toBe("complete");
    expect(jev.ranked).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fix 2: the retry escalates instead of re-begging the same model
  // -------------------------------------------------------------------------

  it("runs the retry on the same model, and records it, when nothing stronger exists", async () => {
    originalThenRetry("original q1", "retry q3");
    const a = await app({ jev: gateJev({ verdict: "incomplete" }) });

    const res = await a.fetch(chatRequest());
    expect(res.headers.get("x-milo-retry-model")).toBeNull();
    expect(openRouter.calls[1]?.body["model"]).toBe("test/mid");
    expect(recorded[0]?.upstream.gate).toMatchObject({ retryModel: "test/mid" });
  });

  it("escalates a controller decision's retry to the band-3 orchestrator model", async () => {
    originalThenRetry("original q1", "retry q3");
    const jev = gateJev({ verdict: "off_task" });
    const a = await app({ jev, decision: decision({ tier: "fast", model: DEEPSEEK_BRANCH_MODEL }) });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-retry")).toBe("1");
    expect(res.headers.get("x-milo-retry-model")).toBe(DEEPSEEK_ORCHESTRATOR_MODEL);

    // Still exactly one retry, and it ran on the stronger model.
    expect(openRouter.calls).toHaveLength(2);
    expect(openRouter.calls[0]?.body["model"]).toBe(DEEPSEEK_BRANCH_MODEL);
    expect(openRouter.calls[1]?.body["model"]).toBe(DEEPSEEK_ORCHESTRATOR_MODEL);
    expect(recorded[0]?.upstream.gate).toMatchObject({
      verdict: "off_task",
      retried: true,
      retryModel: DEEPSEEK_ORCHESTRATOR_MODEL,
      pick: "retry",
    });
  });

  it("gives the escalated retry a price ceiling computed for the model it actually calls", async () => {
    originalThenRetry("original q1", "retry q3");
    const jev = gateJev({ verdict: "incomplete" });
    const a = await app({ jev, decision: decision({ tier: "fast", model: DEEPSEEK_BRANCH_MODEL }) });

    await a.fetch(chatRequest());
    const branch = DEFAULT_ROSTER_INFO.tiers.fast.find((m) => m.id === DEEPSEEK_BRANCH_MODEL);
    const orchestrator = DEFAULT_ROSTER_INFO.tiers.mid.find((m) => m.id === DEEPSEEK_ORCHESTRATOR_MODEL);
    expect(openRouter.calls[0]?.body["provider"]).toEqual({
      sort: "throughput",
      allow_fallbacks: true,
      max_price: { prompt: (branch as { inputUsdPerM: number }).inputUsdPerM * 1.1, completion: (branch as { outputUsdPerM: number }).outputUsdPerM * 1.1 },
    });
    expect(openRouter.calls[1]?.body["provider"]).toEqual({
      sort: "throughput",
      allow_fallbacks: true,
      max_price: {
        prompt: (orchestrator as { inputUsdPerM: number }).inputUsdPerM * 1.1,
        completion: (orchestrator as { outputUsdPerM: number }).outputUsdPerM * 1.1,
      },
    });
  });

  it("leaves a caller-supplied provider preference on the escalated retry untouched", async () => {
    originalThenRetry("original q1", "retry q3");
    const jev = gateJev({ verdict: "incomplete" });
    const a = await app({ jev, decision: decision({ tier: "fast", model: DEEPSEEK_BRANCH_MODEL }) });

    await a.fetch(chatRequest({ provider: { order: ["mine"] } }));
    expect(openRouter.calls[1]?.body["provider"]).toEqual({ order: ["mine"] });
  });

  it("replays the served answer as well-formed SSE for a streaming client", async () => {
    originalThenRetry("original q1", "retry q3");
    const a = await app({ jev: gateJev({ verdict: "incomplete" }) });

    const res = await a.fetch(chatRequest({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-milo-retry")).toBe("1");

    // Both upstream calls were buffered whatever the client asked for.
    for (const call of openRouter.calls) expect(call.body["stream"]).toBe(false);

    const text = await res.text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
    expect(frames.at(-1)).toBe("data: [DONE]");
    const first = JSON.parse((frames[0] as string).slice("data: ".length)) as Record<string, unknown>;
    expect(first["object"]).toBe("chat.completion.chunk");
    const choices = first["choices"] as Array<Record<string, unknown>>;
    expect((choices[0]?.["delta"] as Record<string, unknown>)["content"]).toBe("retry q3");
  });
});

// ---------------------------------------------------------------------------
// ADR-022: the gate's Jev calls bill to the caller's forwarded OpenRouter key
// ---------------------------------------------------------------------------

/**
 * A gate Jev that records the per-call `apiKey` opt every systemone call saw,
 * and answers `incomplete` so the retry path fires -- exercising the
 * completeness check AND both ranking calls (original + retry) in one request.
 */
function keyRecordingGateJev(): JevClientLike & { keys: Array<string | undefined> } {
  const keys: Array<string | undefined> = [];
  return {
    keys,
    systemone: (req: { questions: Record<string, unknown> }, opts?: { apiKey?: string }): Promise<SystemOneResult> => {
      keys.push(opts?.apiKey);
      if ("completeness" in req.questions) {
        return Promise.resolve({
          model: "jev-latest",
          answers: {
            completeness: { type: "choice", choice: "incomplete", confidence: 0.9, probabilities: { incomplete: 0.9 } },
          },
          usage: { input_tokens: 400, output_tokens: 6 },
          requestId: "req_check",
          latencyMs: 20,
        });
      }
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities: { "2": 1 } },
          correct: { type: "noul", noul: 0.6 },
        },
        usage: { input_tokens: 300, output_tokens: 8 },
        requestId: "req_rank",
        latencyMs: 25,
      });
    },
  };
}

describe("the completeness gate: forwarded Jev key (ADR-022)", () => {
  it("threads the caller's forwarded key to every gate Jev call under forwardJevKey", async () => {
    originalThenRetry("original q1", "retry q2");
    const jev = keyRecordingGateJev();
    const server = await app({ jev, forwardJevKey: true });

    const res = await server.request(chatRequest());
    expect(res.status).toBe(200);

    // The completeness check plus both ranking calls all saw the forwarded key
    // (the same key that pays for the completions), never Milo's Jev key.
    expect(jev.keys.length).toBeGreaterThanOrEqual(2);
    expect(jev.keys.every((k) => k === KEY)).toBe(true);
  });

  it("threads NO key under the default TypeSafe transport (forwardJevKey unset)", async () => {
    originalThenRetry("original q1", "retry q2");
    const jev = keyRecordingGateJev();
    const server = await app({ jev });

    const res = await server.request(chatRequest());
    expect(res.status).toBe(200);

    // No forwardJevKey: the gate passes no per-call key, so the client
    // authenticates with Milo's configured Jev key exactly as before.
    expect(jev.keys.length).toBeGreaterThanOrEqual(2);
    expect(jev.keys.every((k) => k === undefined)).toBe(true);
  });
});
