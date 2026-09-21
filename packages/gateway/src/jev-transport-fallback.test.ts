/**
 * ADR-023: circuit breaker + opt-in TypeSafe fallback around the
 * `"openrouter"` Jev transport, end to end through the gateway.
 *
 * The Decisions endpoint is made to fail (5xx) so the breaker trips, then the
 * suite checks the two possible outcomes:
 *
 *   - no opt-in (`jevFallbackToTypesafe` unset, the default): the breaker
 *     opens and every later call fails open per call -- `api.typesafe.ai` is
 *     NEVER called, whatever JEV_API_KEY is or is not set;
 *   - opt-in with a key: once the breaker is open, later calls are served by
 *     the direct TypeSafe transport on Milo's own key, and the response
 *     carries `x-milo-jev-transport: typesafe-fallback`.
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
    JSON.stringify({ model, answers: fixtureAnswers(), usage: { input_tokens: 393, output_tokens: 72 }, id: idHeader }),
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
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A double where OpenRouter's Decisions endpoint always answers 503 (so the
 * breaker trips), TypeSafe always answers normally, and the completion
 * always succeeds.
 */
class BrokenDecisionsUpstream {
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

    if (url.host === "openrouter.ai" && url.pathname === "/api/alpha/decisions") {
      return new Response("upstream broken", { status: 503 });
    }
    if (url.host === "api.typesafe.ai") return systemoneResponse("req_ts", "jev-latest");
    if (url.host === "openrouter.ai") return completion();
    throw new Error(`unexpected upstream host: ${url.host}`);
  }) as typeof fetch;

  typesafeCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "api.typesafe.ai");
  }

  decisionCalls(): Call[] {
    return this.calls.filter((c) => c.url.pathname === "/api/alpha/decisions");
  }
}

let upstream: BrokenDecisionsUpstream;
let gateway: Gateway;

async function start(overrides: Partial<GatewayOptions> = {}): Promise<Gateway> {
  gateway = await createGateway({
    roster: ROSTER,
    fetch: upstream.fetch,
    jevTransport: "openrouter",
    // A tiny threshold/cooldown so the suite does not wait 30 real seconds.
    jevBreaker: { failureThreshold: 2, cooldownMs: 10 },
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

async function request(): Promise<Response> {
  return gateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });
}

beforeEach(() => {
  upstream = new BrokenDecisionsUpstream();
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
});

describe("jev breaker + fallback (ADR-023): no operator opt-in", () => {
  it("never calls api.typesafe.ai once the breaker opens, with no JEV_API_KEY configured at all", async () => {
    await start(); // jevFallbackToTypesafe unset, jevApiKey unset

    // Trip the breaker (threshold 2).
    for (let i = 0; i < 2; i++) {
      const res = await request();
      expect(res.status).toBe(503);
    }
    // Now open: further requests fail fast, still with zero typesafe calls.
    for (let i = 0; i < 3; i++) {
      const res = await request();
      expect(res.status).toBe(503);
    }

    expect(upstream.typesafeCalls()).toHaveLength(0);
  });

  it("never calls api.typesafe.ai even when jevFallbackToTypesafe is true but no JEV_API_KEY is configured", async () => {
    await start({ jevFallbackToTypesafe: true }); // opted in, but no key

    for (let i = 0; i < 2; i++) await request();
    for (let i = 0; i < 3; i++) {
      const res = await request();
      expect(res.status).toBe(503);
    }

    expect(upstream.typesafeCalls()).toHaveLength(0);
  });

  it("discloses x-milo-jev-transport: openrouter while the breaker is closed", async () => {
    // A separate, healthy upstream double so the first call actually succeeds.
    const healthyGateway = await createGateway({
      roster: ROSTER,
      jevTransport: "openrouter",
      fetch: (async (input: RequestInfo | URL, _init?: RequestInit) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const url = new URL(href);
        if (url.host === "openrouter.ai" && url.pathname === "/api/alpha/decisions") {
          return systemoneResponse("gen-dec-1", "typesafe/jev-1.13-20260917");
        }
        if (url.host === "openrouter.ai") return completion();
        throw new Error(`unexpected host ${url.host}`);
      }) as typeof fetch,
    });
    try {
      const res = await healthyGateway.app.request("/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: chatBody(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-milo-jev-transport")).toBe("openrouter");
    } finally {
      await healthyGateway.close();
    }
  });

  it("sends no x-milo-jev-transport header at all under the default typesafe transport", async () => {
    const ts = new BrokenDecisionsUpstream();
    const tsGateway = await createGateway({ roster: ROSTER, jevApiKey: "jev-milo-key", fetch: ts.fetch });
    try {
      const res = await tsGateway.app.request("/v1/chat/completions", { method: "POST", headers: AUTH, body: chatBody() });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-milo-jev-transport")).toBeNull();
    } finally {
      await tsGateway.close();
    }
  });
});

describe("jev breaker + fallback (ADR-023): operator opt-in", () => {
  it("falls back to TypeSafe once the breaker opens, authenticated with Milo's own key", async () => {
    await start({ jevFallbackToTypesafe: true, jevApiKey: "jev-milo-key" });

    // Trip the breaker (threshold 2).
    for (let i = 0; i < 2; i++) {
      const res = await request();
      expect(res.status).toBe(503);
    }
    expect(upstream.typesafeCalls()).toHaveLength(0); // not yet -- breaker just tripped

    // Now open: the next request is served by the typesafe fallback.
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-jev-transport")).toBe("typesafe-fallback");

    const typesafeCalls = upstream.typesafeCalls();
    expect(typesafeCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of typesafeCalls) {
      expect(call.headers.get("authorization")).toBe("Bearer jev-milo-key");
      expect(call.headers.get("authorization")).not.toContain(KEY);
    }
  });

  // Full breaker recovery through a real `JevClient` (half-open probe,
  // close-on-success, re-open-on-failed-probe) is covered thoroughly and
  // deterministically at the unit level in `../core/src/jev/fallback.test.ts`,
  // against clean single-call-site stubs. At the gateway level a routed
  // request also fires auxiliary Jev calls (the completeness gate, capture,
  // ...) on the SAME shared breaker-wrapped client, and `JevClient` itself
  // retries a failing call internally before reporting it as failed -- the
  // combination makes the exact raw-HTTP-attempt count needed to trip and
  // then clear the breaker depend on gate/feature behaviour this file
  // shouldn't need to know about. This suite instead sticks to what the
  // gateway wiring itself is responsible for: routing calls to the right
  // transport and disclosing it, which the tests above already cover.
});
