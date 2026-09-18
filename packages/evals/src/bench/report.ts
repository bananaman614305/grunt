/**
 * Benchmark metrics and their markdown rendering. Pure: everything here is
 * computed from a `BenchReport` and touches no network or clock.
 *
 * The headline table has one row per arm plus `oracle`, which is not a
 * separate set of calls: for each example it is the fixed arm of the tier
 * the label asked for, so it costs nothing extra and marks the ceiling the
 * routed arm could reach with perfect tier choice.
 */

import type { TaskType, Tier } from "@milo/core";
import { TASK_TYPES, TIERS } from "@milo/core";
import { costFromTokens, estimateCostUsd } from "./prices.js";
import { auroc, randomPickPassRate } from "./sampling.js";
import type { ArmResult, BenchReport, BenchRow, FixedArm, ModelPrice, ResultArm } from "./types.js";
import { FIXED_ARMS, MILO_ARM } from "./types.js";

export type SummaryArm = ResultArm | "oracle";
export const SUMMARY_ARMS = [MILO_ARM, "oracle", "frontier", "mid", "fast", "bestof-jev", "bestof-oracle"] as const satisfies readonly SummaryArm[];

/** One arm's aggregate numbers. `NaN` means no data, never zero. */
export type ArmSummary = {
  arm: SummaryArm;
  calls: number;
  ok: number;
  graded: number;
  passRate: number;
  meanScore: number;
  /** passRate / frontier passRate over the examples both graded. */
  qualityRetained: number;
  costUsd: number;
  costPerCallUsd: number;
  /** The baseline's estimated cost for the same calls, at 1x and 2x observed output. */
  baselineUsd: number;
  baselineUsd2x: number;
  savings: number;
  savings2x: number;
  ttfbP50: number;
  ttfbP95: number;
  totalP50: number;
  totalP95: number;
  meanOutputTokens: number;
  meanReasoningTokens: number;
};

export type RoutingSummary = {
  tiers: Record<Tier, number>;
  /** Routed tier equals the label. */
  agreement: number;
  agreementN: number;
  sticky: number;
  jevLatencyMean: number;
  jevLatencyP95: number;
  jevLatencyN: number;
  /** Routed TTFB minus the fixed arm's TTFB on the same model, ms. */
  overheadP50: number;
  overheadP95: number;
  overheadN: number;
  /** Routed arm failed, a cheaper tier was chosen than frontier, and frontier passed. */
  badDowngrades: number;
  /** Routed arm chose frontier and the fast arm passed. */
  missedSavings: number;
  comparedN: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Nearest-rank percentile, `NaN` when empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

export function isOk(result: ArmResult | undefined): result is ArmResult {
  return result !== undefined && succeeded(result);
}

function succeeded(result: ArmResult): boolean {
  return result.error === undefined && result.status === 200;
}

function resultFor(row: BenchRow, arm: SummaryArm): ArmResult | undefined {
  const name: ResultArm = arm === "oracle" ? row.expectedTier : arm;
  return row.results.find((r) => r.arm === name);
}

/** A result's cost: what OpenRouter reported, else tokens on the known price. */
export function resultCostUsd(result: ArmResult, prices: Record<string, ModelPrice>): number | undefined {
  return result.costUsd ?? costFromTokens(prices[result.model], result.inputTokens, result.outputTokens);
}

function baselineFor(result: ArmResult, baseline: ModelPrice, multiplier: number): number | undefined {
  if (result.inputTokens === undefined || result.outputTokens === undefined) return undefined;
  return estimateCostUsd(baseline, result.inputTokens, result.outputTokens, multiplier);
}

function rate(pass: number, n: number): number {
  return n === 0 ? NaN : pass / n;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function summarizeArm(report: BenchReport, arm: SummaryArm): ArmSummary {
  const picked = report.rows.map((row) => ({ row, result: resultFor(row, arm) })).filter((p) => p.result !== undefined);
  const ok = picked.filter((p) => isOk(p.result));
  const graded = ok.filter((p) => p.result?.grade !== undefined);

  const frontierPass = new Map<string, boolean>();
  for (const row of report.rows) {
    const frontier = resultFor(row, "frontier");
    if (isOk(frontier) && frontier.grade !== undefined) frontierPass.set(row.id, frontier.grade.pass);
  }
  const both = graded.filter((p) => frontierPass.has(p.row.id));
  const ownPass = both.filter((p) => p.result?.grade?.pass).length;
  const theirPass = both.filter((p) => frontierPass.get(p.row.id)).length;

  const costs = ok.map((p) => resultCostUsd(p.result as ArmResult, report.prices)).filter((c): c is number => c !== undefined);
  const withTokens = ok.filter((p) => p.result?.inputTokens !== undefined && p.result.outputTokens !== undefined);
  const costsOnTokenRows = withTokens
    .map((p) => resultCostUsd(p.result as ArmResult, report.prices))
    .filter((c): c is number => c !== undefined);
  const base1 = withTokens.map((p) => baselineFor(p.result as ArmResult, report.baseline, 1)).filter((c): c is number => c !== undefined);
  const base2 = withTokens.map((p) => baselineFor(p.result as ArmResult, report.baseline, 2)).filter((c): c is number => c !== undefined);
  const sum = (xs: number[]): number => xs.reduce((s, v) => s + v, 0);
  const cost = sum(costs);
  const costOnTokenRows = sum(costsOnTokenRows);
  const baseline1 = sum(base1);
  const baseline2 = sum(base2);

  const ttfb = ok.map((p) => (p.result as ArmResult).ttfbMs);
  const total = ok.map((p) => (p.result as ArmResult).totalMs);

  return {
    arm,
    calls: picked.length,
    ok: ok.length,
    graded: graded.length,
    passRate: rate(graded.filter((p) => p.result?.grade?.pass).length, graded.length),
    meanScore: mean(graded.map((p) => p.result?.grade?.score ?? 0)),
    qualityRetained: theirPass === 0 ? NaN : ownPass / theirPass,
    costUsd: costs.length === 0 ? NaN : cost,
    costPerCallUsd: costs.length === 0 ? NaN : cost / costs.length,
    baselineUsd: base1.length === 0 ? NaN : baseline1,
    baselineUsd2x: base2.length === 0 ? NaN : baseline2,
    savings: baseline1 === 0 || base1.length === 0 ? NaN : 1 - costOnTokenRows / baseline1,
    savings2x: baseline2 === 0 || base2.length === 0 ? NaN : 1 - costOnTokenRows / baseline2,
    ttfbP50: percentile(ttfb, 0.5),
    ttfbP95: percentile(ttfb, 0.95),
    totalP50: percentile(total, 0.5),
    totalP95: percentile(total, 0.95),
    meanOutputTokens: mean(ok.map((p) => p.result?.outputTokens).filter((v): v is number => v !== undefined)),
    meanReasoningTokens: mean(ok.map((p) => p.result?.reasoningTokens ?? 0)),
  };
}

export function summarizeRouting(report: BenchReport): RoutingSummary {
  const tiers = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  let agree = 0;
  let agreementN = 0;
  let sticky = 0;
  const jev: number[] = [];
  const overhead: number[] = [];
  let badDowngrades = 0;
  let missedSavings = 0;
  let comparedN = 0;

  for (const row of report.rows) {
    const milo = row.results.find((r) => r.arm === MILO_ARM);
    if (!isOk(milo)) continue;
    tiers[milo.tier] += 1;
    agreementN += 1;
    if (milo.tier === row.expectedTier) agree += 1;
    if (milo.sticky === true) sticky += 1;
    else if (milo.jevLatencyMs !== undefined) jev.push(milo.jevLatencyMs);

    const twin = row.results.find((r) => r.arm !== MILO_ARM && r.model === milo.model);
    if (isOk(twin)) overhead.push(milo.ttfbMs - twin.ttfbMs);

    const frontier = row.results.find((r) => r.arm === "frontier");
    const fast = row.results.find((r) => r.arm === "fast");
    if (milo.grade !== undefined && isOk(frontier) && frontier.grade !== undefined && isOk(fast) && fast.grade !== undefined) {
      comparedN += 1;
      if (!milo.grade.pass && milo.tier !== "frontier" && frontier.grade.pass) badDowngrades += 1;
      if (milo.tier === "frontier" && fast.grade.pass) missedSavings += 1;
    }
  }

  return {
    tiers,
    agreement: rate(agree, agreementN),
    agreementN,
    sticky,
    jevLatencyMean: mean(jev),
    jevLatencyP95: percentile(jev, 0.95),
    jevLatencyN: jev.length,
    overheadP50: percentile(overhead, 0.5),
    overheadP95: percentile(overhead, 0.95),
    overheadN: overhead.length,
    badDowngrades,
    missedSavings,
    comparedN,
  };
}

export type SamplingSummary = {
  rows: number;
  samples: number;
  okSamples: number;
  gradedSamples: number;
  rankedSamples: number;
  rankFailures: number;
  /** Mean per-sample pass rate: what a random pick scores in expectation. */
  randomPick: number;
  /** Rows with at least one passing sample, over rows with any graded sample. */
  coverage: number;
  /** AUROC of Jev's expected quality score against the grader's pass/fail. */
  aurocQuality: number;
  /** AUROC of Jev's correctness probability against the grader's pass/fail. */
  aurocCorrect: number;
  /** Over rows where samples disagree: how often Jev's pick passed, and the random baseline there. */
  mixedRows: number;
  jevPickOnMixed: number;
  randomOnMixed: number;
  jevLatencyMean: number;
  byTaskType: Array<{ taskType: TaskType; n: number; single: number; random: number; jev: number; oracle: number }>;
};

export function summarizeSampling(report: BenchReport): SamplingSummary | undefined {
  if (report.sampling === undefined) return undefined;
  const withSamples = report.rows.filter((r) => r.samples !== undefined && r.samples.length > 0);
  const all = withSamples.flatMap((r) => r.samples as NonNullable<BenchRow["samples"]>);
  const ok = all.filter((s) => s.error === undefined && s.status === 200);
  const graded = ok.filter((s) => s.grade !== undefined);
  const ranked = ok.filter((s) => s.rank !== undefined);
  const gradedAndRanked = graded.filter((s) => s.rank !== undefined);

  const rowsGraded = withSamples.filter((r) => (r.samples ?? []).some((s) => s.grade !== undefined));
  const covered = rowsGraded.filter((r) => (r.samples ?? []).some((s) => s.grade?.pass === true));
  const mixed = rowsGraded.filter((r) => {
    const g = (r.samples ?? []).filter((s) => s.grade !== undefined);
    return g.some((s) => s.grade?.pass) && g.some((s) => !s.grade?.pass);
  });
  const jevOnMixed = mixed.filter((r) => isOk(r.results.find((x) => x.arm === "bestof-jev")) && r.results.find((x) => x.arm === "bestof-jev")?.grade?.pass === true);
  const randomOnMixedRates = mixed.map((r) => randomPickPassRate((r.samples ?? []).map((s) => ({ index: s.index, grade: s.grade, rank: s.rank }))));

  const byTaskType = TASK_TYPES.map((taskType) => {
    const rows = rowsGraded.filter((r) => r.taskType === taskType);
    const rateOf = (arm: SummaryArm): number => {
      const picked = rows.map((r) => resultFor(r, arm)).filter((x) => isOk(x) && x.grade !== undefined);
      return rate(picked.filter((x) => x?.grade?.pass).length, picked.length);
    };
    const random = mean(rows.map((r) => randomPickPassRate((r.samples ?? []).map((s) => ({ index: s.index, grade: s.grade, rank: s.rank })))).filter((v) => !Number.isNaN(v)));
    return { taskType, n: rows.length, single: rateOf(report.sampling?.tier ?? "fast"), random, jev: rateOf("bestof-jev"), oracle: rateOf("bestof-oracle") };
  });

  return {
    rows: withSamples.length,
    samples: all.length,
    okSamples: ok.length,
    gradedSamples: graded.length,
    rankedSamples: ranked.length,
    rankFailures: ok.filter((s) => s.rankError !== undefined).length,
    randomPick: rate(graded.filter((s) => s.grade?.pass).length, graded.length),
    coverage: rate(covered.length, rowsGraded.length),
    aurocQuality: auroc(gradedAndRanked.map((s) => ({ score: s.rank?.quality ?? 0, pass: s.grade?.pass === true }))),
    aurocCorrect: auroc(gradedAndRanked.map((s) => ({ score: s.rank?.correct ?? 0, pass: s.grade?.pass === true }))),
    mixedRows: mixed.length,
    jevPickOnMixed: rate(jevOnMixed.length, mixed.length),
    randomOnMixed: mean(randomOnMixedRates.filter((v) => !Number.isNaN(v))),
    jevLatencyMean: mean(ranked.map((s) => s.rank?.latencyMs ?? 0)),
    byTaskType,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function pct(value: number): string {
  return Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function ms(value: number): string {
  return Number.isNaN(value) ? "n/a" : `${value.toFixed(0)} ms`;
}

function usd(value: number): string {
  if (Number.isNaN(value)) return "n/a";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(3)}`;
}

function num(value: number): string {
  return Number.isNaN(value) ? "n/a" : value.toFixed(0);
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function tierMark(result: ArmResult | undefined): string {
  if (result === undefined) return "–";
  if (!isOk(result)) return "err";
  if (result.grade === undefined) return "·";
  return result.grade.pass ? "✓" : "✗";
}

export function formatBenchMarkdown(report: BenchReport): string {
  const arms = SUMMARY_ARMS.map((arm) => summarizeArm(report, arm)).filter((a) => a.calls > 0);
  const routing = summarizeRouting(report);
  const sampling = summarizeSampling(report);
  const judgeCost = report.rows
    .flatMap((row) => row.results)
    .reduce((s, r) => s + (r.grade?.judgeCostUsd ?? 0), 0);
  const gradedIds = report.rows.filter((r) => r.hasGrader).length;

  const sections: string[] = [];
  sections.push("# Milo benchmark report");
  sections.push(
    [
      `- Generated: ${report.generatedAt}`,
      `- Gateway: \`${report.gateway}\`, posture \`${report.posture}\``,
      `- Fixed arms: ${FIXED_ARMS.map((a) => `${a} = \`${report.fixedModels[a as FixedArm]}\``).join(", ")}`,
      `- Baseline (estimated, never called): \`${report.baseline.id}\` at $${report.baseline.inputUsdPerM}/M in, $${report.baseline.outputUsdPerM}/M out`,
      `- Judge: \`${report.judgeModel}\`, total judge cost ${usd(judgeCost)}`,
      `- Providers: ${report.providers.length === 0 ? "OpenRouter's choice (unpinned)" : `pinned to ${report.providers.map((p) => `\`${p}\``).join(", ")}, no fallbacks`}`,
      `- Examples: ${report.rows.length} (${gradedIds} with a grader)`,
    ].join("\n"),
  );

  sections.push("## Headline");
  sections.push(
    "Savings compare each arm's real cost with what the same prompt and completion tokens would cost on the baseline. " +
      "`2x` assumes the baseline would have written twice the observed completion tokens. " +
      "`oracle` is the fixed arm of each example's labeled tier: the ceiling for perfect routing.",
  );
  sections.push(
    table(
      ["arm", "ok/calls", "graded", "pass", "quality vs frontier", "cost", "per call", "baseline est.", "savings", "savings 2x", "ttfb p50", "ttfb p95", "total p50", "out tok", "reason tok"],
      arms.map((a) => [
        `\`${a.arm}\``,
        `${a.ok}/${a.calls}`,
        String(a.graded),
        pct(a.passRate),
        pct(a.qualityRetained),
        usd(a.costUsd),
        usd(a.costPerCallUsd),
        usd(a.baselineUsd),
        pct(a.savings),
        pct(a.savings2x),
        ms(a.ttfbP50),
        ms(a.ttfbP95),
        ms(a.totalP50),
        num(a.meanOutputTokens),
        num(a.meanReasoningTokens),
      ]),
    ),
  );

  sections.push("## Routing (the `milo` arm)");
  sections.push(
    [
      `- Tiers chosen: ${TIERS.map((t) => `${t} ${routing.tiers[t]}`).join(", ")}`,
      `- Tier agreement with the label: ${pct(routing.agreement)} (n=${routing.agreementN})`,
      `- Sticky (inherited) decisions: ${routing.sticky}${routing.sticky > 0 ? " — excluded from the Jev latency figures; rerun with `--salt` or after the 30 minute TTL for fresh decisions" : ""}`,
      `- Jev latency: mean ${ms(routing.jevLatencyMean)}, p95 ${ms(routing.jevLatencyP95)} (n=${routing.jevLatencyN})`,
      `- Routing overhead (routed TTFB minus the same model called directly): p50 ${ms(routing.overheadP50)}, p95 ${ms(routing.overheadP95)} (n=${routing.overheadN})`,
      `- Bad downgrades (routed cheaper than frontier, failed, frontier passed): ${routing.badDowngrades} of ${routing.comparedN}`,
      `- Missed savings (routed to frontier, fast passed): ${routing.missedSavings} of ${routing.comparedN}`,
    ].join("\n"),
  );

  if (sampling !== undefined && report.sampling !== undefined) {
    const cfg = report.sampling;
    sections.push(`## Best-of-${cfg.n} sampling on \`${cfg.model}\` (${cfg.tier} tier${cfg.vary ? ", prompt framings varied" : ""})`);
    sections.push(
      [
        `- Samples: ${sampling.samples} drawn over ${sampling.rows} examples; ${sampling.okSamples} succeeded, ${sampling.gradedSamples} graded, ${sampling.rankedSamples} ranked by Jev (${sampling.rankFailures} ranking failures)`,
        `- Random pick (mean per-sample pass rate): ${pct(sampling.randomPick)}`,
        `- Coverage (some sample passes): ${pct(sampling.coverage)} — the ceiling any selector could reach`,
        `- Jev as verifier: AUROC ${sampling.aurocQuality.toFixed(3)} on its quality score, ${sampling.aurocCorrect.toFixed(3)} on its correctness probability (0.5 is chance)`,
        `- Where samples disagree (${sampling.mixedRows} examples): Jev's pick passed ${pct(sampling.jevPickOnMixed)} of the time, a random pick ${pct(sampling.randomOnMixed)}, the oracle 100%`,
        `- Jev ranking latency: mean ${ms(sampling.jevLatencyMean)} per sample, charged at $${cfg.jevUsdPerCall} per call`,
      ].join("\n"),
    );
    sections.push(
      table(
        ["task type", "n", "single sample", "random pick", "jev pick", "oracle"],
        sampling.byTaskType.filter((t) => t.n > 0).map((t) => [t.taskType, String(t.n), pct(t.single), pct(t.random), pct(t.jev), pct(t.oracle)]),
      ),
    );
  }

  const failures = report.rows.flatMap((row) =>
    row.results.filter((r) => !succeeded(r)).map((r) => `- **${row.id}** \`${r.arm}\` (${r.model}): ${r.error ?? `HTTP ${r.status}`}`),
  );
  sections.push("## Failed calls");
  sections.push(failures.length === 0 ? "None." : failures.join("\n"));

  sections.push("## Per example");
  sections.push(
    table(
      ["id", "type", "band", "label", "milo tier", "milo model", "provider", "milo", "frontier", "mid", "fast", "milo cost", "baseline est."],
      report.rows.map((row) => {
        const milo = row.results.find((r) => r.arm === MILO_ARM);
        const cost = isOk(milo) ? resultCostUsd(milo, report.prices) : undefined;
        const base = isOk(milo) ? baselineFor(milo, report.baseline, 1) : undefined;
        return [
          row.id,
          row.taskType,
          String(row.difficultyBand),
          row.expectedTier,
          milo?.tier ?? "–",
          milo?.model ?? "–",
          milo?.provider ?? "–",
          tierMark(milo),
          tierMark(row.results.find((r) => r.arm === "frontier")),
          tierMark(row.results.find((r) => r.arm === "mid")),
          tierMark(row.results.find((r) => r.arm === "fast")),
          usd(cost ?? NaN),
          usd(base ?? NaN),
        ];
      }),
    ),
  );

  return sections.join("\n\n");
}
