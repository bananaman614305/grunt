/**
 * `/v1/responses` against mocked upstreams.
 *
 * Same harness as `app.test.ts` and `messages.test.ts`: both upstreams are one
 * injected `fetch` that dispatches on host, so a test that accidentally
 * reaches the network fails loudly, and the Jev answers come from the
 * recorded fixture shapes in `packages/core/src/router/__fixtures__`.
 *
 * What this file checks is that the Responses dialect reaches the *same*
 * router with the *same* decisions as the other two -- only the request shape
 * differs -- and, specifically, that the shape Codex CLI actually sends works:
 * `instructions` as the system prompt, the full `input` array resent every
 * turn with `store: false` and no `previous_response_id`, and a
 * `function_call_output` item continuing a tool loop rather than counting as
 * a new user turn.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { DecisionRecord, Roster, Router, RoutingUnavailableCause } from "@milo/core";
import { DecisionLog, OpenRouterClient, RoutingUnavailableError } from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import { createGateway } from "../index.js";
import type { Gateway, GatewayOptions } from "../index.js";
import { RateLimiter } from "../rate-limit.js";

// A key-shaped value that must never reach a decision, a header, or a log.
const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const JSON_TYPE = { "content-type": "application/json" };
const AUTH = { authorization: `Bearer ${KEY}`, ...JSON_TYPE };

const ROSTER: Roster = {
  fast: ["test/fast"],
  mid: ["test/mid"],
  frontier: ["test/frontier"],
};

const INSTRUCTIONS = "You are a sub-agent in an engineering crew.";
const BRIEF = "The gateway test fails one run in five in CI. Find out why.";

// ---------------------------------------------------------------------------
// Upstream doubles
// ---------------------------------------------------------------------------

type Call = { url: URL; method: string; headers: Headers; body: string | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

type Fixture = {
  requestId: string;
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
};

function fixture(name: string): Fixture {
  const url = new URL(`../../../core/src/router/__fixtures__/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

function jevOk(name: string): Handler {
  const f = fixture(name);
  return () =>
    new Response(JSON.stringify({ model: f.model, answers: f.answers, usage: f.usage }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": f.requestId },
    });
}

class Upstreams {
  readonly calls: Call[] = [];
  jev: Handler = jevOk("flaky-test");
  openRouter: Handler = () => jsonResponse({ ok: true });

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    this.calls.push(call);

    if (url.host === "api.typesafe.ai") return this.jev(call);
    if (url.host === "openrouter.ai") return this.openRouter(call);
    throw new Error(`unexpected upstream host: ${url.host}`);
  }) as typeof fetch;

  openRouterCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "openrouter.ai");
  }

  jevCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "api.typesafe.ai");
  }

  /** The `state` object Milo sent Jev on its nth routed call. */
  jevState(index = 0): Record<string, unknown> {
    const body = this.jevCalls()[index]?.body ?? "{}";
    return (JSON.parse(body) as { state?: Record<string, unknown> }).state ?? {};
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A Responses API result. Note `usage.input_tokens` / `usage.output_tokens`,
 * not the chat dialect's `prompt_tokens` / `completion_tokens`, and
 * OpenRouter's `usage.cost` extension.
 */
function response(model: string, text = "hello"): Record<string, unknown> {
  return {
    id: "resp_abc",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_abc",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 137,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 42,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 179,
      cost: 0.00123,
    },
  };
}

/**
 * Responses SSE bytes, split exactly as the mock will emit them. Event names
 * are OpenRouter's own (`StreamEvents` in their OpenAPI document); usage
 * rides on `response.completed` and there is no `[DONE]` sentinel.
 */
const SSE_CHUNKS = [
  'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"test/frontier","output":[]}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hel"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"lo"}\n\n',
  'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"text":"Hello"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","sequence_number":5,"response":{"id":"resp_1","object":"response","status":"completed","model":"test/frontier","output":[],"usage":{"input_tokens":137,"output_tokens":42,"total_tokens":179}}}\n\n',
];

function sseResponse(chunks: string[] = SSE_CHUNKS): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "or-req-7" },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type LogLine = { level: string; msg: string; meta?: Record<string, unknown> };

function capturingLogger(lines: LogLine[]): NonNullable<GatewayOptions["logger"]> {
  const push =
    (level: string) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      lines.push(meta === undefined ? { level, msg } : { level, msg, meta });
    };
  return { info: push("info"), warn: push("warn"), error: push("error") };
}

let upstreams: Upstreams;
let lines: LogLine[];
let gateway: Gateway;

async function start(overrides: Partial<GatewayOptions> = {}): Promise<Gateway> {
  gateway = await createGateway({
    jevApiKey: "jev-test-key",
    roster: ROSTER,
    fetch: upstreams.fetch,
    logger: capturingLogger(lines),
    ...overrides,
  });
  return gateway;
}

/** Decision logs opened by `stubRouterApp`, closed with the gateway. */
let stubLogs: DecisionLog[];

/**
 * The app wired to a router that throws. The real `Router` decides when to
 * throw; what this file checks is that the Responses surface renders the
 * throw in the OpenAI error envelope the Codex CLI parses.
 */
async function stubRouterApp(
  route: () => Promise<never>,
  opts: { routedPerMinute?: number } = {},
): Promise<{ app: Hono; log: DecisionLog }> {
  const log = await DecisionLog.open(":memory:");
  stubLogs.push(log);
  const app = createApp({
    router: { route } as unknown as Router,
    openRouter: new OpenRouterClient({ fetch: upstreams.fetch }),
    anthropic: new AnthropicUpstream({ fetch: upstreams.fetch }),
    log,
    rateLimiter: new RateLimiter(
      opts.routedPerMinute !== undefined ? { routedPerMinute: opts.routedPerMinute } : {},
    ),
    logger: capturingLogger(lines),
    now: Date.now,
    recordUpstream: () => undefined,
  });
  return { app, log };
}

/** A router that always throws the same routing failure. */
function unroutable(cause: RoutingUnavailableCause, opts: { retryAfterMs?: number } = {}): () => Promise<never> {
  return () =>
    Promise.reject(
      new RoutingUnavailableError(cause, `jev ${cause}`, {
        requestId: "req_jev_0001",
        ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
      }),
    );
}

beforeEach(() => {
  upstreams = new Upstreams();
  lines = [];
  stubLogs = [];
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
  for (const log of stubLogs) await log.close();
});

type Extra = Record<string, unknown> & { extraInput?: unknown[] };

/**
 * A Responses request body in the shape Codex CLI sends: `instructions` as
 * the system prompt, `input` as the whole conversation so far, `store: false`
 * and no `previous_response_id`.
 */
function responsesBody(extra: Extra = {}): string {
  const { extraInput, ...rest } = extra;
  return JSON.stringify({
    model: "milo/auto",
    instructions: INSTRUCTIONS,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: BRIEF }] },
      ...(extraInput ?? []),
    ],
    store: false,
    ...rest,
  });
}

function post(path: string, body: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return gateway.app.request(path, { method: "POST", headers, body });
}

/** Waits for the upstream outcome a streamed response records after the fact. */
async function upstreamOf(log: DecisionLog, id: string): Promise<NonNullable<DecisionRecord["upstream"]>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await log.getDecision(id);
    if (record?.upstream !== undefined) return record.upstream;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`decision ${id} never recorded an upstream outcome`);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("POST /v1/responses auth", () => {
  it("401s in the OpenAI error shape when no key is sent", async () => {
    await start();
    const res = await gateway.app.request("/v1/responses", {
      method: "POST",
      headers: JSON_TYPE,
      body: responsesBody(),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        message: expect.any(String),
        type: "authentication_error",
        code: "missing_authorization",
      },
    });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("rejects a non-bearer Authorization header", async () => {
    await start();
    const res = await post("/v1/responses", responsesBody(), { authorization: `Token ${KEY}`, ...JSON_TYPE });
    expect(res.status).toBe(401);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("does not accept x-api-key, which is an Anthropic convention", async () => {
    await start();
    const res = await post("/v1/responses", responsesBody(), { "x-api-key": KEY, ...JSON_TYPE });
    expect(res.status).toBe(401);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("forwards the bearer token to OpenRouter unchanged", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    const res = await post("/v1/responses", responsesBody());
    expect(res.status).toBe(200);

    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/responses");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });
});

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

describe("POST /v1/responses, explicit model", () => {
  it("forwards untouched and returns the upstream response", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("openai/gpt-5.3-codex"), 200, { "x-request-id": "or-req-1" });

    const res = await post(
      "/v1/responses",
      JSON.stringify({
        model: "openai/gpt-5.3-codex",
        instructions: INSTRUCTIONS,
        input: "hi",
        store: false,
        temperature: 0.4,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("or-req-1");
    expect(res.headers.get("x-milo-decision-id")).toBeNull();

    expect(upstreams.jevCalls()).toHaveLength(0);
    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/responses");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      model: "openai/gpt-5.3-codex",
      instructions: INSTRUCTIONS,
      input: "hi",
      store: false,
      temperature: 0.4,
    });
  });

  it("strips the milo field even when the request is not routed", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("openai/gpt-5.3-codex"));

    await post(
      "/v1/responses",
      JSON.stringify({
        model: "openai/gpt-5.3-codex",
        input: "hi",
        milo: { posture: "low" },
      }),
    );

    const body = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("milo");
    expect(body["model"]).toBe("openai/gpt-5.3-codex");
  });

  it("rejects an unparseable body with a 400", async () => {
    await start();
    const res = await post("/v1/responses", "{not json");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "invalid_request_body" },
    });
    expect(upstreams.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Routed
// ---------------------------------------------------------------------------

describe("POST /v1/responses, milo/auto", () => {
  it("routes, rewrites the model, and explains itself in headers", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"), 200, { "x-request-id": "or-req-2" });

    const res = await post("/v1/responses", responsesBody());

    expect(res.status).toBe(200);
    // The `flaky-test` fixture is a debug task at difficulty 2.31, which the
    // policy sends to frontier under the default balanced posture.
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    expect(res.headers.get("x-milo-task-type")).toBe("debug");
    expect(res.headers.get("x-milo-difficulty")).toBe("2.31");
    expect(res.headers.get("x-milo-sticky")).toBe("false");
    expect(res.headers.get("x-request-id")).toBe("or-req-2");

    // The same six headers as the other two dialects, and no seventh.
    expect([...res.headers.keys()].filter((k) => k.startsWith("x-milo-")).sort()).toEqual([
      "x-milo-decision-id",
      "x-milo-difficulty",
      "x-milo-model",
      "x-milo-sticky",
      "x-milo-task-type",
      "x-milo-tier",
    ]);

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["model"]).toBe("test/frontier");
    expect(forwarded).not.toHaveProperty("milo");

    const decisionId = res.headers.get("x-milo-decision-id") ?? "";
    const record = await gateway.log.getDecision(decisionId);
    expect(record).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "test/frontier",
      sticky: false,
      signals: { taskType: "debug", difficulty: 2.31, jevRequestId: "req_synthetic_flaky_test" },
    });

    // Usage is read off the Responses field names, and OpenRouter's cost.
    expect(await upstreamOf(gateway.log, decisionId)).toMatchObject({
      status: 200,
      inputTokens: 137,
      outputTokens: 42,
      costUsd: 0.00123,
    });
  });

  it("builds the router's view from instructions and the input array", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    await post("/v1/responses", responsesBody({ tools: [{ type: "function", name: "shell" }] }));

    const state = upstreams.jevState();
    expect(state["system"]).toBe(INSTRUCTIONS);
    expect(state["recent_user_turns"]).toEqual([BRIEF]);
    expect(state["has_tools"]).toBe(true);
    expect(state["tool_count"]).toBe(1);
    expect(state["user_message_count"]).toBe(1);
  });

  it("accepts a bare string input as one user turn", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    const res = await post(
      "/v1/responses",
      JSON.stringify({ model: "milo/auto", instructions: INSTRUCTIONS, input: BRIEF, store: false }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-tier")).toBe("frontier");

    const state = upstreams.jevState();
    expect(state["system"]).toBe(INSTRUCTIONS);
    expect(state["recent_user_turns"]).toEqual([BRIEF]);
    expect(state["user_message_count"]).toBe(1);
  });

  it("honours the milo extension's posture and candidates", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/mid"));

    const res = await post(
      "/v1/responses",
      responsesBody({ milo: { posture: "low", candidates: ["test/mid"] } }),
    );

    // `low` posture caps at mid however hard the work looks, and candidates
    // pin the model there too.
    expect(res.headers.get("x-milo-tier")).toBe("mid");
    expect(res.headers.get("x-milo-model")).toBe("test/mid");
    expect(JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}")).not.toHaveProperty("milo");
  });

  it("streams byte-for-byte and still answers with the milo headers", async () => {
    await start();
    upstreams.openRouter = () => sseResponse();

    const res = await post("/v1/responses", responsesBody({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    const decisionId = res.headers.get("x-milo-decision-id") ?? "";
    expect(decisionId).not.toBe("");

    expect(await res.text()).toBe(SSE_CHUNKS.join(""));

    expect(JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}")).toMatchObject({
      model: "test/frontier",
      stream: true,
    });

    // Usage rides on `response.completed` inside the stream, which must not
    // be parsed, so a streamed call records status and latency and no tokens.
    const upstream = await upstreamOf(gateway.log, decisionId);
    expect(upstream.status).toBe(200);
    expect(upstream.latencyMs).toBeGreaterThanOrEqual(0);
    expect(upstream.inputTokens).toBeUndefined();
  });

  it("forwards previous_response_id and store untouched", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    await post("/v1/responses", responsesBody({ previous_response_id: "resp_prev", store: true }));

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["previous_response_id"]).toBe("resp_prev");
    expect(forwarded["store"]).toBe(true);
  });

  it("reuses the decision when a function_call_output continues the tool loop", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    const first = await post("/v1/responses", responsesBody());
    // Codex's next turn: the same input, plus the call it made and the output
    // it got back. No new user message, so the decision is reused.
    const second = await post(
      "/v1/responses",
      responsesBody({
        extraInput: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "shell",
            arguments: '{"command":["pnpm","test"]}',
          },
          { type: "function_call_output", id: "out_1", call_id: "call_1", output: "3 failed" },
        ],
      }),
    );

    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(second.headers.get("x-milo-sticky")).toBe("true");
    expect(second.headers.get("x-milo-model")).toBe(first.headers.get("x-milo-model"));
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));

    // The sticky turn is its own row, so the log counts turns, not routes.
    const sticky = await gateway.log.getDecision(second.headers.get("x-milo-decision-id") ?? "");
    expect(sticky?.sticky).toBe(true);
  });

  it("re-evaluates when the user asks something new in the same conversation", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    const first = await post("/v1/responses", responsesBody());
    const second = await post(
      "/v1/responses",
      responsesBody({
        extraInput: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Now redesign the schema for multi-region writes." }],
          },
        ],
      }),
    );

    expect(upstreams.jevCalls()).toHaveLength(2);
    expect(second.headers.get("x-milo-sticky")).toBe("false");
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));

    // The second ask reached Jev with both turns and the assistant's reply,
    // and the tool-loop items contributed nothing but markers.
    const state = upstreams.jevState(1);
    expect(state["user_message_count"]).toBe(2);
    expect(state["recent_user_turns"]).toEqual([BRIEF, "Now redesign the schema for multi-region writes."]);
  });

  it("ignores reasoning items when building the router's view", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    await post(
      "/v1/responses",
      responsesBody({
        extraInput: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "secret chain of thought" }] },
        ],
      }),
    );

    expect(JSON.stringify(upstreams.jevState())).not.toContain("secret chain of thought");
  });

  it("passes an upstream 500 straight through and records it", async () => {
    await start();
    const failure = { error: { message: "upstream exploded", type: "server_error" } };
    upstreams.openRouter = () => jsonResponse(failure, 500);

    const res = await post("/v1/responses", responsesBody());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(failure);

    const upstream = await upstreamOf(gateway.log, res.headers.get("x-milo-decision-id") ?? "");
    expect(upstream.status).toBe(500);
    expect(upstream.inputTokens).toBeUndefined();
  });

  it("answers 502 when OpenRouter cannot be reached", async () => {
    await start();
    upstreams.openRouter = () => {
      throw new Error("ECONNREFUSED");
    };

    const res = await post("/v1/responses", responsesBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: "api_error", code: "upstream_unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("POST /v1/responses when the router cannot answer", () => {
  it("503s in the OpenAI error shape with a Retry-After", async () => {
    const { app } = await stubRouterApp(unroutable("timeout", { retryAfterMs: 1500 }));

    const res = await app.request("/v1/responses", { method: "POST", headers: AUTH, body: responsesBody() });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toMatchObject({
      error: { type: "api_error", code: "routing_unavailable" },
    });
    // Nothing was forwarded: an unroutable `milo/auto` never reaches OpenRouter.
    expect(upstreams.openRouterCalls()).toHaveLength(0);
  });

  it("502s when the router fails for a reason that is not Jev's", async () => {
    const { app } = await stubRouterApp(() => Promise.reject(new Error("roster is empty")));

    const res = await app.request("/v1/responses", { method: "POST", headers: AUTH, body: responsesBody() });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: "api_error", code: "routing_failed" } });
  });

  it("429s once the key is over its routed rate limit", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(response("test/frontier"));

    const first = await post("/v1/responses", responsesBody());
    expect(first.status).toBe(200);

    const second = await post(
      "/v1/responses",
      responsesBody({
        extraInput: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "A different brief entirely." }] },
        ],
      }),
    );

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
    // One token a minute refills in sixty seconds, rounded up to whole ones.
    expect(second.headers.get("retry-after")).toBe("60");
    expect(second.headers.get("x-milo-decision-id")).toBeNull();

    // A refusal is not routed and not forwarded, and it is not a decision.
    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(upstreams.openRouterCalls()).toHaveLength(1);
    const rows = await gateway.log.listRecent({ limit: 100 });
    expect(rows).toHaveLength(1);
  });

  it("does not spend a rate limit token on a forced tier, since it skips Jev", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(response("test/fast"));

    for (let i = 0; i < 5; i++) {
      const res = await post(
        "/v1/responses",
        responsesBody({
          milo: { tier: "fast" },
          extraInput: [
            { type: "message", role: "user", content: [{ type: "input_text", text: `forced turn ${i}` }] },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-milo-tier")).toBe("fast");
    }

    expect(upstreams.jevCalls()).toHaveLength(0);

    // The bucket is still full: an unforced request right after still succeeds.
    const unforced = await post("/v1/responses", responsesBody());
    expect(unforced.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// `/v1/responses/*`: the generic proxy
// ---------------------------------------------------------------------------

describe("other /v1/responses paths", () => {
  it("proxies a retrieve to OpenRouter unchanged", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ id: "resp_abc", object: "response" });

    const res = await gateway.app.request("/v1/responses/resp_abc", { headers: AUTH });

    expect(res.status).toBe(200);
    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/responses/resp_abc");
    expect(call?.method).toBe("GET");
    expect(res.headers.get("x-milo-decision-id")).toBeNull();
  });

  it("proxies an input-items listing too", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ object: "list", data: [] });

    await gateway.app.request("/v1/responses/resp_abc/input_items?limit=20", { headers: AUTH });

    expect(upstreams.openRouterCalls()[0]?.url.href).toBe(
      "https://openrouter.ai/api/v1/responses/resp_abc/input_items?limit=20",
    );
  });
});

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------

describe("key handling on /v1/responses", () => {
  it("forwards the key upstream and leaks it nowhere else", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(response("test/frontier"), 200, { "x-request-id": "or-req-9" });

    const routed = await post("/v1/responses", responsesBody());
    // A second routed call, over the limit, so the rate-limited path (which
    // reads the key to find the bucket) is covered too.
    await post(
      "/v1/responses",
      responsesBody({
        extraInput: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Another brief." }] }],
      }),
    );
    const unauthorized = await gateway.app.request("/v1/responses", {
      method: "POST",
      headers: JSON_TYPE,
      body: "{}",
    });

    // It does reach OpenRouter, unchanged. That is the one place it belongs.
    expect(upstreams.openRouterCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // And never reaches Jev, which uses Milo's own key.
    expect(upstreams.jevCalls()[0]?.headers.get("authorization")).toBe("Bearer jev-test-key");

    const haystacks: string[] = [
      JSON.stringify(lines),
      JSON.stringify(await gateway.log.listRecent({ limit: 100 })),
      [...routed.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"),
      await unauthorized.text(),
    ];

    for (const haystack of haystacks) {
      expect(haystack).not.toContain(KEY);
      expect(haystack).not.toContain("sk-or-");
    }
    // The logger did run, so the assertion above is not vacuous.
    expect(lines.some((line) => line.msg === "routed")).toBe(true);
    expect(lines.every((line) => line.level !== "error")).toBe(true);
  });
});
