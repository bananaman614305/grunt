/**
 * Speculative routing on the OpenAI chat surface (ADR-024).
 *
 * The router is stubbed so a test declares both what it would speculate
 * (`speculativeModel`) and what Jev then decides (`route`); this file is only
 * about what the gateway does with the two -- reuse the in-flight call on a
 * match, abort and forward Jev's choice otherwise, and never let speculation
 * change the answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DecisionLog, OpenRouterClient } from "@milo/core";
import type { ChatMessage, DecisionRecord, JevClientLike, RouteDecision, RouteRequest, Router, SystemOneResult } from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import type { AppDeps } from "../app.js";
import { RateLimiter } from "../rate-limit.js";
import { SPECULATION_HEADER } from "./chat.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const SPECULATED = "deepseek/deepseek-v4-flash";
const FRONTIER = "z-ai/glm-5.3";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "Rename res to rows." },
];

type Upstream = NonNullable<DecisionRecord["upstream"]>;
type Call = { body: Record<string, unknown>; signal?: AbortSignal };

/** OpenRouter as one injected fetch: JSON by default, SSE for a streamed body. */
class FakeOpenRouter {
  readonly calls: Call[] = [];
  readonly fetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.calls.push({ body, signal: init?.signal ?? undefined });
    const model = String(body["model"] ?? "");
    if (body["stream"] === true) return sse(model);
    return json({
      id: `resp-${model}`,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: `answer from ${model}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
    });
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "or-req-1" },
  });
}

/** A minimal well-formed SSE completion: one content chunk, one final, DONE. */
function sse(model: string): Response {
  const frame = { id: `resp-${model}`, object: "chat.completion.chunk", created: 1, model };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: { role: "assistant", content: `answer from ${model}` }, finish_reason: null }] })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 } })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Jev used only for the sampled fan-out's ranking; centred on a fixed quality. */
function rankingJev(): JevClientLike {
  return {
    systemone: (): Promise<SystemOneResult> =>
      Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: { "3": 1 } },
          correct: { type: "noul", noul: 1 },
        },
        usage: { input_tokens: 100, output_tokens: 4 },
        requestId: "req_rank",
        latencyMs: 10,
      }),
  };
}

function decisionFor(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    id: "01SPECDECISION000000000000",
    fingerprint: "fp-spec",
    signals: {
      taskType: "chat",
      difficulty: 0.4,
      difficultyLevels: [0.8, 0.15, 0.03, 0.02],
      needsReasoning: 0.1,
      longOutput: 0.1,
      confidences: { task_type: 0.9, difficulty: 0.8 },
      jevRequestId: "req_route",
      jevModel: "jev-latest",
      latencyMs: 40,
    },
    tier: "fast",
    model: SPECULATED,
    reason: "chat task, fast; chose deepseek",
    policyVersion: "v4",
    sticky: false,
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
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
  opts: {
    speculativeModel?: string | undefined;
    decision?: RouteDecision;
    speculation?: { enabled?: boolean };
    jev?: JevClientLike;
    speculativeModelSpy?: (req: RouteRequest) => void;
  } = {},
): Promise<Hono> {
  const log = await DecisionLog.open(":memory:");
  logs.push(log);
  const decision = opts.decision ?? decisionFor();
  await log.insert(decision);

  const stubRouter = {
    route: async () => decision,
    speculativeModel: (req: RouteRequest) => {
      opts.speculativeModelSpy?.(req);
      return opts.speculativeModel;
    },
  } as unknown as Router;

  const deps: AppDeps = {
    router: stubRouter,
    roster: { fast: [SPECULATED], mid: ["m/mid"], frontier: [FRONTIER] },
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
    ...(opts.speculation !== undefined ? { speculation: opts.speculation } : {}),
    ...(opts.jev !== undefined ? { jev: opts.jev } : {}),
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

describe("speculative routing (ADR-024)", () => {
  it("on a hit, serves the in-flight speculative call and makes no second upstream call", async () => {
    const server = await app({ speculation: { enabled: true }, speculativeModel: SPECULATED });
    const res = await server.request(chatRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get(SPECULATION_HEADER)).toBe("hit");
    expect(res.headers.get("x-milo-model")).toBe(SPECULATED);
    // Exactly one upstream call: the speculative one, reused.
    expect(openRouter.calls).toHaveLength(1);
    expect(openRouter.calls[0]?.body["model"]).toBe(SPECULATED);
    expect(await res.text()).toContain(`answer from ${SPECULATED}`);
  });

  it("on a miss, aborts the speculative call and serves Jev's chosen model", async () => {
    // Speculated deepseek, but Jev routes to the frontier model instead.
    const server = await app({
      speculation: { enabled: true },
      speculativeModel: SPECULATED,
      decision: decisionFor({ model: FRONTIER, tier: "frontier" }),
    });
    const res = await server.request(chatRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get(SPECULATION_HEADER)).toBe("miss");
    // The final answer is always Jev's choice, never the speculated model.
    expect(res.headers.get("x-milo-model")).toBe(FRONTIER);
    expect(await res.text()).toContain(`answer from ${FRONTIER}`);
    // Two calls: the discarded speculative one, then the real forward.
    expect(openRouter.calls).toHaveLength(2);
    expect(openRouter.calls[0]?.body["model"]).toBe(SPECULATED);
    expect(openRouter.calls[1]?.body["model"]).toBe(FRONTIER);
    // The speculative call was aborted promptly, so it stops consuming an
    // upstream slot rather than running to completion needlessly.
    expect(openRouter.calls[0]?.signal?.aborted).toBe(true);
  });

  it("disabled: never speculates, never asks the router, no header", async () => {
    let asked = false;
    const server = await app({
      speculativeModel: SPECULATED,
      speculativeModelSpy: () => {
        asked = true;
      },
      // no `speculation` -> off
    });
    const res = await server.request(chatRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get(SPECULATION_HEADER)).toBeNull();
    expect(asked).toBe(false);
    expect(openRouter.calls).toHaveLength(1);
    expect(openRouter.calls[0]?.body["model"]).toBe(SPECULATED);
  });

  it("enabled but ineligible (router declines): discloses off, one plain call", async () => {
    const server = await app({ speculation: { enabled: true }, speculativeModel: undefined });
    const res = await server.request(chatRequest());

    expect(res.headers.get(SPECULATION_HEADER)).toBe("off");
    expect(openRouter.calls).toHaveLength(1);
    expect(openRouter.calls[0]?.body["model"]).toBe(SPECULATED);
  });

  it("never reuses a speculative call for a best-of-N decision", async () => {
    // Jev decides best-of-2 on the same model. A speculative call is a single
    // call and must not stand in for a sampled fan-out: it is aborted, and the
    // response comes from the sampling path (which sets x-milo-samples).
    const server = await app({
      speculation: { enabled: true },
      speculativeModel: SPECULATED,
      decision: decisionFor({ samples: 2, unsampledTier: "fast" }),
      jev: rankingJev(),
    });
    const res = await server.request(chatRequest());

    expect(res.status).toBe(200);
    // The sampled path does not carry the speculation header, and it does carry
    // the samples header.
    expect(res.headers.get("x-milo-samples")).toBe("2");
    // The speculative call was started, then aborted (never reused).
    const speculative = openRouter.calls.find((c) => c.body["stream"] !== true && c.body["model"] === SPECULATED);
    expect(speculative?.signal?.aborted).toBe(true);
    // The sampled sub-requests (streamed) ran on their own, so more than the
    // one speculative call was made.
    expect(openRouter.calls.length).toBeGreaterThan(1);
  });

  it("streams a hit back to a streaming client", async () => {
    const server = await app({ speculation: { enabled: true }, speculativeModel: SPECULATED });
    const res = await server.request(chatRequest({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers.get(SPECULATION_HEADER)).toBe("hit");
    expect(openRouter.calls).toHaveLength(1);
    expect(openRouter.calls[0]?.body["stream"]).toBe(true);
    const text = await res.text();
    expect(text).toContain(`answer from ${SPECULATED}`);
    expect(text).toContain("[DONE]");
  });
});
