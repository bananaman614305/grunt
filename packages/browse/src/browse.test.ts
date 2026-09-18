import { describe, expect, it, vi } from "vitest";
import type { JevAnswer, JevClientLike, SystemOneRequest, SystemOneResult } from "@milo/core";
import { runBrowseTask, type NeedsHumanEvent } from "./browse.js";
import { FakeDriver } from "./driver.js";
import { NONE_CHOICE } from "./questions.js";
import type { PageObservation } from "./types.js";

// --- a fake Jev brain that grades the content-free state as the questions ask

type SummaryElement = { ref: string; role: string; label?: string };
type ObsState = { url: string; title: string; elements: SummaryElement[] };

function tokens(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

const DESTRUCTIVE = /transfer|pay|delete|deactivate|remove|send|confirm|buy|order/;

function defaultKind(s: ObsState): { choice: string; confidence: number } {
  const u = s.url.toLowerCase();
  const t = s.title.toLowerCase();
  const labels = s.elements.map((e) => (e.label ?? "").toLowerCase()).join(" ");
  if (u.includes("captcha") || labels.includes("robot")) return { choice: "captcha", confidence: 0.95 };
  if (u.includes("consent") || labels.includes("accept cookies")) return { choice: "consent", confidence: 0.9 };
  if (u.includes("login") || t.includes("sign in")) return { choice: "login", confidence: 0.9 };
  if (t.includes("dashboard") || u.includes("home")) return { choice: "dashboard", confidence: 0.88 };
  if (u.includes("done") || t.includes("export") || u.includes("result") || t.includes("success")) {
    return { choice: "result", confidence: 0.9 };
  }
  return { choice: "other", confidence: 0.6 };
}

type Brain = {
  kind?: (s: ObsState) => { choice: string; confidence: number };
  humanGate?: (s: ObsState) => number;
  locate?: (goal: string, candidates: SummaryElement[]) => { choice: string; confidence: number };
  sensitive?: (goal: string, candidate: SummaryElement) => number;
  verify?: () => number;
};

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };

function brainJev(brain: Brain = {}): JevClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  const reply = (answers: Record<string, JevAnswer>): Promise<SystemOneResult> =>
    Promise.resolve({
      model: "jev-latest",
      answers,
      usage: { input_tokens: 10, output_tokens: 2 },
      requestId: "req",
      latencyMs: 5,
    } satisfies SystemOneResult);

  return {
    calls,
    systemone(req) {
      calls.push(req);
      const key = Object.keys(req.questions)[0];
      const state = req.state as Record<string, unknown>;

      if (key === "page_kind") {
        const r = (brain.kind ?? defaultKind)(state as unknown as ObsState);
        return reply({ page_kind: { type: "choice", choice: r.choice, confidence: r.confidence, probabilities: { [r.choice]: r.confidence } } });
      }
      if (key === "human_gate") {
        const s = state as unknown as ObsState;
        const n = brain.humanGate?.(s) ?? (["captcha", "consent"].includes(defaultKind(s).choice) ? 0.95 : 0.05);
        return reply({ human_gate: { type: "noul", noul: n } });
      }
      if (key === "element") {
        const goal = state["goal"] as string;
        const candidates = state["candidates"] as SummaryElement[];
        const r = (brain.locate ?? defaultLocate)(goal, candidates);
        return reply({ element: { type: "choice", choice: r.choice, confidence: r.confidence, probabilities: { [r.choice]: r.confidence } } });
      }
      if (key === "sensitive") {
        const goal = state["goal"] as string;
        const candidate = state["candidate"] as SummaryElement;
        const n = brain.sensitive?.(goal, candidate) ?? (DESTRUCTIVE.test((candidate.label ?? "").toLowerCase()) ? 0.9 : 0.05);
        return reply({ sensitive: { type: "noul", noul: n } });
      }
      if (key === "succeeded") {
        return reply({ succeeded: { type: "noul", noul: brain.verify?.() ?? 0.9 } });
      }
      throw new Error(`unexpected question ${String(key)}`);
    },
  };
}

function defaultLocate(goal: string, candidates: SummaryElement[]): { choice: string; confidence: number } {
  const goalTokens = new Set(tokens(goal));
  for (const c of candidates) {
    if (tokens(c.label ?? "").some((t) => goalTokens.has(t))) return { choice: c.ref, confidence: 0.85 };
  }
  return { choice: NONE_CHOICE, confidence: 0.3 };
}

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
  elements: [{ ref: "d1", role: "button", text: "Export report" }],
};
const RESULT: PageObservation = {
  url: "https://app.example.com/done",
  title: "Exported",
  elements: [],
};

// --- 1. happy path ---------------------------------------------------------

describe("runBrowseTask happy path", () => {
  it("walks login -> dashboard -> result with clicks and finishes done", async () => {
    const driver = new FakeDriver([LOGIN, DASHBOARD, RESULT]);
    const result = await runBrowseTask({
      driver,
      jev: brainJev(),
      goal: "sign in and export the report",
      maxSteps: 6,
    });
    expect(result.status).toBe("done");
    expect(result.trace.map((s) => s.pageKind)).toEqual(["login", "dashboard", "result"]);
    expect(result.trace[0]?.action).toEqual({ kind: "click", ref: "e3" });
    expect(result.trace[1]?.action).toEqual({ kind: "click", ref: "d1" });
    expect(driver.actions.filter((a) => a.kind === "click")).toHaveLength(2);
  });
});

// --- 2. captcha pause ------------------------------------------------------

describe("runBrowseTask gate pause", () => {
  it("pauses for a human on a captcha wall", async () => {
    const captcha: PageObservation = {
      url: "https://app.example.com/captcha",
      title: "Verify",
      elements: [{ ref: "c1", role: "button", text: "I am not a robot" }],
    };
    const onNeedsHuman = vi.fn<(e: NeedsHumanEvent) => void>();
    const result = await runBrowseTask({
      driver: new FakeDriver([captcha]),
      jev: brainJev(),
      goal: "open the account",
      maxSteps: 4,
      onNeedsHuman,
    });
    expect(result.status).toBe("needs_human");
    expect(result.needsHuman).toEqual({ reason: "gate", step: 0 });
    expect(result.trace[0]?.gateBlocked).toBe(true);
    expect(onNeedsHuman).toHaveBeenCalledWith(expect.objectContaining({ reason: "gate", pageKind: "captcha" }));
  });
});

// --- 3. sensitive pause ----------------------------------------------------

describe("runBrowseTask sensitive pause", () => {
  it("pauses for a human before an irreversible money-moving action", async () => {
    const checkout: PageObservation = {
      url: "https://bank.example.com/checkout",
      title: "Checkout",
      elements: [{ ref: "pay", role: "button", text: "Transfer $4,000" }],
    };
    const onNeedsHuman = vi.fn<(e: NeedsHumanEvent) => void>();
    const result = await runBrowseTask({
      driver: new FakeDriver([checkout]),
      jev: brainJev(),
      goal: "transfer the balance",
      maxSteps: 4,
      onNeedsHuman,
    });
    expect(result.status).toBe("needs_human");
    expect(result.needsHuman).toEqual({ reason: "sensitive", step: 0 });
    expect(result.trace[0]?.sensitive?.flagged).toBe(true);
    expect(result.trace[0]?.action).toBeUndefined(); // paused BEFORE acting
    expect(onNeedsHuman).toHaveBeenCalledWith(expect.objectContaining({ reason: "sensitive", ref: "pay" }));
  });
});

// --- 4. low-confidence escalation ------------------------------------------

describe("runBrowseTask escalation", () => {
  it("escalates when locate is not confident enough to act", async () => {
    const page: PageObservation = {
      url: "https://app.example.com/page",
      title: "Page",
      elements: [{ ref: "a1", role: "button", text: "Frobnicate" }],
    };
    const result = await runBrowseTask({
      driver: new FakeDriver([page]),
      jev: brainJev({ locate: () => ({ choice: "a1", confidence: 0.3 }) }),
      goal: "export the report",
      maxSteps: 4,
      minConfidence: 0.5,
    });
    expect(result.status).toBe("escalated");
    expect(result.escalation).toEqual({ reason: "low_confidence", step: 0 });
    expect(result.trace[0]?.located).toEqual({ ref: "a1", confidence: 0.3 });
    expect(result.trace[0]?.action).toBeUndefined();
  });

  it("escalates as no_candidate when locate abstains", async () => {
    const page: PageObservation = {
      url: "https://app.example.com/page",
      title: "Page",
      elements: [{ ref: "a1", role: "button", text: "Frobnicate" }],
    };
    const result = await runBrowseTask({
      driver: new FakeDriver([page]),
      jev: brainJev(),
      goal: "xyzzy plugh",
      maxSteps: 4,
    });
    expect(result.status).toBe("escalated");
    expect(result.escalation).toEqual({ reason: "no_candidate", step: 0 });
  });
});

// --- 5. verify-failed retry ------------------------------------------------

describe("runBrowseTask verify retry", () => {
  it("retries a failed action once, then proceeds when verify passes", async () => {
    const form: PageObservation = {
      url: "https://app.example.com/form",
      title: "Form",
      elements: [{ ref: "s1", role: "button", text: "Submit" }],
    };
    const driver = new FakeDriver([form, RESULT]);
    let verifyCall = 0;
    const result = await runBrowseTask({
      driver,
      jev: brainJev({ verify: () => (verifyCall++ === 0 ? 0.2 : 0.9) }),
      goal: "submit the form",
      maxSteps: 4,
    });
    expect(result.status).toBe("done");
    expect(result.trace[0]?.retries).toBe(1);
    expect(result.trace[0]?.verify?.success).toBe(true);
    expect(driver.actions.filter((a) => a.kind === "click" && a.ref === "s1")).toHaveLength(2);
  });

  it("escalates when verify keeps failing past the retry budget", async () => {
    const form: PageObservation = {
      url: "https://app.example.com/form",
      title: "Form",
      elements: [{ ref: "s1", role: "button", text: "Submit" }],
    };
    const result = await runBrowseTask({
      driver: new FakeDriver([form, RESULT]),
      jev: brainJev({ verify: () => 0.1 }),
      goal: "submit the form",
      maxSteps: 4,
      maxRetries: 1,
    });
    expect(result.status).toBe("escalated");
    expect(result.escalation).toEqual({ reason: "verify_failed", step: 0 });
    expect(result.trace[0]?.retries).toBe(1);
  });
});

// --- credentials never leak ------------------------------------------------

describe("runBrowseTask keeps credentials out of Jev and the trace", () => {
  it("types a caller-supplied value without it reaching a gate, the trace, or a recordable driver slot", async () => {
    const driver = new FakeDriver([LOGIN]);
    const jev = brainJev({ locate: () => ({ choice: "e2", confidence: 0.9 }) });
    const secret = "hunter2-do-not-log";
    const result = await runBrowseTask({
      driver,
      jev,
      goal: "enter the password",
      maxSteps: 1,
      inputs: { password: secret },
    });
    // The action was a type on the password field...
    expect(result.trace[0]?.action).toEqual({ kind: "type", ref: "e2" });
    expect(driver.actions.some((a) => a.kind === "type" && a.hasText === true)).toBe(true);
    // ...but the secret appears nowhere: not in the trace, not in any Jev call, not in a recorded action.
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(jev.calls)).not.toContain(secret);
    expect(JSON.stringify(driver.actions)).not.toContain(secret);
  });
});
