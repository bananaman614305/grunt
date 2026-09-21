/**
 * ADR-021 / ADR-022: the `"openrouter"` Jev transport, end to end through the
 * gateway.
 *
 * A single injected `fetch` doubles for both upstreams and dispatches on the
 * request path: `/api/alpha/decisions` is OpenRouter's Decisions router (Jev),
 * `/api/v1/chat/completions` is the ordinary completion, and `api.typesafe.ai`
 * is native Jev. The classification call carries the router's question set
 * (`task_type`), so a call whose body has `"task_type"` is the routing
 * decision.
 *
 * Under `"openrouter"` the routing decision -- and, since ADR-022, EVERY other
 * Jev call the gateway makes (the completeness gate, ranking, verification,
 * pruning, fact capture and relevance, preference capture) -- must go to the
 * Decisions endpoint on the caller's own forwarded OpenRouter key, and never to
 * `api.typesafe.ai`. `JEV_API_KEY` is then unused and need not be set.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Gateway, GatewayOptions } from "./index.js";
import { createGateway } from "./index.js";
import type { Roster } from "@milo/core";

const KEY = "sk-or-v1-FORWARDEDUSERKEY0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const ROSTER: Roster = {
  fast: ["test/fast"],
  mid: ["test/mid"],
  frontier: ["test/frontier"],
};

type Call = { url: URL; method: string; headers: Headers; body: string | undefined };

function fixtureAnswers(): Record<string, unknown> {
  const url = new URL("../../core/src/router/__fixtures__/flaky-test.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { answers: Record<string, unknown> }).answers;
}

function systemoneResponse(idHeader: string, model: string): Response {
  return new Response(
    JSON.stringify({
      model,
      answers: fixtureAnswers(),
      usage: { input_tokens: 393, output_tokens: 72, cost: 0.0000165 },
      id: idHeader,
      provider: "TypeSafe",
    }),
    { status: 200, headers: { "content-type": "application/json", "x-generation-id": idHeader, "x-typesafe-request-id": idHeader } },
  );
}

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "gen-abc",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "test/frontier",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0001 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

class Upstreams {
  readonly calls: Call[] = [];

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

    if (url.host === "api.typesafe.ai") return systemoneResponse("req_ts", "jev-latest");
    if (url.host === "openrouter.ai" && url.pathname === "/api/alpha/decisions") {
      return systemoneResponse("gen-dec-test-1", "typesafe/jev-1.13-20260917");
    }
    if (url.host === "openrouter.ai") return completion();
    throw new Error(`unexpected upstream host: ${url.host}`);
  }) as typeof fetch;

  /** Calls carrying the router's classification question set. */
  classificationCalls(host: string): Call[] {
    return this.calls.filter((c) => c.url.host === host && (c.body ?? "").includes('"task_type"'));
  }

  decisionCalls(): Call[] {
    return this.calls.filter((c) => c.url.pathname === "/api/alpha/decisions");
  }
}

let upstreams: Upstreams;
let gateway: Gateway;

async function start(overrides: Partial<GatewayOptions> = {}): Promise<Gateway> {
  gateway = await createGateway({
    jevApiKey: "jev-milo-key",
    roster: ROSTER,
    fetch: upstreams.fetch,
    ...overrides,
  });
  return gateway;
}

function chatBody(): string {
  return JSON.stringify({
    model: "milo/auto",
    messages: [
      { role: "system", content: "You are a sub-agent in an engineering crew." },
      { role: "user", content: "The gateway test fails one run in five in CI. Find out why." },
    ],
  });
}

beforeEach(() => {
  upstreams = new Upstreams();
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
});

describe("jevTransport: openrouter (ADR-021)", () => {
  it("routes the classification call through OpenRouter's Decisions endpoint, not TypeSafe", async () => {
    await start({ jevTransport: "openrouter" });

    const res = await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    expect(res.status).toBe(200);
    // The routing/classification call went to the Decisions endpoint...
    expect(upstreams.classificationCalls("openrouter.ai")).toHaveLength(1);
    expect(upstreams.decisionCalls()[0]?.url.href).toBe("https://openrouter.ai/api/alpha/decisions");
    // ...and never to TypeSafe.
    expect(upstreams.classificationCalls("api.typesafe.ai")).toHaveLength(0);
    expect(res.headers.get("x-milo-model")).toBe("test/frontier");
  });

  it("authenticates the decision call with the caller's own forwarded key", async () => {
    await start({ jevTransport: "openrouter" });

    await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    expect(upstreams.decisionCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("defaults to the TypeSafe transport: classification goes to api.typesafe.ai", async () => {
    await start();

    const res = await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    expect(res.status).toBe(200);
    expect(upstreams.classificationCalls("api.typesafe.ai")).toHaveLength(1);
    expect(upstreams.decisionCalls()).toHaveLength(0);
  });

  it("never sends the forwarded key to TypeSafe: the decision uses Milo's own key", async () => {
    await start();

    await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    // Under TypeSafe, every Jev call authenticates with Milo's own key, and
    // the caller's forwarded OpenRouter key never reaches api.typesafe.ai.
    const typesafeCalls = upstreams.calls.filter((call) => call.url.host === "api.typesafe.ai");
    expect(typesafeCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of typesafeCalls) {
      expect(call.headers.get("authorization")).toBe("Bearer jev-milo-key");
      expect(call.headers.get("authorization")).not.toContain(KEY);
    }
  });
});

describe("jevTransport: openrouter -- full Jev offload (ADR-022)", () => {
  it("starts WITHOUT JEV_API_KEY and never calls TypeSafe for any Jev call", async () => {
    // JEV_API_KEY is unused under the openrouter transport: the gateway starts
    // without it, and no Jev call falls back to Milo's key.
    gateway = await createGateway({ roster: ROSTER, fetch: upstreams.fetch, jevTransport: "openrouter" });

    const res = await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    expect(res.status).toBe(200);
    expect(upstreams.calls.filter((call) => call.url.host === "api.typesafe.ai")).toHaveLength(0);
    // The classification call still fired -- on the Decisions endpoint.
    expect(upstreams.decisionCalls().length).toBeGreaterThanOrEqual(1);
  });

  it("authenticates EVERY Decisions-endpoint Jev call with the caller's forwarded key", async () => {
    await start({ jevTransport: "openrouter" });

    await gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });

    const decisionCalls = upstreams.decisionCalls();
    expect(decisionCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of decisionCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }
    // Not one Jev call reached TypeSafe, whatever auxiliary features fired.
    expect(upstreams.calls.filter((call) => call.url.host === "api.typesafe.ai")).toHaveLength(0);
  });
});
