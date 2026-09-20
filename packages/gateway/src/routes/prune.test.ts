/**
 * Context pruning at the gateway (ADR-014): `maybePrune` fires and skips on
 * the right conditions (token floor, posture, deployment/opt-in flags, a Jev
 * client), never mangles a tool-call/result pair when it edits the body, and
 * -- driven end to end through the routed chat surface -- discloses what it
 * shed in the `x-milo-pruned*` headers and the decision record's `prune`
 * block, with no content anywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DecisionLog, OpenRouterClient } from "@milo/core";
import type {
  ChatMessage,
  DecisionRecord,
  JevClientLike,
  RouteDecision,
  Router,
  SystemOneResult,
} from "@milo/core";
import { AnthropicUpstream } from "../anthropic.js";
import { createApp } from "../app.js";
import type { AppDeps } from "../app.js";
import { RateLimiter } from "../rate-limit.js";
import { maybePrune } from "./prune.js";

// ---------------------------------------------------------------------------
// Jev double: answers the two pruning questions from a fixed verdict.
// ---------------------------------------------------------------------------

function pruneJev(
  opts: { finishedSafe?: number; prunable?: number; fail?: boolean } = {},
): JevClientLike & { calls: number } {
  const stub = {
    calls: 0,
    systemone: (req: { questions: Record<string, unknown> }): Promise<SystemOneResult> => {
      if ("oldest_finished" in req.questions) {
        stub.calls += 1;
        if (opts.fail === true) return Promise.reject(new Error("jev down"));
        const finishedSafe = opts.finishedSafe ?? 0.95;
        const prunable = opts.prunable ?? 3;
        return Promise.resolve({
          model: "jev-latest",
          answers: {
            oldest_finished: { type: "noul", noul: finishedSafe },
            prunable: { type: "score", score: Math.round(prunable), confidence: 0.8, probabilities: { [String(Math.round(prunable))]: 1 } },
          },
          usage: { input_tokens: 500, output_tokens: 4 },
          requestId: "req_prune",
          latencyMs: 20,
        });
      }
      // Any other question set (e.g. preference capture): a benign no-op.
      return Promise.resolve({
        model: "jev-latest",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "req_other",
        latencyMs: 1,
      });
    },
  };
  return stub;
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A deps stub carrying only what `maybePrune` reads. */
function pruneDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    jev: pruneJev(),
    pruning: { enabled: true },
    logger: silentLogger,
    ...over,
  } as unknown as AppDeps;
}

const big = (n: number): string => "lorem ipsum dolor sit amet ".repeat(n);

/** A conversation whose text is well over the 40k-token (160k-char) floor. */
function longHistory(): ChatMessage[] {
  return [
    { role: "system", content: big(1200) },
    { role: "user", content: big(1200) },
    { role: "assistant", content: big(1200) },
    { role: "user", content: big(1200) },
    { role: "assistant", content: big(1200) },
    { role: "user", content: "and now, the current request" },
  ];
}

const decisionModel = "test/mid";
function bodyOf(messages: ChatMessage[]): Record<string, unknown> {
  return { model: "milo/auto", messages };
}

// ---------------------------------------------------------------------------
// Fires / skips
// ---------------------------------------------------------------------------

describe("maybePrune fires and skips", () => {
  const decision = { id: "d1", model: decisionModel } as unknown as RouteDecision;

  it("prunes a long history when enabled, over the floor, and not low posture", async () => {
    const body = bodyOf(longHistory());
    const before = (body["messages"] as ChatMessage[]).length;
    const outcome = await maybePrune(pruneDeps(), body, decision, "balanced", undefined);
    expect(outcome).toBeDefined();
    expect(outcome?.pruned).toBeGreaterThan(0);
    expect(outcome?.tokensSaved).toBeGreaterThan(0);
    // The body was edited: the dropped range became one summary note.
    const after = body["messages"] as ChatMessage[];
    expect(after.length).toBeLessThan(before);
    expect(after.some((m) => m.role === "system" && String(m.content).includes("pruned by Milo"))).toBe(true);
  });

  it("skips a history under the token floor", async () => {
    const short: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "old" },
      { role: "assistant", content: "a" },
      { role: "user", content: "now" },
    ];
    const body = bodyOf(short);
    const outcome = await maybePrune(pruneDeps(), body, decision, "balanced", undefined);
    expect(outcome).toBeUndefined();
    expect((body["messages"] as ChatMessage[]).length).toBe(4);
  });

  it("never fires on low posture", async () => {
    const body = bodyOf(longHistory());
    expect(await maybePrune(pruneDeps(), body, decision, "low", undefined)).toBeUndefined();
  });

  it("is off by default and on when the deployment enables it", async () => {
    const off = bodyOf(longHistory());
    expect(await maybePrune(pruneDeps({ pruning: { enabled: false } }), off, decision, "balanced", undefined)).toBeUndefined();
    const on = bodyOf(longHistory());
    expect(await maybePrune(pruneDeps({ pruning: { enabled: true } }), on, decision, "balanced", undefined)).toBeDefined();
  });

  it("honours the per-request opt-in and opt-out, with false always winning", async () => {
    // Opt in even though the deployment default is off.
    const inBody = bodyOf(longHistory());
    expect(
      await maybePrune(pruneDeps({ pruning: { enabled: false } }), inBody, decision, "balanced", { prune: true }),
    ).toBeDefined();
    // Opt out even though the deployment default is on.
    const outBody = bodyOf(longHistory());
    expect(
      await maybePrune(pruneDeps({ pruning: { enabled: true } }), outBody, decision, "balanced", { prune: false }),
    ).toBeUndefined();
  });

  it("does nothing without a Jev client to ask", async () => {
    const body = bodyOf(longHistory());
    expect(await maybePrune(pruneDeps({ jev: undefined }), body, decision, "balanced", undefined)).toBeUndefined();
  });

  it("forwards unpruned when the Jev check fails", async () => {
    const body = bodyOf(longHistory());
    const before = (body["messages"] as ChatMessage[]).length;
    const outcome = await maybePrune(pruneDeps({ jev: pruneJev({ fail: true }) }), body, decision, "balanced", undefined);
    expect(outcome).toBeUndefined();
    expect((body["messages"] as ChatMessage[]).length).toBe(before);
  });

  it("does not prune when Jev judges the older context load-bearing", async () => {
    const body = bodyOf(longHistory());
    const outcome = await maybePrune(pruneDeps({ jev: pruneJev({ prunable: 0.2 }) }), body, decision, "balanced", undefined);
    expect(outcome).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-pair safety
// ---------------------------------------------------------------------------

describe("maybePrune never mangles a tool-call/result pair", () => {
  const decision = { id: "d2", model: decisionModel } as unknown as RouteDecision;

  it("keeps an in-window tool group intact when the range lands mid-group", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: big(2000) },
      { role: "user", content: big(2000) },
      { role: "assistant", content: null, tool_calls: [{ id: "t1" }] },
      { role: "tool", content: big(2000), tool_call_id: "t1" },
      { role: "assistant", content: big(2000) },
      { role: "user", content: "current request" },
    ];
    const body = bodyOf(messages);
    // prunable ~1.5 targets the middle of the tool group; it must snap to a
    // group boundary rather than split the pair.
    const outcome = await maybePrune(pruneDeps({ jev: pruneJev({ prunable: 1.5 }) }), body, decision, "balanced", undefined);
    expect(outcome).toBeDefined();
    const after = body["messages"] as ChatMessage[];
    // Every surviving tool result is still immediately preceded by an
    // assistant message bearing tool_calls: no pair was split.
    for (let i = 0; i < after.length; i += 1) {
      if (after[i]?.role === "tool") {
        const prev = after[i - 1];
        expect(prev).toBeDefined();
        expect(prev?.role).toBe("assistant");
        expect(Array.isArray(prev?.tool_calls) && (prev?.tool_calls as unknown[]).length > 0).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: disclosure headers and the decision record
// ---------------------------------------------------------------------------

type Upstream = NonNullable<DecisionRecord["upstream"]>;
type Call = { url: URL; body: Record<string, unknown> };

class FakeOpenRouter {
  readonly calls: Call[] = [];
  handler: (body: Record<string, unknown>) => Response = () =>
    new Response(
      JSON.stringify({
        id: "gen-1",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "test/mid",
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.0001 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "or-1" } },
    );

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.calls.push({ url: new URL(href), body });
    return this.handler(body);
  }) as typeof fetch;
}

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

/** A band-0 decision so the completeness gate stays out of the way. */
function band0(): RouteDecision {
  return {
    id: "01PRUNEDECISION0000000000",
    fingerprint: "fp-prune",
    signals: {
      taskType: "chat",
      difficulty: 0.1,
      difficultyLevels: [0.9, 0.1, 0, 0],
      needsReasoning: 0.1,
      longOutput: 0.1,
      confidences: { task_type: 0.9, difficulty: 0.8 },
      jevRequestId: "req_route",
      jevModel: "jev-latest",
      latencyMs: 40,
    },
    tier: "mid",
    model: decisionModel,
    reason: "chat task, routed to mid",
    policyVersion: "v4",
    sticky: false,
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("pruning disclosure through the routed chat surface", () => {
  let openRouter: FakeOpenRouter;
  let logs: DecisionLog[];
  let recorded: Array<{ id: string; upstream: Upstream }>;

  beforeEach(() => {
    openRouter = new FakeOpenRouter();
    logs = [];
    recorded = [];
  });

  afterEach(async () => {
    for (const log of logs) await log.close();
  });

  async function app(): Promise<Hono> {
    const log = await DecisionLog.open(":memory:");
    logs.push(log);
    const fixed = band0();
    await log.insert(fixed);
    const deps: AppDeps = {
      router: { route: async () => fixed } as unknown as Router,
      roster: { fast: ["test/fast"], mid: [decisionModel], frontier: ["test/frontier"] },
      openRouter: new OpenRouterClient({ fetch: openRouter.fetch }),
      anthropic: new AnthropicUpstream({ fetch: openRouter.fetch }),
      log,
      jev: pruneJev(),
      pruning: { enabled: true },
      rateLimiter: new RateLimiter(),
      logger: silentLogger,
      now: Date.now,
      recordUpstream: (id, upstream) => {
        recorded.push({ id, upstream });
        void log.setUpstream(id, upstream);
      },
    };
    return createApp(deps);
  }

  it("sets x-milo-pruned headers, records a content-free prune block, and forwards the pruned body", async () => {
    const a = await app();
    const res = await a.fetch(
      new Request("http://milo.test/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(bodyOf(longHistory())),
      }),
    );
    expect(res.status).toBe(200);
    const pruned = Number(res.headers.get("x-milo-pruned"));
    expect(pruned).toBeGreaterThan(0);
    expect(Number(res.headers.get("x-milo-pruned-tokens"))).toBeGreaterThan(0);

    // The forwarded body carries the summary note and fewer messages.
    const forwarded = openRouter.calls[0]?.body["messages"] as ChatMessage[];
    expect(forwarded.some((m) => m.role === "system" && String(m.content).includes("pruned by Milo"))).toBe(true);
    expect(forwarded).not.toHaveProperty("milo");

    // The record's prune block is counts only, no content.
    const block = recorded[0]?.upstream.prune;
    expect(block?.pruned).toBe(pruned);
    expect(block?.tokensSaved).toBeGreaterThan(0);
    expect(typeof block?.from).toBe("number");
    expect(typeof block?.to).toBe("number");
    const serialized = JSON.stringify(recorded[0]?.upstream);
    expect(serialized).not.toContain("lorem ipsum");
  });

  it("does not disclose pruning when the request opts out", async () => {
    const a = await app();
    const res = await a.fetch(
      new Request("http://milo.test/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ ...bodyOf(longHistory()), milo: { prune: false } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-pruned")).toBeNull();
    expect(recorded[0]?.upstream.prune).toBeUndefined();
  });
});
