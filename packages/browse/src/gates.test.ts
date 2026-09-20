import { describe, expect, it } from "vitest";
import type { JevAnswer, JevClientLike, SystemOneRequest, SystemOneResult } from "@milo/core";
import { gate, locate, observe, sensitive, verify, candidateSummary, observationState } from "./gates.js";
import { NONE_CHOICE } from "./questions.js";
import type { ElementCandidate, IntendedAction, PageObservation } from "./types.js";

// --- fixtures --------------------------------------------------------------

const LOGIN: PageObservation = {
  url: "https://app.example.com/login",
  title: "Sign in",
  elements: [
    { ref: "e1", role: "textbox", text: "Email", testid: "username" },
    { ref: "e2", role: "textbox", text: "Password", testid: "password" },
    { ref: "e3", role: "button", text: "Sign in" },
  ],
};

const DASHBOARD: PageObservation = {
  url: "https://app.example.com/home",
  title: "Dashboard",
  elements: [{ ref: "d1", role: "button", text: "Export report", bbox: { x: 1, y: 2, width: 3, height: 4 } }],
};

// --- a fake Jev keyed on which question set it was handed ------------------

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };

function jevReturning(answers: Record<string, JevAnswer>): JevClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    systemone(req) {
      calls.push(req);
      return Promise.resolve({
        model: "jev-latest",
        answers,
        usage: { input_tokens: 10, output_tokens: 2 },
        requestId: "req_browse",
        latencyMs: 15,
      } satisfies SystemOneResult);
    },
  };
}

// --- content-free state builders -------------------------------------------

describe("state builders are content-free", () => {
  it("candidateSummary carries only ref/role/label/testid/bbox", () => {
    const c: ElementCandidate = { ref: "e1", role: "button", text: "Pay now", testid: "pay", bbox: { x: 0, y: 0, width: 1, height: 1 } };
    expect(Object.keys(candidateSummary(c)).sort()).toEqual(["bbox", "label", "ref", "role", "testid"]);
  });

  it("observationState carries only url/title/elements and no html field", () => {
    const state = observationState(LOGIN);
    expect(Object.keys(state).sort()).toEqual(["elements", "title", "url"]);
    expect(JSON.stringify(state)).not.toContain("html");
  });
});

// --- observe ---------------------------------------------------------------

describe("observe", () => {
  it("maps a choice answer to a page-kind and confidence", async () => {
    const jev = jevReturning({ page_kind: { type: "choice", choice: "login", confidence: 0.82, probabilities: { login: 0.82 } } });
    const r = await observe(jev, LOGIN);
    expect(r).toEqual({ kind: "login", confidence: 0.82 });
    expect(jev.calls[0]?.questions).toHaveProperty("page_kind");
  });

  it("throws on an out-of-vocabulary page-kind", async () => {
    const jev = jevReturning({ page_kind: { type: "choice", choice: "spaceship", confidence: 0.9, probabilities: {} } });
    await expect(observe(jev, LOGIN)).rejects.toThrow(/wrong shape/);
  });
});

// --- locate ----------------------------------------------------------------

describe("locate", () => {
  it("returns the chosen ref when Jev picks a candidate", async () => {
    const jev = jevReturning({ element: { type: "choice", choice: "e3", confidence: 0.77, probabilities: { e3: 0.77 } } });
    const r = await locate(jev, "sign in", LOGIN.elements);
    expect(r).toEqual({ matched: true, ref: "e3", confidence: 0.77 });
  });

  it("treats the reserved none choice as an abstain the caller can escalate on", async () => {
    const jev = jevReturning({ element: { type: "choice", choice: NONE_CHOICE, confidence: 0.4, probabilities: {} } });
    const r = await locate(jev, "buy a house", LOGIN.elements);
    expect(r).toEqual({ matched: false, confidence: 0.4 });
  });

  it("abstains with zero confidence and makes no Jev call when there are no candidates", async () => {
    const jev = jevReturning({});
    const r = await locate(jev, "anything", []);
    expect(r).toEqual({ matched: false, confidence: 0 });
    expect(jev.calls).toHaveLength(0);
  });

  it("throws when Jev returns a ref not in the candidate list", async () => {
    const jev = jevReturning({ element: { type: "choice", choice: "ghost", confidence: 0.9, probabilities: {} } });
    await expect(locate(jev, "sign in", LOGIN.elements)).rejects.toThrow(/unknown element ref/);
  });

  it("sends only the goal and the compact candidate list", async () => {
    const jev = jevReturning({ element: { type: "choice", choice: "e3", confidence: 0.7, probabilities: {} } });
    await locate(jev, "sign in", LOGIN.elements);
    const state = jev.calls[0]?.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["candidates", "goal"]);
  });
});

// --- verify ----------------------------------------------------------------

describe("verify", () => {
  const intended: IntendedAction = { kind: "click", ref: "e3", role: "button", label: "Sign in" };

  it("reads noul >= 0.5 as success and reports decisiveness as confidence", async () => {
    const jev = jevReturning({ succeeded: { type: "noul", noul: 0.9 } });
    expect(await verify(jev, LOGIN, DASHBOARD, intended)).toEqual({ success: true, confidence: 0.9 });
  });

  it("reads noul < 0.5 as failure with confidence 1 - noul", async () => {
    const jev = jevReturning({ succeeded: { type: "noul", noul: 0.2 } });
    expect(await verify(jev, LOGIN, LOGIN, intended)).toEqual({ success: false, confidence: 0.8 });
  });

  it("never forwards typed text: the intended action carries no value field", async () => {
    const jev = jevReturning({ succeeded: { type: "noul", noul: 0.9 } });
    await verify(jev, LOGIN, DASHBOARD, intended);
    const state = jev.calls[0]?.state as { intendedAction: Record<string, unknown> };
    // The intended action carries kind/ref/role/label -- and crucially no text/value field.
    expect(Object.keys(state.intendedAction).sort()).toEqual(["kind", "label", "ref", "role"]);
    expect(state.intendedAction).not.toHaveProperty("text");
    expect(state.intendedAction).not.toHaveProperty("value");
  });
});

// --- gate ------------------------------------------------------------------

describe("gate", () => {
  it("flags a wall when noul is at or above the threshold", async () => {
    const jev = jevReturning({ human_gate: { type: "noul", noul: 0.95 } });
    expect(await gate(jev, LOGIN)).toEqual({ blocked: true, probability: 0.95 });
  });

  it("does not flag an ordinary page", async () => {
    const jev = jevReturning({ human_gate: { type: "noul", noul: 0.1 } });
    expect(await gate(jev, LOGIN)).toEqual({ blocked: false, probability: 0.1 });
  });
});

// --- sensitive -------------------------------------------------------------

describe("sensitive", () => {
  const payButton: ElementCandidate = { ref: "p1", role: "button", text: "Transfer $4,000" };

  it("flags an irreversible, money-moving action", async () => {
    const jev = jevReturning({ sensitive: { type: "noul", noul: 0.88 } });
    expect(await sensitive(jev, "pay the invoice", payButton)).toEqual({ flagged: true, probability: 0.88 });
  });

  it("sends only the goal and the one candidate", async () => {
    const jev = jevReturning({ sensitive: { type: "noul", noul: 0.88 } });
    await sensitive(jev, "pay the invoice", payButton);
    const state = jev.calls[0]?.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["candidate", "goal"]);
  });
});
