/**
 * Closed-loop policy tuning, step one: roll the decision log up into the cells
 * a routing policy is actually written in.
 *
 * The band -> budget table in `router/controller.ts` was set by hand from a
 * benchmark (ADR-012). The decision log now holds tens of thousands of real
 * decisions carrying, per request, the band's inputs (Jev's signals), what was
 * spent (model, `samples`, `costUsd`) and what came back (the completeness
 * gate's verdict, its retry, the per-sample ranking scores). This module turns
 * those rows into per-band and per-(band, task type) statistics; `propose.ts`
 * turns the statistics into a proposed policy diff for a human to read.
 *
 * ## What counts as an outcome signal here, and what it is worth
 *
 * There is no ground truth in the decision log -- it stores no message content
 * by contract, and nobody labels production answers. Every signal below is a
 * proxy, and the honest ranking of them is:
 *
 *   - **gate verdict** (`upstream.gate.verdict`, ADR-013 phase A). The
 *     strongest signal available, and still a proxy: it is Jev judging an
 *     answer that Jev also routed, on coverage of the request's stated parts
 *     rather than correctness. Its own confidence separates trustworthy
 *     verdicts from suspect ones (`GATE_TRUST_CONFIDENCE`), so both readings
 *     are reported. It is absent whenever the gate did not run (`milo: { gates:
 *     false }`, a non-gated path, or an older row), which makes gate coverage
 *     itself a number worth printing.
 *   - **retry fired** (`upstream.gate.retried`). A derived view of the same
 *     verdict -- the gate's own escalation -- not independent evidence.
 *   - **per-sample ranking scores** (`upstream.samples[].jevQuality`). Only
 *     exist on sampled decisions, and are again Jev's own opinion. Their one
 *     real advantage: within a single decision, the picked sample's score
 *     against the mean score of that decision's samples measures what best-of-N
 *     bought on *that* request, with the request held fixed. That is the
 *     closest thing to a controlled comparison the log contains.
 *   - **degraded notes** (`upstream.sampleNote`) and **upstream status**.
 *     Reliability, not quality.
 *   - **cost** (`upstream.costUsd`). The only number here that is not a
 *     judgement at all.
 *
 * The sampled-versus-single comparison across decisions is observational: the
 * policy decides who samples, so the two arms are not randomly assigned and a
 * raw difference between them mixes the policy's own selection in with any
 * effect of sampling. It is reported per cell -- within one band and one task
 * type -- to hold the obvious confounder fixed, and `propose.ts` never leans on
 * it alone. Nothing here replaces the benchmark (ADR-012: "Do not change a
 * band's budget without re-running the benchmark"); it points at which band is
 * worth benchmarking next.
 *
 * Pure arithmetic over a structural shape, like `log/cost.ts`: no SQLite, no
 * network, no stored contract, so it lives here rather than in `types.ts`.
 */

import { computeBand, computeBudget, type ComputeBand } from "../router/controller.js";
import { GATE_TRUST_CONFIDENCE, GATE_VERDICTS } from "../router/gates.js";
import { JEV_PROFILE, type PolicyProfile } from "../router/policy.js";
import type { DecisionRecord, RouteSignals, TaskType } from "../types.js";

/** The minimum a decision has to expose for the tuner to read it. */
export type TuningInputDecision = {
  tier: string;
  model: string;
  sticky?: boolean;
  /** Best-of-N fan-out size (ADR-010); > 1 on a sampled decision, else absent. */
  samples?: number;
  /** Absent on a forced-tier decision, which therefore has no band. */
  signals?: RouteSignals;
  /** ISO 8601; only read to report the window the rows cover. */
  createdAt?: string;
  upstream?: NonNullable<DecisionRecord["upstream"]>;
};

/** Every band the controller can put work in, in order. */
export const COMPUTE_BANDS: readonly ComputeBand[] = [0, 1, 2, 3];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the completeness gate said about one cell's requests. */
export type GateStats = {
  /** Requests whose gate returned one of the four real verdicts. */
  answered: number;
  /** Requests the gate never graded (no gate, or the gate itself errored). */
  ungraded: number;
  complete: number;
  /** `complete` verdicts below `GATE_TRUST_CONFIDENCE` -- a pass, but a suspect one. */
  suspect: number;
  /** `incomplete` + `off_task` + `wrong_format`. */
  failed: number;
  /** The failure-typed retry fired. */
  retried: number;
  /** ... and the retry's answer was the one served. */
  retryWon: number;
  /** `complete / answered`, or null when nothing in the cell was graded. */
  passRate: number | null;
  /** The strict reading: `(complete - suspect) / answered`. */
  trustedPassRate: number | null;
  /** `retried / answered`, or null when nothing was graded. */
  retryRate: number | null;
};

export type CostStats = {
  /** Requests that reported a cost -- the denominator for `avgUsd`. */
  withCost: number;
  totalUsd: number;
  /** Mean over priced requests only, or null when none reported a cost. */
  avgUsd: number | null;
};

/** One arm of a cell: its requests, what they cost, and how they were graded. */
export type OutcomeStats = {
  n: number;
  /** Requests whose upstream call completed and was recorded. */
  withUpstream: number;
  /** Recorded upstream calls that came back non-2xx. */
  upstreamFailures: number;
  /** Sampled decisions that fell through to a degraded path (`sampleNote`). */
  degraded: number;
  gate: GateStats;
  cost: CostStats;
};

/** What sampling looks like inside one cell. */
export type SamplingStats = {
  /** Decisions that fanned out (`samples` > 1). */
  sampled: OutcomeStats;
  /** Decisions that made a single call. */
  single: OutcomeStats;
  /**
   * `sampled.gate.passRate - single.gate.passRate`, or null when either arm
   * was never graded. OBSERVATIONAL: the policy chose which arm each request
   * landed in, so this is a correlation, not an effect.
   */
  passRateDelta: number | null;
  /** `sampled.cost.avgUsd / single.cost.avgUsd`, or null when either is absent. */
  costRatio: number | null;
  /**
   * The within-decision lift: mean over sampled decisions of (the picked
   * sample's `jevQuality` - the mean `jevQuality` across that decision's
   * samples), on Jev's 0..3 scale. This is what drawing N answers and keeping
   * the best bought over drawing one, with the request held fixed. Null when
   * no sampled decision in the cell carried per-sample scores.
   */
  qualityLift: number | null;
  /** How many sampled decisions the lift was averaged over. */
  qualityLiftN: number;
  /** Both arms carry enough graded requests to be compared at all. */
  comparable: boolean;
};

export type CellStats = OutcomeStats & {
  band: ComputeBand;
  /** Absent on a band rollup; set on a per-task-type cell. */
  taskType?: TaskType;
  /** Human-readable cell name: `band 2` or `band 2 / edit`. */
  target: string;
  /** Requests served from a sticky decision rather than freshly decided. */
  sticky: number;
  /** The most common `samples` value observed in the cell (1 when unsampled). */
  observedSamples: number;
  sampling: SamplingStats;
};

export type BandStats = CellStats & {
  /** What ADR-012's measured table budgets for this band today. */
  configuredSamples: number;
  configuredModel: string;
};

export type TuningReport = {
  /** Rows read. */
  total: number;
  /** Rows with no signals (a forced tier): no band, so excluded from the cells. */
  unbanded: number;
  /** Rows that fell in a band. */
  banded: number;
  /** The profile the bands were read with. */
  profile: PolicyProfile;
  /** Earliest and latest `createdAt` seen, when the rows carried one. */
  from?: string;
  to?: string;
  bands: BandStats[];
  cells: CellStats[];
  overall: CellStats;
};

export type AggregateOptions = {
  /** Threshold profile the bands are read with. Defaults to `JEV_PROFILE`. */
  profile?: PolicyProfile;
  /**
   * Each arm needs this many *graded* requests before a cell's sampled-versus-
   * single comparison is marked `comparable`. Defaults to `MIN_ARM_N`.
   */
  minArmN?: number;
};

/** Default graded-request floor per arm before a comparison is worth reading. */
export const MIN_ARM_N = 20;

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

type GateAcc = {
  answered: number;
  ungraded: number;
  complete: number;
  suspect: number;
  failed: number;
  retried: number;
  retryWon: number;
};

type OutcomeAcc = {
  n: number;
  withUpstream: number;
  upstreamFailures: number;
  degraded: number;
  gate: GateAcc;
  withCost: number;
  totalUsd: number;
};

type CellAcc = OutcomeAcc & {
  sticky: number;
  sampleCounts: Map<number, number>;
  sampled: OutcomeAcc;
  single: OutcomeAcc;
  liftSum: number;
  liftN: number;
};

function newOutcome(): OutcomeAcc {
  return {
    n: 0,
    withUpstream: 0,
    upstreamFailures: 0,
    degraded: 0,
    gate: { answered: 0, ungraded: 0, complete: 0, suspect: 0, failed: 0, retried: 0, retryWon: 0 },
    withCost: 0,
    totalUsd: 0,
  };
}

function newCell(): CellAcc {
  return {
    ...newOutcome(),
    sticky: 0,
    sampleCounts: new Map(),
    sampled: newOutcome(),
    single: newOutcome(),
    liftSum: 0,
    liftN: 0,
  };
}

function isRealVerdict(verdict: string): boolean {
  return (GATE_VERDICTS as readonly string[]).includes(verdict);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Folds one decision into one arm-or-cell accumulator. */
function addOutcome(acc: OutcomeAcc, decision: TuningInputDecision): void {
  acc.n += 1;
  const upstream = decision.upstream;
  if (!upstream) {
    acc.gate.ungraded += 1;
    return;
  }

  acc.withUpstream += 1;
  if (upstream.status < 200 || upstream.status >= 300) acc.upstreamFailures += 1;
  if (upstream.sampleNote !== undefined) acc.degraded += 1;
  if (isFiniteNumber(upstream.costUsd)) {
    acc.withCost += 1;
    acc.totalUsd += upstream.costUsd;
  }

  const gate = upstream.gate;
  if (!gate || !isRealVerdict(gate.verdict)) {
    acc.gate.ungraded += 1;
    return;
  }

  acc.gate.answered += 1;
  if (gate.verdict === "complete") {
    acc.gate.complete += 1;
    // A `complete` verdict under the trust confidence is a pass the gate
    // itself does not stand behind (ADR-013's suspect path), so it is counted
    // as a pass AND as suspect: `trustedPassRate` is the strict reading.
    if (isFiniteNumber(gate.confidence) && gate.confidence < GATE_TRUST_CONFIDENCE) acc.gate.suspect += 1;
  } else {
    acc.gate.failed += 1;
  }
  if (gate.retried === true) {
    acc.gate.retried += 1;
    if (gate.pick === "retry") acc.gate.retryWon += 1;
  }
}

/**
 * The within-decision sampling lift for one sampled decision: the picked
 * sample's quality minus the mean quality across that decision's samples.
 * Undefined unless at least two samples carried a score and one of them was
 * the pick -- with fewer there is nothing to have chosen between.
 */
export function sampleQualityLift(upstream: NonNullable<DecisionRecord["upstream"]>): number | undefined {
  const samples = upstream.samples;
  if (!samples || samples.length < 2) return undefined;
  const scored = samples.filter((s) => isFiniteNumber(s.jevQuality));
  if (scored.length < 2) return undefined;

  const pickIndex = upstream.samplePick;
  const picked =
    scored.find((s) => s.index === pickIndex) ?? (scored.find((s) => s.picked === true) as (typeof scored)[number] | undefined);
  if (!picked || !isFiniteNumber(picked.jevQuality)) return undefined;

  const mean = scored.reduce((sum, s) => sum + (s.jevQuality as number), 0) / scored.length;
  return picked.jevQuality - mean;
}

function finishGate(acc: GateAcc): GateStats {
  const answered = acc.answered;
  return {
    answered,
    ungraded: acc.ungraded,
    complete: acc.complete,
    suspect: acc.suspect,
    failed: acc.failed,
    retried: acc.retried,
    retryWon: acc.retryWon,
    passRate: answered > 0 ? acc.complete / answered : null,
    trustedPassRate: answered > 0 ? (acc.complete - acc.suspect) / answered : null,
    retryRate: answered > 0 ? acc.retried / answered : null,
  };
}

function finishOutcome(acc: OutcomeAcc): OutcomeStats {
  return {
    n: acc.n,
    withUpstream: acc.withUpstream,
    upstreamFailures: acc.upstreamFailures,
    degraded: acc.degraded,
    gate: finishGate(acc.gate),
    cost: {
      withCost: acc.withCost,
      totalUsd: acc.totalUsd,
      avgUsd: acc.withCost > 0 ? acc.totalUsd / acc.withCost : null,
    },
  };
}

/** The most common `samples` value in the cell; ties break toward the smaller. */
function modalSamples(counts: Map<number, number>): number {
  let best = 1;
  let bestCount = -1;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return bestCount < 0 ? 1 : best;
}

function finishCell(acc: CellAcc, band: ComputeBand, taskType: TaskType | undefined, minArmN: number): CellStats {
  const sampled = finishOutcome(acc.sampled);
  const single = finishOutcome(acc.single);
  const passRateDelta =
    sampled.gate.passRate !== null && single.gate.passRate !== null
      ? sampled.gate.passRate - single.gate.passRate
      : null;
  const costRatio =
    sampled.cost.avgUsd !== null && single.cost.avgUsd !== null && single.cost.avgUsd > 0
      ? sampled.cost.avgUsd / single.cost.avgUsd
      : null;

  const cell: CellStats = {
    ...finishOutcome(acc),
    band,
    target: taskType === undefined ? `band ${band}` : `band ${band} / ${taskType}`,
    sticky: acc.sticky,
    observedSamples: modalSamples(acc.sampleCounts),
    sampling: {
      sampled,
      single,
      passRateDelta,
      costRatio,
      qualityLift: acc.liftN > 0 ? acc.liftSum / acc.liftN : null,
      qualityLiftN: acc.liftN,
      comparable: sampled.gate.answered >= minArmN && single.gate.answered >= minArmN,
    },
  };
  if (taskType !== undefined) cell.taskType = taskType;
  return cell;
}

// ---------------------------------------------------------------------------
// The roll-up
// ---------------------------------------------------------------------------

/**
 * Rolls decisions up per difficulty band and per (band, task type).
 *
 * A decision's band is recomputed from its stored signals with the controller's
 * own `computeBand`, so the tuner bands work exactly as the controller does
 * rather than guessing from the model that answered. A decision with no signals
 * (a forced tier) has no band and is counted in `unbanded` only.
 */
export function aggregateDecisions(decisions: Iterable<TuningInputDecision>, opts: AggregateOptions = {}): TuningReport {
  const profile = opts.profile ?? JEV_PROFILE;
  const minArmN = opts.minArmN ?? MIN_ARM_N;

  const bands = new Map<ComputeBand, CellAcc>();
  const cells = new Map<string, { band: ComputeBand; taskType: TaskType; acc: CellAcc }>();
  const overall = newCell();

  let total = 0;
  let unbanded = 0;
  let banded = 0;
  let from: string | undefined;
  let to: string | undefined;

  for (const decision of decisions) {
    total += 1;
    const createdAt = decision.createdAt;
    if (typeof createdAt === "string" && createdAt !== "") {
      if (from === undefined || createdAt < from) from = createdAt;
      if (to === undefined || createdAt > to) to = createdAt;
    }

    const signals = decision.signals;
    if (!signals) {
      unbanded += 1;
      continue;
    }
    banded += 1;

    const band = computeBand(signals, profile);
    const taskType = signals.taskType;

    let bandAcc = bands.get(band);
    if (!bandAcc) {
      bandAcc = newCell();
      bands.set(band, bandAcc);
    }
    const key = `${band}/${taskType}`;
    let cellEntry = cells.get(key);
    if (!cellEntry) {
      cellEntry = { band, taskType, acc: newCell() };
      cells.set(key, cellEntry);
    }

    for (const acc of [bandAcc, cellEntry.acc, overall]) {
      addCell(acc, decision);
    }
  }

  const bandRows: BandStats[] = COMPUTE_BANDS.filter((band) => bands.has(band)).map((band) => {
    const budget = computeBudget(band);
    return {
      ...finishCell(bands.get(band) as CellAcc, band, undefined, minArmN),
      configuredSamples: budget.samples,
      configuredModel: budget.model,
    };
  });

  const cellRows = [...cells.values()]
    .sort((a, b) => a.band - b.band || a.taskType.localeCompare(b.taskType))
    .map((entry) => finishCell(entry.acc, entry.band, entry.taskType, minArmN));

  const report: TuningReport = {
    total,
    unbanded,
    banded,
    profile,
    bands: bandRows,
    cells: cellRows,
    // The pooled row is not a band; band 0 is the least misleading label for a
    // rollup whose `band` field nothing reads.
    overall: finishCell(overall, 0, undefined, minArmN),
  };
  report.overall.target = "all bands";
  if (from !== undefined) report.from = from;
  if (to !== undefined) report.to = to;
  return report;
}

/** Folds one decision into a cell: the cell itself, then its sampling arm. */
function addCell(acc: CellAcc, decision: TuningInputDecision): void {
  addOutcome(acc, decision);
  if (decision.sticky === true) acc.sticky += 1;

  const samples = isFiniteNumber(decision.samples) ? decision.samples : 1;
  acc.sampleCounts.set(samples, (acc.sampleCounts.get(samples) ?? 0) + 1);

  if (samples > 1) {
    addOutcome(acc.sampled, decision);
    if (decision.upstream) {
      const lift = sampleQualityLift(decision.upstream);
      if (lift !== undefined) {
        acc.liftSum += lift;
        acc.liftN += 1;
      }
    }
  } else {
    addOutcome(acc.single, decision);
  }
}
