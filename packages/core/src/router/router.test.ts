import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevError } from "../jev/client.js";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, CostPosture, RouteDecision, RouteRequest, Roster, Tier } from "../types.js";
import { POLICY_VERSION, ROUTER_LIMITS } from "../types.js";
import { BREAKER_COOLDOWN_MS } from "./breaker.js";
import { isRoutingUnavailable, RoutingUnavailableError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { classifyFailure, Router } from "./router.js";
import type { RouterOptions } from "./router.js";
import { ClassificationCache } from "./classification-cache.js";
import { StickyCache } from "./sticky.js";
import type { StickyEntry, StickyStore } from "./sticky-store.js";

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

/** The same conversation after a tool call: no new user turn. */
const TOOL_CONTINUATION: ChatMessage[] = [
  ...MESSAGES,
  { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
  { role: "tool", content: "ok", tool_call_id: "call_1" },
];

/** The same conversation after the user says something else. */
const NEXT_USER_TURN: ChatMessage[] = [
  ...TOOL_CONTINUATION,
  { role: "assistant", content: "Renamed it." },
  { role: "user", content: "Now make the whole module concurrency-safe." },
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

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };
type StubJev = JevClientLike & { calls: StubCall[]; budgets: Array<number | undefined> };

function stubJev(answers: SystemOneResult["answers"], extra: Partial<SystemOneResult> = {}): StubJev {
  const calls: StubCall[] = [];
  const budgets: Array<number | undefined> = [];
  return {
    calls,
    budgets,
    systemone: (req, opts) => {
      calls.push(req);
      budgets.push(opts?.budgetMs);
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

/** A stub whose calls resolve only when the test says so. */
function gatedJev(answers: SystemOneResult["answers"]): StubJev & { release: () => void } {
  const calls: StubCall[] = [];
  const budgets: Array<number | undefined> = [];
  const waiters: Array<() => void> = [];
  return {
    calls,
    budgets,
    release: () => {
      for (const resume of waiters.splice(0)) resume();
    },
    systemone: async (req, opts) => {
      calls.push(req);
      budgets.push(opts?.budgetMs);
      await new Promise<void>((resolve) => waiters.push(resolve));
      return {
        model: "jev-latest",
        answers,
        usage: { input_tokens: 1200, output_tokens: 24 },
        requestId: `req_${calls.length}`,
        latencyMs: 64,
      };
    },
  };
}

function failingJev(error: unknown): JevClientLike {
  return { systemone: () => Promise.reject(error) };
}

/** An in-memory StickyStore that counts what the router asked it to do. */
function memoryStore(): StickyStore & {
  entries: Map<string, StickyEntry>;
  gets: string[];
  sets: Array<[string, StickyEntry]>;
} {
  const entries = new Map<string, StickyEntry>();
  const gets: string[] = [];
  const sets: Array<[string, StickyEntry]> = [];
  return {
    entries,
    gets,
    sets,
    get: (fp) => {
      gets.push(fp);
      return Promise.resolve(entries.get(fp));
    },
    set: (fp, entry) => {
      sets.push([fp, entry]);
      entries.set(fp, entry);
      return Promise.resolve();
    },
    delete: (fp) => {
      entries.delete(fp);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Router.route: forced tier", () => {
  it("skips Jev and reports no signals", async () => {
    const jev = stubJev({});
    const decisions: RouteDecision[] = [];
    const router = new Router({ jev, roster: ROSTER, onDecision: (d) => decisions.push(d) });

    const decision = await router.route(request({ forcedTier: "frontier" }));

    expect(jev.calls).toHaveLength(0);
    expect(decision.tier).toBe("frontier");
    expect(decision.model).toBe("frontier-model");
    expect(decision.reason).toContain("forced");
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

  it("answers even with the breaker wide open: it needs no backend", async () => {
    const router = new Router({ jev: failingJev(new TypeError("fetch failed")), roster: ROSTER });
    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request())).rejects.toThrow(RoutingUnavailableError);
    }
    expect(router.breakerState().state).toBe("open");

    const decision = await router.route(request({ forcedTier: "fast" }));
    expect(decision.tier).toBe("fast");
  });
});

describe("Router.route: per-request roster", () => {
  const fixture = loadFixture("trivial-rename");
  const MINE: Roster = { fast: ["mine-fast"], mid: ["mine-mid"], frontier: ["mine-frontier"] };

  it("resolves against the request's roster when it brings one", async () => {
    // One Router serves every key, so the table has to arrive per request
    // rather than per construction (ADR-008).
    const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER });
    const decision = await router.route(request({ roster: MINE }));

    expect(decision.tier).toBe("fast");
    expect(decision.model).toBe("mine-fast");
  });

  it("falls back to the Router's own roster when the request brings none", async () => {
    const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER });
    expect((await router.route(request())).model).toBe("fast-model");
  });

  it("applies a per-request roster to a forced tier too", async () => {
    const router = new Router({ jev: stubJev({}), roster: ROSTER });
    const decision = await router.route(request({ forcedTier: "frontier", roster: MINE }));
    expect(decision.model).toBe("mine-frontier");
  });

  it("still lets candidates filter within the request's roster", async () => {
    const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER });
    const decision = await router.route(request({ roster: MINE, candidates: ["mine-mid"] }));
    expect(decision.model).toBe("mine-mid");
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

  it("takes a stickyTtlMs option, so the pin window is tunable", async () => {
    let now = 1_700_000_000_000;
    const jev = stubJev(fixture.answers);
    // The classification cache (ADR-023) is disabled here so this test keeps
    // isolating stickiness' own TTL: left on, its default five-minute window
    // would still answer the second call from cache, which is correct new
    // behaviour (see "the classification cache" below) but not what this
    // test means to exercise.
    const router = new Router({
      jev,
      roster: ROSTER,
      clock: () => now,
      stickyTtlMs: 1_000,
      classificationCacheEnabled: false,
    });

    await router.route(request());
    now += 1_001;
    await router.route(request());

    expect(jev.calls).toHaveLength(2);
  });
});

describe("Router.route: user-turn-aware stickiness", () => {
  const fixture = loadFixture("trivial-rename");

  it("reuses the decision for a tool-result continuation, which adds no user turn", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });
    const fp = fingerprint(MESSAGES);

    const first = await router.route(request());
    const continued = await router.route(request({ messages: TOOL_CONTINUATION, fingerprint: fp }));

    // Switching models mid-tool-loop breaks tool-call continuity; this is the
    // case stickiness exists for.
    expect(jev.calls).toHaveLength(1);
    expect(continued.sticky).toBe(true);
    expect(continued.model).toBe(first.model);
  });

  it("re-evaluates when the user takes another turn, and replaces the entry", async () => {
    const jev = stubJev(fixture.answers);
    const sticky = new StickyCache();
    const router = new Router({ jev, roster: ROSTER, sticky });
    const fp = fingerprint(MESSAGES);

    await router.route(request());
    const next = await router.route(request({ messages: NEXT_USER_TURN, fingerprint: fp }));

    // The fingerprint only hashes the system prompt and the first user
    // message, so a follow-up lands on the same key -- but it is a different
    // question and gets its own answer.
    expect(jev.calls).toHaveLength(2);
    expect(next.sticky).toBe(false);
    expect(sticky.get(fp)?.userTurns).toBe(2);
  });

  it("sends the new turn's context to Jev on the re-evaluation, not the old", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request());
    await router.route(request({ messages: NEXT_USER_TURN, fingerprint: fingerprint(MESSAGES) }));

    const second = jev.calls[1]?.state as Record<string, unknown>;
    expect(second["recent_user_turns"]).toEqual([
      "Rename res to rows in listRecent.",
      "Now make the whole module concurrency-safe.",
    ]);
    expect(second["user_message_count"]).toBe(2);
  });

  it("pins the new decision, so the next continuation of it reuses the new tier", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });
    const fp = fingerprint(MESSAGES);

    await router.route(request());
    await router.route(request({ messages: NEXT_USER_TURN, fingerprint: fp }));
    const third = await router.route(request({ messages: NEXT_USER_TURN, fingerprint: fp }));

    expect(jev.calls).toHaveLength(2);
    expect(third.sticky).toBe(true);
  });
});

describe("Router.route: the classification cache (ADR-023)", () => {
  const fixture = loadFixture("trivial-rename");

  // Under default config a same-fingerprint, same-user-turn repeat is
  // already a sticky hit (30-minute window) before the classification cache
  // (5-minute default) is ever consulted, so these tests disable stickiness'
  // pinning window (`stickyTtlMs: 0`) to exercise the cache on its own --
  // exactly the deployment shape that wants cost savings without conversation
  // continuity pinning.
  function noStickyRouter(jev: StubJev, extra: Partial<RouterOptions> = {}): Router {
    return new Router({ jev, roster: ROSTER, stickyTtlMs: 0, ...extra });
  }

  it("skips Jev on a hit and marks the decision cached", async () => {
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev);

    const first = await router.route(request());
    const second = await router.route(request());

    expect(jev.calls).toHaveLength(1);
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    // Distinct from, but layered under, stickiness' own flag: no Jev call
    // was made for either decision, so both count as `sticky` in the sense
    // every other reader of that field already relies on.
    expect(first.sticky).toBe(false);
    expect(second.sticky).toBe(true);
    expect(second.signals).toEqual(first.signals);
  });

  it("decides fresh on a hit, so a changed request-level knob is honoured", async () => {
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev);

    const first = await router.route(request());
    // A sticky hit would have replayed `first.model` unchanged; the
    // classification cache instead reuses only the classification and lets
    // `candidates` filter the roster again.
    const second = await router.route(request({ candidates: ["mid-model"] }));

    expect(jev.calls).toHaveLength(1);
    expect(second.cached).toBe(true);
    expect(second.model).toBe("mid-model");
    expect(second.model).not.toBe(first.model);
  });

  it("expires a cached classification after its own (shorter) TTL", async () => {
    let now = 1_700_000_000_000;
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev, { classificationCacheTtlMs: 1_000, clock: () => now });

    await router.route(request());
    now += 1_001;
    const after = await router.route(request());

    expect(jev.calls).toHaveLength(2);
    expect(after.cached).toBeUndefined();
  });

  it("does not leak a classification across two callers' scoped fingerprints", async () => {
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev);

    await router.route(request({ fingerprint: fingerprint(MESSAGES, "key-hash-a") }));
    await router.route(request({ fingerprint: fingerprint(MESSAGES, "key-hash-b") }));

    expect(jev.calls).toHaveLength(2);
  });

  it("classificationCacheEnabled: false always falls through to Jev", async () => {
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev, { classificationCacheEnabled: false });

    await router.route(request());
    const second = await router.route(request());

    expect(jev.calls).toHaveLength(2);
    expect(second.cached).toBeUndefined();
  });

  it("takes a classificationCache instance directly, so it can be shared or clocked", async () => {
    const cache = new ClassificationCache({ ttlMs: 1_000 });
    const jev = stubJev(fixture.answers);
    const router = noStickyRouter(jev, { classificationCache: cache });

    await router.route(request());
    expect(cache.size).toBe(1);

    const second = await router.route(request());
    expect(jev.calls).toHaveLength(1);
    expect(second.cached).toBe(true);
  });

  it("pins a cache hit into stickiness, so its own next continuation is a sticky hit", async () => {
    const jev = stubJev(fixture.answers);
    // Stickiness stays live here, unlike the other tests in this block, to
    // show the two caches layering: a cache hit still produces a decision
    // worth pinning for the conversation it just answered.
    const router = new Router({ jev, roster: ROSTER, classificationCacheTtlMs: 5 * 60 * 1000 });
    const fp = fingerprint(MESSAGES);

    await router.route(request());
    const continued = await router.route(request({ messages: TOOL_CONTINUATION, fingerprint: fp }));

    expect(jev.calls).toHaveLength(1);
    expect(continued.sticky).toBe(true);
    expect(continued.cached).toBeUndefined();
  });

  it("a joiner of an in-flight call does not populate the cache on the sharer's behalf", async () => {
    const jev = gatedJev(fixture.answers);
    const router = noStickyRouter(jev);

    const all = Promise.all([router.route(request()), router.route(request())]);
    await Promise.resolve();
    jev.release();
    const [a, b] = await all;

    expect(jev.calls).toHaveLength(1);
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBeUndefined();
    // ...but the call that answered them both did populate it, so the next
    // request is a cache hit rather than a third Jev call.
    const third = await router.route(request());
    expect(jev.calls).toHaveLength(1);
    expect(third.cached).toBe(true);
  });
});

describe("Router.route: the sticky store", () => {
  const fixture = loadFixture("trivial-rename");

  it("writes through on every fresh decision", async () => {
    const store = memoryStore();
    const jev = stubJev(fixture.answers);
    const now = 1_700_000_000_000;
    const router = new Router({ jev, roster: ROSTER, stickyStore: store, clock: () => now });

    const decision = await router.route(request());

    expect(store.sets).toHaveLength(1);
    const [fp, entry] = store.sets[0] as [string, StickyEntry];
    expect(fp).toBe(decision.fingerprint);
    expect(entry.decision.id).toBe(decision.id);
    expect(entry.userTurns).toBe(1);
    expect(entry.expiresAt).toBe(now + ROUTER_LIMITS.stickyTtlMs);
  });

  it("fills a cold memory cache from the store instead of asking Jev", async () => {
    const store = memoryStore();
    const jev = stubJev(fixture.answers);
    const fp = fingerprint(MESSAGES);

    // One instance decides and writes through.
    await new Router({ jev, roster: ROSTER, stickyStore: store }).route(request());
    expect(jev.calls).toHaveLength(1);

    // A second instance -- a redeploy, or another Fly machine -- starts cold.
    const cold = stubJev(fixture.answers);
    const second = new Router({ jev: cold, roster: ROSTER, stickyStore: store });
    const decision = await second.route(request());

    expect(cold.calls).toHaveLength(0);
    expect(store.gets).toContain(fp);
    expect(decision.sticky).toBe(true);
    expect(decision.tier).toBe("fast");
  });

  it("consults the store only once per conversation: the fill warms memory", async () => {
    const store = memoryStore();
    await new Router({ jev: stubJev(fixture.answers), roster: ROSTER, stickyStore: store }).route(request());
    store.gets.length = 0;

    const cold = new Router({ jev: stubJev(fixture.answers), roster: ROSTER, stickyStore: store });
    await cold.route(request());
    await cold.route(request());

    expect(store.gets).toHaveLength(1);
  });

  it("ignores a stored entry recorded at a different user-turn count", async () => {
    const store = memoryStore();
    const fp = fingerprint(MESSAGES);
    await new Router({ jev: stubJev(fixture.answers), roster: ROSTER, stickyStore: store }).route(request());

    const cold = stubJev(fixture.answers);
    const second = new Router({ jev: cold, roster: ROSTER, stickyStore: store });
    const decision = await second.route(request({ messages: NEXT_USER_TURN, fingerprint: fp }));

    expect(cold.calls).toHaveLength(1);
    expect(decision.sticky).toBe(false);
    expect(store.entries.get(fp)?.userTurns).toBe(2);
  });

  it("ignores an expired stored entry", async () => {
    const store = memoryStore();
    let now = 1_700_000_000_000;
    await new Router({ jev: stubJev(fixture.answers), roster: ROSTER, stickyStore: store, clock: () => now })
      .route(request());

    now += ROUTER_LIMITS.stickyTtlMs + 1;
    const cold = stubJev(fixture.answers);
    await new Router({ jev: cold, roster: ROSTER, stickyStore: store, clock: () => now }).route(request());

    expect(cold.calls).toHaveLength(1);
  });

  it("routes anyway when the store is down, and reports the failure", async () => {
    const errors: unknown[] = [];
    const broken: StickyStore = {
      get: () => Promise.reject(new Error("store read failed")),
      set: () => Promise.reject(new Error("store write failed")),
      delete: () => Promise.resolve(),
    };
    const router = new Router({
      jev: stubJev(fixture.answers),
      roster: ROSTER,
      stickyStore: broken,
      onError: (err) => errors.push(err),
    });

    const decision = await router.route(request());

    // A store outage costs an extra Jev call on another instance, never a
    // failed request.
    expect(decision.tier).toBe("fast");
    expect(errors).toHaveLength(2);
  });

  it("never consults the store when there is none", async () => {
    const jev = stubJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });
    await expect(router.route(request())).resolves.toBeDefined();
  });
});

describe("Router.route: coalescing identical asks", () => {
  const fixture = loadFixture("trivial-rename");

  it("shares one Jev call between concurrent identical asks", async () => {
    const jev = gatedJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    const all = Promise.all([router.route(request()), router.route(request()), router.route(request())]);
    await Promise.resolve();
    jev.release();
    const [a, b, c] = await all;

    expect(jev.calls).toHaveLength(1);
    expect([a, b, c].map((d) => d.tier)).toEqual(["fast", "fast", "fast"]);
    // Each caller gets its own decision id, so the log stays one row per
    // request and the gateway can attach each request's upstream outcome to
    // its own row.
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    // ...and they all cite the one Jev call that actually answered.
    expect(new Set([a, b, c].map((d) => d.signals?.jevRequestId))).toEqual(new Set(["req_1"]));
  });

  it("marks every caller but the one that made the call sticky", async () => {
    const jev = gatedJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    const all = Promise.all([router.route(request()), router.route(request()), router.route(request())]);
    await Promise.resolve();
    jev.release();
    const decisions = await all;

    expect(decisions.filter((d) => !d.sticky)).toHaveLength(1);
    expect(decisions.filter((d) => d.sticky)).toHaveLength(2);
  });

  it("does not coalesce different fingerprints", async () => {
    const jev = gatedJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    const all = Promise.all([router.route(request()), router.route(request({ fingerprint: "other" }))]);
    await Promise.resolve();
    jev.release();
    await all;

    expect(jev.calls).toHaveLength(2);
  });

  it("does not coalesce the same fingerprint at different user-turn counts", async () => {
    const jev = gatedJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });
    const fp = fingerprint(MESSAGES);

    const all = Promise.all([
      router.route(request()),
      router.route(request({ messages: NEXT_USER_TURN, fingerprint: fp })),
    ]);
    await Promise.resolve();
    jev.release();
    await all;

    // Two different questions; sharing one answer would route the follow-up
    // on the first turn's signals.
    expect(jev.calls).toHaveLength(2);
  });

  it("gives every joined caller the same failure when the shared call fails", async () => {
    let reject: (err: unknown) => void = () => undefined;
    let started = 0;
    const jev: JevClientLike = {
      systemone: () => {
        started += 1;
        return new Promise<never>((_resolve, rej) => {
          reject = rej;
        });
      },
    };
    const router = new Router({ jev, roster: ROSTER });

    const all = Promise.allSettled([router.route(request()), router.route(request())]);
    await Promise.resolve();
    reject(new TypeError("fetch failed"));
    const results = await all;

    expect(started).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect(isRoutingUnavailable((r as PromiseRejectedResult).reason)).toBe(true);
    }
  });

  it("clears the entry on settle, so a later ask is not served a stale promise", async () => {
    const jev = gatedJev(fixture.answers);
    const sticky = new StickyCache({ ttlMs: 0 }); // never a sticky hit
    // The classification cache (ADR-023) is disabled here for the same
    // reason as stickiness' own TTL test above: it would otherwise correctly
    // answer the second wave from cache, which is not what this test means
    // to exercise -- whether a settled in-flight entry is cleared.
    const router = new Router({ jev, roster: ROSTER, sticky, classificationCacheEnabled: false });

    const first = Promise.all([router.route(request()), router.route(request())]);
    await Promise.resolve();
    jev.release();
    await first;

    const second = router.route(request());
    await Promise.resolve();
    jev.release();
    await second;

    expect(jev.calls).toHaveLength(2);
  });

  it("does not leave an entry behind after a failure", async () => {
    const jev = failingJev(new TypeError("fetch failed"));
    const router = new Router({ jev, roster: ROSTER, breaker: { failureThreshold: 100 } });

    await expect(router.route(request())).rejects.toThrow(RoutingUnavailableError);
    // A pinned failure would make every later caller inherit the first
    // outage forever.
    await expect(router.route(request())).rejects.toThrow(RoutingUnavailableError);
  });
});

describe("Router.route: it fails loudly", () => {
  const causes: Array<[string, unknown, string]> = [
    ["network", new TypeError("fetch failed"), "network"],
    ["http", new JevError("boom", "http", { status: 502, requestId: "req_502" }), "http"],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    ["validation", new JevError("nope", "validation"), "validation"],
  ];

  for (const [label, error, cause] of causes) {
    it(`throws RoutingUnavailableError on a ${label} failure`, async () => {
      const decisions: RouteDecision[] = [];
      const router = new Router({
        jev: failingJev(error),
        roster: ROSTER,
        onDecision: (d) => decisions.push(d),
      });

      const thrown = await router.route(request()).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(RoutingUnavailableError);
      expect((thrown as RoutingUnavailableError).cause_).toBe(cause);
      // No decision is invented, so none is logged.
      expect(decisions).toEqual([]);
    });
  }

  it("throws rather than returning a mid-tier guess", async () => {
    const router = new Router({ jev: failingJev(new TypeError("fetch failed")), roster: ROSTER });
    // The old behaviour returned `mid` and marked it degraded, which is a
    // wrong answer billed at Sonnet prices and indistinguishable from a right
    // one.
    await expect(router.route(request())).rejects.toThrow(RoutingUnavailableError);
  });

  it("carries the status and Jev's request id on an http failure", async () => {
    const router = new Router({
      jev: failingJev(new JevError("boom", "http", { status: 502, requestId: "req_502" })),
      roster: ROSTER,
    });

    const err = (await router.route(request()).catch((e: unknown) => e)) as RoutingUnavailableError;
    expect(err.cause_).toBe("http");
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("req_502");
  });

  it("reports a 429 as rate_limited and passes the Retry-After through", async () => {
    const router = new Router({
      jev: failingJev(new JevError("slow down", "http", { status: 429, retryAfterMs: 2_000 })),
      roster: ROSTER,
    });

    const err = (await router.route(request()).catch((e: unknown) => e)) as RoutingUnavailableError;
    expect(err.cause_).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2_000);
  });

  it("throws a timeout when Jev exceeds the budget", async () => {
    vi.useFakeTimers();
    const router = new Router({ jev: { systemone: () => new Promise<never>(() => {}) }, roster: ROSTER });

    const pending = router.route(request()).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs);
    const err = (await pending) as RoutingUnavailableError;

    expect(err).toBeInstanceOf(RoutingUnavailableError);
    expect(err.cause_).toBe("timeout");
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

    const pending = router.route(request()).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs);
    expect(await pending).toBeInstanceOf(RoutingUnavailableError);

    // Vitest fails the test on an unhandled rejection, so this asserts that the
    // abandoned call cannot take the process down.
    await vi.advanceTimersByTimeAsync(ROUTER_LIMITS.jevTimeoutMs * 2);
  });

  it("passes its own budget to the client, so retries live inside it", async () => {
    const jev = stubJev(loadFixture("trivial-rename").answers);
    const router = new Router({ jev, roster: ROSTER, jevTimeoutMs: 1_234 });
    await router.route(request());
    expect(jev.budgets).toEqual([1_234]);
  });

  it("pins nothing when it throws, so the next turn tries again", async () => {
    const sticky = new StickyCache();
    const router = new Router({
      jev: failingJev(new Error("boom")),
      roster: ROSTER,
      sticky,
      breaker: { failureThreshold: 100 },
    });

    await expect(router.route(request())).rejects.toThrow(RoutingUnavailableError);
    expect(sticky.size).toBe(0);
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
    it(`throws a validation failure on ${label}`, async () => {
      const router = new Router({ jev: stubJev(answers), roster: ROSTER });
      const err = (await router.route(request()).catch((e: unknown) => e)) as RoutingUnavailableError;

      expect(err).toBeInstanceOf(RoutingUnavailableError);
      expect(err.cause_).toBe("validation");
    });
  }
});

describe("Router.route: the circuit breaker", () => {
  const fixture = loadFixture("trivial-rename");

  it("starts closed and reports its state", () => {
    const router = new Router({ jev: stubJev(fixture.answers), roster: ROSTER });
    expect(router.breakerState()).toEqual({ state: "closed", failures: 0 });
  });

  it("opens after three transport failures and then refuses without calling Jev", async () => {
    const now = 1_700_000_000_000;
    let calls = 0;
    const jev: JevClientLike = {
      systemone: () => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      },
    };
    const router = new Router({ jev, roster: ROSTER, clock: () => now });

    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request({ fingerprint: `fp-${i}` }))).rejects.toThrow(RoutingUnavailableError);
    }
    expect(calls).toBe(3);
    expect(router.breakerState().state).toBe("open");

    const err = (await router.route(request({ fingerprint: "fp-x" })).catch((e: unknown) => e)) as
      RoutingUnavailableError;
    expect(err.cause_).toBe("breaker_open");
    expect(err.retryAfterMs).toBe(BREAKER_COOLDOWN_MS);
    // The whole point: no fourth call, and no three-second wait to find out.
    expect(calls).toBe(3);
  });

  it("counts down the cooldown in retryAfterMs", async () => {
    let now = 1_700_000_000_000;
    const router = new Router({ jev: failingJev(new TypeError("x")), roster: ROSTER, clock: () => now });
    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request({ fingerprint: `fp-${i}` }))).rejects.toThrow();
    }

    now += 11_000;
    const err = (await router.route(request({ fingerprint: "y" })).catch((e: unknown) => e)) as
      RoutingUnavailableError;
    expect(err.retryAfterMs).toBe(BREAKER_COOLDOWN_MS - 11_000);
  });

  it("half-opens after the cooldown, and a successful probe closes it", async () => {
    let now = 1_700_000_000_000;
    let fail = true;
    let calls = 0;
    const jev: JevClientLike = {
      systemone: () => {
        calls += 1;
        if (fail) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve({
          model: "jev-latest",
          answers: fixture.answers,
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "req_probe",
          latencyMs: 10,
        });
      },
    };
    const router = new Router({ jev, roster: ROSTER, clock: () => now });

    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request({ fingerprint: `fp-${i}` }))).rejects.toThrow();
    }
    now += BREAKER_COOLDOWN_MS;
    expect(router.breakerState().state).toBe("half_open");

    fail = false;
    const decision = await router.route(request({ fingerprint: "probe" }));
    expect(decision.tier).toBe("fast");
    expect(calls).toBe(4);
    expect(router.breakerState()).toEqual({ state: "closed", failures: 0 });
  });

  it("a failed probe re-opens it for another full cooldown", async () => {
    let now = 1_700_000_000_000;
    const router = new Router({
      jev: failingJev(new TypeError("fetch failed")),
      roster: ROSTER,
      clock: () => now,
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request({ fingerprint: `fp-${i}` }))).rejects.toThrow();
    }
    now += BREAKER_COOLDOWN_MS;

    const probe = (await router.route(request({ fingerprint: "probe" })).catch((e: unknown) => e)) as
      RoutingUnavailableError;
    expect(probe.cause_).toBe("network");

    const after = (await router.route(request({ fingerprint: "after" })).catch((e: unknown) => e)) as
      RoutingUnavailableError;
    expect(after.cause_).toBe("breaker_open");
    expect(after.retryAfterMs).toBe(BREAKER_COOLDOWN_MS);
  });

  it("does not open on failures Jev actually answered", async () => {
    const router = new Router({
      jev: failingJev(new JevError("bad request", "http", { status: 400 })),
      roster: ROSTER,
    });

    for (let i = 0; i < 5; i += 1) {
      const err = (await router.route(request({ fingerprint: `fp-${i}` })).catch((e: unknown) => e)) as
        RoutingUnavailableError;
      expect(err.cause_).toBe("http");
    }
    expect(router.breakerState()).toEqual({ state: "closed", failures: 0 });
  });

  it("a success in between resets the failure run", async () => {
    let fail = true;
    const jev: JevClientLike = {
      systemone: () =>
        fail
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve({
              model: "jev-latest",
              answers: fixture.answers,
              usage: { input_tokens: 1, output_tokens: 1 },
              requestId: "req_ok",
              latencyMs: 10,
            }),
    };
    const router = new Router({ jev, roster: ROSTER });

    await expect(router.route(request({ fingerprint: "a" }))).rejects.toThrow();
    await expect(router.route(request({ fingerprint: "b" }))).rejects.toThrow();
    fail = false;
    await router.route(request({ fingerprint: "c" }));
    fail = true;
    await expect(router.route(request({ fingerprint: "d" }))).rejects.toThrow();

    expect(router.breakerState().state).toBe("closed");
  });

  it("serves a sticky hit while open: the answer is already known", async () => {
    const now = 1_700_000_000_000;
    let fail = false;
    const jev: JevClientLike = {
      systemone: () =>
        fail
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve({
              model: "jev-latest",
              answers: fixture.answers,
              usage: { input_tokens: 1, output_tokens: 1 },
              requestId: "req_ok",
              latencyMs: 10,
            }),
    };
    const router = new Router({ jev, roster: ROSTER, clock: () => now });

    const first = await router.route(request());
    fail = true;
    for (let i = 0; i < 3; i += 1) {
      await expect(router.route(request({ fingerprint: `other-${i}` }))).rejects.toThrow();
    }
    expect(router.breakerState().state).toBe("open");

    const sticky = await router.route(request());
    expect(sticky.sticky).toBe(true);
    expect(sticky.model).toBe(first.model);
  });
});

describe("Router.route: happy path", () => {
  it("sends the built state, the four routing questions, and the capture questions", async () => {
    const jev = stubJev(loadFixture("trivial-rename").answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request({ tools: [{ name: "read_file" }] }));

    const call = jev.calls[0];
    expect(call).toBeDefined();
    // The two preference-capture questions ride the routing call (ADR-011).
    expect(Object.keys(call!.questions).sort()).toEqual([
      "difficulty",
      "long_output",
      "needs_reasoning",
      "preference_field",
      "preference_stated",
      "task_type",
    ]);
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
      difficultyLevels: [0.01, 0.09, 0.49, 0.41],
      needsReasoning: 0.93,
      longOutput: 0.31,
      confidences: { task_type: 0.94, difficulty: 0.72 },
      jevRequestId: fixture.requestId,
      jevModel: "jev-latest",
      latencyMs: 71,
    });
    expect(decision.reason).toContain("debug task");
    expect(decision.reason).toContain("P(hard) 0.41");
    expect(decision.reason).toContain("frontier-model");
  });

  it("leaves difficultyLevels empty when the answer carries no distribution", async () => {
    const fixture = loadFixture("flaky-test");
    const answers = JSON.parse(JSON.stringify(fixture.answers)) as Record<string, Record<string, unknown>>;
    delete answers["difficulty"]?.["probabilities"];
    const router = new Router({ jev: stubJev(answers as SystemOneResult["answers"]), roster: ROSTER });

    const decision = await router.route(request());

    expect(decision.signals?.difficultyLevels).toEqual([]);
    // Policy falls back to the v1 expected-score rule, which still routes it.
    expect(decision.reason).toContain("difficulty 2.31");
    expect(decision.tier).toBe("frontier");
  });

  it("treats an all-zero distribution as no distribution, not as certainly trivial", async () => {
    const fixture = loadFixture("flaky-test");
    const answers = JSON.parse(JSON.stringify(fixture.answers)) as Record<string, Record<string, unknown>>;
    answers["difficulty"]!["probabilities"] = {};
    const router = new Router({ jev: stubJev(answers as SystemOneResult["answers"]), roster: ROSTER });

    const decision = await router.route(request());

    expect(decision.signals?.difficultyLevels).toEqual([]);
    expect(decision.tier).toBe("frontier");
  });

  it("reads a partial distribution, treating the missing levels as zero mass", async () => {
    const fixture = loadFixture("trivial-rename");
    const answers = JSON.parse(JSON.stringify(fixture.answers)) as Record<string, Record<string, unknown>>;
    answers["difficulty"]!["probabilities"] = { "0": 0.7, "1": 0.3 };
    const router = new Router({ jev: stubJev(answers as SystemOneResult["answers"]), roster: ROSTER });

    expect((await router.route(request())).signals?.difficultyLevels).toEqual([0.7, 0.3, 0, 0]);
  });

  it("uses the Jev profile whatever the backend called itself", async () => {
    const answers = {
      task_type: { type: "choice", choice: "feature", confidence: 0.9, probabilities: {} },
      difficulty: {
        type: "score",
        score: 1.36,
        confidence: 0.4,
        legend: {},
        probabilities: { "0": 0.2, "1": 0.42, "2": 0.2, "3": 0.18 },
      },
      needs_reasoning: { type: "noul", noul: 0.5 },
      long_output: { type: "noul", noul: 0.2 },
    } as unknown as SystemOneResult["answers"];

    // There is one profile now, so the reported model name no longer selects
    // thresholds; it is recorded in the signals and nothing more.
    const a = new Router({ jev: stubJev(answers, { model: "jev-latest" }), roster: ROSTER });
    const b = new Router({ jev: stubJev(answers, { model: "something-else" }), roster: ROSTER });

    expect((await a.route(request())).tier).toBe("frontier");
    expect((await b.route(request())).tier).toBe("frontier");
  });

  it("lets a caller pass a candidate profile", async () => {
    const fixture = loadFixture("flaky-test");
    const timid = new Router({
      jev: stubJev(fixture.answers),
      roster: ROSTER,
      // A bar nothing can clear: every answer routes to fast.
      profile: {
        fastMassFromLevel: 1,
        fastBelowMass: 1.1,
        frontierHardMass: 0.05,
        frontierUpperMass: 0.65,
        cappedFrontierHardMass: 0.25,
      },
    });
    expect((await timid.route(request())).tier).toBe("fast");
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

describe("Router.route: the Jev key never reaches a decision or an error", () => {
  const leaky: unknown[] = [
    new Error(`401 Unauthorized calling https://api.typesafe.ai/v1/systemone with Bearer ${FAKE_KEY}`),
    Object.assign(new Error(`request failed: {"Authorization":"Bearer ${FAKE_KEY}"}`), { status: 403 }),
    { name: "TimeoutError", message: FAKE_KEY, headers: { authorization: `Bearer ${FAKE_KEY}` } },
  ];

  for (const [index, error] of leaky.entries()) {
    it(`keeps key material out of the thrown error (case ${index + 1})`, async () => {
      const router = new Router({ jev: failingJev(error), roster: ROSTER });

      const err = (await router.route(request()).catch((e: unknown) => e)) as RoutingUnavailableError;
      const serialized = `${err.message} ${JSON.stringify(err)} ${Object.values(err).join(" ")}`;

      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain("sk-");
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("Authorization");
      // The error names the class of failure and nothing more.
      expect(err.message).toContain("routing is unavailable");
    });
  }
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

    await expect(router.route(request())).resolves.toMatchObject({ tier: "fast" });
  });
});

describe("classifyFailure", () => {
  it("names the class of failure without reading its message", () => {
    expect(classifyFailure(Object.assign(new Error("x"), { name: "TimeoutError" })).cause).toBe("timeout");
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })).cause).toBe("timeout");
    expect(classifyFailure(Object.assign(new Error("x"), { status: 500 })).cause).toBe("http");
    expect(classifyFailure(new TypeError("fetch failed")).cause).toBe("network");
    expect(classifyFailure(undefined).cause).toBe("network");
  });

  it("separates a rate limit from a generic http failure", () => {
    expect(classifyFailure(new JevError("x", "http", { status: 429 })).cause).toBe("rate_limited");
    expect(classifyFailure(Object.assign(new Error("x"), { status: 429 })).cause).toBe("rate_limited");
    expect(classifyFailure(new JevError("x", "http", { status: 500 })).cause).toBe("http");
  });

  it("carries the status, request id and Retry-After the gateway needs", () => {
    expect(
      classifyFailure(new JevError("x", "http", { status: 503, requestId: "req_1", retryAfterMs: 5_000 })),
    ).toEqual({ cause: "http", status: 503, requestId: "req_1", retryAfterMs: 5_000 });
  });

  it("omits an empty request id rather than reporting one", () => {
    expect(classifyFailure(new JevError("x", "http", { status: 500, requestId: "" }))).toEqual({
      cause: "http",
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// Best-of-N sampling outcomes (policy v4, ADR-010)
// ---------------------------------------------------------------------------

describe("sampled decisions", () => {
  /** An edit task whose mass sits in the mid band: samples under balanced. */
  const editMidAnswers: SystemOneResult["answers"] = {
    task_type: {
      type: "choice",
      choice: "edit",
      confidence: 0.91,
      probabilities: { edit: 0.91, feature: 0.05, debug: 0.04 },
    },
    difficulty: {
      type: "score",
      score: 0.69,
      confidence: 0.7,
      legend: { "0": "Trivial", "1": "Routine", "2": "Substantial", "3": "Hard" },
      probabilities: { "0": 0.5, "1": 0.35, "2": 0.11, "3": 0.04 },
    },
    needs_reasoning: { type: "noul", noul: 0.4 },
    long_output: { type: "noul", noul: 0.1 },
  };

  it("resolves an edit/mid cell to best-of-5 on the fast tier, keeping the unsampled tier", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER });
    const decision = await router.route(request());
    expect(decision.tier).toBe("fast");
    expect(decision.model).toBe("fast-model");
    expect(decision.samples).toBe(5);
    expect(decision.unsampledTier).toBe("mid");
    expect(decision.reason).toContain("best-of-5");
  });

  it("resolves to the single-model outcome when sampling is disabled", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER, samplingEnabled: false });
    const decision = await router.route(request());
    expect(decision.tier).toBe("mid");
    expect(decision.model).toBe("mid-model");
    expect(decision.samples).toBeUndefined();
    expect(decision.unsampledTier).toBeUndefined();
  });

  it("honors a per-request samples override: 1 disables, N sets the count", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER });
    const disabled = await router.route(request({ samples: 1 }));
    expect(disabled.tier).toBe("mid");
    expect(disabled.samples).toBeUndefined();

    const three = await router.route(request({ fingerprint: "other", samples: 3 }));
    expect(three.samples).toBe(3);
    expect(three.tier).toBe("fast");
  });

  it("reuses a sampled decision from the sticky cache as sampled", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER });
    const first = await router.route(request());
    const second = await router.route(request());
    expect(second.sticky).toBe(true);
    expect(second.samples).toBe(5);
    expect(second.unsampledTier).toBe("mid");
    expect(second.model).toBe(first.model);
  });

  it("re-applies a samples: 1 override to a sticky sampled decision", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER });
    await router.route(request());
    const optedOut = await router.route(request({ samples: 1 }));
    expect(optedOut.sticky).toBe(true);
    expect(optedOut.tier).toBe("mid");
    expect(optedOut.model).toBe("mid-model");
    expect(optedOut.samples).toBeUndefined();
    expect(optedOut.unsampledTier).toBeUndefined();
  });

  it("never samples a forced tier", async () => {
    const router = new Router({ jev: stubJev(editMidAnswers), roster: ROSTER });
    const decision = await router.route(request({ forcedTier: "mid" }));
    expect(decision.samples).toBeUndefined();
    expect(decision.tier).toBe("mid");
  });
});

describe("deepseek mode (ADR-012)", () => {
  /** Signals whose band the controller reads: only the difficulty differs. */
  function bandAnswers(probabilities: Record<string, number>, score = 1): SystemOneResult["answers"] {
    return {
      task_type: {
        type: "choice",
        choice: "feature",
        confidence: 0.9,
        probabilities: { feature: 0.9, edit: 0.1 },
      },
      difficulty: {
        type: "score",
        score,
        confidence: 0.7,
        legend: { "0": "Trivial", "1": "Routine", "2": "Substantial", "3": "Hard" },
        probabilities,
      },
      needs_reasoning: { type: "noul", noul: 0.4 },
      long_output: { type: "noul", noul: 0.1 },
    };
  }

  const BAND0 = bandAnswers({ "0": 0.9, "1": 0.1 }, 0.1);
  const BAND1 = bandAnswers({ "0": 0.5, "1": 0.35, "2": 0.11, "3": 0.04 }, 0.69);
  const BAND2 = bandAnswers({ "0": 0.1, "1": 0.2, "2": 0.66, "3": 0.04 }, 1.64);
  const BAND3 = bandAnswers({ "0": 0.5, "1": 0.3, "2": 0.1, "3": 0.1 }, 0.8);

  function deepseekRouter(answers: SystemOneResult["answers"], extra: Partial<RouterOptions> = {}): Router {
    return new Router({ jev: stubJev(answers), roster: ROSTER, mode: "deepseek", ...extra });
  }

  it("maps bands 0 and 1 to a single v4-flash call", async () => {
    for (const [name, answers] of [
      ["band0", BAND0],
      ["band1", BAND1],
    ] as const) {
      const decision = await deepseekRouter(answers).route(request({ fingerprint: name }));
      expect(decision.model).toBe("deepseek/deepseek-v4-flash");
      expect(decision.tier).toBe("fast");
      expect(decision.samples).toBeUndefined();
      expect(decision.unsampledModel).toBeUndefined();
      expect(decision.reason).toContain("deepseek controller");
    }
  });

  it("maps band 2 to best-of-5 on v4-flash and band 3 to best-of-5 on v4.1-flash", async () => {
    const band2 = await deepseekRouter(BAND2).route(request());
    expect(band2.model).toBe("deepseek/deepseek-v4-flash");
    expect(band2.tier).toBe("mid");
    expect(band2.samples).toBe(5);
    expect(band2.unsampledModel).toBe("deepseek/deepseek-v4-flash");
    expect(band2.unsampledTier).toBeUndefined();
    expect(band2.reason).toContain("band 2");
    expect(band2.reason).toContain("best-of-5 on deepseek/deepseek-v4-flash");

    const band3 = await deepseekRouter(BAND3).route(request({ fingerprint: "band3" }));
    expect(band3.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(band3.tier).toBe("frontier");
    expect(band3.samples).toBe(5);
    expect(band3.unsampledModel).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("keeps milo.samples semantics: 1 collapses to one call on the same model, N re-sizes a sampling band only", async () => {
    const single = await deepseekRouter(BAND3).route(request({ samples: 1 }));
    expect(single.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(single.samples).toBeUndefined();

    const three = await deepseekRouter(BAND2).route(request({ fingerprint: "n3", samples: 3 }));
    expect(three.samples).toBe(3);
    expect(three.model).toBe("deepseek/deepseek-v4-flash");

    // A band that does not sample is not multiplied by an override.
    const band1 = await deepseekRouter(BAND1).route(request({ fingerprint: "b1", samples: 6 }));
    expect(band1.samples).toBeUndefined();
  });

  it("collapses every band to a single call when sampling is disabled", async () => {
    const decision = await deepseekRouter(BAND3, { samplingEnabled: false }).route(request());
    expect(decision.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(decision.samples).toBeUndefined();
  });

  it("posture does not move the band: low posture still buys the band-3 budget", async () => {
    const decision = await deepseekRouter(BAND3).route(request({ posture: "low" }));
    expect(decision.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(decision.samples).toBe(5);
  });

  it("falls back to roster resolution when candidates exclude the controller's model", async () => {
    const decision = await deepseekRouter(BAND2).route(request({ candidates: ["mid-model"] }));
    expect(decision.model).toBe("mid-model");
    expect(decision.reason).not.toContain("deepseek controller");
  });

  it("keeps the controller when candidates include its model", async () => {
    const decision = await deepseekRouter(BAND2).route(
      request({ candidates: ["deepseek/deepseek-v4-flash", "mid-model"] }),
    );
    expect(decision.model).toBe("deepseek/deepseek-v4-flash");
    expect(decision.samples).toBe(5);
  });

  it("ignores a per-request roster: the controller's model wins and forced tiers use the deployment's table", async () => {
    const theirs: Roster = { fast: ["their-fast"], mid: ["their-mid"], frontier: ["their-frontier"] };
    const routed = await deepseekRouter(BAND0).route(request({ roster: theirs }));
    expect(routed.model).toBe("deepseek/deepseek-v4-flash");

    const forced = await deepseekRouter(BAND0).route(
      request({ fingerprint: "forced", roster: theirs, forcedTier: "mid" }),
    );
    expect(forced.model).toBe("mid-model");
  });

  it("reuses a sticky controller decision, and a samples: 1 override keeps its model", async () => {
    const router = deepseekRouter(BAND3);
    const first = await router.route(request());
    const second = await router.route(request());
    expect(second.sticky).toBe(true);
    expect(second.samples).toBe(5);
    expect(second.model).toBe(first.model);

    const optedOut = await router.route(request({ samples: 1 }));
    expect(optedOut.sticky).toBe(true);
    expect(optedOut.samples).toBeUndefined();
    expect(optedOut.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(optedOut.unsampledModel).toBeUndefined();
  });

  it("defaults to roster mode: an unconfigured router never picks a deepseek model", async () => {
    const router = new Router({ jev: stubJev(BAND3), roster: ROSTER });
    const decision = await router.route(request());
    expect(decision.model).toBe("frontier-model");
    expect(decision.reason).not.toContain("deepseek");
  });
});

describe("Router.route: forwarded Jev key (ADR-021)", () => {
  const fixture = loadFixture("trivial-rename");

  /** A stub that records the per-call `apiKey` opt each systemone call saw. */
  function keyCapturingJev(
    answers: SystemOneResult["answers"],
  ): JevClientLike & { keys: Array<string | undefined> } {
    const keys: Array<string | undefined> = [];
    return {
      keys,
      systemone: (_req, opts) => {
        keys.push(opts?.apiKey);
        return Promise.resolve({
          model: "jev-latest",
          answers,
          usage: { input_tokens: 1200, output_tokens: 24 },
          requestId: "req_stub",
          latencyMs: 64,
        });
      },
    };
  }

  it("forwards RouteRequest.jevKey to the classification call as opts.apiKey", async () => {
    const jev = keyCapturingJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request({ jevKey: FAKE_KEY }));

    expect(jev.keys).toEqual([FAKE_KEY]);
  });

  it("passes no apiKey when the request carries no jevKey", async () => {
    const jev = keyCapturingJev(fixture.answers);
    const router = new Router({ jev, roster: ROSTER });

    await router.route(request());

    expect(jev.keys).toEqual([undefined]);
  });

  it("never puts the forwarded key on the decision it returns or logs", async () => {
    const jev = keyCapturingJev(fixture.answers);
    const decisions: RouteDecision[] = [];
    const router = new Router({ jev, roster: ROSTER, onDecision: (d) => decisions.push(d) });

    const decision = await router.route(request({ jevKey: FAKE_KEY }));

    expect(JSON.stringify(decision)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(decisions)).not.toContain(FAKE_KEY);
  });
});
