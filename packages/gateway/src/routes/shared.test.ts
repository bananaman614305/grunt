/**
 * `applyMiloHeaders`' own behaviour, isolated from a running gateway --
 * the routing dialects (`chat.ts`, `messages.ts`, `responses.ts`) already
 * exercise it end to end; this file just pins the header/decision mapping,
 * including the classification cache's `x-milo-cache` (ADR-023).
 */
import { describe, expect, it } from "vitest";
import { POLICY_VERSION } from "@milo/core";
import type { RouteDecision } from "@milo/core";
import { applyMiloHeaders } from "./shared.js";

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    id: "01ABCDEFGHJKMNPQRSTVWXYZ00",
    fingerprint: "fp",
    tier: "mid",
    model: "test/mid",
    reason: "test",
    policyVersion: POLICY_VERSION,
    sticky: false,
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyMiloHeaders: x-milo-cache (ADR-023)", () => {
  it("discloses hit only when the decision was served from the classification cache", () => {
    const headers = new Headers();
    applyMiloHeaders(headers, decision({ sticky: true, cached: true }));
    expect(headers.get("x-milo-cache")).toBe("hit");
  });

  it("discloses miss on an ordinary, freshly-classified decision", () => {
    const headers = new Headers();
    applyMiloHeaders(headers, decision());
    expect(headers.get("x-milo-cache")).toBe("miss");
  });

  it("discloses miss on a sticky-cache hit that is not a classification-cache hit", () => {
    const headers = new Headers();
    applyMiloHeaders(headers, decision({ sticky: true }));
    expect(headers.get("x-milo-cache")).toBe("miss");
  });

  it("discloses miss on a forced tier, which carries no signals at all", () => {
    const headers = new Headers();
    applyMiloHeaders(headers, decision({ sticky: false, signals: undefined }));
    expect(headers.get("x-milo-cache")).toBe("miss");
  });
});
