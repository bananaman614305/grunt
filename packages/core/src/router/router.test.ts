import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest, Roster, Tier } from "../types.js";
import { POLICY_VERSION, ROUTER_LIMITS } from "../types.js";
import { fingerprint } from "./fingerprint.js";
import { classifyFailure, degradedDecision, Router } from "./router.js";
import { StickyCache } from "./sticky.js";

// A key-shaped string that must never surface in a reason or a decision.
const FAKE_KEY = "sk-live-NEVERLEAKTHIS0123456789";

const ROSTER: Roster = {
  fast: ["fast-model"],
  mid: ["mid-model"],
  frontier: ["frontier-model"],
};

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent in an engineering crew." },
  { role: "user", content: "Rename res to rows in listRecent." },
];

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    messages: MESSAGES,
    posture: "balanced",
    fingerprint: fingerprint(MESSAGES),
    ...overrides,
  };
}

type Fixture = {
  source: string;
  prompt: string;
  expectedTier: Record<CostPosture, Tier>;
  requestId: string;
  model: string;
  answers: SystemOneResult["answers"];
  usage: SystemOneResult["usage"];
};

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

type StubJev = JevClientLike & { calls: Array<Omit<SystemOneRequest, "model"> & { model?: string }> };

function stubJev(answers: SystemOneResult["answers"], extra: Partial<SystemOneResult> = {}): StubJev {
  const calls: StubJev["calls"] = [];
  return {
    calls,
    systemone: (req) => {
      calls.push(req);
      return Promise.resolve({
        model: "jev-latest",
        answers,
        usage: { input_tokens: 1200, output_tokens: 24 },
        requestId: "req_stub",
        latencyMs: 64,
        ...extra,
      });
    },
  };
}

function failingJev(error: unknown): JevClientLike {
  return { systemone: () => Promise.reject(error) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Router.route: forced tier", () => {
  it("skips Jev, reports no signals, and is not degraded", async () => {
    const jev = stubJev({});
    const decisions: RouteDecision[] = [];
    const router = new Router({ jev, roster: ROSTER, onDecision: (d) => decisions.push(d) });

    const decision = await router.route(request({ forcedTier: "frontier" }));

    expect(jev.calls).toHaveLength(0);
    expect(decision.tier).toBe("frontier");
    expect(decision.model).toBe("frontier-model");
    expect(decision.reason).toContain("forced");
    expect(decision.degraded).toBe(false);
    expect(decision.sticky).toBe(false);
    expect(decision.signals).toBeUndefined();
    expect(decision.policyVersion).toBe(POLICY_VERSION);
    expect(decision.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(decisions).toEqual([decision]);
  });

  it("honours candidates while forced", async () => {
    const router = new Router({ jev: stubJev({}), roster: ROSTER });
    const decision = await router.route(request({ forcedTier: "fast", candidates: ["mid-model"] }));
    expect(decision.model).toBe("mid-model");
  });

  it("does not pin a forced decision to the fingerprint", async () => {
    const sticky = new StickyCache();
    const router = new Router({ jev: stubJev({}), roster: ROSTER, sticky });
    await router.route(request({ forcedTier: "fast" }));
    expect(sticky.size).toBe(0);
  });
});

describe("Router.route: stickiness", () => {
  const fixture = loadFixture("trivial-rename");

  it("calls Jev once per fingerprint and reuses the decision", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });
    const req = request();

    const first = await router.route(req);
    const second = await router.route(req);

    expect(jev.calls).toHaveLength(1);
    expect(first.sticky).toBe(false);
    expect(second.sticky).toBe(true);
    expect(second.model).toBe(first.model);
    expect(second.tier).toBe(first.tier);
    expect(second.signals).toEqual(first.signals);
  });

  it("gives the sticky hit a fresh id and timestamp", async () => {
    let now = 1_700_000_000_000;
    const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER, clock: () => now });
    const req = request();

    const first = await router.route(req);
    now += 60_000;
    const second = await router.route(req);

    expect(second.id).not.toBe(first.id);
    expect(second.createdAt).toBe(new Date(now).toISOString());
    expect(second.createdAt).not.toBe(first.createdAt);
  });

  it("does not leak a decision across fingerprints", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request());
    await router.route(request({ fingerprint: "a-different-conversation" }));

    expect(jev.calls).toHaveLength(2);
  });

  it("asks Jev again once the sticky entry expires", async () => {
    let now = 1_700_000_000_000;
    const sticky = new StickyCache({ clock: () => now });
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER, sticky, clock: () => now });

    await router.route(request());
    now += ROUTER_LIMITS.stickyTtlMs + 1;
    const after = await router.route(request());

    expect(jev.calls).toHaveLength(2);
    expect(after.sticky).toBe(false);
  });
});

describe("Router.route: happy path", () => {
  it("sends the built state and the four questions under an abort signal", async () => {
    const jev = stubJev(loadFixture("trivial-rename").answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request({ tools: [{ name: "read_file" }] }));

    const call = jev.calls[0];
    expect(call).toBeDefined();
    expect(Object.keys(call!.questions).sort()).toEqual(["difficulty", "long_output", "needs_reasoning", "task_type"]);
    const state = call!.state as Record<string, unknown>;
    expect(state["has_tools"]).toBe(true);
    expect(state["tool_count"]).toBe(1);
    expect(state["recent_user_turns"]).toEqual(["Rename res to rows in listRecent."]);
  });

  it("maps answers onto signals", async () => {
    const fixture = loadFixture("flaky-test");
    const jev = stubJev(fixture.answers, { requestId: fixture.requestId, model: fixture.model, latencyMs: 71 });
    const router = new Router({ jev, roster: ROSTER });

    const decision = await router.route(request());

    expect(decision.signals).toEqual({
      taskType: "debug",
      difficulty: 2.31,
      needsReasoning: 0.93,
      longOutput: 0.31,
      confidences: { task_type: 0.94, difficulty: 0.72 },
      jevRequestId: fixture.requestId,
      jevModel: "jev-latest",
      latencyMs: 71,
    });
    expect(decision.degraded).toBe(false);
    expect(decision.reason).toContain("debug task");
    expect(decision.reason).toContain("difficulty 2.31");
    expect(decision.reason).toContain("frontier-model");
  });

  for (const name of ["trivial-rename", "flaky-test", "schema-migration", "concurrency-bug"]) {
    const fixture = loadFixture(name);
    it(`routes the ${name} fixture where the policy expects under every posture`, async () => {
      for (const posture of ["low", "balanced", "quality"] as const) {
        const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER });
        const decision = await router.route(request({ posture }));
        expect(`${posture}:${decision.tier}`).toBe(`${posture}:${fixture.expectedTier[posture]}`);
      }
    });
  }

  it("calls onDecision with every decision it returns", async () => {
    const decisions: RouteDecision[] = [];
    const router = new Router({
      jev: stubJev(loadFixture("trivial-rename").answers),
      roster: ROSTER,
      onDecision: (d) => decisions.push(d),
    });

    const first = await router.route(request());
    const second = await router.route(request());
    const forced = await router.route(request({ forcedTier: "mid" }));

    expect(decisions).toEqual([first, second, forced]);
    expect(decisions[1]?.sticky).toBe(true);
  });
});

describe("Router.route: degraded fallback", () => {
  const causes: Array<[string, unknown, string]> = [
    ["network", new TypeError("fetch failed"), "network"],
    ["http", Object.assign(new Error("bad gateway"), { status: 502 }), "http"],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
  ];

  for (const [label, error, cause] of causes) {
    it(`falls back to mid on a ${label} failure`, async () => {
      const decisions: RouteDecision[] = [];
      const router = new Router({
        jev: failingJev(error),
        roster: ROSTER,
        onDecision: (d) => decisions.push(d),
      });

      const decision = await router.route(request());

      expect(decision.tier).toBe("mid");
      expect(decision.model).toBe("mid-model");
      expect(decision.degraded).toBe(true);
      expect(decision.sticky).toBe(false);
      expect(decision.signals).toBeUndefined();
      expect(decision.reason).toContain(cause);
      expect(decisions).toEqual([decision]);
    });
  }

  it("degrades to mid when Jev exceeds the timeout budget", async () => {
    vi.useFakeTimers();
    const router = new Router({ jev: { systemone: () => new Promise<never>(() => {}) }, roster: ROSTER });

    const pending = router.route(request());
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs);
    const decision = await pending;

    expect(decision.tier).toBe("mid");
    expect(decision.degraded).toBe(true);
    expect(decision.reason).toContain("timeout");
  });

  it("ignores a Jev rejection that lands after the deadline", async () => {
    vi.useFakeTimers();
    const router = new Router({
      jev: {
        systemone: () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late")), ROUTER_LIMITS.jevTimeoutMs * 2);
          }),
      },
      roster: ROSTER,
    });

    const pending = router.route(request());
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs);
    const decision = await pending;
    expect(decision.degraded).toBe(true);

    // Vitest fails the test on an unhandled rejection, so this asserts that the
    // abandoned call cannot take the process down.
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs * 2);
  });

  it("does not pin a degraded decision, so the next turn retries Jev", async () => {
    const sticky = new StickyCache();
    const router = new Router({ jev: failingJev(new Error("boom")), roster: ROSTER, sticky });

    const decision = await router.route(request());

    expect(decision.degraded).toBe(true);
    expect(sticky.size).toBe(0);
    expect(sticky.get(decision.fingerprint)).toBeUndefined();
  });

  it("honours candidates while degraded", async () => {
    const router = new Router({ jev: failingJev(new Error("boom")), roster: ROSTER });
    const decision = await router.route(request({ candidates: ["frontier-model"] }));
    expect(decision.model).toBe("frontier-model");
  });

  const malformed: Array<[string, SystemOneResult["answers"]]> = [
    ["a missing answer", { task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: {} } }],
    [
      "a task type that is not in the vocabulary",
      {
        task_type: { type: "choice", choice: "refactor", confidence: 0.9, probabilities: {} },
        difficulty: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: {} },
        needs_reasoning: { type: "noul", noul: 0.5 },
        long_output: { type: "noul", noul: 0.5 },
      } as unknown as SystemOneResult["answers"],
    ],
    [
      "a difficulty outside 0..3",
      {
        task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: {} },
        difficulty: { type: "score", score: 7, confidence: 0.8, legend: {}, probabilities: {} },
        needs_reasoning: { type: "noul", noul: 0.5 },
        long_output: { type: "noul", noul: 0.5 },
      },
    ],
    [
      "a difficulty that is not a number",
      {
        task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: {} },
        difficulty: { type: "score", score: "hard", confidence: 0.8, legend: {}, probabilities: {} },
        needs_reasoning: { type: "noul", noul: 0.5 },
        long_output: { type: "noul", noul: 0.5 },
      } as unknown as SystemOneResult["answers"],
    ],
    [
      "a noul answered as a choice",
      {
        task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: {} },
        difficulty: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: {} },
        needs_reasoning: { type: "choice", choice: "yes", confidence: 0.9, probabilities: {} },
        long_output: { type: "noul", noul: 0.5 },
      } as unknown as SystemOneResult["answers"],
    ],
  ];

  for (const [label, answers] of malformed) {
    it(`degrades on ${label}`, async () => {
      const router = new Router({ jev: stubJev(answers), roster: ROSTER });
      const decision = await router.route(request());

      expect(decision.tier).toBe("mid");
      expect(decision.degraded).toBe(true);
      expect(decision.reason).toContain("validation");
      expect(decision.signals).toBeUndefined();
    });
  }
});

describe("Router.route: the Jev key never reaches a decision", () => {
  const leaky: unknown[] = [
    new Error(`401 Unauthorized calling https://api.typesafe.ai/v1/systemone with Bearer ${FAKE_KEY}`),
    Object.assign(new Error(`request failed: {"Authorization":"Bearer ${FAKE_KEY}"}`), { status: 403 }),
    { name: "TimeoutError", message: FAKE_KEY, headers: { authorization: `Bearer ${FAKE_KEY}` } },
  ];

  for (const [index, error] of leaky.entries()) {
    it(`keeps key material out of the reason (case ${index + 1})`, async () => {
      const decisions: RouteDecision[] = [];
      const router = new Router({
        jev: failingJev(error),
        roster: ROSTER,
        onDecision: (d) => decisions.push(d),
      });

      const decision = await router.route(request());
      const serialized = JSON.stringify(decisions);

      expect(decision.reason).not.toContain(FAKE_KEY);
      expect(decision.reason).not.toContain("sk-");
      expect(decision.reason).not.toContain("Bearer");
      expect(decision.reason).not.toContain("Authorization");
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain("sk-");
    });
  }
});

describe("degradedDecision", () => {
  it("builds a mid-tier, degraded, non-sticky decision with no signals", () => {
    const decision = degradedDecision({
      fingerprint: "fp-1",
      roster: ROSTER,
      reason: "something went wrong",
    });

    expect(decision.tier).toBe("mid");
    expect(decision.model).toBe("mid-model");
    expect(decision.degraded).toBe(true);
    expect(decision.sticky).toBe(false);
    expect(decision.signals).toBeUndefined();
    expect(decision.reason).toBe("something went wrong");
    expect(decision.fingerprint).toBe("fp-1");
    expect(decision.policyVersion).toBe(POLICY_VERSION);
    expect(decision.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("honours candidates and an injected clock", () => {
    const decision = degradedDecision({
      fingerprint: "fp-2",
      roster: ROSTER,
      candidates: ["frontier-model"],
      reason: "over the limit",
      clock: () => 1_700_000_000_000,
    });

    expect(decision.model).toBe("frontier-model");
    expect(decision.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("is the implementation the router's own degraded path uses", async () => {
    const router = new Router({ jev: failingJev(new Error("boom")), roster: ROSTER });
    const decision = await router.route(request());

    expect(decision.tier).toBe("mid");
    expect(decision.degraded).toBe(true);
    expect(decision.sticky).toBe(false);
    expect(decision.signals).toBeUndefined();
  });
});

describe("Router.route: onDecision is awaited", () => {
  it("waits for an async onDecision before resolving", async () => {
    let resolveHook: () => void = () => undefined;
    const hookDone = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });
    let observed: RouteDecision | undefined;
    const router = new Router({
      jev: stubJev(loadFixture("trivial-rename").answers),
      roster: ROSTER,
      onDecision: async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        observed = d;
        resolveHook();
      },
    });

    const decision = await router.route(request());
    expect(observed).toEqual(decision);
    await hookDone;
  });

  it("catches an onDecision failure and routes it to onError instead of throwing", async () => {
    const errors: unknown[] = [];
    const hookError = new Error("log insert failed");
    const router = new Router({
      jev: stubJev(loadFixture("trivial-rename").answers),
      roster: ROSTER,
      onDecision: () => Promise.reject(hookError),
      onError: (err) => errors.push(err),
    });

    const decision = await router.route(request());

    expect(decision.tier).toBeDefined();
    expect(errors).toEqual([hookError]);
  });

  it("does not throw when onDecision fails and no onError is given", async () => {
    const router = new Router({
      jev: stubJev(loadFixture("trivial-rename").answers),
      roster: ROSTER,
      onDecision: () => {
        throw new Error("boom");
      },
    });

    await expect(router.route(request())).resolves.toMatchObject({ degraded: false });
  });
});

describe("classifyFailure", () => {
  it("names the class of failure without reading its message", () => {
    expect(classifyFailure(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(classifyFailure(Object.assign(new Error("x"), { status: 500 }))).toBe("http");
    expect(classifyFailure(new TypeError("fetch failed"))).toBe("network");
    expect(classifyFailure(undefined)).toBe("network");
  });
});
