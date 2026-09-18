/**
 * The preference store (ADR-011), exercised through `DecisionLog`, which
 * implements it: closed-vocabulary enforcement, the upsert semantics
 * (repetition reinforces, contradiction replaces and re-versions), per-key
 * scoping of reads and deletes, and the per-key settings switches.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog } from "../log/decision-log.js";
import {
  GLOBAL_SCOPE,
  OUTPUT_SHAPING_FIELDS,
  PREFERENCE_FIELDS,
  PREFERENCE_VALUES,
  ROUTING_SHAPING_FIELDS,
  mergeCandidate,
  reinforcedConfidence,
} from "./store.js";
import type { PreferenceCandidate } from "./store.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PROVENANCE = "0123456789abcdef0123456789abcdef";

function candidate(overrides: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    scope: GLOBAL_SCOPE,
    field: "verbosity",
    value: "concise",
    confidence: 0.8,
    provenance: PROVENANCE,
    now: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("vocabulary", () => {
  it("splits the seven fields into the two ADR-011 families", () => {
    expect(ROUTING_SHAPING_FIELDS).toEqual(["posture_default", "tier_floor", "sampling"]);
    expect(OUTPUT_SHAPING_FIELDS).toEqual(["verbosity", "format", "evidence_style", "testing_depth"]);
    expect(PREFERENCE_FIELDS).toHaveLength(7);
  });

  it("gives every field a non-empty closed value list", () => {
    for (const field of PREFERENCE_FIELDS) {
      expect(PREFERENCE_VALUES[field].length).toBeGreaterThan(0);
    }
  });
});

describe("mergeCandidate", () => {
  it("creates at version 1 with the observation's confidence", () => {
    expect(mergeCandidate(undefined, { value: "concise", confidence: 0.8, provenance: PROVENANCE })).toEqual({
      value: "concise",
      confidence: 0.8,
      version: 1,
      provenance: PROVENANCE,
    });
  });

  it("reinforces on repetition, capped at 1, keeping the version", () => {
    const merged = mergeCandidate(
      { value: "concise", confidence: 0.8, version: 3 },
      { value: "concise", confidence: 0.9, provenance: PROVENANCE },
    );
    expect(merged.version).toBe(3);
    expect(merged.confidence).toBeCloseTo(reinforcedConfidence(0.8, 0.9));
    expect(merged.confidence).toBeGreaterThan(0.9);
    expect(merged.confidence).toBeLessThanOrEqual(1);
  });

  it("never pushes confidence past 1 however often a value repeats", () => {
    let confidence = 0.9;
    for (let i = 0; i < 50; i++) confidence = reinforcedConfidence(confidence, 0.95);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it("replaces on contradiction: new value, bumped version, reset confidence", () => {
    const merged = mergeCandidate(
      { value: "concise", confidence: 0.97, version: 2 },
      { value: "detailed", confidence: 0.6, provenance: PROVENANCE },
    );
    expect(merged).toEqual({ value: "detailed", confidence: 0.6, version: 3, provenance: PROVENANCE });
  });
});

describe("DecisionLog as PreferenceStore", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  it("round-trips a first observation as a version-1 row", async () => {
    const row = await log.upsertPreference(HASH_A, candidate());
    expect(row).toMatchObject({
      keyHash: HASH_A,
      scope: "global",
      field: "verbosity",
      value: "concise",
      confidence: 0.8,
      version: 1,
      provenance: PROVENANCE,
    });
    expect(await log.getPreference(HASH_A, "global", "verbosity")).toEqual(row);
  });

  it("keeps id and createdAt across both repetition and contradiction", async () => {
    const first = await log.upsertPreference(HASH_A, candidate());
    const repeated = await log.upsertPreference(
      HASH_A,
      candidate({ confidence: 0.7, now: "2026-09-18T01:00:00.000Z" }),
    );
    expect(repeated.id).toBe(first.id);
    expect(repeated.createdAt).toBe(first.createdAt);
    expect(repeated.version).toBe(1);
    expect(repeated.confidence).toBeCloseTo(reinforcedConfidence(0.8, 0.7));

    const contradicted = await log.upsertPreference(
      HASH_A,
      candidate({ value: "detailed", confidence: 0.6, now: "2026-09-18T02:00:00.000Z" }),
    );
    expect(contradicted.id).toBe(first.id);
    expect(contradicted.version).toBe(2);
    expect(contradicted.value).toBe("detailed");
    expect(contradicted.confidence).toBe(0.6);
    expect(await log.listPreferences(HASH_A)).toHaveLength(1);
  });

  it("keeps (scope, field) rows separate: a task-scoped row is not the global one", async () => {
    await log.upsertPreference(HASH_A, candidate());
    await log.upsertPreference(HASH_A, candidate({ scope: "review", value: "detailed" }));
    const rows = await log.listPreferences(HASH_A);
    expect(rows).toHaveLength(2);
    expect((await log.getPreference(HASH_A, "review", "verbosity"))?.value).toBe("detailed");
    expect((await log.getPreference(HASH_A, "global", "verbosity"))?.value).toBe("concise");
  });

  it("lists highest confidence first", async () => {
    await log.upsertPreference(HASH_A, candidate({ field: "format", value: "bullets", confidence: 0.4 }));
    await log.upsertPreference(HASH_A, candidate({ confidence: 0.9 }));
    const rows = await log.listPreferences(HASH_A);
    expect(rows.map((r) => r.field)).toEqual(["verbosity", "format"]);
  });

  it("scopes reads and deletes to the key hash", async () => {
    const row = await log.upsertPreference(HASH_A, candidate());
    expect(await log.listPreferences(HASH_B)).toEqual([]);
    // The other key cannot delete it, even knowing the id.
    expect(await log.deletePreference(HASH_B, row.id)).toBe(false);
    expect(await log.deletePreference(HASH_A, row.id)).toBe(true);
    expect(await log.deletePreference(HASH_A, row.id)).toBe(false);
    expect(await log.listPreferences(HASH_A)).toEqual([]);
  });

  it("refuses a raw credential where the hash belongs", async () => {
    await expect(log.upsertPreference("sk-or-v1-oops", candidate())).rejects.toThrow(/digest/);
    await expect(log.listPreferences("Bearer sk-or-v1-oops")).rejects.toThrow(/digest/);
  });

  it("refuses values and fields outside the closed vocabulary", async () => {
    await expect(log.upsertPreference(HASH_A, candidate({ value: "be very terse please" }))).rejects.toThrow(
      /vocabulary/,
    );
    await expect(
      log.upsertPreference(HASH_A, candidate({ field: "tone" as never })),
    ).rejects.toThrow(/unknown field/);
    await expect(
      log.upsertPreference(HASH_A, candidate({ scope: "everything" as never })),
    ).rejects.toThrow(/scope/);
  });

  it("refuses provenance that is not a fingerprint-style digest", async () => {
    await expect(
      log.upsertPreference(HASH_A, candidate({ provenance: "the user said to be concise" })),
    ).rejects.toThrow(/provenance/);
  });

  it("defaults both per-key switches to on, and patches them independently", async () => {
    expect(await log.getPreferenceSettings(HASH_A)).toEqual({
      keyHash: HASH_A,
      captureEnabled: true,
      briefEnabled: true,
    });

    await log.setPreferenceSettings(HASH_A, { captureEnabled: false });
    expect(await log.getPreferenceSettings(HASH_A)).toEqual({
      keyHash: HASH_A,
      captureEnabled: false,
      briefEnabled: true,
    });

    await log.setPreferenceSettings(HASH_A, { briefEnabled: false });
    const settings = await log.getPreferenceSettings(HASH_A);
    expect(settings.captureEnabled).toBe(false);
    expect(settings.briefEnabled).toBe(false);
    // Another key's switches are untouched.
    expect(await log.getPreferenceSettings(HASH_B)).toMatchObject({ captureEnabled: true });
  });
});
