/**
 * The preference store's contract (ADR-011): what Milo remembers about how a
 * caller wants answers produced and presented, without ever storing what the
 * caller said.
 *
 * Every row is a *closed-vocabulary label*, one per (caller, scope, field).
 * The caller is the SHA-256 of the bearer credential, exactly as per-key
 * rosters are keyed (ADR-008, ADR-003); the scope is `"global"` or one task
 * type; the field is one of seven names fixed below; the value is a member of
 * that field's fixed vocabulary. `provenance` is the fingerprint hash of the
 * teaching turn -- a digest the caller passes in, never content.
 *
 * Upsert semantics are the ADR's: **repetition raises confidence** (noisy-or,
 * capped at 1) and keeps the version; **contradiction replaces the value**,
 * bumps the version, and resets confidence to the new observation's.
 *
 * `DecisionLog` implements this, for the same reason it implements
 * `RosterStore`: one database, one migration path, one file to back up.
 */

import { COST_POSTURES, TASK_TYPES, TIERS } from "../types.js";
import type { TaskType } from "../types.js";
import { assertKeyHash } from "../log/roster-store.js";

// ---------------------------------------------------------------------------
// The closed vocabulary
// ---------------------------------------------------------------------------

/**
 * Fields that shape *routing*: they set the caller's default posture, a
 * minimum tier, and whether best-of-N sampling (ADR-010) may spend their
 * budget. These never enter the prompt; the gateway applies them before the
 * policy runs (`routingDefaults` in `./brief.ts`).
 */
export const ROUTING_SHAPING_FIELDS = ["posture_default", "tier_floor", "sampling"] as const;

/**
 * Fields that shape *output*: they compile into the injected brief
 * (`compileBrief` in `./brief.ts`) and never touch routing.
 */
export const OUTPUT_SHAPING_FIELDS = ["verbosity", "format", "evidence_style", "testing_depth"] as const;

export const PREFERENCE_FIELDS = [...ROUTING_SHAPING_FIELDS, ...OUTPUT_SHAPING_FIELDS] as const;

export type RoutingShapingField = (typeof ROUTING_SHAPING_FIELDS)[number];
export type OutputShapingField = (typeof OUTPUT_SHAPING_FIELDS)[number];
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];

/**
 * Every value a field can hold. A value outside its field's list is refused
 * at the store boundary: the vocabulary being closed is what makes the table
 * content-free (ADR-011), so it is enforced where rows are written, not just
 * where questions are asked.
 */
export const PREFERENCE_VALUES: Record<PreferenceField, readonly string[]> = {
  posture_default: COST_POSTURES,
  tier_floor: TIERS,
  sampling: ["on", "off"],
  verbosity: ["concise", "balanced", "detailed"],
  format: ["prose", "bullets", "code_first"],
  evidence_style: ["citations", "examples", "assertions"],
  testing_depth: ["none", "smoke", "thorough"],
};

/** `"global"`, or one task type the preference is limited to. */
export const GLOBAL_SCOPE = "global";
export type PreferenceScope = typeof GLOBAL_SCOPE | TaskType;

export function isPreferenceField(value: string): value is PreferenceField {
  return (PREFERENCE_FIELDS as readonly string[]).includes(value);
}

export function isOutputShapingField(value: string): value is OutputShapingField {
  return (OUTPUT_SHAPING_FIELDS as readonly string[]).includes(value);
}

export function isRoutingShapingField(value: string): value is RoutingShapingField {
  return (ROUTING_SHAPING_FIELDS as readonly string[]).includes(value);
}

export function isPreferenceScope(value: string): value is PreferenceScope {
  return value === GLOBAL_SCOPE || (TASK_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type PreferenceRow = {
  /** ulid; what `DELETE /v1/preferences/:id` names. */
  id: string;
  /** SHA-256 hex of the caller's credential. Never the credential. */
  keyHash: string;
  scope: PreferenceScope;
  field: PreferenceField;
  value: string;
  /** 0..1. Raised by repetition, reset by contradiction. */
  confidence: number;
  /** Starts at 1; a contradiction that replaces the value bumps it. */
  version: number;
  /** Fingerprint hash of the teaching turn. A digest, never content. */
  provenance: string;
  createdAt: string;
  updatedAt: string;
};

/** What one capture observation asks the store to record. */
export type PreferenceCandidate = {
  scope: PreferenceScope;
  field: PreferenceField;
  value: string;
  /** 0..1; the observation's own confidence, from the resolution answers. */
  confidence: number;
  /** Fingerprint-style hash of the turn that taught it. */
  provenance: string;
  /** ISO 8601 write time; defaults to now. Injectable for tests. */
  now?: string;
};

/** The per-key switches: capture off entirely, or the brief off (ADR-011). */
export type PreferenceSettings = {
  keyHash: string;
  captureEnabled: boolean;
  briefEnabled: boolean;
};

export type PreferenceStore = {
  getPreference(
    keyHash: string,
    scope: PreferenceScope,
    field: PreferenceField,
  ): Promise<PreferenceRow | undefined>;
  /** Every row this key stored, highest confidence first. */
  listPreferences(keyHash: string): Promise<PreferenceRow[]>;
  /** Applies the ADR-011 upsert semantics; see `mergeCandidate`. */
  upsertPreference(keyHash: string, candidate: PreferenceCandidate): Promise<PreferenceRow>;
  /** True when the row existed *and* belonged to this key. */
  deletePreference(keyHash: string, id: string): Promise<boolean>;
  /** Both switches default to on for a key that never wrote a row. */
  getPreferenceSettings(keyHash: string): Promise<PreferenceSettings>;
  setPreferenceSettings(
    keyHash: string,
    patch: Partial<Pick<PreferenceSettings, "captureEnabled" | "briefEnabled">>,
  ): Promise<PreferenceSettings>;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A provenance is a fingerprint-style hex digest. Anything else -- prose, a
 * key, message content -- is refused before it can land in a row.
 */
const PROVENANCE = /^[0-9a-f]{8,128}$/;

/** Guards every write: hash-keyed, closed vocabulary, digest provenance. */
export function assertPreferenceCandidate(keyHash: string, candidate: PreferenceCandidate): void {
  assertKeyHash(keyHash);
  if (!isPreferenceField(candidate.field)) {
    throw new Error(`preference store: unknown field "${candidate.field}"`);
  }
  if (!isPreferenceScope(candidate.scope)) {
    throw new Error(`preference store: scope must be "global" or a task type, got "${candidate.scope}"`);
  }
  const vocabulary = PREFERENCE_VALUES[candidate.field];
  if (!vocabulary.includes(candidate.value)) {
    throw new Error(
      `preference store: "${candidate.value}" is not in the ${candidate.field} vocabulary ` +
        `(${vocabulary.join(", ")})`,
    );
  }
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error("preference store: confidence must be a number in [0, 1]");
  }
  if (!PROVENANCE.test(candidate.provenance)) {
    throw new Error(
      "preference store: provenance must be a fingerprint-style hex digest, never content or a key",
    );
  }
}

// ---------------------------------------------------------------------------
// Upsert semantics (pure, so tests and implementations share one rule)
// ---------------------------------------------------------------------------

/**
 * Repetition: the same value observed again. Combined as noisy-or --
 * `1 - (1 - a)(1 - b)` -- so each repetition raises confidence, the rise
 * shrinks as certainty grows, and the value can approach but never exceed 1.
 */
export function reinforcedConfidence(existing: number, observed: number): number {
  return Math.min(1, 1 - (1 - existing) * (1 - observed));
}

/** The fields of a row that an upsert decides. */
export type MergedPreference = {
  value: string;
  confidence: number;
  version: number;
  provenance: string;
};

/**
 * The ADR-011 upsert rule. With no existing row: version 1, the observation
 * as-is. Same value again: confidence reinforced (cap 1), version kept.
 * A different value: replaced, version bumped, confidence reset to the new
 * observation's. Provenance always follows the latest teaching turn.
 */
export function mergeCandidate(
  existing: Pick<PreferenceRow, "value" | "confidence" | "version"> | undefined,
  candidate: Pick<PreferenceCandidate, "value" | "confidence" | "provenance">,
): MergedPreference {
  if (existing === undefined) {
    return {
      value: candidate.value,
      confidence: candidate.confidence,
      version: 1,
      provenance: candidate.provenance,
    };
  }
  if (existing.value === candidate.value) {
    return {
      value: existing.value,
      confidence: reinforcedConfidence(existing.confidence, candidate.confidence),
      version: existing.version,
      provenance: candidate.provenance,
    };
  }
  return {
    value: candidate.value,
    confidence: candidate.confidence,
    version: existing.version + 1,
    provenance: candidate.provenance,
  };
}
