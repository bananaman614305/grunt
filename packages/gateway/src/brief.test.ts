/**
 * Brief injection (ADR-011): `routedBrief` honours both opt-outs and never
 * throws; `applyBrief` appends exactly one final system message; the
 * disclosure header comes and goes with the brief.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIEF_TEMPLATES, DecisionLog } from "@milo/core";
import type { PreferenceCandidate, PreferenceStore } from "@milo/core";
import { BRIEF_VERSION_HEADER, applyBrief, briefHeaders, routedBrief } from "./brief.js";
import type { Body } from "./routes/shared.js";

const HASH = "c".repeat(64);
const PROVENANCE = "0123456789abcdef0123456789abcdef";

function candidate(overrides: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    scope: "global",
    field: "verbosity",
    value: "concise",
    confidence: 0.8,
    provenance: PROVENANCE,
    ...overrides,
  };
}

let log: DecisionLog;

beforeEach(async () => {
  log = await DecisionLog.open(":memory:");
});

afterEach(async () => {
  await log.close();
});

describe("routedBrief", () => {
  it("compiles the caller's output-shaping rows", async () => {
    await log.upsertPreference(HASH, candidate());
    await log.upsertPreference(HASH, candidate({ field: "posture_default", value: "low" }));

    const brief = await routedBrief(log, HASH);
    expect(brief).toBeDefined();
    expect(brief?.text).toContain(BRIEF_TEMPLATES.verbosity["concise"]);
    // Routing-shaping rows shape routing, never the prompt.
    expect(brief?.text.toLowerCase()).not.toContain("cheap");
    expect(brief?.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("prefers a task-scoped row for the routed task type", async () => {
    await log.upsertPreference(HASH, candidate());
    await log.upsertPreference(HASH, candidate({ scope: "docs", value: "detailed" }));

    const forDocs = await routedBrief(log, HASH, { taskType: "docs" });
    expect(forDocs?.text).toContain(BRIEF_TEMPLATES.verbosity["detailed"]);
    const forEdit = await routedBrief(log, HASH, { taskType: "edit" });
    expect(forEdit?.text).toContain(BRIEF_TEMPLATES.verbosity["concise"]);
  });

  it("returns undefined when the caller stored nothing", async () => {
    expect(await routedBrief(log, HASH)).toBeUndefined();
  });

  it("honours the per-request opt-out without touching the store", async () => {
    await log.upsertPreference(HASH, candidate());
    expect(await routedBrief(log, HASH, { extension: { brief: false } })).toBeUndefined();
  });

  it("honours the per-key briefEnabled switch", async () => {
    await log.upsertPreference(HASH, candidate());
    await log.setPreferenceSettings(HASH, { briefEnabled: false });
    expect(await routedBrief(log, HASH)).toBeUndefined();
  });

  it("swallows a broken store: a warning, not a failed request", async () => {
    const broken = {
      getPreferenceSettings: () => Promise.reject(new Error("store down")),
    } as unknown as PreferenceStore;
    const warnings: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      error: () => undefined,
    };
    expect(await routedBrief(broken, HASH, { logger })).toBeUndefined();
    expect(warnings).toContain("preference brief read failed");
  });
});

describe("applyBrief", () => {
  const body: Body = {
    model: "milo/auto",
    messages: [
      { role: "system", content: "You are a sub-agent." },
      { role: "user", content: "Do the thing." },
    ],
    temperature: 0.2,
  };

  it("appends the brief as the final system message, leaving everything else alone", () => {
    const brief = { text: "The brief.", version: "abc123" };
    const applied = applyBrief(body, brief);
    const messages = applied["messages"] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: "system", content: "The brief." });
    expect(applied["temperature"]).toBe(0.2);
    // The input body was not mutated.
    expect((body["messages"] as unknown[]).length).toBe(2);
  });

  it("is the identity when there is no brief", () => {
    expect(applyBrief(body, undefined)).toBe(body);
  });
});

describe("briefHeaders", () => {
  it("names the version when there is one, and is empty when there is none", () => {
    expect(briefHeaders("abc123")).toEqual({ [BRIEF_VERSION_HEADER]: "abc123" });
    expect(briefHeaders(undefined)).toEqual({});
  });
});
