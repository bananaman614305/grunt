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
import type { DecisionLog, DecisionRecord, Roster } from "@milo/core";
import { POLICY_VERSION } from "@milo/core";
import { createGateway } from "./index.js";
import type { Gateway, GatewayOptions } from "./index.js";

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

/** Never answers; aborts when the caller's deadline fires. */
const jevHangs: Handler = () =>
  new Promise<Response>((_resolve, reject) => {
    const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    // Nothing resolves this; the router's 400 ms budget ends the wait.
    setTimeout(fail, 5_000).unref();
  });

/** The same answers in the open backend's list-of-answers wire shape. */
function systemOneOpenOk(name: string): Handler {
  const f = fixture(name);
  return (call) => {
    if (call.url.pathname === "/info") {
      return jsonResponse({ model: "e2b-full", device: "cuda", primitives: ["choice", "score", "noul"] });
    }
    const answers = Object.entries(f.answers).map(([id, answer]) => {
      const a = answer as Record<string, unknown>;
      if (a["type"] === "score") {
        // The open backend returns no legend and keys probabilities by index.
        const { legend: _legend, ...rest } = a;
        return { id, ...rest };
      }
      return { id, ...a };
    });
    return jsonResponse({ answers, latency_ms: 110.8, passes: 1, model: "e2b-full" });
  };
}

const SYSTEM_ONE_OPEN_URL = "https://open.example.test";

class Upstreams {
  readonly calls: Call[] = [];
  jev: Handler = jevOk("flaky-test");
  systemOneOpen: Handler = systemOneOpenOk("flaky-test");
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
    if (url.host === "open.example.test") return this.systemOneOpen(call);
    if (url.host === "openrouter.ai") return this.openRouter(call);
    throw new Error(`unexpected upstream host: ${url.host}`);
  }) as typeof fetch;

  openRouterCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "openrouter.ai");
  }

  jevCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "api.typesafe.ai");
  }

  systemOneOpenCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "open.example.test");
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

beforeEach(() => {
  upstreams = new Upstreams();
  lines = [];
  // A test that never starts a gateway (or whose `createGateway` throws) must
  // not have `afterEach` close the previous test's gateway a second time.
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
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
    const record = await log.get(id);
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
    expect(res.headers.get("x-milo-degraded")).toBe("false");
    expect(res.headers.get("x-request-id")).toBe("or-req-2");

    const decisionId = res.headers.get("x-milo-decision-id");
    expect(decisionId).toBeTruthy();

    const forwarded = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded["model"]).toBe("test/frontier");
    expect(forwarded).not.toHaveProperty("milo");

    const record = await gateway.log.get(decisionId ?? "");
    expect(record).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "test/frontier",
      degraded: false,
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

    const record = await gateway.log.get(res.headers.get("x-milo-decision-id") ?? "");
    expect(record?.reason).toContain("low posture caps at mid");
  });

  it("streams byte-for-byte and still answers with the milo headers", async () => {
    await start();
    upstreams.openRouter = () => sseResponse();

    const res = await post("/v1/chat/completions", chatBody({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    expect(res.headers.get("x-milo-degraded")).toBe("false");
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
    const second = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "assistant", content: "Looking." }, { role: "user", content: "Any luck?" }] }),
    );

    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(second.headers.get("x-milo-sticky")).toBe("true");
    expect(second.headers.get("x-milo-model")).toBe(first.headers.get("x-milo-model"));
    expect(second.headers.get("x-milo-decision-id")).not.toBe(first.headers.get("x-milo-decision-id"));

    // The sticky turn is its own row, so the log counts turns, not routes.
    const sticky = await gateway.log.get(second.headers.get("x-milo-decision-id") ?? "");
    expect(sticky?.sticky).toBe(true);
  });

  it("degrades to mid and still forwards when Jev times out", async () => {
    await start();
    upstreams.jev = jevHangs;
    upstreams.openRouter = () => jsonResponse(completion("test/mid"));

    const res = await post("/v1/chat/completions", chatBody());

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-degraded")).toBe("true");
    expect(res.headers.get("x-milo-tier")).toBe("mid");
    expect(res.headers.get("x-milo-model")).toBe("test/mid");
    expect(res.headers.get("x-milo-task-type")).toBe("unknown");
    expect(res.headers.get("x-milo-difficulty")).toBe("unknown");

    expect(JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}")).toMatchObject({ model: "test/mid" });

    const record = await gateway.log.get(res.headers.get("x-milo-decision-id") ?? "");
    expect(record?.degraded).toBe(true);
    expect(record?.signals).toBeUndefined();
    expect(record?.reason).toMatch(/routing signals unavailable/);
  });

  it("degrades without calling Jev once the key is over its routed rate limit", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("test/mid"));

    const first = await post("/v1/chat/completions", chatBody());
    expect(first.headers.get("x-milo-degraded")).toBe("false");

    const second = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "A different brief entirely." }] }),
    );

    expect(second.status).toBe(200);
    expect(second.headers.get("x-milo-degraded")).toBe("true");
    expect(second.headers.get("x-milo-tier")).toBe("mid");
    expect(second.headers.get("x-milo-sticky")).toBe("false");

    // Only the first request spent a Jev call; both reached OpenRouter.
    expect(upstreams.jevCalls()).toHaveLength(1);
    expect(upstreams.openRouterCalls()).toHaveLength(2);

    const record = await gateway.log.get(second.headers.get("x-milo-decision-id") ?? "");
    expect(record?.reason).toBe("rate limited: routed requests exceeded 1 per minute for this key");
    expect(record?.degraded).toBe(true);
    expect(record?.signals).toBeUndefined();
  });

  it("does not spend a rate limit token on a forced tier, since it skips Jev", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    upstreams.openRouter = () => jsonResponse(completion("test/fast"));

    // Burn the one token the bucket has on a forced-tier request, five times
    // over: if forcing a tier consumed a token, every request past the first
    // would come back degraded.
    for (let i = 0; i < 5; i++) {
      const res = await post(
        "/v1/chat/completions",
        chatBody({
          milo: { tier: "fast" },
          extraMessages: [{ role: "user", content: `forced turn ${i}` }],
        }),
      );
      expect(res.headers.get("x-milo-degraded")).toBe("false");
      expect(res.headers.get("x-milo-tier")).toBe("fast");
    }

    expect(upstreams.jevCalls()).toHaveLength(0);

    // The bucket is still full: an unforced request right after still succeeds.
    const unforced = await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "unforced turn" }] }),
    );
    expect(unforced.headers.get("x-milo-degraded")).toBe("false");
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
    expect(routed.headers.get("x-milo-degraded")).toBe("false");
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
    expect(body.data[0]).toMatchObject({
      id: "milo/auto",
      name: "Milo auto-router",
      description: "Routes to a model chosen by Jev from task type and difficulty",
    });
    // Shaped like a real entry, so a model picker can render it.
    expect(body.data[0]).toHaveProperty("pricing");
    expect(body.data[0]).toHaveProperty("context_length");
    expect(body.data[1]).toMatchObject({ id: "anthropic/claude-sonnet-5" });
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
    expect(await stats.json()).toMatchObject({ total: 1, byTier: { frontier: 1 }, degraded: 0 });
  });

  it("filters the list to degraded decisions", async () => {
    await start();
    upstreams.jev = jevHangs;
    upstreams.openRouter = () => jsonResponse(completion("test/mid"));
    const degraded = await post("/v1/chat/completions", chatBody());

    upstreams.jev = jevOk("flaky-test");
    await post(
      "/v1/chat/completions",
      chatBody({ extraMessages: [{ role: "user", content: "A second, unrelated brief." }] }),
    );

    const all = (await (await gateway.app.request("/v1/decisions", { headers: AUTH })).json()) as {
      data: DecisionRecord[];
    };
    expect(all.data).toHaveLength(2);

    const only = (await (
      await gateway.app.request("/v1/decisions?degraded=true", { headers: AUTH })
    ).json()) as { data: DecisionRecord[] };
    expect(only.data.map((d) => d.id)).toEqual([degraded.headers.get("x-milo-decision-id")]);
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
    expect(await res.json()).toEqual({ ok: true, policyVersion: POLICY_VERSION, decisionBackend: "jev" });
    expect(upstreams.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Decision backends (ADR-004)
// ---------------------------------------------------------------------------

describe("decision backends", () => {
  it("routes through system-one-open and never touches Jev", async () => {
    await start({
      jevApiKey: "",
      decisionBackend: { kind: "system-one-open", systemOneOpenUrl: SYSTEM_ONE_OPEN_URL },
    });
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const res = await post("/v1/chat/completions", chatBody());

    expect(res.status).toBe(200);
    // The fixture's signals put this one on the frontier tier, whichever
    // backend produced them.
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
    expect(res.headers.get("x-milo-task-type")).toBe("debug");
    expect(upstreams.jevCalls()).toHaveLength(0);

    const decide = upstreams.systemOneOpenCalls().filter((c) => c.url.pathname === "/decide");
    expect(decide).toHaveLength(1);
    expect(decide[0]?.method).toBe("POST");
    // The open backend has no auth, and Milo must not invent one.
    expect(decide[0]?.headers.get("authorization")).toBeNull();

    const id = res.headers.get("x-milo-decision-id") ?? "";
    const record = await gateway.log.get(id);
    expect(record?.signals?.jevModel).toBe("system-one-open/e2b-full");
    expect(record?.signals?.jevRequestId).toMatch(/^s1o_/);
    expect(record?.degraded).toBe(false);
  });

  it("warms the open backend at startup and reports it from healthz", async () => {
    await start({
      jevApiKey: "",
      decisionBackend: { kind: "system-one-open", systemOneOpenUrl: SYSTEM_ONE_OPEN_URL },
    });

    const res = await gateway.app.request("/healthz");
    expect(await res.json()).toEqual({
      ok: true,
      policyVersion: POLICY_VERSION,
      decisionBackend: "system-one-open",
    });

    // The warmup is fire and forget, so give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreams.systemOneOpenCalls().map((c) => c.url.pathname)).toContain("/info");
  });

  it("falls back to the open backend when Jev fails, and says so in healthz", async () => {
    await start({
      decisionBackend: { kind: "jev-with-fallback", systemOneOpenUrl: SYSTEM_ONE_OPEN_URL },
    });
    upstreams.jev = () => jsonResponse({ error: "quota exceeded" }, 429);
    upstreams.openRouter = () => jsonResponse(completion("test/frontier"));

    const res = await post("/v1/chat/completions", chatBody());

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-task-type")).toBe("debug");

    const health = await gateway.app.request("/healthz");
    expect(await health.json()).toMatchObject({ decisionBackend: "jev-with-fallback" });

    const id = res.headers.get("x-milo-decision-id") ?? "";
    const record = await gateway.log.get(id);
    expect(record?.signals?.jevModel).toBe("system-one-open/e2b-full");
    expect(record?.degraded).toBe(false);
  });

  it("throws a clear error when the jev backend has no key", async () => {
    await expect(
      createGateway({ jevApiKey: "", roster: ROSTER, fetch: upstreams.fetch }),
    ).rejects.toThrow(/needs Milo's Jev key/);

    await expect(
      createGateway({
        jevApiKey: "",
        roster: ROSTER,
        fetch: upstreams.fetch,
        decisionBackend: { kind: "jev-with-fallback" },
      }),
    ).rejects.toThrow(/needs Milo's Jev key/);
  });

  it("does not need a Jev key for the open backend", async () => {
    await expect(
      start({
        jevApiKey: "",
        decisionBackend: { kind: "system-one-open", systemOneOpenUrl: SYSTEM_ONE_OPEN_URL },
      }),
    ).resolves.toBeDefined();
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
    // A second routed call, over the limit, so the rate-limited decision path
    // (which is the one that reads the key) is covered too.
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
    const body = (await res.json()) as { baseUrl: string; routedModel: string };
    expect(body.routedModel).toBe("milo/auto");
    expect(body.baseUrl).toBe("http://milo.test/v1");
    expect(upstreams.calls).toHaveLength(0);
  });

  it("uses the forwarded protocol behind a TLS-terminating proxy", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/", { headers: { "x-forwarded-proto": "https" } });
    const body = (await res.json()) as { baseUrl: string };
    expect(body.baseUrl).toBe("https://milo.test/v1");
  });
});
