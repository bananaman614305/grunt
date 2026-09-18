/**
 * `maybeCapture` (ADR-011): fires the resolution call only when detection
 * rode the routing answers, respects the per-key switch, stores only
 * closed-vocabulary labels, and never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog, PREFERENCE_SCOPE_KEY, PREFERENCE_VALUE_KEY } from "@milo/core";
import type { JevAnswer, JevClientLike, RouteSignals, SystemOneRequest, SystemOneResult } from "@milo/core";
import { maybeCapture } from "./capture.js";

const HASH = "d".repeat(64);
const FINGERPRINT = "e".repeat(64);
const MESSAGES = [{ role: "user" as const, content: "Never add tests unless I ask. Now rename this function." }];

function signals(overrides: Partial<RouteSignals> = {}): RouteSignals {
  return {
    taskType: "edit",
    difficulty: 0.4,
    difficultyLevels: [],
    needsReasoning: 0.2,
    longOutput: 0.1,
    confidences: {},
    jevRequestId: "req-1",
    jevModel: "jev-latest",
    latencyMs: 120,
    capture: { field: "testing_depth", detection: 0.9, fieldConfidence: 0.85 },
    ...overrides,
  };
}

function choice(value: string, confidence: number): JevAnswer {
  return { type: "choice", choice: value, confidence, probabilities: { [value]: confidence } };
}

/** A Jev stub that records what it was asked and answers from a script. */
function fakeJev(answers: Record<string, JevAnswer>): {
  jev: JevClientLike;
  calls: Array<Omit<SystemOneRequest, "model"> & { model?: string }>;
} {
  const calls: Array<Omit<SystemOneRequest, "model"> & { model?: string }> = [];
  const jev: JevClientLike = {
    systemone: (req) => {
      calls.push(req);
      const result: SystemOneResult = {
        model: "jev-latest",
        answers,
        usage: { input_tokens: 10, output_tokens: 2 },
        requestId: "req-cap",
        latencyMs: 40,
      };
      return Promise.resolve(result);
    },
  };
  return { jev, calls };
}

const RESOLUTION_ANSWERS = {
  [PREFERENCE_VALUE_KEY]: choice("none", 0.9),
  [PREFERENCE_SCOPE_KEY]: choice("global", 0.8),
};

let log: DecisionLog;

beforeEach(async () => {
  log = await DecisionLog.open(":memory:");
});

afterEach(async () => {
  await log.close();
});

describe("maybeCapture", () => {
  it("resolves and stores the preference when detection fired", async () => {
    const { jev, calls } = fakeJev(RESOLUTION_ANSWERS);
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals(),
      provenance: FINGERPRINT,
    });

    expect(row).toMatchObject({
      keyHash: HASH,
      scope: "global",
      field: "testing_depth",
      value: "none",
      version: 1,
      provenance: FINGERPRINT,
    });
    // The weaker of detection (0.9) and value confidence (0.9).
    expect(row?.confidence).toBeCloseTo(0.9);

    // One resolution call, asking only over testing_depth's vocabulary.
    expect(calls).toHaveLength(1);
    const valueQuestion = calls[0]?.questions[PREFERENCE_VALUE_KEY];
    expect(valueQuestion?.type).toBe("choice");
    if (valueQuestion?.type === "choice") {
      expect(Object.keys(valueQuestion.criteria).sort()).toEqual(["none", "smoke", "thorough"]);
    }

    expect(await log.listPreferences(HASH)).toHaveLength(1);
  });

  it("scopes to the routed task type on a task_only answer", async () => {
    const { jev } = fakeJev({
      ...RESOLUTION_ANSWERS,
      [PREFERENCE_SCOPE_KEY]: choice("task_only", 0.8),
    });
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals(),
      provenance: FINGERPRINT,
    });
    expect(row?.scope).toBe("edit");
  });

  it("does nothing when detection did not fire, and spends no Jev call", async () => {
    const { jev, calls } = fakeJev(RESOLUTION_ANSWERS);
    const undetected = signals();
    delete undetected.capture;
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: undetected,
      provenance: FINGERPRINT,
    });
    expect(row).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await log.listPreferences(HASH)).toEqual([]);
  });

  it("does nothing without a Jev client (a hand-built AppDeps)", async () => {
    const row = await maybeCapture(log, undefined, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals(),
      provenance: FINGERPRINT,
    });
    expect(row).toBeUndefined();
  });

  it("honours the per-key captureEnabled switch before spending the call", async () => {
    await log.setPreferenceSettings(HASH, { captureEnabled: false });
    const { jev, calls } = fakeJev(RESOLUTION_ANSWERS);
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals(),
      provenance: FINGERPRINT,
    });
    expect(row).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("drops a weak or alien resolution instead of storing it", async () => {
    const weak = fakeJev({ ...RESOLUTION_ANSWERS, [PREFERENCE_VALUE_KEY]: choice("none", 0.3) });
    expect(
      await maybeCapture(log, weak.jev, {
        keyHash: HASH,
        messages: MESSAGES,
        signals: signals(),
        provenance: FINGERPRINT,
      }),
    ).toBeUndefined();

    const alien = fakeJev({ ...RESOLUTION_ANSWERS, [PREFERENCE_VALUE_KEY]: choice("interpretive_dance", 0.99) });
    expect(
      await maybeCapture(log, alien.jev, {
        keyHash: HASH,
        messages: MESSAGES,
        signals: signals(),
        provenance: FINGERPRINT,
      }),
    ).toBeUndefined();
    expect(await log.listPreferences(HASH)).toEqual([]);
  });

  it("ignores an unknown detection field without asking Jev", async () => {
    const { jev, calls } = fakeJev(RESOLUTION_ANSWERS);
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals({ capture: { field: "tone", detection: 0.95, fieldConfidence: 0.9 } }),
      provenance: FINGERPRINT,
    });
    expect(row).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("turns a Jev failure into a warning, never a throw", async () => {
    const jev: JevClientLike = {
      systemone: () => Promise.reject(new Error("jev down")),
    };
    const warnings: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      error: () => undefined,
    };
    const row = await maybeCapture(log, jev, {
      keyHash: HASH,
      messages: MESSAGES,
      signals: signals(),
      provenance: FINGERPRINT,
      logger,
    });
    expect(row).toBeUndefined();
    expect(warnings).toContain("preference capture failed");
  });
});
