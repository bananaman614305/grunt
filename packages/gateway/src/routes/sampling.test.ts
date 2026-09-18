/**
 * The best-of-N fan-out (ADR-010) against a mocked OpenRouter and a stub Jev:
 * the pick, the headers, the streaming replay shape, and both fallbacks.
 *
 * The router is stubbed to return a fixed sampled decision -- what the policy
 * does to produce one is `packages/core`'s business, tested there -- so this
 * file is only about what the gateway does with it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DecisionLog, OpenRouterClient, PROMPT_VARIANTS } from "@milo/core";
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

/** OpenRouter as one injected fetch: answers per parsed request body. */
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

function completionBody(content: string, opts: { tokens?: number; cost?: number; toolCalls?: unknown[] } = {}) {
  const tokens = opts.tokens ?? 10;
  const message: Record<string, unknown> =
    opts.toolCalls !== undefined
      ? { role: "assistant", content: null, tool_calls: opts.toolCalls }
      : { role: "assistant", content };
  return {
    id: `gen-${content}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "test/fast",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: tokens, total_tokens: 100 + tokens, cost: opts.cost ?? 0.0001 },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "or-req-1" },
  });
}

/**
 * The same completion as OpenRouter would stream it: content (and tool-call
 * arguments) split across chunks, usage on the final chunk, then `[DONE]`.
 * Sub-requests are internally streamed, so this is what the fan-out consumes.
 */
function sse(body: ReturnType<typeof completionBody>): Response {
  const message = body.choices[0]?.message as Record<string, unknown>;
  const frame = { id: body.id, object: "chat.completion.chunk", created: body.created, model: body.model };
  const chunks: Array<Record<string, unknown>> = [];

  const content = message["content"];
  if (typeof content === "string" && content.length > 0) {
    const half = Math.ceil(content.length / 2);
    chunks.push({ ...frame, choices: [{ index: 0, delta: { role: "assistant", content: content.slice(0, half) }, finish_reason: null }] });
    chunks.push({ ...frame, choices: [{ index: 0, delta: { content: content.slice(half) }, finish_reason: null }] });
  } else {
    chunks.push({ ...frame, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  }

  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const [i, raw] of toolCalls.entries()) {
      const call = raw as { id: string; type: string; function: { name: string; arguments: string } };
      const args = call.function.arguments;
      const half = Math.ceil(args.length / 2);
      chunks.push({
        ...frame,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: i, id: call.id, type: call.type, function: { name: call.function.name, arguments: args.slice(0, half) } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        ...frame,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] }, finish_reason: null }],
      });
    }
  }

  chunks.push({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: body.usage });
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "or-req-1" },
  });
}

/**
 * A stream that sends one partial content chunk and then hangs forever: the
 * production straggler. `cancelled()` reports whether the fan-out aborted it.
 */
function hangingSse(): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const encoder = new TextEncoder();
  const chunk = {
    id: "gen-hang",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "test/fast",
    choices: [{ index: 0, delta: { role: "assistant", content: "partial straggler text" }, finish_reason: null }],
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      // Never closes: only an abort ends this stream.
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    cancelled: () => cancelled,
  };
}

/**
 * A Jev that ranks by the quality each candidate answer's text encodes:
 * "answer-2 quality" beats "answer-0". The stub reads the candidate text out
 * of the rank state and answers with a quality distribution centred on the
 * digit after "q" in the text, so a test declares the ranking in the fixture.
 */
function rankingJev(): JevClientLike & { calls: number } {
  const stub = {
    calls: 0,
    systemone: (req: { state: string | Record<string, unknown> | unknown[] }): Promise<SystemOneResult> => {
      stub.calls += 1;
      const state = req.state as Record<string, unknown>;
      const candidate = String(state["candidate_answer"] ?? "");
      const match = /q([0-3])/.exec(candidate);
      const level = match === null ? 0 : Number(match[1]);
      const probabilities: Record<string, number> = { [String(level)]: 1 };
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          quality: { type: "score", score: level, confidence: 0.8, legend: {}, probabilities },
          correct: { type: "noul", noul: level / 3 },
        },
        usage: { input_tokens: 300, output_tokens: 8 },
        requestId: "req_rank",
        latencyMs: 40,
      });
    },
  };
  return stub;
}

function failingJev(): JevClientLike {
  return { systemone: () => Promise.reject(new Error("jev down")) };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "Apply the described diff." },
];

function sampledDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    id: "01SAMPLEDECISION0000000000",
    fingerprint: "fp-sampled",
    signals: {
      taskType: "edit",
      difficulty: 0.7,
      difficultyLevels: [0.5, 0.35, 0.11, 0.04],
      needsReasoning: 0.4,
      longOutput: 0.1,
      confidences: { task_type: 0.9, difficulty: 0.7 },
      jevRequestId: "req_route",
      jevModel: "jev-latest",
      latencyMs: 60,
    },
    tier: "fast",
    model: "test/fast",
    reason: "edit task, sampled",
    policyVersion: "v4",
    sticky: false,
    samples: 3,
    unsampledTier: "mid",
    createdAt: "2026-09-18T00:00:00.000Z",
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
    jev?: JevClientLike;
    decision?: RouteDecision;
    sampling?: { sampleTimeoutMs?: number; minRanked?: number };
  } = {},
): Promise<Hono> {
  const log = await DecisionLog.open(":memory:");
  logs.push(log);
  const decision = opts.decision ?? sampledDecision();
  await log.insert(decision);
  const deps: AppDeps = {
    router: { route: async () => decision } as unknown as Router,
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
    ...(opts.sampling !== undefined ? { sampling: opts.sampling } : {}),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sampled fan-out", () => {
  it("draws N varied streamed samples on throughput-sorted providers and returns Jev's pick", async () => {
    // Sample 1 encodes the highest quality; Jev must pick it.
    const contents = ["plain q1", "framed q3", "framed q0"];
    openRouter.handler = (_body, index) => sse(completionBody(contents[index] as string));
    const jev = rankingJev();
    const a = await app({ jev });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);

    // Three upstream calls, each on the fast model, each internally streamed
    // and pinned to OpenRouter's currently fastest provider, framings cycled.
    expect(openRouter.calls).toHaveLength(3);
    for (const [i, call] of openRouter.calls.entries()) {
      expect(call.body["model"]).toBe("test/fast");
      expect(call.body["stream"]).toBe(true);
      expect(call.body["stream_options"]).toEqual({ include_usage: true });
      expect(call.body["provider"]).toEqual({ sort: "throughput" });
      expect(call.body["milo"]).toBeUndefined();
      const messages = call.body["messages"] as ChatMessage[];
      const system = String(messages[0]?.content);
      if (i === 0) expect(system).toBe("You are a sub-agent.");
      else expect(system).toBe(`You are a sub-agent.\n\n${PROMPT_VARIANTS[i] as string}`);
    }

    // The chosen answer comes back as one well-formed completion, with the
    // disclosure headers.
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.id).toBe("gen-framed q3");
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message["content"]).toBe("framed q3");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 10 });
    expect(res.headers.get("x-milo-samples")).toBe("3");
    expect(res.headers.get("x-milo-sample-pick")).toBe("1");
    expect(res.headers.get("x-milo-decision-id")).toBe("01SAMPLEDECISION0000000000");
    expect(res.headers.get("x-milo-model")).toBe("test/fast");
    expect(res.headers.get("x-milo-tier")).toBe("fast");
    expect(jev.calls).toBe(3);
  });

  it("aggregates cost and tokens across samples and stores per-sample metadata, no content", async () => {
    const contents = ["a q1", "b q3", "c q0"];
    openRouter.handler = (_body, index) => sse(completionBody(contents[index] as string, { tokens: 10 + index, cost: 0.0001 }));
    const a = await app({ jev: rankingJev() });
    await a.fetch(chatRequest());

    expect(recorded).toHaveLength(1);
    const upstream = recorded[0]?.upstream as Upstream;
    expect(upstream.status).toBe(200);
    expect(upstream.inputTokens).toBe(300);
    expect(upstream.outputTokens).toBe(10 + 11 + 12);
    expect(upstream.costUsd).toBeCloseTo(0.0003);
    expect(upstream.samplePick).toBe(1);
    expect(upstream.samples).toHaveLength(3);
    expect(upstream.samples?.[1]).toMatchObject({ index: 1, status: 200, picked: true, jevQuality: 3 });
    // No content anywhere in the record.
    expect(JSON.stringify(upstream)).not.toContain("q3");

    // And the decision endpoint serves it.
    const res = await a.fetch(
      new Request("http://milo.test/v1/decisions/01SAMPLEDECISION0000000000", { headers: AUTH }),
    );
    const record = (await res.json()) as DecisionRecord;
    expect(record.upstream?.samplePick).toBe(1);
    expect(record.samples).toBe(3);
    expect(record.unsampledTier).toBe("mid");
  });

  it("replays the chosen answer as well-formed SSE when the request streamed", async () => {
    const contents = ["a q0", "b q2", "c q1"];
    openRouter.handler = (_body, index) => sse(completionBody(contents[index] as string));
    const a = await app({ jev: rankingJev() });

    const res = await a.fetch(chatRequest({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-milo-sample-pick")).toBe("1");

    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice("data: ".length));
    expect(frames).toHaveLength(3);
    expect(frames[2]).toBe("[DONE]");

    const first = JSON.parse(frames[0] as string) as Record<string, unknown>;
    expect(first["object"]).toBe("chat.completion.chunk");
    expect(first["id"]).toBe("gen-b q2");
    const firstChoice = (first["choices"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(firstChoice["delta"]).toMatchObject({ role: "assistant", content: "b q2" });
    expect(firstChoice["finish_reason"]).toBeNull();

    const last = JSON.parse(frames[1] as string) as Record<string, unknown>;
    const lastChoice = (last["choices"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(lastChoice["delta"]).toEqual({});
    expect(lastChoice["finish_reason"]).toBe("stop");
    expect(last["usage"]).toMatchObject({ completion_tokens: 10 });
  });

  it("ranks and picks tool-call answers like any other", async () => {
    const toolCalls = [
      { id: "call_1", type: "function", function: { name: "grep", arguments: '{"q":"q3"}' } },
    ];
    openRouter.handler = (_body, index) =>
      index === 1 ? sse(completionBody("", { toolCalls })) : sse(completionBody(`text q0-${index}`));
    const a = await app({ jev: rankingJev() });

    const res = await a.fetch(chatRequest({ stream: true }));
    const text = await res.text();
    expect(res.headers.get("x-milo-sample-pick")).toBe("1");
    const first = JSON.parse(
      (text.split("\n\n")[0] as string).slice("data: ".length),
    ) as Record<string, unknown>;
    const delta = ((first["choices"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
      "delta"
    ] as Record<string, unknown>;
    const calls = delta["tool_calls"] as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({ index: 0, id: "call_1", type: "function" });
  });

  it("falls back to one unsampled call on unsampledTier when every sample fails", async () => {
    openRouter.handler = (body) => {
      if (body["model"] === "test/fast") {
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return ok({ ...completionBody("fallback answer"), model: "test/mid" });
    };
    const a = await app({ jev: rankingJev() });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["model"]).toBe("test/mid");
    expect(res.headers.get("x-milo-model")).toBe("test/mid");
    expect(res.headers.get("x-milo-tier")).toBe("mid");

    // Three failed samples, then the one fallback call -- which is an
    // ordinary unsampled forward: no stream, no provider override.
    expect(openRouter.calls).toHaveLength(4);
    expect(openRouter.calls[3]?.body["model"]).toBe("test/mid");
    expect(openRouter.calls[3]?.body["stream"]).toBeUndefined();
    expect(openRouter.calls[3]?.body["provider"]).toBeUndefined();

    const upstream = recorded[0]?.upstream as Upstream;
    expect(upstream.sampleNote).toBe("all_samples_failed");
    expect(upstream.samples).toHaveLength(3);
    expect(upstream.samples?.every((s) => s.error === "http_500")).toBe(true);
  });

  it("returns the first successful sample and marks the decision when Jev cannot rank", async () => {
    const contents = ["first q0", "second q3", "third q2"];
    openRouter.handler = (_body, index) => sse(completionBody(contents[index] as string));
    const a = await app({ jev: failingJev() });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message["content"]).toBe("first q0");
    expect(res.headers.get("x-milo-sample-pick")).toBe("0");

    const upstream = recorded[0]?.upstream as Upstream;
    expect(upstream.sampleNote).toBe("ranking_failed");
    expect(upstream.samples?.[1]?.error).toMatch(/^rank_/);
  });

  it("also marks the decision when no Jev client is wired at all", async () => {
    openRouter.handler = (_body, index) => sse(completionBody(`answer-${index}`));
    const a = await app();
    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-sample-pick")).toBe("0");
    expect(recorded[0]?.upstream.sampleNote).toBe("ranking_failed");
  });

  it("passes a caller-supplied provider field through untouched on every sample", async () => {
    openRouter.handler = () => sse(completionBody("answer q3"));
    const a = await app({ jev: rankingJev() });

    const res = await a.fetch(chatRequest({ provider: { order: ["cerebras"] } }));
    expect(res.status).toBe(200);
    expect(openRouter.calls).toHaveLength(3);
    for (const call of openRouter.calls) {
      expect(call.body["provider"]).toEqual({ order: ["cerebras"] });
    }
  });
});

describe("sampled fan-out: first-k early return", () => {
  it("returns the clear winner once minRanked samples are ranked and aborts the straggler", async () => {
    const hang = hangingSse();
    openRouter.handler = (_body, index) => {
      if (index === 2) return hang.response;
      return sse(completionBody(index === 0 ? "a q1" : "b q3"));
    };
    const a = await app({ jev: rankingJev(), sampling: { minRanked: 2 } });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message["content"]).toBe("b q3");
    expect(res.headers.get("x-milo-samples")).toBe("3");
    expect(res.headers.get("x-milo-sample-pick")).toBe("1");

    // The straggler's stream was cancelled: its token spend stops there.
    expect(hang.cancelled()).toBe(true);

    // The aborted-sample record: aborted marker, whatever partial usage the
    // stream reported (none here -- usage arrives on the final chunk), no
    // rank, no error class, and never any content.
    const upstream = recorded[0]?.upstream as Upstream;
    const aborted = upstream.samples?.[2] as Record<string, unknown>;
    expect(aborted).toMatchObject({ index: 2, status: 200, aborted: true });
    expect(aborted["error"]).toBeUndefined();
    expect(aborted["jevQuality"]).toBeUndefined();
    expect(aborted["picked"]).toBeUndefined();
    expect(JSON.stringify(upstream)).not.toContain("partial straggler text");

    // The aggregate bills only what was actually spent: the two completed
    // samples; the aborted stream reported no usage before the abort.
    expect(upstream.inputTokens).toBe(200);
    expect(upstream.outputTokens).toBe(20);
    expect(upstream.costUsd).toBeCloseTo(0.0002);
    expect(upstream.samplePick).toBe(1);
    expect(upstream.sampleNote).toBeUndefined();
  });

  it("keeps waiting when the best rank is below the threshold, then survives the straggler's timeout", async () => {
    const hang = hangingSse();
    openRouter.handler = (_body, index) => {
      if (index === 2) return hang.response;
      return sse(completionBody(index === 0 ? "a q1" : "b q2"));
    };
    const a = await app({ jev: rankingJev(), sampling: { minRanked: 2, sampleTimeoutMs: 250 } });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    // No early return at k=2 (best quality 2 < 2.5): the fan-out waited for
    // the third sample, which timed out, and then picked the best of the two
    // that succeeded.
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message["content"]).toBe("b q2");

    const upstream = recorded[0]?.upstream as Upstream;
    const straggler = upstream.samples?.[2] as Record<string, unknown>;
    expect(straggler["error"]).toBe("timeout");
    expect(straggler["aborted"]).toBeUndefined();
  });

  it("returns the first success early when ranking is degraded, aborting the straggler", async () => {
    const hang = hangingSse();
    openRouter.handler = (_body, index) => {
      if (index === 2) return hang.response;
      return sse(completionBody(`answer-${index}`));
    };
    const a = await app({ jev: failingJev(), sampling: { minRanked: 2 } });

    const res = await a.fetch(chatRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof completionBody>;
    expect(body.choices[0]?.message["content"]).toBe("answer-0");
    expect(res.headers.get("x-milo-sample-pick")).toBe("0");
    expect(hang.cancelled()).toBe(true);

    const upstream = recorded[0]?.upstream as Upstream;
    expect(upstream.sampleNote).toBe("ranking_failed");
    expect((upstream.samples?.[2] as Record<string, unknown>)["aborted"]).toBe(true);
  });
});
