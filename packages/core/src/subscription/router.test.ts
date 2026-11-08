import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { heuristicClassify, withHeuristicFallback } from "./classify.js";
import { UsageMeter } from "./meter.js";
import { toPrompt } from "./prompt.js";
import { SubscriptionRouter } from "./router.js";
import { selectBackends } from "./select.js";
import { UsageStore } from "./store.js";
import type {
  BackendOutcome,
  BackendRequest,
  CapacitySnapshot,
  Classification,
  LimitSignal,
  SubscriptionBackend,
  SubscriptionId,
} from "./types.js";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const user = (content: string): ChatMessage[] => [{ role: "user", content }];

function ok(text: string, limits?: LimitSignal): BackendOutcome {
  return {
    ok: true,
    text,
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
    latencyMs: 5,
    ...(limits !== undefined ? { limits } : {}),
  };
}

class FakeBackend implements SubscriptionBackend {
  readonly label: string;
  calls: BackendRequest[] = [];
  constructor(
    readonly id: SubscriptionId,
    private readonly outcomes: BackendOutcome[],
    readonly readLimits?: () => Promise<LimitSignal | undefined>,
  ) {
    this.label = id;
  }
  async run(req: BackendRequest): Promise<BackendOutcome> {
    this.calls.push(req);
    const next = this.outcomes.shift() ?? ok(`${this.id} answer`);
    if (next.ok) req.onText?.(next.text);
    return next;
  }
}

function limits(usedPercent: number, status: LimitSignal["status"] = "allowed", resetsAt = "2026-11-09T00:00:00.000Z"): LimitSignal {
  return { observedAt: new Date(NOW).toISOString(), status, windows: [{ name: "weekly", usedPercent, resetsAt }] };
}

const snap = (backend: SubscriptionId, extra: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({
  backend,
  limited: false,
  source: "unknown",
  ...extra,
});
const cls = (taskType: Classification["taskType"]): Classification => ({ taskType, difficulty: 1, source: "heuristic" });

describe("selectBackends", () => {
  const both: SubscriptionId[] = ["codex", "claude"];

  it("follows the task preference when capacity does not say otherwise", () => {
    expect(selectBackends(cls("debug"), [snap("codex"), snap("claude")], both).order).toEqual(["codex", "claude"]);
    expect(selectBackends(cls("chat"), [snap("codex"), snap("claude")], both).order).toEqual(["claude", "codex"]);
  });

  it("moves work off a subscription below its reserve", () => {
    const capacity = [snap("codex", { remainingPercent: 60, source: "cli" }), snap("claude", { remainingPercent: 5, source: "cli" })];
    const selection = selectBackends(cls("chat"), capacity, both);
    expect(selection.order).toEqual(["codex", "claude"]);
    expect(selection.reason).toContain("below its 10% reserve");
  });

  it("moves work to the subscription with far more left", () => {
    const capacity = [snap("codex", { remainingPercent: 98, source: "cli" }), snap("claude", { remainingPercent: 40, source: "cli" })];
    expect(selectBackends(cls("docs"), capacity, both).order).toEqual(["codex", "claude"]);
    // Within the margin, the task preference stands.
    const close = [snap("codex", { remainingPercent: 60, source: "cli" }), snap("claude", { remainingPercent: 40, source: "cli" })];
    expect(selectBackends(cls("docs"), close, both).order).toEqual(["claude", "codex"]);
  });

  it("puts a rate-limited subscription last, and still tries it when everything is limited", () => {
    const capacity = [snap("codex", { limited: true, limitedUntil: "2026-11-08T13:00:00Z" }), snap("claude")];
    const selection = selectBackends(cls("debug"), capacity, both);
    expect(selection.order).toEqual(["claude", "codex"]);
    expect(selection.reason).toContain("codex is rate-limited");

    const allLimited = [
      snap("codex", { limited: true, limitedUntil: "2026-11-08T15:00:00Z" }),
      snap("claude", { limited: true, limitedUntil: "2026-11-08T13:00:00Z" }),
    ];
    expect(selectBackends(cls("debug"), allLimited, both).order).toEqual(["claude", "codex"]);
  });

  it("only orders the backends that are enabled", () => {
    expect(selectBackends(cls("debug"), [snap("codex"), snap("claude")], ["claude"]).order).toEqual(["claude"]);
  });
});

describe("UsageMeter", () => {
  it("says unknown until a CLI reports, then reports the fullest window", async () => {
    const meter = new UsageMeter({ now: () => NOW });
    expect(meter.snapshot("claude")).toEqual({ backend: "claude", limited: false, source: "unknown" });

    await meter.observe("claude", {
      observedAt: "x",
      status: "warning",
      windows: [
        { name: "five_hour", usedPercent: 20, resetsAt: "2026-11-08T14:00:00Z" },
        { name: "seven_day", usedPercent: 99, resetsAt: "2026-11-09T00:00:00Z" },
      ],
    });
    expect(meter.snapshot("claude")).toMatchObject({
      usedPercent: 99,
      remainingPercent: 1,
      window: "seven_day",
      resetsAt: "2026-11-09T00:00:00Z",
      source: "cli",
      limited: false,
    });
  });

  it("treats a window whose reset has passed as empty", async () => {
    const meter = new UsageMeter({ now: () => NOW });
    await meter.observe("codex", limits(95, "warning", "2026-11-08T11:00:00Z"));
    expect(meter.snapshot("codex")).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
  });

  it("is estimated, and limited for the cooldown, after a rate-limit error with no reset time", async () => {
    let now = NOW;
    const meter = new UsageMeter({ now: () => now, cooldownMs: 60_000 });
    await meter.recordOutcome("codex", { ok: false, error: "rate_limited", message: "limit", latencyMs: 1 });
    expect(meter.snapshot("codex")).toMatchObject({ limited: true, source: "estimated", limitedUntil: new Date(NOW + 60_000).toISOString() });
    now += 61_000;
    expect(meter.snapshot("codex")).toMatchObject({ limited: false, source: "estimated" });
  });

  it("is limited until the reported reset after a refusal", async () => {
    const meter = new UsageMeter({ now: () => NOW });
    await meter.recordOutcome("claude", {
      ok: false,
      error: "rate_limited",
      message: "limit",
      latencyMs: 1,
      limits: limits(100, "limited", "2026-11-09T00:00:00.000Z"),
    });
    expect(meter.snapshot("claude")).toMatchObject({ limited: true, limitedUntil: "2026-11-09T00:00:00.000Z", remainingPercent: 0 });
  });

  it("persists readings and cooldowns in the SQLite log and restores them", async () => {
    const store = await UsageStore.open(":memory:");
    const first = new UsageMeter({ store, now: () => NOW });
    await first.observe("codex", limits(40));
    await store.recordCall({
      id: "c1",
      decisionId: "d1",
      backend: "claude",
      createdAt: new Date(NOW - 1_000).toISOString(),
      ok: false,
      error: "rate_limited",
      latencyMs: 3,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });

    const second = new UsageMeter({ store, now: () => NOW });
    await second.load();
    expect(second.snapshot("codex")).toMatchObject({ usedPercent: 40, source: "cli" });
    expect(second.snapshot("claude")).toMatchObject({ limited: true });
    store.close();
  });
});

describe("SubscriptionRouter", () => {
  async function setup(codexOutcomes: BackendOutcome[], claudeOutcomes: BackendOutcome[]) {
    const store = await UsageStore.open(":memory:");
    const meter = new UsageMeter({ store, now: () => NOW });
    const codex = new FakeBackend("codex", codexOutcomes, async () => limits(2));
    const claude = new FakeBackend("claude", claudeOutcomes);
    let n = 0;
    const router = new SubscriptionRouter({
      backends: [codex, claude],
      meter,
      store,
      now: () => NOW,
      newId: () => `id${++n}`,
    });
    return { store, meter, codex, claude, router };
  }

  it("routes by task type and records the call", async () => {
    const { router, store, claude } = await setup([], []);
    const result = await router.complete({ messages: user("hey, what's up") });

    expect(result.served).toBe("claude");
    expect(result.decision.classification).toMatchObject({ taskType: "chat", source: "heuristic" });
    expect(claude.calls[0]?.prompt).toBe("hey, what's up");
    const totals = await store.totals(new Date(NOW - 1000).toISOString());
    expect(totals).toEqual([expect.objectContaining({ backend: "claude", calls: 1, failures: 0, inputTokens: 10 })]);
  });

  it("fails over to the other subscription when the first is rate-limited, and remembers it", async () => {
    const refusal: BackendOutcome = { ok: false, error: "rate_limited", message: "usage limit", latencyMs: 2, limits: limits(100, "limited") };
    const { router, codex, claude } = await setup([], [refusal]);

    const first = await router.complete({ messages: user("hey, what's up") });
    expect(first.served).toBe("codex");
    expect(first.attempts.map((a) => a.backend)).toEqual(["claude", "codex"]);
    expect(codex.calls).toHaveLength(1);

    // The next chat task goes straight to codex: claude is limited until its reset.
    const second = await router.complete({ messages: user("tell me a joke") });
    expect(second.decision.order).toEqual(["codex", "claude"]);
    expect(second.decision.reason).toContain("claude is rate-limited");
    expect(claude.calls).toHaveLength(1);
  });

  it("does not fail over when the request forced a backend", async () => {
    const refusal: BackendOutcome = { ok: false, error: "rate_limited", message: "usage limit", latencyMs: 2 };
    const { router, codex } = await setup([], [refusal]);
    const result = await router.complete({ messages: user("hi"), force: "claude", model: "opus" });
    expect(result.served).toBeUndefined();
    expect(result.outcome).toMatchObject({ ok: false, error: "rate_limited" });
    expect(codex.calls).toHaveLength(0);
  });

  it("passes a model override only to a forced backend", async () => {
    const { router, claude } = await setup([], []);
    await router.complete({ messages: user("hi"), force: "claude", model: "opus" });
    expect(claude.calls[0]?.model).toBe("opus");
  });

  it("does not fail over on timeout or abort", async () => {
    const { router, claude } = await setup([{ ok: false, error: "timeout", message: "slow", latencyMs: 9 }], []);
    const result = await router.complete({ messages: user("fix this crash: TypeError in foo()") });
    expect(result.attempts).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
  });

  it("reads limits from CLIs that report them and routes on them", async () => {
    const { router } = await setup([], []);
    await router.refreshLimits(0);
    expect(router.capacity().find((s) => s.backend === "codex")).toMatchObject({ remainingPercent: 98, source: "cli" });
  });
});

describe("classification", () => {
  it("falls back to the heuristic when Jev fails", async () => {
    const errors: unknown[] = [];
    const classify = withHeuristicFallback(async () => {
      throw new Error("jev down");
    }, (e) => errors.push(e));
    expect(await classify(user("Refactor this function to use async/await"))).toMatchObject({ taskType: "edit", source: "heuristic" });
    expect(errors).toHaveLength(1);
  });

  it("agrees with most of the labeled routing set's task types", () => {
    const url = new URL("../../../evals/data/routing.jsonl", import.meta.url);
    const rows = readFileSync(url, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { messages: ChatMessage[]; task_type: string });
    const agree = rows.filter((r) => heuristicClassify(r.messages).taskType === r.task_type).length;
    // The rules were written against this set, so this is a floor against
    // regressions, not an accuracy claim.
    expect(agree / rows.length).toBeGreaterThanOrEqual(0.7);
  });

  it("flattens a multi-turn conversation into one prompt and keeps system text separate", () => {
    expect(
      toPrompt([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: [{ type: "text", text: "Again?" }] },
      ]),
    ).toEqual({
      system: "Be brief.",
      prompt:
        "Continue this conversation. Reply only with the assistant's next message, without a label.\n\nUser:\nHi\n\nAssistant:\nHello\n\nUser:\nAgain?",
    });
  });
});
