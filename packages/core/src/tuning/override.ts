/**
 * Closed-loop policy tuning, step three: the file `milo tune --apply` writes.
 *
 * ## Why this is a file and not a code edit
 *
 * ADR-012's band -> budget table in `router/controller.ts` is a MEASURED
 * artefact: "Do not change a band's budget without re-running the benchmark".
 * A tuner that rewrote that table would be editing the record of a benchmark
 * it never ran. So `--apply` writes a separate, versioned override document
 * instead, carrying the evidence that produced it and an explicit
 * `requiresBenchmark: true`. Nothing in the gateway reads it today, by design:
 * phase 1 is analyse-and-propose, and the step from "the log says this" to
 * "production does this" goes through a human, a benchmark run (`pnpm bench`)
 * or a canary, and a commit that says so.
 *
 * ## Why it is not in `types.ts`
 *
 * `types.ts` is the pinned routing contract (an ADR per change). An override
 * document is an operator artefact on disk, like `milo.config.json`: it has a
 * schema version of its own and can move without touching the contract. It
 * lives here with the code that writes it.
 */

import { z } from "zod";
import { TASK_TYPES } from "../types.js";
import type { PolicyChange, PolicyProposal } from "./propose.js";

/** Bumped when the document's shape changes in a way a reader must notice. */
export const POLICY_OVERRIDE_VERSION = 1;

/** Default path `milo tune --apply` writes to. */
export const DEFAULT_OVERRIDE_PATH = "./.milo/policy-override.json";

/** The sentence every written override carries, so the file explains itself. */
export const OVERRIDE_NOTE =
  "Proposed from the decision log by `milo tune`. NOT in force: nothing reads this file at runtime. " +
  "ADR-012's band budgets are measured, so validate any change here with a benchmark run (`pnpm bench`) " +
  "or a canary deployment before editing the policy in source.";

const bandKey = z.enum(["0", "1", "2", "3"]);
const sampleCount = z.number().int().min(1).max(8);

export const policyOverrideSchema = z
  .object({
    version: z.number().int().positive(),
    generatedAt: z.string().min(1),
    policyVersion: z.string().min(1),
    /** Always true in a written document: an override is a hypothesis. */
    requiresBenchmark: z.literal(true),
    note: z.string().min(1),
    source: z
      .object({
        decisions: z.number().int().nonnegative(),
        banded: z.number().int().nonnegative(),
        unbanded: z.number().int().nonnegative(),
        sinceIso: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .strict(),
    /** Proposed sample count per difficulty band (ADR-012's table). */
    bandSamples: z.record(bandKey, sampleCount).optional(),
    /** Proposed sample count per band and task type, overriding `bandSamples`. */
    taskSamples: z.record(bandKey, z.record(z.enum(TASK_TYPES), sampleCount)).optional(),
    /** Proposed mass thresholds (a partial `PolicyProfile`). */
    profile: z
      .object({
        fastBelowMass: z.number().min(0).max(1).optional(),
        frontierHardMass: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    /** The changes, with their evidence, exactly as the proposal reported them. */
    evidence: z.array(z.unknown()),
    caveats: z.array(z.string()),
  })
  .strict();

export type PolicyOverride = z.infer<typeof policyOverrideSchema>;

/** Parses an override document, throwing a readable error on a bad one. */
export function parsePolicyOverride(value: unknown): PolicyOverride {
  const result = policyOverrideSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`policy override: invalid document:\n${detail}`);
  }
  return result.data;
}

/** Why `--apply` refused, one line per blocking change. */
export type ApplyRefusal = { ok: false; blockers: string[] };
export type ApplyCheck = { ok: true } | ApplyRefusal;

/**
 * Whether a proposal may be written as an override.
 *
 * Refuses when there is nothing to apply, and when ANY proposed change rests on
 * fewer graded requests than `applyMinN`. All-or-nothing on purpose: an
 * override written from a mixture of well-evidenced and thin changes reads, a
 * week later, as one equally-trusted document.
 */
export function checkApplicable(proposal: PolicyProposal): ApplyCheck {
  const min = proposal.thresholds.applyMinN;
  if (proposal.changes.length === 0) {
    return { ok: false, blockers: ["the proposal contains no changes"] };
  }
  const blockers = proposal.changes
    .filter((change) => change.lowN)
    .map(
      (change) =>
        `${change.target} (${change.rule}): ${change.evidence.gradedN} graded requests, under the ${min} --apply requires`,
    );
  return blockers.length > 0 ? { ok: false, blockers } : { ok: true };
}

/** Folds the proposal's changes into the document's override maps. */
function applyChange(doc: PolicyOverride, change: PolicyChange): void {
  switch (change.kind) {
    case "band-samples": {
      if (change.band === undefined) return;
      const bands = doc.bandSamples ?? {};
      bands[String(change.band) as keyof typeof bands] = change.to;
      doc.bandSamples = bands;
      return;
    }
    case "task-samples": {
      if (change.band === undefined || change.taskType === undefined) return;
      const tasks = doc.taskSamples ?? {};
      const key = String(change.band) as keyof typeof tasks;
      const forBand = tasks[key] ?? {};
      forBand[change.taskType] = change.to;
      tasks[key] = forBand;
      doc.taskSamples = tasks;
      return;
    }
    case "profile-threshold": {
      if (change.threshold === undefined) return;
      const profile = doc.profile ?? {};
      profile[change.threshold] = change.to;
      doc.profile = profile;
      return;
    }
  }
}

/**
 * Builds the override document for a proposal. Call `checkApplicable` first --
 * this does not enforce the sample-size floor, so a caller can still render a
 * document for review without writing it.
 */
export function buildOverride(proposal: PolicyProposal): PolicyOverride {
  const doc: PolicyOverride = {
    version: POLICY_OVERRIDE_VERSION,
    generatedAt: proposal.generatedAt,
    policyVersion: proposal.policyVersion,
    requiresBenchmark: true,
    note: OVERRIDE_NOTE,
    source: proposal.source,
    evidence: proposal.changes,
    caveats: [...proposal.caveats],
  };
  for (const change of proposal.changes) applyChange(doc, change);
  return doc;
}
