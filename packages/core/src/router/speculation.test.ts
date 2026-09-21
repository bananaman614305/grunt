/**
 * `Router.speculativeModel` (ADR-024): the eligibility gate for speculative
 * routing. It never calls Jev and never mutates state -- it only decides
 * whether to start a single cheap call in parallel with the classification,
 * and it is deliberately conservative.
 */

import { describe, expect, it } from "vitest";
import type { JevClientLike } from "../jev/types.js";
import type { ChatMessage, RouteRequest, RouteSignals, Roster } from "../types.js";
import { fingerprint } from "./fingerprint.js";
import { Router } from "./router.js";
import type { RouterOptions } from "./router.js";
import { ClassificationCache } from "./classification-cache.js";
import { StickyCache } from "./sticky.js";
import { countUserTurns } from "./context.js";

const ROSTER: Roster = {
  fast: ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
  mid: ["openai/gpt-5.6-luna"],
  frontier: ["z-ai/glm-5.3"],
};

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "Rename res to rows." },
];

/** A Jev that must never be called: speculativeModel is pure and offline. */
const NEVER_JEV: JevClientLike = {
  systemone: () => {
    throw new Error("speculativeModel must not call Jev");
  },
};

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    messages: MESSAGES,
    posture: "balanced",
    fingerprint: fingerprint(MESSAGES),
    ...overrides,
  };
}

function router(extra: Partial<RouterOptions> = {}): Router {
  return new Router({
    jev: NEVER_JEV,
    roster: ROSTER,
    speculation: { enabled: true },
    ...extra,
  });
}

function signals(): RouteSignals {
  return {
    taskType: "chat",
    difficulty: 0.4,
    difficultyLevels: [0.8, 0.15, 0.03, 0.02],
    needsReasoning: 0.1,
    longOutput: 0.1,
    confidences: { task_type: 0.9, difficulty: 0.8 },
    jevRequestId: "req_x",
    jevModel: "jev-latest",
    latencyMs: 40,
  };
}

describe("Router.speculativeModel (ADR-024)", () => {
  it("returns the resolved fast-tier model for a probably-easy cache-miss", () => {
    expect(router().speculativeModel(req())).toBe("deepseek/deepseek-v4-flash");
  });

  it("is off by default (no speculation config)", () => {
    const r = new Router({ jev: NEVER_JEV, roster: ROSTER });
    expect(r.speculativeModel(req())).toBeUndefined();
  });

  it("is off when explicitly disabled", () => {
    expect(router({ speculation: { enabled: false } }).speculativeModel(req())).toBeUndefined();
  });

  it("never speculates a forced tier (no Jev call to hide)", () => {
    expect(router().speculativeModel(req({ forcedTier: "frontier" }))).toBeUndefined();
  });

  it("never speculates a tool-using request", () => {
    expect(router().speculativeModel(req({ tools: [{ type: "function" }] }))).toBeUndefined();
  });

  it("never speculates on quality posture", () => {
    expect(router().speculativeModel(req({ posture: "quality" }))).toBeUndefined();
  });

  it("still speculates on low posture (biased even cheaper)", () => {
    expect(router().speculativeModel(req({ posture: "low" }))).toBe("deepseek/deepseek-v4-flash");
  });

  it("never speculates a long prompt (heuristic can't call it easy)", () => {
    const long: ChatMessage[] = [{ role: "user", content: "x".repeat(3_000) }];
    expect(router({ speculation: { enabled: true, maxPromptChars: 2_000 } }).speculativeModel(req({ messages: long, fingerprint: fingerprint(long) }))).toBeUndefined();
  });

  it("skips speculation on an in-memory sticky hit (Jev latency already hidden)", () => {
    const sticky = new StickyCache();
    const r = router({ sticky });
    const fp = fingerprint(MESSAGES);
    sticky.set(fp, {
      decision: {
        id: "d1",
        fingerprint: fp,
        tier: "fast",
        model: "deepseek/deepseek-v4-flash",
        reason: "x",
        policyVersion: "v",
        sticky: false,
        createdAt: new Date().toISOString(),
      },
      userTurns: countUserTurns(MESSAGES),
      expiresAt: Date.now() + 60_000,
    });
    expect(r.speculativeModel(req({ fingerprint: fp }))).toBeUndefined();
  });

  it("skips speculation on a classification-cache hit", () => {
    const cache = new ClassificationCache();
    const r = router({ classificationCache: cache });
    const fp = fingerprint(MESSAGES);
    cache.set(`${fp} ${countUserTurns(MESSAGES)}`, signals());
    expect(r.speculativeModel(req({ fingerprint: fp }))).toBeUndefined();
  });

  it("is off under the deepseek controller mode", () => {
    expect(router({ mode: "deepseek" }).speculativeModel(req())).toBeUndefined();
  });

  it("resolves the fast model through the candidates filter, never a mid/frontier one", () => {
    // Candidates exclude the fast default: the next allowed fast model wins,
    // and it is still a fast-tier (cheap) model, never mid/frontier.
    expect(router().speculativeModel(req({ candidates: ["z-ai/glm-5.3-flash"] }))).toBe("z-ai/glm-5.3-flash");
  });

  it("declines rather than climbing to a hard tier when candidates exclude every fast model", () => {
    // Only a frontier model is allowed. A speculative call must never be a
    // hard-tier call, so speculation declines instead of climbing to it.
    expect(router().speculativeModel(req({ candidates: ["z-ai/glm-5.3"] }))).toBeUndefined();
  });
});
