import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { SubscriptionRouter, UsageMeter, UsageStore } from "@milo/core";
import type { BackendOutcome, BackendRequest, LimitSignal, SubscriptionBackend, SubscriptionId } from "@milo/core";
import { writeFakeClis } from "../../core/src/subscription/test-support.js";
import type { FakeClis } from "../../core/src/subscription/test-support.js";
import { createApp, parseModel } from "./app.js";
import type { Logger } from "./app.js";
import { createGateway } from "./index.js";
import { startServer } from "./server.js";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

class FakeBackend implements SubscriptionBackend {
  readonly label: string;
  calls: BackendRequest[] = [];
  constructor(
    readonly id: SubscriptionId,
    private readonly outcomes: BackendOutcome[] = [],
  ) {
    this.label = `${id} label`;
  }
  async run(req: BackendRequest): Promise<BackendOutcome> {
    this.calls.push(req);
    const next = this.outcomes.shift() ?? {
      ok: true as const,
      text: `answer from ${this.id}`,
      model: `${this.id}-model`,
      usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 3, apiEquivalentUsd: 0.01 },
      latencyMs: 4,
    };
    if (next.ok) {
      for (const word of next.text.split(" ")) req.onText?.(`${word} `);
    }
    return next;
  }
}

const limited: BackendOutcome = {
  ok: false,
  error: "rate_limited",
  message: "usage limit reached",
  latencyMs: 2,
  limits: { observedAt: "x", status: "limited", windows: [{ name: "weekly", usedPercent: 100, resetsAt: "2026-11-09T00:00:00Z" }] },
};

async function setup(codexOutcomes: BackendOutcome[] = [], claudeOutcomes: BackendOutcome[] = []) {
  const store = await UsageStore.open(":memory:");
  const meter = new UsageMeter({ store, now: () => NOW });
  const codex = new FakeBackend("codex", codexOutcomes);
  const claude = new FakeBackend("claude", claudeOutcomes);
  const router = new SubscriptionRouter({ backends: [codex, claude], meter, store, now: () => NOW });
  const app = createApp({ router, labels: { codex: "ChatGPT (codex)", claude: "Claude (claude)" }, store, logger: silent, now: () => NOW });
  const post = (body: unknown) =>
    app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, codex, claude, store, meter };
}

describe("parseModel", () => {
  it("maps model ids to routing targets", () => {
    expect(parseModel("milo/auto")).toEqual({});
    expect(parseModel("milo/codex")).toEqual({ force: "codex" });
    expect(parseModel("claude")).toEqual({ force: "claude" });
    expect(parseModel("claude/opus")).toEqual({ force: "claude", model: "opus" });
    expect(parseModel("codex/gpt-5.5-codex")).toEqual({ force: "codex", model: "gpt-5.5-codex" });
    expect(parseModel("gpt-4o")).toBeUndefined();
  });
});

describe("POST /v1/chat/completions", () => {
  it("answers milo/auto with no API key and explains the choice in x-milo-* headers", async () => {
    const { post, claude } = await setup();
    const res = await post({ model: "milo/auto", messages: [{ role: "user", content: "hey, what's up" }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: unknown };
    expect(body.choices[0]?.message.content).toBe("answer from claude");
    expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    expect(res.headers.get("x-milo-backend")).toBe("claude");
    expect(res.headers.get("x-milo-model")).toBe("claude-model");
    expect(res.headers.get("x-milo-task-type")).toBe("chat");
    expect(res.headers.get("x-milo-classifier")).toBe("heuristic");
    expect(res.headers.get("x-milo-reason")).toContain("chat task prefers claude");
    expect(res.headers.get("x-milo-capacity")).toContain("codex=unknown");
    expect(res.headers.get("x-milo-decision-id")).toBeTruthy();
    expect(res.headers.get("x-milo-failover")).toBeNull();
    expect(claude.calls[0]?.prompt).toBe("hey, what's up");
  });

  it("serves from the other subscription when one is rate-limited, and says so", async () => {
    const { post, codex } = await setup([], [limited]);
    const res = await post({ model: "milo/auto", messages: [{ role: "user", content: "hey, what's up" }] });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-backend")).toBe("codex");
    expect(res.headers.get("x-milo-failover")).toBe("claude:rate_limited");
    expect(codex.calls).toHaveLength(1);
  });

  it("answers 429 when every subscription is rate-limited", async () => {
    const { post } = await setup([limited], [{ ...limited }]);
    const res = await post({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("subscriptions_exhausted");
    expect(res.headers.get("x-milo-failover")).toBe("claude:rate_limited, codex:rate_limited");
  });

  it("forces a backend and model with claude/<model>", async () => {
    const { post, claude, codex } = await setup();
    const res = await post({ model: "claude/opus", messages: [{ role: "user", content: "fix this crash" }] });
    expect(res.headers.get("x-milo-backend")).toBe("claude");
    expect(claude.calls[0]?.model).toBe("opus");
    expect(codex.calls).toHaveLength(0);
  });

  it("refuses unknown models, tools, n > 1 and malformed messages", async () => {
    const { post } = await setup();
    const codes = async (body: unknown) => {
      const res = await post(body);
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    };
    expect(await codes({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] })).toEqual([400, "model_not_found"]);
    expect(await codes({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function" }] })).toEqual([400, "tools_unsupported"]);
    expect(await codes({ messages: [{ role: "user", content: "x" }], n: 2 })).toEqual([400, "n_unsupported"]);
    expect(await codes({ messages: [] })).toEqual([400, "invalid_messages"]);
  });

  it("streams OpenAI chunks, ending with usage and [DONE]", async () => {
    const { post } = await setup();
    const res = await post({
      model: "milo/auto",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hey there" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-milo-backend")).toBe("claude");
    const events = (await res.text())
      .split("\n\n")
      .filter((e) => e.startsWith("data: "))
      .map((e) => e.slice("data: ".length));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }>; usage?: unknown });
    const text = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("");
    expect(text).toBe("answer from claude ");
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
  });

  it("reports a failover that happened before the stream started", async () => {
    const { post } = await setup([], [limited]);
    const res = await post({ stream: true, messages: [{ role: "user", content: "hey there" }] });
    expect(res.headers.get("x-milo-backend")).toBe("codex");
    expect(res.headers.get("x-milo-failover")).toBe("claude:rate_limited");
    expect(await res.text()).toContain('"content":"codex "');
  });

  it("answers a stream that no subscription can serve with a JSON error, not an empty stream", async () => {
    const { post } = await setup([limited], [{ ...limited }]);
    const res = await post({ stream: true, messages: [{ role: "user", content: "hey there" }] });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /v1/usage and /v1/models", () => {
  it("reports each subscription's capacity and Milo's own calls", async () => {
    const { app, post, meter } = await setup();
    await meter.observe("codex", {
      observedAt: "2026-11-08T11:59:00Z",
      status: "allowed",
      windows: [{ name: "weekly", usedPercent: 2, resetsAt: "2026-11-14T00:00:00Z" }],
    } satisfies LimitSignal);
    await post({ messages: [{ role: "user", content: "hey there" }] });

    const res = await app.request("/v1/usage");
    const body = (await res.json()) as {
      subscriptions: Array<{ backend: string; label: string; capacity: Record<string, unknown>; last24h: Record<string, unknown> | null }>;
    };
    const codex = body.subscriptions.find((s) => s.backend === "codex");
    const claude = body.subscriptions.find((s) => s.backend === "claude");
    expect(codex).toMatchObject({ label: "ChatGPT (codex)", capacity: { usedPercent: 2, remainingPercent: 98, source: "cli" }, last24h: null });
    expect(claude).toMatchObject({ capacity: { source: "estimated" }, last24h: { calls: 1, outputTokens: 3, apiEquivalentUsd: 0.01 } });
  });

  it("lists the routed and per-subscription model ids", async () => {
    const { app } = await setup();
    const body = (await (await app.request("/v1/models")).json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["milo/auto", "milo/codex", "milo/claude"]);
  });
});

describe("createGateway with the real CLI backends (fake binaries) and the OpenAI SDK", () => {
  let fakes: FakeClis;
  beforeEach(() => {
    fakes = writeFakeClis();
  });
  afterEach(() => {
    rmSync(fakes.dir, { recursive: true, force: true });
  });

  it("spawns codex and claude for real requests through an OpenAI client", async () => {
    const gateway = await createGateway({
      decisionLogUrl: ":memory:",
      workdir: fakes.dir,
      backends: { codex: { binary: fakes.codex }, claude: { binary: fakes.claude } },
      env: { PATH: process.env.PATH, FAKE_LOG: fakes.log },
      logger: silent,
    });
    const server = await startServer(gateway, { port: 0, hostname: "127.0.0.1" });
    try {
      const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "unused" });

      const chat = await client.chat.completions.create({ model: "milo/auto", messages: [{ role: "user", content: "hey, what's up" }] });
      expect(chat.choices[0]?.message.content).toBe("pong from claude");

      const code = await client.chat.completions
        .create({ model: "milo/auto", messages: [{ role: "user", content: "This throws TypeError: x is undefined" }] })
        .withResponse();
      expect(code.data.choices[0]?.message.content).toBe("pong from codex");
      expect(code.response.headers.get("x-milo-backend")).toBe("codex");

      const usage = (await (await fetch(`http://127.0.0.1:${server.port}/v1/usage`)).json()) as {
        subscriptions: Array<{ backend: string; capacity: { usedPercent?: number } }>;
      };
      // codex reported its limits through app-server; claude through its answer stream.
      expect(usage.subscriptions.find((s) => s.backend === "codex")?.capacity.usedPercent).toBe(37);
      expect(usage.subscriptions.find((s) => s.backend === "claude")?.capacity.usedPercent).toBe(83);
    } finally {
      await server.close();
      await gateway.close();
    }
  });
});
