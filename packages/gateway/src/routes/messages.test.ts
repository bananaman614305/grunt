/**
 * `/v1/messages` against mocked upstreams.
 *
 * Same harness as `app.test.ts`: both upstreams are one injected `fetch` that
 * dispatches on host, so a test that accidentally reaches the network fails
 * loudly, and the Jev answers come from the recorded fixture shapes in
 * `packages/core/src/router/__fixtures__`.
 *
 * What this file is really checking is that the Anthropic dialect reaches the
 * *same* router with the *same* decisions as the OpenAI one -- the request
 * shape is the only thing that differs -- and that a key arriving as
 * `x-api-key` is treated exactly like one arriving as a bearer token and
 * leaves as a bearer token.
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
/** What the Anthropic SDK and Claude Code's ANTHROPIC_API_KEY send. */
const API_KEY_AUTH = { "x-api-key": KEY, ...JSON_TYPE };
/** What Claude Code's ANTHROPIC_AUTH_TOKEN sends. */
const BEARER_AUTH = { authorization: `Bearer ${KEY}`, ...JSON_TYPE };

const ROSTER: Roster = {
  fast: ["test/fast"],
  mid: ["test/mid"],
  frontier: ["test/frontier"],
};

const SYSTEM = "You are a sub-agent in an engineering crew.";
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

  /** The `state` object Milo sent Jev on its first routed call. */
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

/** An Anthropic Messages response. Note `usage.input_tokens`, not `prompt_tokens`. */
function message(model: string, text = "hello"): Record<string, unknown> {
  return {
    id: "msg_abc",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 137, output_tokens: 42 },
  };
}

/** Anthropic SSE bytes, split exactly as the mock will emit them. */
const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test/frontier","content":[],"usage":{"input_tokens":137,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
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
 * throw; what this file checks is that the Anthropic surface renders the
 * throw in Anthropic's own error envelope.
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
});

afterEach(async () => {
  await gateway?.close();
  for (const log of stubLogs) await log.close();
});

type Extra = Record<string, unknown> & { extraMessages?: unknown[] };

/** An Anthropic Messages request body: `system` is a field, not a message. */
function messagesBody(extra: Extra = {}): string {
  const { extraMessages, ...rest } = extra;
  return JSON.stringify({
    model: "milo/auto",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: BRIEF }, ...(extraMessages ?? [])],
    ...rest,
  });
}

function post(path: string, body: string, headers: Record<string, string> = API_KEY_AUTH): Promise<Response> {
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

describe("POST /v1/messages auth", () => {
  it("accepts x-api-key and forwards it as a bearer token, dropping x-api-key", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const res = await post("/v1/messages", messagesBody(), API_KEY_AUTH);
    expect(res.status).toBe(200);

    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/messages");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // OpenRouter documents bearer auth only, and a key in two headers is a
    // key in two places it can leak from.
    expect(call?.headers.has("x-api-key")).toBe(false);
  });

  it("accepts Authorization: Bearer just as well", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const res = await post("/v1/messages", messagesBody(), BEARER_AUTH);
    expect(res.status).toBe(200);
    expect(upstreams.openRouterCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("prefers the bearer token when a request carries both", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post("/v1/messages", messagesBody(), {
      authorization: `Bearer ${KEY}`,
      "x-api-key": "sk-or-v1-the-other-one",
      ...JSON_TYPE,
    });

    expect(upstreams.openRouterCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("401s with an Anthropic-shaped body when neither header carries a key", async () => {
    await start();
    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: JSON_TYPE,
      body: messagesBody(),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: expect.any(String) },
    });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("rejects an empty x-api-key", async () => {
    await start();
    const res = await post("/v1/messages", messagesBody(), { "x-api-key": "   ", ...JSON_TYPE });
    expect(res.status).toBe(401);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("still requires a bearer token on the OpenAI surface", async () => {
    await start();
    // x-api-key is an Anthropic convention; it buys nothing at /v1/chat/completions.
    const res = await post(
      "/v1/chat/completions",
      JSON.stringify({ model: "milo/auto", messages: [{ role: "user", content: "hi" }] }),
      API_KEY_AUTH,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: "authentication_error" } });
  });
});

// ---------------------------------------------------------------------------
// Header forwarding
// ---------------------------------------------------------------------------

describe("POST /v1/messages header handling", () => {
  it("forwards anthropic-version and anthropic-beta upstream", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post("/v1/messages", messagesBody(), {
      ...API_KEY_AUTH,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31,context-1m-2025-08-07",
    });

    const [call] = upstreams.openRouterCalls();
    expect(call?.headers.get("anthropic-version")).toBe("2023-06-01");
    // Forwarded verbatim rather than allow-listed value by value.
    expect(call?.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31,context-1m-2025-08-07");
  });

  it("passes back content-type and both spellings of the upstream request id", async () => {
    await start();
    upstreams.openRouter = () =>
      jsonResponse(message("test/frontier"), 200, { "x-request-id": "or-req-3", "request-id": "req_anthropic_3" });

    const res = await post("/v1/messages", messagesBody());

    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-request-id")).toBe("or-req-3");
    expect(res.headers.get("request-id")).toBe("req_anthropic_3");
  });

  it("keeps the query string Claude Code sends", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post("/v1/messages?beta=true", messagesBody());
    expect(upstreams.openRouterCalls()[0]?.url.href).toBe("https://openrouter.ai/api/v1/messages?beta=true");
  });
});

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

describe("POST /v1/messages, explicit model", () => {
  it("forwards untouched and returns the upstream response", async () => {
    await start();
    upstreams.openRouter = () =>
      jsonResponse(message("anthropic/claude-sonnet-5"), 200, { "x-request-id": "or-req-1" });

    const res = await post(
      "/v1/messages",
      JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.4,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("or-req-1");
    expect(res.headers.get("x-milo-decision-id")).toBeNull();

    expect(upstreams.jevCalls()).toHaveLength(0);
    expect(JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}")).toEqual({
      model: "anthropic/claude-sonnet-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
    });
  });

  it("strips the milo field even when the request is not routed", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("anthropic/claude-sonnet-5"));

    await post(
      "/v1/messages",
      JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        milo: { posture: "low" },
      }),
    );

    const body = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("milo");
    expect(body["model"]).toBe("anthropic/claude-sonnet-5");
  });

  it("rejects an unparseable body with an Anthropic-shaped 400", async () => {
    await start();
    const res = await post("/v1/messages", "{not json");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: expect.any(String) },
    });
    expect(upstreams.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Routed
// ---------------------------------------------------------------------------

describe("POST /v1/messages, milo/auto", () => {
  it("routes, rewrites the model, and explains itself in headers", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"), 200, { "x-request-id": "or-req-2" });

    const res = await post("/v1/messages", messagesBody());

    expect(res.status).toBe(200);
    // The `flaky-test` fixture is a debug task at difficulty 2.31, which
    // The policy sends this distribution to frontier under balanced posture -- the
    // same answer the OpenAI surface gets for the same conversation.
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    expect(res.headers.get("x-milo-task-type")).toBe("debug");
    expect(res.headers.get("x-milo-difficulty")).toBe("2.31");
    expect(res.headers.get("x-milo-sticky")).toBe("false");
    expect(res.headers.get("x-milo-cache")).toBe("miss");
    expect(res.headers.get("x-request-id")).toBe("or-req-2");

    // The same eight headers the OpenAI surface sets, and no ninth.
    expect([...res.headers.keys()].filter((k) => k.startsWith("x-milo-")).sort()).toEqual([
      "x-milo-cache",
      "x-milo-decision-id",
      "x-milo-difficulty",
      "x-milo-modality",
      "x-milo-model",
      "x-milo-sticky",
      "x-milo-task-type",
      "x-milo-tier",
    ]);

    const decisionId = res.headers.get("x-milo-decision-id");
    expect(decisionId).toBeTruthy();

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["model"]).toBe("test/frontier");
    expect(forwarded["system"]).toBe(SYSTEM);
    expect(forwarded["max_tokens"]).toBe(1024);
    expect(forwarded).not.toHaveProperty("milo");

    const record = await gateway.log.getDecision(decisionId ?? "");
    expect(record).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "test/frontier",
      sticky: false,
      signals: { taskType: "debug", difficulty: 2.31, jevRequestId: "req_synthetic_flaky_test" },
    });

    // Anthropic reports usage as input_tokens/output_tokens.
    expect(await upstreamOf(gateway.log, decisionId ?? "")).toMatchObject({
      status: 200,
      inputTokens: 137,
      outputTokens: 42,
    });
  });

  it("honours the milo extension's posture and candidates", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/mid"));

    const res = await post("/v1/messages", messagesBody({ milo: { posture: "low", candidates: ["test/mid"] } }));

    // `low` posture caps at mid however hard the work looks, and candidates
    // leave only `test/mid` eligible anyway.
    expect(res.headers.get("x-milo-tier")).toBe("mid");
    expect(res.headers.get("x-milo-model")).toBe("test/mid");
    expect(JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}")).not.toHaveProperty("milo");
  });

  it("streams byte-for-byte and still answers with the milo headers", async () => {
    await start();
    upstreams.openRouter = () => sseResponse();

    const res = await post("/v1/messages", messagesBody({ stream: true }));

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

    // Token counts live in the stream, which must not be parsed, so a
    // streamed call records its status and latency and nothing else.
    const upstream = await upstreamOf(gateway.log, decisionId);
    expect(upstream.status).toBe(200);
    expect(upstream.inputTokens).toBeUndefined();
  });

  it("reuses the decision for a second turn of the same conversation", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const first = await post("/v1/messages", messagesBody());
    const second = await post(
      "/v1/messages",
      messagesBody({
        // A tool loop continuing: tool_use, then the tool_result coming back.
        extraMessages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] },
        ],
      }),
    );

    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(second.headers.get("x-milo-sticky")).toBe("true");
    expect(second.headers.get("x-milo-model")).toBe(first.headers.get("x-milo-model"));
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));
  });

  it("re-evaluates when the user asks something new in the same conversation", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const first = await post("/v1/messages", messagesBody());
    const second = await post(
      "/v1/messages",
      messagesBody({
        extraMessages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
          { role: "user", content: "Now redesign the schema for multi-region writes." },
        ],
      }),
    );

    expect(upstreams.jevCalls()).toHaveLength(2);
    expect(second.headers.get("x-milo-sticky")).toBe("false");
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));
  });

  it("refuses with an Anthropic-shaped 429 once the key is over its routed rate limit", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const first = await post("/v1/messages", messagesBody());
    expect(first.status).toBe(200);

    const second = await post("/v1/messages", messagesBody({ extraMessages: [{ role: "user", content: "More?" }] }));

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: expect.any(String) },
    });
    expect(second.headers.get("retry-after")).toBe("60");
    expect(second.headers.get("x-milo-decision-id")).toBeNull();

    // The refusal is not routed, not forwarded, and not a decision.
    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(upstreams.openRouterCalls()).toHaveLength(1);
    expect(await gateway.log.listRecent({ limit: 100 })).toHaveLength(1);
  });

  it("shares one rate limit bucket across both header spellings of the same key", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    const first = await post("/v1/messages", messagesBody(), API_KEY_AUTH);
    expect(first.status).toBe(200);

    // Same key, other header: the bucket is keyed on the credential, not the
    // header, so this must not buy a second budget.
    const second = await post("/v1/messages", messagesBody(), BEARER_AUTH);
    expect(second.status).toBe(429);
  });

  it("passes an upstream refusal through with its own status and body", async () => {
    await start();
    const refusal = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    upstreams.openRouter = () => jsonResponse(refusal, 529);

    const res = await post("/v1/messages", messagesBody());

    expect(res.status).toBe(529);
    expect(await res.json()).toEqual(refusal);
    expect(res.headers.get("x-milo-decision-id")).toBeTruthy();
  });

  it("answers 502 in the Anthropic shape when OpenRouter cannot be reached", async () => {
    await start();
    upstreams.openRouter = () => {
      throw new Error("ECONNREFUSED");
    };

    const res = await post("/v1/messages", messagesBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });
});

// ---------------------------------------------------------------------------
// Routing failures: 503, in the Anthropic dialect
// ---------------------------------------------------------------------------

describe("POST /v1/messages when the router cannot decide", () => {
  const CAUSES: RoutingUnavailableCause[] = [
    "timeout",
    "network",
    "http",
    "validation",
    "breaker_open",
    "rate_limited",
  ];

  it.each(CAUSES)("answers 503 in the Anthropic shape for a %s failure", async (cause) => {
    const { app, log } = await stubRouterApp(unroutable(cause));

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: API_KEY_AUTH,
      body: messagesBody(),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: `Milo could not route this request: ${cause} from the decision model. Retry, or set an explicit model.`,
      },
    });
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.headers.get("x-milo-decision-id")).toBeNull();
    expect(upstreams.openRouterCalls()).toHaveLength(0);
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);

    const line = lines.find((l) => l.msg === "routing unavailable");
    expect(line?.meta).toMatchObject({ cause, status: 503, jevRequestId: "req_jev_0001" });
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("uses the error's own retry hint, rounded up to whole seconds", async () => {
    const { app } = await stubRouterApp(unroutable("breaker_open", { retryAfterMs: 10_500 }));

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: API_KEY_AUTH,
      body: messagesBody(),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("11");
  });

  it("still answers 502 for a router failure that is not a routing failure", async () => {
    const { app, log } = await stubRouterApp(() => Promise.reject(new Error("roster has no eligible model")));

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: API_KEY_AUTH,
      body: messagesBody(),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);
  });

  it("refuses an over-limit key before it ever reaches the router", async () => {
    let routes = 0;
    const { app, log } = await stubRouterApp(
      () => {
        routes += 1;
        return Promise.reject(new Error("the router must not be asked"));
      },
      { routedPerMinute: 1 },
    );

    await app.request("/v1/messages", { method: "POST", headers: API_KEY_AUTH, body: messagesBody() });
    const res = await app.request("/v1/messages", { method: "POST", headers: API_KEY_AUTH, body: messagesBody() });

    expect(routes).toBe(1);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic request shape -> router state
// ---------------------------------------------------------------------------

describe("what the router sees", () => {
  it("passes a string system prompt through to the Jev state", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post("/v1/messages", messagesBody());

    const state = upstreams.jevState();
    expect(state["system"]).toBe(SYSTEM);
    expect(state["recent_user_turns"]).toEqual([BRIEF]);
    expect(state["has_tools"]).toBe(false);
  });

  it("flattens a block-array system prompt into the same state", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post(
      "/v1/messages",
      JSON.stringify({
        model: "milo/auto",
        max_tokens: 1024,
        system: [
          { type: "text", text: "You are a sub-agent" },
          { type: "text", text: "in an engineering crew.", cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: BRIEF }] }],
      }),
    );

    const state = upstreams.jevState();
    expect(state["system"]).toBe("You are a sub-agent\nin an engineering crew.");
    expect(state["recent_user_turns"]).toEqual([BRIEF]);
  });

  it("notes tool blocks as short markers and reports tool presence", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(message("test/frontier"));

    await post(
      "/v1/messages",
      messagesBody({
        tools: [{ name: "read" }, { name: "edit" }],
        extraMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking the log." },
              { type: "tool_use", id: "tu_1", name: "read", input: { path: "/var/log/ci.log" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "a".repeat(5000) },
              { type: "text", text: "Anything?" },
            ],
          },
        ],
      }),
    );

    const state = upstreams.jevState();
    expect(state["has_tools"]).toBe(true);
    expect(state["tool_count"]).toBe(2);
    expect(state["latest_assistant_turn"]).toBe("Checking the log.\n[tool_use: read]");
    // The payload is summarized, not pasted: a 5 kB tool result would eat the
    // Jev context budget while saying nothing about the task.
    expect(state["recent_user_turns"]).toEqual([BRIEF, "[tool_result]\nAnything?"]);
  });
});

// ---------------------------------------------------------------------------
// /v1/messages/* passthrough
// ---------------------------------------------------------------------------

describe("POST /v1/messages/count_tokens", () => {
  it("proxies to OpenRouter with the key normalized to a bearer token", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ input_tokens: 2095 });

    const body = JSON.stringify({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await post("/v1/messages/count_tokens", body, {
      ...API_KEY_AUTH,
      "anthropic-version": "2023-06-01",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 2095 });

    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/messages/count_tokens");
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe(body);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call?.headers.has("x-api-key")).toBe(false);
    // Nothing is routed on this path, so no Jev call and no decision.
    expect(upstreams.jevCalls()).toHaveLength(0);
    expect(res.headers.get("x-milo-decision-id")).toBeNull();
  });

  it("requires a key like every other /v1 path", async () => {
    await start();
    const res = await gateway.app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: JSON_TYPE,
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("passes an upstream 404 through, since OpenRouter has no count_tokens", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ error: { message: "No endpoints found" } }, 404);

    const res = await post("/v1/messages/count_tokens", "{}");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------

describe("key handling on /v1/messages", () => {
  it("forwards the key upstream and leaks it nowhere else", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(message("test/frontier"), 200, { "x-request-id": "or-req-9" });

    const routed = await post("/v1/messages", messagesBody(), API_KEY_AUTH);
    // A second routed call, over the limit, so the rate-limited path (which
    // reads the key to find the bucket) is covered too.
    await post("/v1/messages", messagesBody({ extraMessages: [{ role: "user", content: "Another brief." }] }));
    const unauthorized = await gateway.app.request("/v1/messages", { method: "POST", headers: JSON_TYPE, body: "{}" });

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
