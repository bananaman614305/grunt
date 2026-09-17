/**
 * Milo keys, credits and metering against mocked upstreams (ADR-007).
 *
 * One injected `fetch` answers as all three upstreams, dispatching on host and
 * path: `api.typesafe.ai` is Jev, `openrouter.ai/api/v1/keys*` is the
 * provisioning API, and everything else on `openrouter.ai` is inference. A
 * request to any other host throws, so a test that reaches the network fails
 * loudly rather than silently passing.
 *
 * The store is the in-memory fake in `test-support.ts`, which hashes keys with
 * the same function the Postgres store uses and enforces the same reserve
 * floor, so the auth and charge paths here are the ones that run in
 * production.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, generateEncryptionKey } from "@milo/billing";
import { DEFAULT_PRICING, defaultRosterModel, defaultRosterModels } from "@milo/core";
import type { Account, ApiKey, Roster } from "@milo/core";
import { OpenRouterProvisioningClient } from "@milo/provisioning";
import { createStripeClient } from "@milo/stripe";
import { createGateway } from "./index.js";
import type { Gateway, GatewayOptions } from "./index.js";
import { createFakeBillingStore } from "./test-support.js";
import type { FakeBillingStore } from "./test-support.js";

// A Milo key and a sub-key that must never appear in a log, a header, or a
// decision. Both are replaced by generated values in the tests that mint
// them; these are the fixed ones for the paths that do not.
const BYOK_KEY = "sk-or-v1-BYOKNEVERLEAK0123456789";
const SUB_KEY = "sk-or-v1-SUBKEYNEVERLEAK0123456789";
const SUB_KEY_HASH = "or-hash-1";

const ROSTER: Roster = { fast: ["test/fast"], mid: ["test/mid"], frontier: ["test/frontier"] };

/** A model the shipped roster knows a price for, for the estimate fallback. */
const PRICED_MODEL_ID = defaultRosterModels()[0]?.id ?? "";

const JSON_TYPE = { "content-type": "application/json" };

// ---------------------------------------------------------------------------
// Upstream doubles
// ---------------------------------------------------------------------------

type Call = { url: URL; method: string; headers: Headers; body: string | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

type Fixture = { requestId: string; model: string; answers: Record<string, unknown>; usage: unknown };

function jevOk(name: string): Handler {
  const url = new URL(`../../core/src/router/__fixtures__/${name}.json`, import.meta.url);
  const f = JSON.parse(readFileSync(url, "utf8")) as Fixture;
  return () =>
    new Response(JSON.stringify({ model: f.model, answers: f.answers, usage: f.usage }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": f.requestId },
    });
}

class Upstreams {
  readonly calls: Call[] = [];
  jev: Handler = jevOk("flaky-test");
  inference: Handler = () => json({ ok: true });
  provisioning: Handler = (call) =>
    call.method === "POST"
      ? json({ key: SUB_KEY, data: keyData() })
      : json({ data: keyData(limitOf(call.body)) });

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
    if (url.host === "openrouter.ai") {
      return url.pathname.startsWith("/api/v1/keys") ? this.provisioning(call) : this.inference(call);
    }
    throw new Error(`unexpected upstream host: ${url.host}`);
  }) as typeof fetch;

  inferenceCalls(): Call[] {
    return this.calls.filter((c) => c.url.host === "openrouter.ai" && !c.url.pathname.startsWith("/api/v1/keys"));
  }

  provisioningCalls(): Call[] {
    return this.calls.filter((c) => c.url.pathname.startsWith("/api/v1/keys"));
  }
}

function keyData(limit: number | null = 0): Record<string, unknown> {
  return {
    hash: SUB_KEY_HASH,
    name: "milo-acc",
    disabled: false,
    limit,
    limit_remaining: limit,
    usage: 0,
  };
}

function limitOf(body: string | undefined): number | null {
  if (body === undefined) return null;
  const parsed = JSON.parse(body) as { limit?: number };
  return parsed.limit ?? null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_TYPE, ...headers } });
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

/** `usage.cost` is OpenRouter's: what the call cost the key that made it. */
function chatCompletion(costUsd: number | undefined): Record<string, unknown> {
  const usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (costUsd !== undefined) usage["cost"] = costUsd;
  return {
    id: "gen-abc",
    object: "chat.completion",
    model: "test/frontier",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage,
  };
}

function responsesBody(costUsd: number): Record<string, unknown> {
  return {
    id: "resp-abc",
    object: "response",
    status: "completed",
    model: "test/frontier",
    output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost: costUsd },
  };
}

function anthropicBody(costUsd: number | undefined): Record<string, unknown> {
  const usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20 };
  if (costUsd !== undefined) usage["cost"] = costUsd;
  return {
    id: "msg-abc",
    type: "message",
    role: "assistant",
    model: "test/frontier",
    content: [{ type: "text", text: "hi" }],
    usage,
  };
}

const CHAT_STREAM = [
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n',
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.002}}\n\n',
  "data: [DONE]\n\n",
];

/** The same shape as `CHAT_STREAM`, at whatever the call is said to cost. */
function chatStreamCosting(costUsd: number): string[] {
  return [
    CHAT_STREAM[0] ?? "",
    `data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":${costUsd}}}\n\n`,
    "data: [DONE]\n\n",
  ];
}

const CHAT_STREAM_NO_USAGE = [
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
  'data: {"id":"gen-1","model":"test/frontier","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

const RESPONSES_STREAM = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","usage":{"input_tokens":100,"output_tokens":20,"cost":0.004}}}\n\n',
];

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"test/frontier","usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20,"cost":0.001}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

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

type StripeSdk = NonNullable<Parameters<typeof createStripeClient>[0]>["sdk"];

type StripeCapture = { checkout: Record<string, unknown>[]; portal: Record<string, unknown>[] };

function fakeStripe(capture: StripeCapture): ReturnType<typeof createStripeClient> {
  const sdk = {
    webhooks: {
      constructEvent: (body: string, signature: string) => {
        if (signature !== "good") throw new Error("No signatures found matching the expected signature");
        return JSON.parse(body) as unknown;
      },
    },
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          capture.checkout.push(params);
          return { url: "https://checkout.stripe.test/session" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          capture.portal.push(params);
          return { url: "https://billing.stripe.test/portal" };
        },
      },
    },
    customers: { create: async () => ({ id: "cus_test" }) },
  };
  return createStripeClient({ sdk: sdk as unknown as StripeSdk, webhookSecret: "whsec_test" });
}

let upstreams: Upstreams;
let lines: LogLine[];
let store: FakeBillingStore;
let gateway: Gateway;
let stripeCapture: StripeCapture;
const encryptionKey = generateEncryptionKey();

type StartOptions = Partial<GatewayOptions> & { withBilling?: boolean; stripe?: boolean; provisioning?: boolean };

async function start(options: StartOptions = {}): Promise<Gateway> {
  const { withBilling = true, stripe = true, provisioning = true, ...overrides } = options;
  const billing: GatewayOptions["billing"] = {
    store,
    encryptionKey,
    ...(stripe ? { stripe: fakeStripe(stripeCapture) } : {}),
    ...(provisioning
      ? { provisioning: new OpenRouterProvisioningClient({ provisioningKey: "prov-test", fetch: upstreams.fetch }) }
      : {}),
  };

  gateway = await createGateway({
    jevApiKey: "jev-test-key",
    roster: ROSTER,
    fetch: upstreams.fetch,
    logger: capturingLogger(lines),
    ...(withBilling ? { billing } : {}),
    ...overrides,
  });
  return gateway;
}

/** An account with `usd` of credit and one key. */
let seeded = 0;

async function seedAccount(usd: number, email = `user${++seeded}@example.com`): Promise<{
  account: Account;
  key: ApiKey;
  secret: string;
}> {
  const account = await store.createAccount(email);
  if (usd !== 0) {
    await store.postLedger({
      accountId: account.id,
      kind: "credit_purchase",
      amountMicroUsd: Math.round(usd * 1_000_000),
      reference: "seed",
    });
  }
  const { key, secret } = await store.createApiKey(account.id, "default");
  const fresh = await store.getAccount(account.id);
  return { account: fresh ?? account, key, secret };
}

function miloAuth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, ...JSON_TYPE };
}

function chatBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "milo/auto",
    messages: [
      { role: "system", content: "You are a sub-agent in an engineering crew." },
      { role: "user", content: "The gateway test fails one run in five in CI. Find out why." },
    ],
    ...extra,
  });
}

function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
  return gateway.app.request(path, { method: "POST", headers, body });
}

/** Waits for work a streamed response settles after the handler returned. */
async function waitFor(what: string, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  upstreams = new Upstreams();
  lines = [];
  store = createFakeBillingStore();
  stripeCapture = { checkout: [], portal: [] };
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("Milo key auth", () => {
  it("leaves a bring-your-own-key request exactly as it was", async () => {
    await start();
    upstreams.inference = () => json(chatCompletion(0.002), 200, { "x-request-id": "or-1" });

    const res = await post("/v1/chat/completions", chatBody(), {
      authorization: `Bearer ${BYOK_KEY}`,
      ...JSON_TYPE,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-cost-usd")).toBeNull();
    expect(res.headers.get("x-milo-balance-usd")).toBeNull();
    // The user's own key went upstream, and nothing was charged to anyone.
    expect(upstreams.inferenceCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${BYOK_KEY}`);
    expect(store.ledger).toHaveLength(0);
    expect(store.usage).toHaveLength(0);
  });

  it("401s an unknown mk_ key", async () => {
    await start();
    const res = await post("/v1/chat/completions", chatBody(), miloAuth("mk_nosuchkey"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { message: expect.stringContaining("Unknown or revoked"), type: "authentication_error", code: "invalid_api_key" },
    });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("401s a revoked key", async () => {
    await start();
    const { key, secret } = await seedAccount(5);
    await store.revokeApiKey(key.id);

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(secret));
    expect(res.status).toBe(401);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("403s a suspended account", async () => {
    await start();
    const { account, secret } = await seedAccount(5);
    await store.updateAccount(account.id, { status: "suspended" });

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(secret));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { message: expect.stringContaining("suspended"), type: "invalid_request_error", code: "account_suspended" },
    });
    expect(upstreams.calls).toHaveLength(0);
  });

  it("401s every mk_ key when the deployment has no billing", async () => {
    await start({ withBilling: false });
    const res = await post("/v1/chat/completions", chatBody(), miloAuth("mk_anything"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        message: "Milo keys are not enabled on this deployment.",
        type: "authentication_error",
        code: "milo_keys_disabled",
      },
    });
  });

  it("refuses in the Anthropic envelope on /v1/messages", async () => {
    await start();
    const res = await post("/v1/messages", chatBody(), { "x-api-key": "mk_nosuchkey", ...JSON_TYPE });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: expect.stringContaining("Unknown or revoked") },
    });
  });

  it("mints the account's OpenRouter sub-key on first use and sends that upstream", async () => {
    await start();
    const { account, secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));

    await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    const created = upstreams.provisioningCalls();
    expect(created).toHaveLength(1);
    expect(created[0]?.method).toBe("POST");
    expect(upstreams.inferenceCalls()[0]?.headers.get("authorization")).toBe(`Bearer ${SUB_KEY}`);

    // Stored encrypted, and reused rather than re-minted on the next call.
    const stored = await store.getAccount(account.id);
    expect(stored?.openRouterSubKeyHash).toBe(SUB_KEY_HASH);
    expect(stored?.openRouterSubKeyEnc).toMatch(/^v1[.:]/);
    await post("/v1/chat/completions", chatBody(), miloAuth(secret));
    expect(upstreams.provisioningCalls()).toHaveLength(1);
  });

  it("buckets the rate limiter on the Milo key, so a rotated key starts fresh", async () => {
    await start({ rateLimit: { routedPerMinute: 1 } });
    const { account, secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.000001));

    expect((await post("/v1/chat/completions", chatBody(), miloAuth(secret))).status).toBe(200);
    expect((await post("/v1/chat/completions", chatBody(), miloAuth(secret))).status).toBe(429);

    const rotated = await store.createApiKey(account.id, "second");
    expect((await post("/v1/chat/completions", chatBody(), miloAuth(rotated.secret))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The credit gate
// ---------------------------------------------------------------------------

describe("the credit gate", () => {
  it("402s an account below the reserve without calling anything upstream", async () => {
    await start();
    const { secret } = await seedAccount(0);

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        message: expect.stringContaining("Milo credits exhausted. Add credits at http://localhost/account."),
        type: "insufficient_quota",
        code: "insufficient_credits",
      },
    });
    expect(res.headers.get("x-milo-balance-usd")).toBe("0.000000");
    expect(upstreams.calls).toHaveLength(0);
  });

  it("402s an explicit-model passthrough too", async () => {
    await start();
    const { secret } = await seedAccount(0);

    const res = await post(
      "/v1/chat/completions",
      JSON.stringify({ model: "test/frontier", messages: [{ role: "user", content: "hi" }] }),
      miloAuth(secret),
    );

    expect(res.status).toBe(402);
    expect(upstreams.calls).toHaveLength(0);
  });

  it("402s the Anthropic surface in its own envelope", async () => {
    await start();
    const { secret } = await seedAccount(0);

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": secret, ...JSON_TYPE },
      body: chatBody(),
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "billing_error", message: expect.stringContaining("Milo credits exhausted") },
    });
    expect(res.headers.get("x-milo-balance-usd")).toBe("0.000000");
  });

  it("uses the configured account URL when there is one", async () => {
    const broke = await seedAccount(0);
    await start({ billing: { store, encryptionKey, accountUrl: "https://milo.example/billing" } });

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(broke.secret));
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("https://milo.example/billing");
  });
});

// ---------------------------------------------------------------------------
// Charging
// ---------------------------------------------------------------------------

describe("charging a buffered response", () => {
  it("charges cost + margin + decision fee on the chat dialect", async () => {
    await start();
    const { account, secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    // 0.002 USD is 2,000 micro-USD; +15% is 2,300; +50 for the decision.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-cost-usd")).toBe("0.002350");
    expect(res.headers.get("x-milo-balance-usd")).toBe("4.997650");

    expect(store.ledger.at(-1)).toMatchObject({
      accountId: account.id,
      kind: "usage",
      amountMicroUsd: -2350,
      balanceAfterMicroUsd: 4_997_650,
      reference: res.headers.get("x-milo-decision-id") ?? "",
    });
    expect(store.usage.at(-1)).toMatchObject({
      accountId: account.id,
      decisionId: res.headers.get("x-milo-decision-id"),
      model: "test/frontier",
      inputTokens: 100,
      outputTokens: 20,
      upstreamCostMicroUsd: 2000,
      chargedMicroUsd: 2350,
    });
  });

  it("charges the Responses dialect from usage.cost", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(responsesBody(0.004));

    const res = await post(
      "/v1/responses",
      JSON.stringify({ model: "milo/auto", instructions: "be brief", input: "why is the test flaky?" }),
      miloAuth(secret),
    );

    // 4,000 micro-USD +15% is 4,600; +50 for the decision.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-cost-usd")).toBe("0.004650");
    expect(res.headers.get("x-milo-balance-usd")).toBe("4.995350");
    expect(store.ledger.at(-1)?.amountMicroUsd).toBe(-4650);
  });

  it("charges the Anthropic dialect from usage.cost", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(anthropicBody(0.001));

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": secret, ...JSON_TYPE },
      body: chatBody({ max_tokens: 64 }),
    });

    // 1,000 micro-USD +15% is 1,150; +50 for the decision.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-cost-usd")).toBe("0.001200");
    expect(store.usage.at(-1)).toMatchObject({ inputTokens: 100, outputTokens: 20, upstreamCostMicroUsd: 1000 });
  });

  it("falls back to roster prices when the Anthropic dialect reports no cost", async () => {
    // OpenRouter does not always put `usage.cost` on the Messages surface, so
    // the charge falls back to the shipped roster's per-million prices. That
    // only works for a model the roster knows, so this deployment runs one,
    // and the tier is forced so the model is the one being priced.
    const priced = defaultRosterModel(PRICED_MODEL_ID);
    expect(priced).toBeDefined();

    await start({ roster: { fast: [PRICED_MODEL_ID], mid: [PRICED_MODEL_ID], frontier: [PRICED_MODEL_ID] } });
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(anthropicBody(undefined));

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": secret, ...JSON_TYPE },
      body: chatBody({ max_tokens: 64, milo: { tier: "mid" } }),
    });

    const expectedUpstream = Math.round(100 * (priced?.inputUsdPerM ?? 0) + 20 * (priced?.outputUsdPerM ?? 0));
    const expectedCharge =
      Math.round(expectedUpstream * (1 + DEFAULT_PRICING.margin)) + DEFAULT_PRICING.decisionFeeMicroUsd;

    expect(res.status).toBe(200);
    expect(store.usage.at(-1)?.upstreamCostMicroUsd).toBe(expectedUpstream);
    expect(store.usage.at(-1)?.chargedMicroUsd).toBe(expectedCharge);
    expect(lines.some((l) => l.msg === "no upstream cost reported; estimated from roster prices")).toBe(true);
  });

  it("charges a passthrough without the decision fee", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));

    const res = await post(
      "/v1/chat/completions",
      JSON.stringify({ model: "test/frontier", messages: [{ role: "user", content: "hi" }] }),
      miloAuth(secret),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-cost-usd")).toBe("0.002300");
    expect(store.ledger.at(-1)).toMatchObject({ amountMicroUsd: -2300, reference: "passthrough:gen-abc" });
    expect(store.usage.at(-1)).toMatchObject({ decisionId: null, model: "test/frontier" });
  });

  it("charges nothing when the response reports no usage", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(undefined));

    const res = await post(
      "/v1/chat/completions",
      JSON.stringify({ model: "test/frontier", messages: [{ role: "user", content: "hi" }] }),
      miloAuth(secret),
    );

    expect(res.status).toBe(200);
    expect(store.ledger).toHaveLength(1); // the seed credit only
    expect(lines.some((l) => l.msg === "upstream cost unknown; nothing charged")).toBe(true);
  });
});

describe("charging a streamed response", () => {
  it("passes the bytes through unchanged and charges when the stream ends", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => sse(CHAT_STREAM);

    const res = await post("/v1/chat/completions", chatBody({ stream: true }), miloAuth(secret));
    const decisionId = res.headers.get("x-milo-decision-id");

    // Trailers are not available, so a streamed response carries the balance
    // as it was before the request and a pending cost.
    expect(res.headers.get("x-milo-cost-usd")).toBe("pending");
    expect(res.headers.get("x-milo-balance-usd")).toBe("5.000000");
    expect(await res.text()).toBe(CHAT_STREAM.join(""));

    await waitFor("the streamed charge", () => store.ledger.length > 1);
    expect(store.ledger.at(-1)).toMatchObject({ amountMicroUsd: -2350, reference: decisionId ?? "" });
    expect(store.usage.at(-1)).toMatchObject({ inputTokens: 100, outputTokens: 20, chargedMicroUsd: 2350 });
  });

  it("reads usage off `response.completed` on the Responses dialect", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => sse(RESPONSES_STREAM);

    const res = await post(
      "/v1/responses",
      JSON.stringify({ model: "milo/auto", instructions: "be brief", input: "why is the test flaky?", stream: true }),
      miloAuth(secret),
    );

    expect(await res.text()).toBe(RESPONSES_STREAM.join(""));
    await waitFor("the streamed charge", () => store.ledger.length > 1);
    expect(store.ledger.at(-1)?.amountMicroUsd).toBe(-4650);
  });

  it("reads usage off message_start and message_delta on the Anthropic dialect", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => sse(ANTHROPIC_STREAM);

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": secret, ...JSON_TYPE },
      body: chatBody({ max_tokens: 64, stream: true }),
    });

    expect(await res.text()).toBe(ANTHROPIC_STREAM.join(""));
    await waitFor("the streamed charge", () => store.ledger.length > 1);
    expect(store.usage.at(-1)).toMatchObject({ inputTokens: 100, outputTokens: 20, chargedMicroUsd: 1200 });
  });

  it("charges nothing and warns when a stream ends without usage", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => sse(CHAT_STREAM_NO_USAGE);

    const res = await post("/v1/chat/completions", chatBody({ stream: true }), miloAuth(secret));
    const decisionId = res.headers.get("x-milo-decision-id");
    expect(await res.text()).toBe(CHAT_STREAM_NO_USAGE.join(""));

    await waitFor("the missing-usage warning", () =>
      lines.some((l) => l.msg === "upstream cost unknown; nothing charged"),
    );
    const warning = lines.find((l) => l.msg === "upstream cost unknown; nothing charged");
    expect(warning?.level).toBe("warn");
    expect(warning?.meta?.["decisionId"]).toBe(decisionId);
    expect(store.ledger).toHaveLength(1); // the seed credit only
  });

  it("logs, and never throws, when a stream outran the reserve", async () => {
    await start();
    // $0.06 passes the $0.05 gate; the stream then costs $0.20 + margin,
    // which takes the balance past the -$0.05 floor and the ledger refuses it.
    const { account, secret } = await seedAccount(0.06);
    upstreams.inference = () => sse(chatStreamCosting(0.2));

    const res = await post("/v1/chat/completions", chatBody({ stream: true }), miloAuth(secret));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(chatStreamCosting(0.2).join(""));

    await waitFor("the refused charge", () =>
      lines.some((l) => l.msg === "charge refused: balance below the reserve floor"),
    );
    // The balance did not move, but the request is still on the record.
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(60_000);
    expect(store.usage.at(-1)?.chargedMicroUsd).toBe(230_050);
    expect(lines.some((l) => l.level === "error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-account decisions
// ---------------------------------------------------------------------------

describe("per-account decisions", () => {
  it("shows an account only its own decisions", async () => {
    await start();
    const a = await seedAccount(5, "a@example.com");
    const b = await seedAccount(5, "b@example.com");
    upstreams.inference = () => json(chatCompletion(0.002));

    const first = await post("/v1/chat/completions", chatBody(), miloAuth(a.secret));
    const second = await post("/v1/chat/completions", chatBody({ temperature: 0.2 }), miloAuth(b.secret));
    const idA = first.headers.get("x-milo-decision-id") ?? "";
    const idB = second.headers.get("x-milo-decision-id") ?? "";

    const listA = (await (
      await gateway.app.request("/v1/decisions", { headers: { authorization: `Bearer ${a.secret}` } })
    ).json()) as { data: Array<{ id: string; accountId?: string }> };
    expect(listA.data.map((d) => d.id)).toEqual([idA]);
    expect(listA.data[0]?.accountId).toBe(a.account.id);

    // One account cannot read another's decision by id.
    const cross = await gateway.app.request(`/v1/decisions/${idB}`, {
      headers: { authorization: `Bearer ${a.secret}` },
    });
    expect(cross.status).toBe(404);
    const own = await gateway.app.request(`/v1/decisions/${idA}`, {
      headers: { authorization: `Bearer ${a.secret}` },
    });
    expect(own.status).toBe(200);

    // Stats are scoped the same way.
    const stats = (await (
      await gateway.app.request("/v1/decisions/stats", { headers: { authorization: `Bearer ${b.secret}` } })
    ).json()) as { total: number };
    expect(stats.total).toBe(1);

    // BYOK stays deployment-wide, as it was before Milo keys existed.
    const byok = (await (
      await gateway.app.request("/v1/decisions", { headers: { authorization: `Bearer ${BYOK_KEY}` } })
    ).json()) as { data: unknown[] };
    expect(byok.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The account API
// ---------------------------------------------------------------------------

describe("the account API", () => {
  it("403s a bring-your-own-key caller and points at the account page", async () => {
    await start();
    const res = await gateway.app.request("/v1/account", { headers: { authorization: `Bearer ${BYOK_KEY}` } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: expect.stringContaining("/account"),
        type: "invalid_request_error",
        code: "milo_key_required",
      },
    });
  });

  it("returns the account, its balance, its keys and the pricing", async () => {
    await start();
    const { account, key, secret } = await seedAccount(5);

    const res = await gateway.app.request("/v1/account", { headers: { authorization: `Bearer ${secret}` } });
    const body = (await res.json()) as {
      account: { id: string; email: string; balanceUsd: number };
      balanceUsd: number;
      keys: Array<Record<string, unknown>>;
      pricing: { margin: number };
    };

    expect(res.status).toBe(200);
    expect(body.account).toMatchObject({ id: account.id, email: account.email, balanceUsd: 5 });
    expect(body.balanceUsd).toBe(5);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ id: key.id, name: "default" });
    // A hash is still key material as far as this surface is concerned.
    expect(JSON.stringify(body)).not.toContain(key.keyHash);
    expect(body.pricing.margin).toBe(DEFAULT_PRICING.margin);
  });

  it("mints a key once and revokes one by id", async () => {
    await start();
    const { secret } = await seedAccount(5);

    const created = await post("/v1/account/keys", JSON.stringify({ name: "laptop" }), miloAuth(secret));
    const body = (await created.json()) as { key: { id: string; name: string }; secret: string };
    expect(created.status).toBe(201);
    expect(body.secret).toMatch(/^mk_/);
    expect(body.key.name).toBe("laptop");

    // The minted key works.
    upstreams.inference = () => json(chatCompletion(0.000001));
    expect((await post("/v1/chat/completions", chatBody(), miloAuth(body.secret))).status).toBe(200);

    const revoked = await gateway.app.request(`/v1/account/keys/${body.key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoked.status).toBe(200);
    expect((await post("/v1/chat/completions", chatBody(), miloAuth(body.secret))).status).toBe(401);

    // Another account's key id is not revokable, and reads as absent.
    const other = await seedAccount(5, "other@example.com");
    const cross = await gateway.app.request(`/v1/account/keys/${other.key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(cross.status).toBe(404);
    expect(store.keys.get(other.key.id)?.revokedAt).toBeNull();
  });

  it("returns a usage summary and the recent records", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));
    await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    const res = await gateway.app.request("/v1/account/usage", { headers: { authorization: `Bearer ${secret}` } });
    const body = (await res.json()) as {
      summary: { requests: number; chargedMicroUsd: number; chargedUsd: number };
      records: Array<{ model: string; chargedMicroUsd: number }>;
    };

    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ requests: 1, chargedMicroUsd: 2350, chargedUsd: 0.00235 });
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ model: "test/frontier", chargedMicroUsd: 2350 });

    // `since` narrows both halves.
    const later = await gateway.app.request(`/v1/account/usage?since=${new Date(Date.now() + 60_000).toISOString()}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    const narrowed = (await later.json()) as { summary: { requests: number }; records: unknown[] };
    expect(narrowed.summary.requests).toBe(0);
    expect(narrowed.records).toHaveLength(0);

    // A typo in `since` is a 400, not a database error.
    const bad = await gateway.app.request("/v1/account/usage?since=yesterday", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(bad.status).toBe(400);
  });

  it("returns the ledger newest first", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));
    await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    const res = await gateway.app.request("/v1/account/ledger", { headers: { authorization: `Bearer ${secret}` } });
    const body = (await res.json()) as { data: Array<{ kind: string; amountUsd: number }> };

    expect(res.status).toBe(200);
    expect(body.data.map((e) => e.kind)).toEqual(["usage", "credit_purchase"]);
    expect(body.data[1]?.amountUsd).toBe(5);
  });

  it("starts a Stripe checkout with URLs derived from the request origin", async () => {
    await start();
    const { account, secret } = await seedAccount(0);

    const res = await post("/v1/account/checkout", JSON.stringify({ packId: "pack_20" }), miloAuth(secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(stripeCapture.checkout[0]).toMatchObject({
      client_reference_id: account.id,
      success_url: "http://localhost/account/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost/account",
    });

    const unknown = await post("/v1/account/checkout", JSON.stringify({ packId: "pack_nope" }), miloAuth(secret));
    expect(unknown.status).toBe(400);
  });

  it("opens the customer portal once there is a customer", async () => {
    await start();
    const { account, secret } = await seedAccount(0);

    const before = await post("/v1/account/portal", "{}", miloAuth(secret));
    expect(before.status).toBe(409);

    await store.updateAccount(account.id, { stripeCustomerId: "cus_test" });
    const res = await post("/v1/account/portal", "{}", miloAuth(secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/portal" });
    expect(stripeCapture.portal[0]).toMatchObject({ customer: "cus_test", return_url: "http://localhost/account" });
  });

  it("503s checkout and the portal when Stripe is not configured", async () => {
    await start({ stripe: false });
    const { secret } = await seedAccount(0);

    expect((await post("/v1/account/checkout", JSON.stringify({ packId: "pack_5" }), miloAuth(secret))).status).toBe(503);
    expect((await post("/v1/account/portal", "{}", miloAuth(secret))).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

describe("POST /v1/signup", () => {
  it("creates an account and its first key, and 409s a second attempt", async () => {
    await start();

    const res = await post("/v1/signup", JSON.stringify({ email: "new@example.com" }), JSON_TYPE);
    const body = (await res.json()) as { accountId: string; key: string };

    expect(res.status).toBe(201);
    expect(body.key).toMatch(/^mk_/);
    expect((await store.getAccountByEmail("new@example.com"))?.id).toBe(body.accountId);

    // The key works immediately, on an account with no balance: 402, not 401.
    expect((await post("/v1/chat/completions", chatBody(), miloAuth(body.key))).status).toBe(402);

    const again = await post("/v1/signup", JSON.stringify({ email: "new@example.com" }), JSON_TYPE);
    expect(again.status).toBe(409);
  });

  it("rejects a malformed email", async () => {
    await start();
    const res = await post("/v1/signup", JSON.stringify({ email: "not-an-email" }), JSON_TYPE);
    expect(res.status).toBe(400);
  });

  it("allows five signups an hour from one address and refuses the sixth", async () => {
    await start();
    const headers = { "x-forwarded-for": "203.0.113.7", ...JSON_TYPE };

    for (let i = 0; i < 5; i++) {
      const res = await post("/v1/signup", JSON.stringify({ email: `u${i}@example.com` }), headers);
      expect(res.status).toBe(201);
    }

    const refused = await post("/v1/signup", JSON.stringify({ email: "u5@example.com" }), headers);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    expect(await store.getAccountByEmail("u5@example.com")).toBeUndefined();

    // A different address is unaffected.
    const other = await post("/v1/signup", JSON.stringify({ email: "u6@example.com" }), {
      "x-forwarded-for": "198.51.100.2",
      ...JSON_TYPE,
    });
    expect(other.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The Stripe webhook
// ---------------------------------------------------------------------------

describe("POST /billing/stripe/webhook", () => {
  function creditEvent(accountId: string): string {
    return JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          payment_status: "paid",
          client_reference_id: accountId,
          amount_total: 2_000,
          metadata: { accountId },
        },
      },
    });
  }

  it("400s a bad signature and changes nothing", async () => {
    await start();
    const { account } = await seedAccount(0);

    const res = await gateway.app.request("/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "forged", ...JSON_TYPE },
      body: creditEvent(account.id),
    });

    expect(res.status).toBe(400);
    expect(store.ledger).toHaveLength(0);
  });

  it("credits the account and raises the sub-key limit", async () => {
    await start();
    const { account } = await seedAccount(0);
    await store.updateAccount(account.id, {
      openRouterSubKeyHash: SUB_KEY_HASH,
      openRouterSubKeyEnc: encryptSecret(SUB_KEY, encryptionKey),
    });

    const res = await gateway.app.request("/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "good", ...JSON_TYPE },
      body: creditEvent(account.id),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, handled: true });
    expect((await store.getAccount(account.id))?.balanceMicroUsd).toBe(20_000_000);

    // The sub-key's spend limit now matches the balance (ADR-007).
    const patch = upstreams.provisioningCalls().find((c) => c.method === "PATCH");
    expect(patch?.url.pathname).toBe(`/api/v1/keys/${SUB_KEY_HASH}`);
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ limit: 20 });
  });

  it("answers 200 to an event it does not handle", async () => {
    await start();
    const res = await gateway.app.request("/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "good", ...JSON_TYPE },
      body: JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: {} } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, handled: false, type: "customer.created" });
  });
});

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------

describe("key hygiene", () => {
  it("keeps the Milo key and the sub-key out of logs, decisions and headers", async () => {
    await start();
    const { secret } = await seedAccount(5);
    upstreams.inference = () => json(chatCompletion(0.002));

    const res = await post("/v1/chat/completions", chatBody(), miloAuth(secret));

    upstreams.inference = () => sse(CHAT_STREAM);
    const streamed = await post("/v1/chat/completions", chatBody({ stream: true }), miloAuth(secret));
    await streamed.text();
    await waitFor("both charges", () => store.usage.length >= 2);

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(SUB_KEY);

    for (const response of [res, streamed]) {
      const headers = JSON.stringify([...response.headers.entries()]);
      expect(headers).not.toContain(secret);
      expect(headers).not.toContain(SUB_KEY);
    }

    const decisions = JSON.stringify(await gateway.log.listRecent());
    expect(decisions).not.toContain(secret);
    expect(decisions).not.toContain(SUB_KEY);

    // The ledger and usage rows reference ids, never key material.
    const rows = JSON.stringify({ ledger: store.ledger, usage: store.usage });
    expect(rows).not.toContain(secret);
    expect(rows).not.toContain(SUB_KEY);
  });
});
