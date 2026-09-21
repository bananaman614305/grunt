/**
 * Closed-loop policy tuning, step two: turn the rolled-up decision log into a
 * proposed policy diff, for a human to read.
 *
 * Phase 1 only PROPOSES (see `override.ts` for what `milo tune --apply` writes
 * and why it is inert until a benchmark says otherwise). ADR-012's rule stands:
 * "Do not change a band's budget without re-running the benchmark". What this
 * module adds is which band is worth benchmarking next, and the evidence for
 * saying so.
 *
 * Every rule below is deterministic, reads only the statistics in
 * `aggregate.ts`, and refuses to fire on a cell it has too little of. The
 * thresholds are named constants rather than literals so a caller can widen or
 * tighten them from the CLI without editing this file -- the same habit
 * `PolicyProfile` follows.
 *
 * ## The rules
 *
 *   R1 band raise -- a band budgeted at one call whose gate pass rate is below
 *      `lowPassRate` is under-served: propose the sampling budget the measured
 *      table already uses (`DEFAULT_SAMPLE_COUNT`).
 *   R2 band drop -- a band budgeted at best-of-N whose sampling shows no
 *      measurable benefit AND whose pass rate is already at or above
 *      `highPassRate` is over-served: propose one call. The pass-rate condition
 *      matters: sampling not helping is not a reason to cut compute on a band
 *      that is failing anyway -- that band needs a different model, which is a
 *      benchmark question, not a tuning one.
 *   R3 task drop -- inside a sampling band that holds overall, one task type
 *      whose own sampled requests show no benefit drops to one call.
 *   R4/R5 thresholds -- a band whose pass rate trails the pooled rate by
 *      `bandGap` argues the boundary above it is in the wrong place: R4 moves
 *      `fastBelowMass` (the band 0 boundary), R5 moves `frontierHardMass` (the
 *      band 3 boundary), one `thresholdStep` at a time.
 *
 * "No measurable benefit" is deliberately conservative: the within-decision
 * quality lift is below `minQualityLift` AND the cross-arm pass-rate delta is
 * either absent or below `minPassRateDelta`. Either signal saying sampling
 * helps blocks the drop.
 */

import { DEFAULT_SAMPLE_COUNT } from "../router/policy.js";
import { POLICY_VERSION, type TaskType } from "../types.js";
import type { ComputeBand } from "../router/controller.js";
import type { BandStats, CellStats, TuningReport } from "./aggregate.js";

/**
 * The tuner's own thresholds -- not a routing contract, just where each rule
 * draws its line. Overridable per run (`milo tune --min-n`).
 */
export type TuningThresholds = {
  /** A rule ignores a cell with fewer graded requests than this. */
  minCellN: number;
  /** `--apply` refuses a change whose evidence has fewer graded requests than this. */
  applyMinN: number;
  /** Each arm needs this many graded requests before a comparison counts. */
  minArmN: number;
  /** A gate pass rate below this is "low": the band should buy more compute. */
  lowPassRate: number;
  /** A gate pass rate at or above this is healthy enough to give compute back. */
  highPassRate: number;
  /** Within-decision quality lift (0..3) below this means sampling bought nothing. */
  minQualityLift: number;
  /** Cross-arm pass-rate advantage below this means sampling bought nothing. */
  minPassRateDelta: number;
  /** How far one threshold proposal moves a mass threshold. */
  thresholdStep: number;
  /** A band's pass rate must trail the pooled rate by this much to move a threshold. */
  bandGap: number;
};

export const DEFAULT_THRESHOLDS: TuningThresholds = {
  minCellN: 50,
  applyMinN: 200,
  minArmN: 20,
  lowPassRate: 0.8,
  highPassRate: 0.92,
  minQualityLift: 0.15,
  minPassRateDelta: 0.03,
  thresholdStep: 0.05,
  bandGap: 0.05,
};

/** Mass thresholds a proposal is allowed to move, and the range they live in. */
export const TUNABLE_THRESHOLDS = ["fastBelowMass", "frontierHardMass"] as const;
export type TunableThreshold = (typeof TUNABLE_THRESHOLDS)[number];

const THRESHOLD_BOUNDS: Record<TunableThreshold, { min: number; max: number }> = {
  fastBelowMass: { min: 0.05, max: 0.9 },
  frontierHardMass: { min: 0.01, max: 0.9 },
};

/** The numbers a change leaned on, carried with it so a reader can check it. */
export type ChangeEvidence = {
  /** Requests in the cell. */
  n: number;
  /** Requests in the cell the gate actually graded -- the rule's real denominator. */
  gradedN: number;
  passRate: number | null;
  /** Cross-arm delta, when both arms exist. Observational; see `aggregate.ts`. */
  passRateDelta: number | null;
  /** Within-decision best-of-N lift on Jev's 0..3 scale, when measurable. */
  qualityLift: number | null;
  qualityLiftN: number;
  avgCostUsd: number | null;
  costRatio: number | null;
};

export type PolicyChange = {
  kind: "band-samples" | "task-samples" | "profile-threshold";
  /** Human-readable name of what moves: `band 1`, `band 2 / edit`, `fastBelowMass`. */
  target: string;
  band?: ComputeBand;
  taskType?: TaskType;
  threshold?: TunableThreshold;
  from: number;
  to: number;
  /** Which rule fired: `R1`..`R5`. */
  rule: string;
  rationale: string;
  evidence: ChangeEvidence;
  /** Evidence below `applyMinN`: reportable, not applicable. */
  lowN: boolean;
};

/** A cell the tuner looked at but would not judge, and why. */
export type SkippedCell = { target: string; n: number; gradedN: number; why: string };

export type PolicyProposal = {
  generatedAt: string;
  /** The policy version the evidence was collected under. */
  policyVersion: string;
  thresholds: TuningThresholds;
  source: {
    decisions: number;
    banded: number;
    unbanded: number;
    sinceIso?: string;
    from?: string;
    to?: string;
  };
  changes: PolicyChange[];
  /** Cells with too little evidence to judge -- printed, never silently dropped. */
  lowNCells: SkippedCell[];
  /** Standing caveats about what these signals are and are not. */
  caveats: string[];
};

export type ProposeOptions = {
  thresholds?: Partial<TuningThresholds>;
  /** Injected for deterministic tests; defaults to `new Date()`. */
  now?: Date;
  policyVersion?: string;
  sinceIso?: string;
};

/**
 * What the tuner will not let a reader forget. These ride on every proposal,
 * in the terminal and in the JSON, because the numbers above them look more
 * authoritative than they are.
 */
export const TUNING_CAVEATS: readonly string[] = [
  "The gate verdict is Jev judging an answer Jev also routed, on coverage of the request's stated parts -- not ground truth and not correctness.",
  "Ungraded requests (gates off, or the gate itself errored) are excluded from every pass rate, so a cell's pass rate describes its graded subset only.",
  "The sampled-versus-single comparison is observational: the policy chose which requests sampled, so a cross-arm delta mixes selection in with any effect of sampling.",
  "The within-decision quality lift holds the request fixed, but it is still Jev's own ranking score, and it exists only where samples were scored.",
  "A proposal is a hypothesis. ADR-012's band budgets were measured; changing one needs a benchmark run (pnpm bench) or a canary before it ships.",
];

function isBenefitAbsent(cell: CellStats, t: TuningThresholds): boolean {
  const lift = cell.sampling.qualityLift;
  const delta = cell.sampling.passRateDelta;
  const liftSaysNothing = lift === null || lift < t.minQualityLift;
  const deltaSaysNothing = delta === null || delta < t.minPassRateDelta;
  return liftSaysNothing && deltaSaysNothing;
}

function evidenceFor(cell: CellStats): ChangeEvidence {
  return {
    n: cell.n,
    gradedN: cell.gate.answered,
    passRate: cell.gate.passRate,
    passRateDelta: cell.sampling.passRateDelta,
    qualityLift: cell.sampling.qualityLift,
    qualityLiftN: cell.sampling.qualityLiftN,
    avgCostUsd: cell.cost.avgUsd,
    costRatio: cell.sampling.costRatio,
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Reads a proposed diff off a tuning report.
 *
 * Deterministic: same report plus same thresholds plus same clock gives the
 * same proposal, which is what makes it reviewable in a diff.
 */
export function propose(report: TuningReport, opts: ProposeOptions = {}): PolicyProposal {
  const t: TuningThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const changes: PolicyChange[] = [];
  const lowNCells: SkippedCell[] = [];

  const push = (change: Omit<PolicyChange, "lowN">): void => {
    changes.push({ ...change, lowN: change.evidence.gradedN < t.applyMinN });
  };

  const droppedBands = new Set<ComputeBand>();

  // -- R1 / R2: band budgets ------------------------------------------------
  for (const band of report.bands) {
    if (band.gate.answered < t.minCellN) {
      lowNCells.push({
        target: band.target,
        n: band.n,
        gradedN: band.gate.answered,
        why: `only ${band.gate.answered} graded requests, under the ${t.minCellN} a rule needs`,
      });
      continue;
    }
    const passRate = band.gate.passRate;
    if (passRate === null) continue;

    if (band.configuredSamples === 1 && passRate < t.lowPassRate) {
      push({
        kind: "band-samples",
        target: band.target,
        band: band.band,
        from: band.configuredSamples,
        to: DEFAULT_SAMPLE_COUNT,
        rule: "R1",
        rationale:
          `one call passes the completeness gate on ${pct(passRate)} of ${band.gate.answered} graded requests, ` +
          `below the ${pct(t.lowPassRate)} floor -- try best-of-${DEFAULT_SAMPLE_COUNT}, the budget the measured table already uses`,
        evidence: evidenceFor(band),
      });
      continue;
    }

    if (band.configuredSamples > 1 && passRate >= t.highPassRate && isBenefitAbsent(band, t)) {
      droppedBands.add(band.band);
      push({
        kind: "band-samples",
        target: band.target,
        band: band.band,
        from: band.configuredSamples,
        to: 1,
        rule: "R2",
        rationale:
          `best-of-${band.configuredSamples} passes on ${pct(passRate)} of ${band.gate.answered} graded requests ` +
          `(at or above the ${pct(t.highPassRate)} bar) while buying ` +
          `${band.sampling.qualityLift === null ? "no measurable quality lift" : `a within-decision lift of only ${band.sampling.qualityLift.toFixed(2)} on Jev's 0..3 scale`}` +
          `${band.sampling.passRateDelta === null ? "" : ` and a cross-arm pass-rate delta of ${pct(band.sampling.passRateDelta)}`} -- one call may be enough`,
        evidence: evidenceFor(band),
      });
    }
  }

  // -- R3: per-task-type drops inside a sampling band -----------------------
  const bandByNumber = new Map<ComputeBand, BandStats>(report.bands.map((b) => [b.band, b]));
  for (const cell of report.cells) {
    const band = bandByNumber.get(cell.band);
    if (!band || band.configuredSamples <= 1) continue;
    if (droppedBands.has(cell.band)) continue; // R2 already proposed dropping the whole band
    if (cell.sampling.sampled.gate.answered < t.minCellN) {
      if (cell.sampling.sampled.n > 0) {
        lowNCells.push({
          target: cell.target,
          n: cell.sampling.sampled.n,
          gradedN: cell.sampling.sampled.gate.answered,
          why: `only ${cell.sampling.sampled.gate.answered} graded sampled requests, under the ${t.minCellN} a rule needs`,
        });
      }
      continue;
    }
    const passRate = cell.sampling.sampled.gate.passRate;
    if (passRate === null || passRate < t.highPassRate) continue;
    if (!isBenefitAbsent(cell, t)) continue;

    push({
      kind: "task-samples",
      target: cell.target,
      band: cell.band,
      ...(cell.taskType !== undefined ? { taskType: cell.taskType } : {}),
      from: cell.observedSamples,
      to: 1,
      rule: "R3",
      rationale:
        `sampling buys nothing for ${cell.taskType ?? "this task type"} in band ${cell.band}: ` +
        `${pct(passRate)} pass on ${cell.sampling.sampled.gate.answered} graded sampled requests, ` +
        `within-decision lift ${cell.sampling.qualityLift === null ? "unmeasured" : cell.sampling.qualityLift.toFixed(2)}` +
        `${cell.sampling.costRatio === null ? "" : `, at ${cell.sampling.costRatio.toFixed(1)}x the single-call cost`}`,
      evidence: {
        ...evidenceFor(cell),
        gradedN: cell.sampling.sampled.gate.answered,
        passRate,
        avgCostUsd: cell.sampling.sampled.cost.avgUsd,
      },
    });
  }

  // -- R4 / R5: where the band boundaries sit -------------------------------
  const pooled = report.overall.gate.passRate;
  const pooledGraded = report.overall.gate.answered;
  if (pooled !== null && pooledGraded >= t.minCellN) {
    const band0 = bandByNumber.get(0);
    if (band0 && band0.gate.answered >= t.minCellN && band0.gate.passRate !== null) {
      const gap = pooled - band0.gate.passRate;
      if (gap >= t.bandGap) {
        const from = report.profile.fastBelowMass;
        const to = round2(Math.min(THRESHOLD_BOUNDS.fastBelowMass.max, from + t.thresholdStep));
        if (to !== from) {
          push({
            kind: "profile-threshold",
            target: "fastBelowMass",
            threshold: "fastBelowMass",
            from,
            to,
            rule: "R4",
            rationale:
              `band 0 takes the cheapest path and passes ${pct(band0.gate.passRate)} against ${pct(pooled)} pooled ` +
              `(${(gap * 100).toFixed(1)} points below, over the ${(t.bandGap * 100).toFixed(0)}-point gap) -- ` +
              `raising the fast gate's mass threshold moves borderline work out of band 0`,
            evidence: evidenceFor(band0),
          });
        }
      }
    }

    const band2 = bandByNumber.get(2);
    const band3 = bandByNumber.get(3);
    if (
      band2 &&
      band3 &&
      band2.gate.answered >= t.minCellN &&
      band3.gate.answered >= t.minCellN &&
      band2.gate.passRate !== null &&
      band3.gate.passRate !== null
    ) {
      const gap = band3.gate.passRate - band2.gate.passRate;
      if (gap >= t.bandGap) {
        const from = report.profile.frontierHardMass;
        const to = round2(Math.max(THRESHOLD_BOUNDS.frontierHardMass.min, from - t.thresholdStep));
        if (to !== from) {
          push({
            kind: "profile-threshold",
            target: "frontierHardMass",
            threshold: "frontierHardMass",
            from,
            to,
            rule: "R5",
            rationale:
              `band 3's stronger model passes ${pct(band3.gate.passRate)} against band 2's ${pct(band2.gate.passRate)} ` +
              `(${(gap * 100).toFixed(1)} points) -- lowering the hard-mass threshold sends more of band 2's work to it`,
            evidence: evidenceFor(band2),
          });
        }
      }
    }
  }

  const proposal: PolicyProposal = {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    policyVersion: opts.policyVersion ?? POLICY_VERSION,
    thresholds: t,
    source: {
      decisions: report.total,
      banded: report.banded,
      unbanded: report.unbanded,
      ...(opts.sinceIso !== undefined ? { sinceIso: opts.sinceIso } : {}),
      ...(report.from !== undefined ? { from: report.from } : {}),
      ...(report.to !== undefined ? { to: report.to } : {}),
    },
    changes,
    lowNCells,
    caveats: [...TUNING_CAVEATS],
  };
  return proposal;
}

/** The profile the proposal's threshold changes would produce, for display. */
export function proposedProfile(report: TuningReport, proposal: PolicyProposal): Record<string, number> {
  const out: Record<string, number> = {
    fastBelowMass: report.profile.fastBelowMass,
    frontierHardMass: report.profile.frontierHardMass,
  };
  for (const change of proposal.changes) {
    if (change.kind === "profile-threshold" && change.threshold) out[change.threshold] = change.to;
  }
  return out;
}

