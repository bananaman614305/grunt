/**
 * Snapshot persistence: a small JSON store, no message content (every field
 * on `Snapshot` is already a number, a count, or a model id -- the same
 * things the decision log itself is allowed to keep).
 *
 * Two files, two purposes:
 *
 *   - The **history** file (`loadSnapshotHistory`/`appendSnapshot`) is an
 *     append-only array every canary run adds one entry to. It backs the
 *     "rolling" baseline (`rollingBaseline`): the mean of the last N runs.
 *   - A **pinned** baseline (`loadPinnedBaseline`/`savePinnedBaseline`) is one
 *     snapshot an operator chose to hold as "known good" -- an explicit
 *     `--save-baseline` rather than whatever happened to run recently.
 *
 * `Snapshot`'s rate/latency/cost fields can legitimately be `NaN` ("no
 * data", never "zero" -- the convention `packages/evals/src/report.ts` and
 * `packages/core/src/log/cost.ts` both already use). `JSON.stringify` turns
 * `NaN` into `null`, so this module converts explicitly both ways rather
 * than letting that conversion happen implicitly and silently.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tier } from "@milo/core";
import { TIERS } from "@milo/core";
import type { Snapshot } from "./snapshot.js";

/** How many entries `appendSnapshot` keeps by default; oldest are dropped first. */
export const DEFAULT_MAX_HISTORY = 200;

const NULLABLE_NUMERIC_FIELDS = ["passRate", "meanCostUsd", "latencyP50Ms", "latencyP95Ms"] as const;
type NullableNumericField = (typeof NULLABLE_NUMERIC_FIELDS)[number];

/** `Snapshot`, but the fields that can be `NaN` are `number | null` on disk. */
type JsonSnapshot = Omit<Snapshot, NullableNumericField> & Record<NullableNumericField, number | null>;

function toJson(snapshot: Snapshot): JsonSnapshot {
  const out = { ...snapshot } as unknown as JsonSnapshot;
  for (const field of NULLABLE_NUMERIC_FIELDS) {
    const value = snapshot[field];
    (out as Record<NullableNumericField, number | null>)[field] = Number.isNaN(value) ? null : value;
  }
  return out;
}

function fromJson(value: JsonSnapshot): Snapshot {
  const out = { ...value } as unknown as Snapshot;
  for (const field of NULLABLE_NUMERIC_FIELDS) {
    const value_ = (value as Record<NullableNumericField, number | null>)[field];
    (out as Record<NullableNumericField, number>)[field] = value_ === null ? NaN : value_;
  }
  return out;
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isTierCountRecord(value: unknown): value is Record<Tier, number> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return TIERS.every((tier) => typeof record[tier] === "number");
}

/** Structural check on a parsed JSON value before it is trusted as a snapshot. */
function isSnapshotLike(value: unknown): value is JsonSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["createdAt"] === "string" &&
    typeof v["policyVersion"] === "string" &&
    typeof v["posture"] === "string" &&
    typeof v["requestedSize"] === "number" &&
    typeof v["n"] === "number" &&
    typeof v["scoredN"] === "number" &&
    typeof v["unscoredN"] === "number" &&
    isNumberOrNull(v["passRate"]) &&
    isNumberOrNull(v["meanCostUsd"]) &&
    typeof v["pricedN"] === "number" &&
    isNumberOrNull(v["latencyP50Ms"]) &&
    isNumberOrNull(v["latencyP95Ms"]) &&
    isTierCountRecord(v["tierCounts"]) &&
    typeof v["modelCounts"] === "object" &&
    v["modelCounts"] !== null
  );
}

/**
 * Every snapshot in the history file at `path`, oldest first. A missing file
 * (the very first run) reads as an empty history, not an error. A file that
 * exists but is not valid JSON, or has no `snapshots` array, is an error --
 * that shape can only come from something other than `appendSnapshot`
 * writing it, and guessing at it would be worse than stopping. An individual
 * entry that does not look like a snapshot (hand-edited, or written by an
 * older, incompatible version) is skipped rather than failing the whole
 * read: the history is a rolling window, not a ledger that must balance.
 */
export function loadSnapshotHistory(path: string): Snapshot[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `canary: history file "${path}" is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const list = (parsed as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(list)) {
    throw new Error(`canary: history file "${path}" has no "snapshots" array`);
  }

  return list.filter(isSnapshotLike).map(fromJson);
}

/**
 * Appends `snapshot` to the history file at `path` (created, parent
 * directories included, if it does not exist yet), trims to `maxHistory`
 * entries (default `DEFAULT_MAX_HISTORY`), and returns the trimmed history.
 */
export function appendSnapshot(path: string, snapshot: Snapshot, opts?: { maxHistory?: number }): Snapshot[] {
  const history = loadSnapshotHistory(path);
  history.push(snapshot);
  const maxHistory = opts?.maxHistory ?? DEFAULT_MAX_HISTORY;
  const trimmed = maxHistory > 0 ? history.slice(-maxHistory) : history;

  mkdirSync(dirname(path), { recursive: true });
  const onDisk: { snapshots: JsonSnapshot[] } = { snapshots: trimmed.map(toJson) };
  writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
  return trimmed;
}

function meanOf(snapshots: readonly Snapshot[], pick: (s: Snapshot) => number): number {
  const values = snapshots.map(pick).filter((v) => !Number.isNaN(v));
  if (values.length === 0) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Reduces several snapshots to one by averaging their numeric fields.
 * `tierCounts` is averaged per tier (fractional is fine -- it only ever
 * feeds a percentage share in `./drift.ts`). `modelCounts` is left empty:
 * averaging per-model counts across runs that may have used different
 * rosters is not a meaningful number, and drift detection compares tier
 * share, not model share (see `./drift.ts`). `createdAt`/`posture` take the
 * most recent snapshot's value; `policyVersion` does too, unless the window
 * spans more than one policy version, in which case it reads `"mixed"` so a
 * drift report cannot claim a single version for an average that spans two.
 */
export function averageSnapshots(snapshots: readonly Snapshot[]): Snapshot {
  if (snapshots.length === 0) {
    throw new Error("averageSnapshots: at least one snapshot is required");
  }
  const last = snapshots[snapshots.length - 1] as Snapshot;
  const tierCounts = Object.fromEntries(
    TIERS.map((tier) => [tier, meanOf(snapshots, (s) => s.tierCounts[tier])]),
  ) as Record<Tier, number>;

  return {
    createdAt: last.createdAt,
    policyVersion: snapshots.every((s) => s.policyVersion === last.policyVersion) ? last.policyVersion : "mixed",
    posture: last.posture,
    requestedSize: Math.round(meanOf(snapshots, (s) => s.requestedSize)),
    n: Math.round(meanOf(snapshots, (s) => s.n)),
    scoredN: Math.round(meanOf(snapshots, (s) => s.scoredN)),
    unscoredN: Math.round(meanOf(snapshots, (s) => s.unscoredN)),
    passRate: meanOf(snapshots, (s) => s.passRate),
    meanCostUsd: meanOf(snapshots, (s) => s.meanCostUsd),
    pricedN: Math.round(meanOf(snapshots, (s) => s.pricedN)),
    latencyP50Ms: meanOf(snapshots, (s) => s.latencyP50Ms),
    latencyP95Ms: meanOf(snapshots, (s) => s.latencyP95Ms),
    tierCounts,
    modelCounts: {},
  };
}

/**
 * The rolling baseline: the mean of the last `window` entries of `history`.
 * `undefined` when `history` is empty (nothing to compare the first run
 * against). Pass the history read *before* the current run was appended, so
 * the current run never compares against itself.
 */
export function rollingBaseline(history: readonly Snapshot[], window: number): Snapshot | undefined {
  if (!Number.isInteger(window) || window <= 0) {
    throw new Error(`rollingBaseline: window must be a positive integer, got ${window}`);
  }
  const slice = history.slice(-window);
  return slice.length === 0 ? undefined : averageSnapshots(slice);
}

/** Reads a pinned baseline: one snapshot, previously written by `savePinnedBaseline`. */
export function loadPinnedBaseline(path: string): Snapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `canary: could not read pinned baseline "${path}" (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `canary: pinned baseline "${path}" is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!isSnapshotLike(parsed)) {
    throw new Error(`canary: pinned baseline "${path}" does not look like a snapshot`);
  }
  return fromJson(parsed);
}

/** Writes `snapshot` as a pinned baseline at `path` (parent directories created if needed). */
export function savePinnedBaseline(path: string, snapshot: Snapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(toJson(snapshot), null, 2)}\n`, "utf8");
}
