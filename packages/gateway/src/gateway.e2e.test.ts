/**
 * End to end: a real HTTP server, driven by the real `openai` and
 * `@anthropic-ai/sdk` clients, with both upstreams mocked.
 *
 * This is the acceptance test for tasks 2.1 and 3.1 as docs/PLAN.md words
 * them -- "a user sets one base URL and their OpenRouter key, sends
 * `milo/auto`, and gets a streamed answer from a model chosen by Jev, with
 * headers naming the decision and a `/v1/decisions/:id` record explaining
 * it", from either dialect. The SDKs are here on purpose: `app.request` would
 * not catch a header an SDK cannot see, a status line it rejects, or an SSE
 * frame its parser chokes on -- and the Anthropic SDK sends its key as
 * `x-api-key`, which is exactly the path task 3.1 had to open.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createGateway } from "./index.js";
import type { Gateway } from "./index.js";
import { startServer } from "./server.js";
import type { RunningServer } from "./server.js";

const KEY = "sk-or-test";

const JEV_ANSWERS = {
  task_type: {
    type: "choice",
    choice: "debug",
    confidence: 0.9,
    probabilities: { debug: 0.9, feature: 0.05, edit: 0.03, chat: 0.02 },
  },
  difficulty: {
    type: "score",
    score: 2.4,
    confidence: 0.81,
    legend: { "0": "Trivial", "1": "Routine", "2": "Substantial", "3": "Hard" },
    probabilities: { "0": 0.02, "1": 0.12, "2": 0.3, "3": 0.56 },
  },
  needs_reasoning: { type: "noul", noul: 0.94 },
  long_output: { type: "noul", noul: 0.22 },
};

const STREAM_FRAMES = [
  'data: {"id":"gen-e2e","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-opus-5","choices":[{"index":0,"delta":{"role":"assistant","content":"race "}}]}\n\n',
  'data: {"id":"gen-e2e","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-opus-5","choices":[{"index":0,"delta":{"content":"condition"}}]}\n\n',
  'data: {"id":"gen-e2e","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-opus-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

/** The Anthropic dialect's SSE frames, as OpenRouter's `/messages` emits them. */
const ANTHROPIC_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","model":"anthropic/claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":940,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"race "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"condition"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":18}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Every header the gateway sent OpenRouter on its `/messages` calls. */
const messagesRequests: Headers[] = [];

/** Both upstreams behind one fetch, dispatched on host. */
const upstreamFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);

  if (url.host === "api.typesafe.ai") {
    return Promise.resolve(
      json(
        { model: "jev-latest", answers: JEV_ANSWERS, usage: { input_tokens: 940, output_tokens: 22 } },
        200,
        { "x-typesafe-request-id": "req_e2e_0001" },
      ),
    );
  }

  if (url.host !== "openrouter.ai") return Promise.reject(new Error(`unexpected host ${url.host}`));

  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;

  // OpenRouter's Anthropic-compatible endpoint answers in Anthropic's shape.
  if (url.pathname === "/api/v1/messages") {
    messagesRequests.push(new Headers(init?.headers));
    if (body["stream"] === true) return Promise.resolve(sse(ANTHROPIC_FRAMES));
    return Promise.resolve(
      json(
        {
          id: "msg_e2e",
          type: "message",
          role: "assistant",
          model: body["model"],
          content: [{ type: "text", text: "It is a race condition." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 940, output_tokens: 18 },
        },
        200,
        { "x-request-id": "or-e2e-2" },
      ),
    );
  }

  if (body["stream"] === true) return Promise.resolve(sse(STREAM_FRAMES));

  return Promise.resolve(
    json(
      {
        id: "gen-e2e",
        object: "chat.completion",
        created: 1,
        model: body["model"],
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "It is a race condition." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 940, completion_tokens: 18, total_tokens: 958, cost: 0.0091 },
      },
      200,
      { "x-request-id": "or-e2e-1" },
    ),
  );
}) as typeof fetch;

const MESSAGES = [
  { role: "system" as const, content: "You are a debugging sub-agent in an engineering crew." },
  { role: "user" as const, content: "The SSE test fails one run in five in CI. Work out why." },
];

/** A distinct conversation, so the Anthropic block has its own fingerprint. */
const ANTHROPIC_SYSTEM = "You are a debugging sub-agent driven by Claude Code.";
const ANTHROPIC_BRIEF = "The retry test flakes one run in five on CI runners. Work out why.";

let gateway: Gateway;
let server: RunningServer;
let client: OpenAI;
let anthropic: Anthropic;

beforeAll(async () => {
  gateway = await createGateway({
    jevApiKey: "jev-e2e-key",
    fetch: upstreamFetch,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  server = await startServer(gateway, { port: 0, hostname: "127.0.0.1" });
  client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: KEY, maxRetries: 0 });
  // The Anthropic SDK appends `/v1/messages` itself, and sends `apiKey` as
  // `x-api-key` -- which is the whole point of this half of the file.
  anthropic = new Anthropic({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: KEY, maxRetries: 0 });
});

afterAll(async () => {
  await server?.close();
  await gateway?.close();
});

describe("the OpenAI SDK against Milo", () => {
  it("routes a non-streaming completion and explains the choice", async () => {
    const { data, response } = await client.chat.completions
      .create({ model: "milo/auto", messages: MESSAGES })
      .withResponse();

    expect(data.choices[0]?.message.content).toBe("It is a race condition.");
    // Difficulty 2.4 on a debug task under the default balanced posture is
    // frontier, and the default roster's frontier model is Opus 5.
    expect(data.model).toBe("anthropic/claude-opus-5");

    expect(response.headers.get("x-milo-model")).toBe("anthropic/claude-opus-5");
    expect(response.headers.get("x-milo-tier")).toBe("frontier");
    expect(response.headers.get("x-milo-task-type")).toBe("debug");
    expect(response.headers.get("x-milo-difficulty")).toBe("2.40");
    expect(response.headers.get("x-milo-sticky")).toBe("false");
    expect(response.headers.get("x-milo-degraded")).toBe("false");
    expect(response.headers.get("x-request-id")).toBe("or-e2e-1");

    const decisionId = response.headers.get("x-milo-decision-id");
    expect(decisionId).toBeTruthy();

    const decision = await fetchDecision(decisionId ?? "");
    expect(decision).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "anthropic/claude-opus-5",
      policyVersion: "v1",
      degraded: false,
      signals: {
        taskType: "debug",
        difficulty: 2.4,
        needsReasoning: 0.94,
        jevRequestId: "req_e2e_0001",
        jevModel: "jev-latest",
      },
    });
    // The reason is the product's explanation, so it has to name the numbers.
    expect(decision.reason).toContain("debug task");
    expect(decision.reason).toContain("2.4");
    expect(decision.reason).toContain("anthropic/claude-opus-5");

    await waitForUpstream(decisionId ?? "");
    const settled = await fetchDecision(decisionId ?? "");
    expect(settled.upstream).toMatchObject({ status: 200, inputTokens: 940, outputTokens: 18, costUsd: 0.0091 });
  });

  it("streams a routed completion through the SDK's parser", async () => {
    const { data: stream, response } = await client.chat.completions
      .create({ model: "milo/auto", messages: MESSAGES, stream: true })
      .withResponse();

    expect(response.headers.get("x-milo-model")).toBe("anthropic/claude-opus-5");
    expect(response.headers.get("x-milo-tier")).toBe("frontier");
    expect(response.headers.get("x-milo-task-type")).toBe("debug");
    expect(response.headers.get("x-milo-difficulty")).toBe("2.40");
    // The second conversation with the same fingerprint is served from the
    // sticky cache, so this one costs no Jev call.
    expect(response.headers.get("x-milo-sticky")).toBe("true");

    let content = "";
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta.content ?? "";
      finish ??= chunk.choices[0]?.finish_reason;
    }

    expect(content).toBe("race condition");
    expect(finish).toBe("stop");

    const decisionId = response.headers.get("x-milo-decision-id") ?? "";
    await waitForUpstream(decisionId);
    const decision = await fetchDecision(decisionId);
    expect(decision).toMatchObject({ sticky: true, model: "anthropic/claude-opus-5" });
    expect(decision.upstream).toMatchObject({ status: 200 });
  });

  it("lists milo/auto first in the models the SDK sees", async () => {
    const models = await client.models.list();
    expect(models.data[0]?.id).toBe("milo/auto");
  });

  it("rejects a request with no key the way the SDK expects", async () => {
    const anonymous = new OpenAI({
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "placeholder",
      maxRetries: 0,
      defaultHeaders: { authorization: null },
    });

    await expect(anonymous.chat.completions.create({ model: "milo/auto", messages: MESSAGES })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("the Anthropic SDK against Milo", () => {
  it("routes a non-streaming message and explains the choice", async () => {
    const { data, response } = await anthropic.messages
      .create({
        model: "milo/auto",
        max_tokens: 1024,
        system: ANTHROPIC_SYSTEM,
        messages: [{ role: "user", content: ANTHROPIC_BRIEF }],
      })
      .withResponse();

    expect(data.content[0]).toMatchObject({ type: "text", text: "It is a race condition." });
    // Difficulty 2.4 on a debug task under the default balanced posture is
    // frontier, and the default roster's frontier model is Opus 5.
    expect(data.model).toBe("anthropic/claude-opus-5");

    expect(response.headers.get("x-milo-model")).toBe("anthropic/claude-opus-5");
    expect(response.headers.get("x-milo-tier")).toBe("frontier");
    expect(response.headers.get("x-milo-task-type")).toBe("debug");
    expect(response.headers.get("x-milo-difficulty")).toBe("2.40");
    expect(response.headers.get("x-milo-sticky")).toBe("false");
    expect(response.headers.get("x-milo-degraded")).toBe("false");
    expect(response.headers.get("x-request-id")).toBe("or-e2e-2");

    // The SDK's key arrived as `x-api-key` and left as a bearer token, and
    // the version header it always sends was carried through.
    const sent = messagesRequests[0];
    expect(sent?.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent?.has("x-api-key")).toBe(false);
    expect(sent?.get("anthropic-version")).toBe("2023-06-01");

    const decisionId = response.headers.get("x-milo-decision-id");
    expect(decisionId).toBeTruthy();

    const decision = await fetchDecision(decisionId ?? "");
    expect(decision).toMatchObject({
      id: decisionId,
      tier: "frontier",
      model: "anthropic/claude-opus-5",
      policyVersion: "v1",
      degraded: false,
      signals: { taskType: "debug", difficulty: 2.4, jevRequestId: "req_e2e_0001" },
    });
    expect(decision.reason).toContain("debug task");

    await waitForUpstream(decisionId ?? "");
    const settled = await fetchDecision(decisionId ?? "");
    // Read off `usage.input_tokens` / `usage.output_tokens`, not the OpenAI
    // dialect's `prompt_tokens` / `completion_tokens`.
    expect(settled.upstream).toMatchObject({ status: 200, inputTokens: 940, outputTokens: 18 });
  });

  it("streams a routed message through the SDK's parser", async () => {
    const { data: stream, response } = await anthropic.messages
      .create({
        model: "milo/auto",
        max_tokens: 1024,
        system: ANTHROPIC_SYSTEM,
        messages: [{ role: "user", content: ANTHROPIC_BRIEF }],
        stream: true,
      })
      .withResponse();

    expect(response.headers.get("x-milo-model")).toBe("anthropic/claude-opus-5");
    expect(response.headers.get("x-milo-tier")).toBe("frontier");
    // Same fingerprint as the turn above, so this one costs no Jev call.
    expect(response.headers.get("x-milo-sticky")).toBe("true");

    let content = "";
    let stop: string | null | undefined;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") content += event.delta.text;
      if (event.type === "message_delta") stop ??= event.delta.stop_reason;
    }

    expect(content).toBe("race condition");
    expect(stop).toBe("end_turn");

    const decisionId = response.headers.get("x-milo-decision-id") ?? "";
    await waitForUpstream(decisionId);
    const decision = await fetchDecision(decisionId);
    expect(decision).toMatchObject({ sticky: true, model: "anthropic/claude-opus-5" });
    expect(decision.upstream).toMatchObject({ status: 200 });
  });

  it("passes an explicit model through unrouted", async () => {
    const before = messagesRequests.length;

    const { data, response } = await anthropic.messages
      .create({
        model: "anthropic/claude-haiku-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
      })
      .withResponse();

    expect(data.model).toBe("anthropic/claude-haiku-4.5");
    expect(response.headers.get("x-milo-decision-id")).toBeNull();
    expect(messagesRequests).toHaveLength(before + 1);
  });

  it("rejects a request with no key the way the SDK expects", async () => {
    const anonymous = new Anthropic({
      baseURL: `http://127.0.0.1:${server.port}`,
      apiKey: "placeholder",
      maxRetries: 0,
      defaultHeaders: { "x-api-key": null },
    });

    await expect(
      anonymous.messages.create({
        model: "milo/auto",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

type Decision = { reason: string; upstream?: { status: number } };

async function fetchDecision(id: string): Promise<Decision & Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/decisions/${id}`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Decision & Record<string, unknown>;
}

/** The upstream outcome of a streamed call lands after the response does. */
async function waitForUpstream(id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await fetchDecision(id)).upstream !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`decision ${id} never recorded an upstream outcome`);
}
