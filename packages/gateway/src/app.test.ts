/**
 * Gateway behaviour against mocked upstreams.
 *
 * Both upstreams are one injected `fetch` that dispatches on host:
 * `api.typesafe.ai` answers as Jev, `openrouter.ai` as OpenRouter. Anything
 * else throws, so a test that accidentally reaches the network fails loudly.
 *
 * The Jev answers come from the recorded shapes in
 * `packages/core/src/router/__fixtures__`, so these tests exercise the real
 * wire format rather than a shape invented here.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { DecisionRecord, Roster, Router, RoutingUnavailableCause } from "@milo/core";
import {
  DecisionLog,
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  OpenRouterClient,
  POLICY_VERSION,
  ROSTER_NOTE,
  RoutingUnavailableError,
  defaultRosterModels,
} from "@milo/core";
import { AnthropicUpstream } from "./anthropic.js";
import { createApp } from "./app.js";
import { createGateway } from "./index.js";
import type { Gateway, GatewayOptions } from "./index.js";
import { RateLimiter } from "./rate-limit.js";

// A key-shaped value that must never reach a decision, a header, or a log.
const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const ROSTER: Roster = {
  fast: ["test/fast"],
  mid: ["test/mid"],
  frontier: ["test/frontier"],
};

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
  const url = new URL(`../../core/src/router/__fixtures__/${name}.json`, import.meta.url);
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

  /**
   * The Jev calls that *routed* something: the ones carrying the router's
   * question set. The completeness gate (ADR-013) rides the same host with
   * its own question, so tests about routing spend count these.
   */
  routingJevCalls(): Call[] {
    return this.jevCalls().filter((c) => (c.body ?? "").includes('"task_type"'));
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completion(model: string, content = "hello"): Record<string, unknown> {
  return {
    id: "gen-abc",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 137, completion_tokens: 42, total_tokens: 179, cost: 0.00123 },
  };
}

/** SSE bytes, split exactly as the mock will emit them. */
const SSE_CHUNKS = [
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
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
// Capturing logger
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
 * The app wired to a router that throws, which is the only way to drive the
 * routing-failure paths from here: the real `Router` is what decides to throw,
 * and this file's job is what the *gateway* does with the throw.
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
  // A test that never starts a gateway (or whose `createGateway` throws) must
  // not have `afterEach` close the previous test's gateway a second time.
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
  for (const log of stubLogs) await log.close();
});

function chatBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "milo/auto",
    messages: [
      { role: "system", content: "You are a sub-agent in an engineering crew." },
      { role: "user", content: "The gateway test fails one run in five in CI. Find out why." },
      ...((extra["extraMessages"] as unknown[]) ?? []),
    ],
    ...omit(extra, "extraMessages"),
  });
}

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = source;
  return rest;
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

describe("auth", () => {
  it("rejects a /v1 request with no Authorization header", async () => {
    await start();
    const res = await gateway.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody(),
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
    const res = await post("/v1/chat/completions", chatBody(), { authorization: `Token ${KEY}` });
    expect(res.status).toBe(401);
  });

  it("guards the decisions routes too", async () => {
    await start();
    expect((await gateway.app.request("/v1/decisions")).status).toBe(401);
    expect((await gateway.app.request("/v1/decisions/stats")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions, explicit model", () => {
  it("forwards untouched and returns the upstream response", async () => {
    await start();
    upstreams.openRouter = () =>
      jsonResponse(completion("anthropic/claude-sonnet-5"), 200, { "x-request-id": "or-req-1" });

    const res = await post(
      "/v1/chat/completions",
      JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.4,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("or-req-1");
    expect(res.headers.get("x-milo-decision-id")).toBeNull();

    expect(upstreams.jevCalls()).toHaveLength(0);
    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
    });
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("strips the milo field even when the request is not routed", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("anthropic/claude-sonnet-5"));

    await post(
      "/v1/chat/completions",
      JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        milo: { posture: "low" },
      }),
    );

    const body = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("milo");
    expect(body["model"]).toBe("anthropic/claude-sonnet-5");
  });

  it("rejects an unparseable body with a 400", async () => {
    await start();
    const res = await post("/v1/chat/completions", "{not json");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(upstreams.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Routed
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions, milo/auto", () => {
  it("routes, rewrites the model, and explains itself in headers", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"), 200, { "x-request-id": "or-req-2" });

    const res = await post("/v1/chat/completions", chatBody());

    expect(res.status).toBe(200);
    // The `flaky-test` fixture is a debug task at difficulty 2.31, which
    // The policy sends this distribution to frontier under balanced posture.
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    expect(res.headers.get("x-milo-task-type")).toBe("debug");
    expect(res.headers.get("x-milo-difficulty")).toBe("2.31");
    expect(res.headers.get("x-milo-sticky")).toBe("false");
    expect(res.headers.get("x-request-id")).toBe("or-req-2");

    // Six headers explain a decision, and `x-milo-degraded` is not one of
    // them any more: there is no degraded decision left to report. The
    // seventh is the completeness gate's (ADR-013): this fixture's band is
    // over the gate's bar, and a check the stub Jev cannot answer serves the
    // response exactly as a passing one -- the gate never fails a request.
    expect([...res.headers.keys()].filter((k) => k.startsWith("x-milo-")).sort()).toEqual([
      "x-milo-completeness",
      "x-milo-decision-id",
      "x-milo-difficulty",
      "x-milo-model",
      "x-milo-sticky",
      "x-milo-task-type",
      "x-milo-tier",
    ]);
    expect(res.headers.get("x-milo-completeness")).toBe("complete");

    const decisionId = res.headers.get("x-milo-decision-id");
    expect(decisionId).toBeTruthy();

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["model"]).toBe("test/frontier");
    expect(forwarded).not.toHaveProperty("milo");

    const record = await gateway.log.getDecision(decisionId ?? "");
    expect(record).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "test/frontier",
      sticky: false,
      signals: { taskType: "debug", difficulty: 2.31, jevRequestId: "req_synthetic_flaky_test" },
    });
    expect(record?.reason).toContain("debug task");

    expect(await upstreamOf(gateway.log, decisionId ?? "")).toMatchObject({
      status: 200,
      inputTokens: 137,
      outputTokens: 42,
      costUsd: 0.00123,
    });
  });

  it("routes onto the deepseek family in deepseek mode (ADR-012)", async () => {
    await start({ mode: "deepseek" });
    upstreams.openRouter = () => jsonResponse(completion("deepseek/deepseek-v4.1-flash"));

    // The flaky-test fixture's hard mass puts it in band 3; `samples: 1`
    // collapses the band's best-of-5 to one call on the same model.
    const res = await post("/v1/chat/completions", chatBody({ milo: { samples: 1 } }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-model")).toBe("deepseek/deepseek-v4.1-flash");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["model"]).toBe("deepseek/deepseek-v4.1-flash");

    const record = await gateway.log.getDecision(res.headers.get("x-milo-decision-id") ?? "");
    expect(record?.reason).toContain("deepseek controller");
  });

  it("honours the milo extension's posture and candidates", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("test/mid"));

    const res = await post(
      "/v1/chat/completions",
      chatBody({ milo: { posture: "low", candidates: ["test/mid"] } }),
    );

    // `low` posture caps at mid however hard the work looks, and candidates
    // pin the model there too.
    expect(res.headers.get("x-milo-tier")).toBe("mid");
    expect(res.headers.get("x-milo-model")).toBe("test/mid");

    const record = await gateway.log.getDecision(res.headers.get("x-milo-decision-id") ?? "");
    expect(record?.reason).toContain("low posture caps at mid");
  });

  it("streams byte-for-byte and still answers with the milo headers", async () => {
    await start();
    upstreams.openRouter = () => sseResponse();

    // Opted out of the completeness gate (ADR-013), which buffers and
    // replays instead of passing bytes through; the gated streaming shape
    // is covered in routes/gate.test.ts.
    const res = await post("/v1/chat/completions", chatBody({ stream: true, milo: { gates: false } }));

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
    expect(upstream.latencyMs).toBeGreaterThanOrEqual(0);
    expect(upstream.inputTokens).toBeUndefined();
  });

  it("reuses the decision for a second turn of the same conversation", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const first = await post("/v1/chat/completions", chatBody());
    // A tool loop continuing: the assistant called a tool and its result
    // comes back. No new user ask, so the decision is reused.
    const second = await post(
      "/v1/chat/completions",
      chatBody({
        extraMessages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "file contents" },
        ],
      }),
    );

    expect(upstreams.routingJevCalls()).toHaveLength(1);
    expect(second.headers.get("x-milo-sticky")).toBe("true");
    expect(second.headers.get("x-milo-model")).toBe(first.headers.get("x-milo-model"));
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));

    // The sticky turn is its own row, so the log counts turns, not routes.
    const sticky = await gateway.log.getDecision(second.headers.get("x-milo-decision-id") ?? "");
    expect(sticky?.sticky).toBe(true);
  });

  it("re-evaluates when the user asks something new in the same conversation", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const first = await post("/v1/chat/completions", chatBody());
    const second = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "assistant", content: "Done." }, { role: "user", content: "Now redesign the schema for multi-region writes." }] }),
    );

    expect(upstreams.routingJevCalls()).toHaveLength(2);
    expect(second.headers.get("x-milo-sticky")).toBe("false");
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));
  });

  it("refuses with a 429 once the key is over its routed rate limit", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const first = await post("/v1/chat/completions", chatBody());
    expect(first.status).toBe(200);

    const second = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "A different brief entirely." }] }),
    );

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
    // One token a minute refills in sixty seconds, rounded up to whole ones.
    expect(second.headers.get("retry-after")).toBe("60");
    expect(second.headers.get("x-milo-decision-id")).toBeNull();

    // Only the first request spent a Jev call, and only it reached OpenRouter:
    // a refusal is not routed and not forwarded.
    expect(upstreams.routingJevCalls()).toHaveLength(1);
    expect(upstreams.openRouterCalls()).toHaveLength(1);

    // And it is not a decision, so the log has only the first request's row.
    const rows = await gateway.log.listRecent({ limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.headers.get("x-milo-decision-id"));
  });

  it("does not spend a rate limit token on a forced tier, since it skips Jev", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("test/fast"));

    // Burn the one token the bucket has on a forced-tier request, five times
    // over: if forcing a tier consumed a token, every request past the first
    // would be refused.
    for (let i = 0; i < 5; i++) {
      const res = await post(
        "/v1/chat/completions",
        chatBody({
          milo: { tier: "fast" },
          extraMessages: [{ role: "user", content: `forced turn ${i}` }],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-milo-tier")).toBe("fast");
    }

    expect(upstreams.jevCalls()).toHaveLength(0);

    // The bucket is still full: an unforced request right after still succeeds.
    const unforced = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "unforced turn" }] }),
    );
    expect(unforced.status).toBe(200);
  });

  it("does not spend rate limit tokens on passthrough requests", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("anthropic/claude-sonnet-5"));

    for (let i = 0; i < 5; i++) {
      await post(
        "/v1/chat/completions",
        JSON.stringify({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: `hi ${i}` }] }),
      );
    }

    const routed = await post("/v1/chat/completions", chatBody());
    expect(routed.status).toBe(200);
    expect(routed.headers.get("x-milo-tier")).toBe("frontier");
  });

  it("passes an upstream 500 straight through and records it", async () => {
    await start();
    const failure = { error: { message: "upstream exploded", type: "server_error" } };
    upstreams.openRouter = () => jsonResponse(failure, 500);

    const res = await post("/v1/chat/completions", chatBody());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(failure);
    expect(res.headers.get("x-milo-decision-id")).toBeTruthy();

    const upstream = await upstreamOf(gateway.log, res.headers.get("x-milo-decision-id") ?? "");
    expect(upstream.status).toBe(500);
    expect(upstream.inputTokens).toBeUndefined();
  });

  it("answers 502 when OpenRouter cannot be reached", async () => {
    await start();
    upstreams.openRouter = () => {
      throw new Error("ECONNREFUSED");
    };

    const res = await post("/v1/chat/completions", chatBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: "api_error", code: "upstream_unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("puts milo/auto in front of OpenRouter's list", async () => {
    await start();
    upstreams.openRouter = () =>
      jsonResponse({ data: [{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }] });

    const res = await gateway.app.request("/v1/models", { headers: AUTH });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ id: "milo/auto", name: "Milo auto-router" });
    // Shaped like a real entry, so a model picker can render it.
    expect(body.data[0]).toHaveProperty("pricing");
    expect(body.data[0]).toHaveProperty("context_length");
    expect(body.data[1]).toMatchObject({ id: "anthropic/claude-sonnet-5" });
  });

  it("says in the description which roster the defaults come from", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ data: [] });

    const res = await gateway.app.request("/v1/models", { headers: AUTH });
    const body = (await res.json()) as { data: Array<{ description: string }> };
    const description = body.data[0]?.description ?? "";
    // A model picker is where most users first meet milo/auto, so the entry
    // has to name the roster version and what the defaults optimize for.
    expect(description).toContain("Jev");
    expect(description).toContain(`Default roster ${DEFAULT_ROSTER_INFO.version}`);
    expect(description).toContain("popular-and-cheap");
    expect(description).toContain(`$${DEFAULT_ROSTER_INFO.excludedAbove}/M output`);
    expect(description).toContain("milo.candidates");
  });

  it("passes an upstream rejection through with its own status and body", async () => {
    await start();
    const refusal = { error: { message: "No auth credentials found", code: 401 } };
    upstreams.openRouter = () => jsonResponse(refusal, 401);

    const res = await gateway.app.request("/v1/models", { headers: AUTH });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(refusal);
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe("GET /v1/decisions", () => {
  it("returns a decision by id, lists recent ones, and aggregates stats", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const routed = await post("/v1/chat/completions", chatBody());
    const decisionId = routed.headers.get("x-milo-decision-id") ?? "";

    const one = await gateway.app.request(`/v1/decisions/${decisionId}`, { headers: AUTH });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: decisionId, tier: "frontier", model: "test/frontier" });

    const list = await gateway.app.request("/v1/decisions?limit=10", { headers: AUTH });
    const listed = (await list.json()) as { data: DecisionRecord[] };
    expect(listed.data.map((d) => d.id)).toContain(decisionId);

    const stats = await gateway.app.request("/v1/decisions/stats", { headers: AUTH });
    expect(await stats.json()).toMatchObject({ total: 1, byTier: { frontier: 1 } });
  });

  it("404s an unknown id in the OpenAI error shape", async () => {
    await start();
    const res = await gateway.app.request("/v1/decisions/01JUNKJUNKJUNKJUNKJUNKJUNK", { headers: AUTH });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { type: "not_found_error", code: "decision_not_found" },
    });
  });
});

// ---------------------------------------------------------------------------
// Generic proxy and health
// ---------------------------------------------------------------------------

describe("generic /v1 proxy", () => {
  it("forwards method, path, query and headers to OpenRouter", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ data: { id: "gen-abc", total_cost: 0.0004 } });

    const res = await gateway.app.request("/v1/generation?id=gen-abc", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: "gen-abc" } });

    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/generation?id=gen-abc");
    expect(call?.method).toBe("GET");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("forwards a body on a POST it does not handle itself", async () => {
    await start();
    upstreams.openRouter = () => jsonResponse({ data: { label: "test" } });

    await gateway.app.request("/v1/keys", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "milo" }),
    });

    const [call] = upstreams.openRouterCalls();
    expect(call?.url.href).toBe("https://openrouter.ai/api/v1/keys");
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe(JSON.stringify({ name: "milo" }));
  });
});

describe("GET /healthz", () => {
  it("answers without a key and names the decision backend", async () => {
    await start();
    const res = await gateway.app.request("/healthz");

    expect(res.status).toBe(200);
    // Jev is the only backend now, but the key stays so dashboards reading it
    // keep working.
    expect(await res.json()).toEqual({ ok: true, policyVersion: POLICY_VERSION, decisionBackend: "jev", mode: "roster" });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("reports the deepseek mode when the deployment runs it (ADR-012)", async () => {
    await start({ mode: "deepseek" });

    const health = (await (await gateway.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health["mode"]).toBe("deepseek");

    const root = (await (await gateway.app.request("/")).json()) as Record<string, unknown>;
    expect(root["mode"]).toBe("deepseek");
  });

  it("names it at the root too", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/");
    expect(await res.json()).toMatchObject({ decisionBackend: "jev" });
  });
});

// ---------------------------------------------------------------------------
// The decision backend: Jev, and only Jev (ADR-005)
// ---------------------------------------------------------------------------

describe("the Jev key", () => {
  it("is required, and says which variable sets it", async () => {
    await expect(createGateway({ jevApiKey: "", roster: ROSTER, fetch: upstreams.fetch })).rejects.toThrow(
      /JEV_API_KEY/,
    );
  });
});

// ---------------------------------------------------------------------------
// Routing failures: 503, in the OpenAI dialect
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions when the router cannot decide", () => {
  const CAUSES: RoutingUnavailableCause[] = [
    "timeout",
    "network",
    "http",
    "validation",
    "breaker_open",
    "rate_limited",
  ];

  it.each(CAUSES)("answers 503 in the OpenAI shape for a %s failure", async (cause) => {
    const { app, log } = await stubRouterApp(unroutable(cause));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chatBody(),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        message: `Milo could not route this request: ${cause} from the decision model. Retry, or set an explicit model.`,
        type: "api_error",
        code: "routing_unavailable",
      },
    });
    // No hint on the error, so the default two seconds.
    expect(res.headers.get("retry-after")).toBe("2");
    // Nothing was decided, so nothing was forwarded and nothing was logged.
    expect(res.headers.get("x-milo-decision-id")).toBeNull();
    expect(upstreams.openRouterCalls()).toHaveLength(0);
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);

    // One line, naming the cause and the status, carrying no key material.
    const line = lines.find((l) => l.msg === "routing unavailable");
    expect(line?.meta).toMatchObject({ cause, status: 503, jevRequestId: "req_jev_0001" });
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("uses the error's own retry hint, rounded up to whole seconds", async () => {
    const { app } = await stubRouterApp(unroutable("rate_limited", { retryAfterMs: 3_400 }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chatBody(),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("4");
  });

  it("still answers 502 for a router failure that is not a routing failure", async () => {
    const { app, log } = await stubRouterApp(() => Promise.reject(new Error("roster has no eligible model")));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: chatBody(),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: "api_error", code: "routing_failed" } });
    // No fabricated mid-tier decision behind it.
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);
    expect(upstreams.openRouterCalls()).toHaveLength(0);
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

    // The bucket starts full, so spend its one token on a request that throws
    // its way to a 502, then watch the next one stop at the limiter.
    await app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    expect(routes).toBe(1);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } });
    expect(await log.listRecent({ limit: 100 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------

describe("key handling", () => {
  it("forwards the key upstream and leaks it nowhere else", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"), 200, { "x-request-id": "or-req-9" });

    const routed = await post("/v1/chat/completions", chatBody());
    // A second routed call, over the limit, so the rate-limited path (which
    // reads the key to find the bucket) is covered too.
    await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "Another brief." }] }),
    );
    await gateway.app.request("/healthz");
    const missing = await gateway.app.request("/v1/decisions/nope", { headers: AUTH });

    // It does reach OpenRouter, unchanged. That is the one place it belongs.
    expect(upstreams.openRouterCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // And never reaches Jev, which uses Milo's own key.
    expect(upstreams.jevCalls()[0]?.headers.get("authorization")).toBe("Bearer jev-test-key");

    const haystacks: string[] = [
      JSON.stringify(lines),
      JSON.stringify(await gateway.log.listRecent({ limit: 100 })),
      [...routed.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"),
      await missing.clone().text(),
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

describe("GET /", () => {
  it("describes the service without requiring a key", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseUrl: string; routedModel: string; setup: string; skill: string };
    expect(body.routedModel).toBe("milo/auto");
    expect(body.baseUrl).toBe("http://milo.test/v1");
    expect(body.setup).toBe("http://milo.test/setup.md");
    expect(body.skill).toBe("http://milo.test/skill.md");
    expect(upstreams.calls).toHaveLength(0);
  });

  it("uses the forwarded protocol behind a TLS-terminating proxy", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/", { headers: { "x-forwarded-proto": "https" } });
    const body = (await res.json()) as { baseUrl: string };
    expect(body.baseUrl).toBe("https://milo.test/v1");
  });

  it("renders a page for browsers", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/", { headers: { accept: "text/html,*/*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Milo</h1>");
    expect(html).toContain("milo/auto");
    expect(html).toContain("http://milo.test/v1");
    expect(html).toContain("http://milo.test/setup.md");
    expect(html).toContain("http://milo.test/skill.md");
  });

  it("discloses the running roster and the default policy in JSON", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/");
    const body = (await res.json()) as {
      roster: { version: string; tiers: Record<string, string[]> };
      rosterNote: string;
      endpoints: string[];
    };

    expect(body.roster.version).toBe(DEFAULT_ROSTER_INFO.version);
    expect(body.roster.tiers).toEqual({
      fast: ["test/fast"],
      mid: ["test/mid"],
      frontier: ["test/frontier"],
    });
    expect(body.rosterNote).toBe(ROSTER_NOTE);
    expect(body.rosterNote).toContain("$5 per million output tokens");
    expect(body.endpoints).toContain("/v1/roster");
  });

  it("reports the shipped defaults when the deployment configured no roster", async () => {
    await start({ roster: undefined });
    const res = await gateway.app.request("http://milo.test/");
    const body = (await res.json()) as { roster: { tiers: Record<string, string[]> } };
    expect(body.roster.tiers).toEqual({
      fast: [...DEFAULT_ROSTER.fast],
      mid: [...DEFAULT_ROSTER.mid],
      frontier: [...DEFAULT_ROSTER.frontier],
    });
  });

  it("shows the three tiers, their models and their output prices on the page", async () => {
    await start({ roster: undefined });
    const res = await gateway.app.request("http://milo.test/", { headers: { accept: "text/html,*/*" } });
    const html = await res.text();

    expect(html).toContain("What Milo picks by default");
    for (const tier of ["fast", "mid", "frontier"]) expect(html).toContain(`>${tier}</td>`);
    for (const model of DEFAULT_ROSTER.fast) expect(html).toContain(model);
    for (const model of DEFAULT_ROSTER.mid) expect(html).toContain(model);
    for (const model of DEFAULT_ROSTER.frontier) expect(html).toContain(model);
    // Output price per million, so the cost of the default is on the page.
    expect(html).toContain("$0.14");
    expect(html).toContain("$1.2");
    expect(html).toContain("$4.4");
    expect(html).toContain(ROSTER_NOTE);
    expect(html).toContain(DEFAULT_ROSTER_INFO.version);
  });
});

describe("GET /v1/roster", () => {
  it("needs a key like every other /v1 route", async () => {
    await start();
    const res = await gateway.app.request("/v1/roster");
    expect(res.status).toBe(401);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("returns the shipped roster with its prices, ranks and provenance", async () => {
    await start({ roster: undefined });
    const res = await gateway.app.request("/v1/roster", { headers: AUTH });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      version: string;
      source: { usage: string; pricing: string };
      topModels: number;
      bands: Record<string, { maxOutputUsdPerM: number }>;
      excludedAbove: number;
      usingDefaults: boolean;
      tiers: Record<string, Array<Record<string, unknown>>>;
      policy: { posture: Record<string, string>; longOutput: string };
      overrides: { perRequest: string; perDeployment: string };
      note: string;
      premium: string;
    };

    expect(body.version).toBe(DEFAULT_ROSTER_INFO.version);
    expect(body.source).toEqual(DEFAULT_ROSTER_INFO.source);
    expect(body.topModels).toBe(10);
    expect(body.bands).toEqual(DEFAULT_ROSTER_INFO.bands);
    expect(body.excludedAbove).toBe(5);
    expect(body.usingDefaults).toBe(true);
    expect(body.note).toBe(ROSTER_NOTE);
    expect(body.premium).toContain("Opus");
    expect(body.overrides.perRequest).toContain("candidates");
    expect(body.overrides.perDeployment).toContain("milo.config.json");

    expect(body.tiers.fast?.[0]).toMatchObject({
      id: "deepseek/deepseek-v4-flash",
      source: "default",
      isTierDefault: true,
      inputUsdPerM: 0.07,
      outputUsdPerM: 0.14,
      usageRank: 2,
      weeklyTokens: 15_400_000_000_000,
    });
    expect(body.tiers.frontier?.at(-1)).toMatchObject({
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      demotedForSmallOutput: true,
      isTierDefault: false,
    });
  });

  it("says which tier each posture favors", async () => {
    await start({ roster: undefined });
    const res = await gateway.app.request("/v1/roster", { headers: AUTH });
    const body = (await res.json()) as { policy: { posture: Record<string, string>; longOutput: string } };

    expect(Object.keys(body.policy.posture)).toEqual(["low", "balanced", "quality"]);
    expect(body.policy.posture.low).toContain("fast");
    expect(body.policy.posture.balanced).toContain("mid");
    expect(body.policy.posture.quality).toContain("frontier");
    expect(body.policy.longOutput).toContain("60000");
  });

  it("marks a deployment's own model ids as coming from config", async () => {
    await start(); // ROSTER: test/fast, test/mid, test/frontier
    const res = await gateway.app.request("/v1/roster", { headers: AUTH });
    const body = (await res.json()) as {
      usingDefaults: boolean;
      tiers: Record<string, Array<Record<string, unknown>>>;
    };

    expect(body.usingDefaults).toBe(false);
    expect(body.tiers.fast).toEqual([{ id: "test/fast", source: "config", isTierDefault: true }]);
    expect(body.tiers.frontier).toEqual([{ id: "test/frontier", source: "config", isTierDefault: true }]);
  });

  it("still names the prices of a shipped model a config moved to another tier", async () => {
    await start({
      roster: {
        fast: ["openai/gpt-5.6-luna"],
        mid: ["z-ai/glm-5.3"],
        frontier: ["anthropic/claude-opus-5"],
      },
    });
    const res = await gateway.app.request("/v1/roster", { headers: AUTH });
    const body = (await res.json()) as {
      usingDefaults: boolean;
      tiers: Record<string, Array<Record<string, unknown>>>;
    };

    expect(body.usingDefaults).toBe(false);
    expect(body.tiers.fast?.[0]).toMatchObject({
      id: "openai/gpt-5.6-luna",
      source: "default",
      defaultTier: "mid",
      outputUsdPerM: 1.2,
    });
    // A model Milo never ships has no price to report and does not invent one.
    expect(body.tiers.frontier?.[0]).toEqual({
      id: "anthropic/claude-opus-5",
      source: "config",
      isTierDefault: true,
    });
  });
});

describe("agent-facing static routes", () => {
  const SKILL_MD_PATH = new URL("../../../skills/milo/SKILL.md", import.meta.url);
  const SKILL_MD = readFileSync(SKILL_MD_PATH, "utf8");

  it("serves /setup.md without a key, with the request's own base URL", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/setup.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("http://milo.test/v1");
    expect(text).toContain("ANTHROPIC_BASE_URL=\"http://milo.test\"");
    expect(upstreams.calls).toHaveLength(0);
  });

  it("uses the forwarded protocol for /setup.md behind a TLS-terminating proxy", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/setup.md", {
      headers: { "x-forwarded-proto": "https" },
    });
    const text = await res.text();
    expect(text).toContain("https://milo.test/v1");
    expect(text).not.toContain("http://milo.test");
  });

  it("serves /llms.txt without a key, pointing at /setup.md, /healthz, and the repo", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text.startsWith("# Milo")).toBe(true);
    expect(text).toContain("http://milo.test/setup.md");
    expect(text).toContain("http://milo.test/healthz");
    expect(text).toContain("https://github.com/bananaman614305/milo");
    expect(upstreams.calls).toHaveLength(0);
  });

  it("serves /skill.md without a key, byte-equal to skills/milo/SKILL.md", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/skill.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toBe(SKILL_MD);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("discloses the default roster in /setup.md, generated from the roster data", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/setup.md");
    const text = await res.text();

    expect(text).toContain("What Milo picks by default");
    // The table is generated from roster-default.json, so it cannot describe
    // a roster the router is not running.
    for (const model of defaultRosterModels()) {
      expect(text).toContain(`| \`${model.id}\` | ${model.inputUsdPerM} |`);
      expect(text).toContain(`| ${model.usageRank} |`);
    }
    expect(text).toContain(ROSTER_NOTE);
    // Both override paths, and the instruction to say so once.
    expect(text).toContain("milo.candidates");
    expect(text).toContain('"roster"');
    expect(text).toContain("anthropic/claude-opus-5");
    expect(text).toContain("Tell the user this once");
    expect(text).toContain("http://milo.test/v1/roster");
  });

  it("says the same thing in the skill, for an agent that installed it instead", () => {
    expect(SKILL_MD).toContain("What Milo picks by default");
    expect(SKILL_MD).toContain("Tell the user this once");
    for (const model of defaultRosterModels()) expect(SKILL_MD).toContain(model.id);
    expect(SKILL_MD).toContain("nothing above $5 per million output tokens");
    expect(SKILL_MD).toContain("milo.candidates");
    expect(SKILL_MD).toContain("anthropic/claude-opus-5");
  });

  it("explains the intended frontier-plans-Milo-implements setup in both", async () => {
    await start();
    const setup = await (await gateway.app.request("http://milo.test/setup.md")).text();
    for (const text of [setup, SKILL_MD]) {
      expect(text).toContain("What Milo is for");
      expect(text).toContain("subscription");
      expect(text).toContain("implementation sub-tasks");
    }
  });
});
