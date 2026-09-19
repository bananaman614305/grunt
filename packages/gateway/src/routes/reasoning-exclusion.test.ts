/**
 * Reproduction / regression: routed milo/auto must ask OpenRouter to omit
 * reasoning traces on every dialect's streaming and non-streaming path.
 *
 * Without that, providers emit delta.reasoning (chat), thinking blocks
 * (messages), or response.reasoning_text.* (responses) and clients surface
 * them as visible thinking even when the caller did not ask for them.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Roster } from "@milo/core";
import { createGateway } from "../index.js";
import type { Gateway, GatewayOptions } from "../index.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const API_KEY_AUTH = { "x-api-key": KEY, "content-type": "application/json" };

const ROSTER: Roster = {
  fast: ["test/fast"],
  mid: ["test/mid"],
  frontier: ["test/frontier"],
};

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
  openRouter: Handler = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

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
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "or-req-repro" },
  });
}

/** Chat SSE that would leak CoT if OpenRouter were not told to exclude it. */
const CHAT_REASONING_SSE = [
  'data: {"id":"gen-1","choices":[{"delta":{"role":"assistant","reasoning":"secret chain of thought"}}]}\n\n',
  'data: {"id":"gen-1","choices":[{"delta":{"content":"42"}}]}\n\n',
  "data: [DONE]\n\n",
];

/** Anthropic Messages SSE with a thinking block (the dialect's leak shape). */
const MESSAGES_THINKING_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test/frontier","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"secret chain of thought"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" more"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"42"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** Responses SSE with reasoning_text events (the dialect's leak shape). */
const RESPONSES_REASONING_SSE = [
  'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"test/frontier","output":[]}}\n\n',
  'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","sequence_number":1,"delta":"secret chain of thought"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"delta":"42"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_1","object":"response","status":"completed","model":"test/frontier","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
];

let upstreams: Upstreams;
let gateway: Gateway;

function capturingLogger(): NonNullable<GatewayOptions["logger"]> {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

async function start(): Promise<void> {
  gateway = await createGateway({
    jevApiKey: "jev-test",
    roster: ROSTER,
    fetch: upstreams.fetch,
    logger: capturingLogger(),
  });
}

beforeEach(() => {
  upstreams = new Upstreams();
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
});

function forwardedReasoning(): unknown {
  const body = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
  return body["reasoning"];
}

describe("routed reasoning exclusion (cross-dialect)", () => {
  it("defaults chat completions streams to reasoning.exclude", async () => {
    await start();
    upstreams.openRouter = () => sse(CHAT_REASONING_SSE);

    const res = await gateway.app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "milo/auto",
        stream: true,
        milo: { gates: false },
        messages: [{ role: "user", content: "Solve 17*23." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(forwardedReasoning()).toEqual({ exclude: true });
    // With exclusion on the request, OpenRouter omits the trace; this fixture
    // still proves Milo asks for that. The client body is whatever upstream
    // returned (byte-for-byte) — the contract is the outbound exclude flag.
    const client = await res.text();
    expect(client).toContain("42");
  });

  it("defaults messages streams to reasoning.exclude", async () => {
    await start();
    upstreams.openRouter = () => sse(MESSAGES_THINKING_SSE);

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: API_KEY_AUTH,
      body: JSON.stringify({
        model: "milo/auto",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "Solve 17*23." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(forwardedReasoning()).toEqual({ exclude: true });
    expect(await res.text()).toContain("42");
  });

  it("defaults responses streams to reasoning.exclude", async () => {
    await start();
    upstreams.openRouter = () => sse(RESPONSES_REASONING_SSE);

    const res = await gateway.app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "milo/auto",
        stream: true,
        instructions: "be brief",
        input: "Solve 17*23.",
        store: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(forwardedReasoning()).toEqual({ exclude: true });
    expect(await res.text()).toContain("42");
  });

  it("leaves explicit-model chat requests untouched", async () => {
    await start();
    upstreams.openRouter = () =>
      new Response(
        JSON.stringify({
          id: "gen-1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await gateway.app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "test/frontier",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const body = JSON.parse(upstreams.openRouterCalls()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("test/frontier");
    expect(body).not.toHaveProperty("reasoning");
  });
});
