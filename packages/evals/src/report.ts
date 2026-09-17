/**
 * The eval report: what the routing eval runner produced, and how to render
 * it as markdown. See `packages/evals/data/README.md` for the labeling rules
 * behind `expectedTier`/`taskType`/`difficultyBand`, and
 * `docs/adr/002-routing-signals-and-policy.md` for Policy v1.
 */

import type { CostPosture, TaskType, Tier } from "@milo/core";
import { TASK_TYPES, TIERS } from "@milo/core";
import type { RoutingExample } from "./schema.js";

/** The dataset's difficulty band (0..3). Restated from `RoutingExample` so this
 * module does not need its own copy of the union. */
export type DifficultyBand = RoutingExample["difficulty_band"];

/** One example the router produced a clean (non-degraded) decision for. */
export type ScoredExample = {
  kind: "scored";
  id: string;
  /** The dataset's label. */
  taskType: TaskType;
  /** What Jev classified the task as. */
  predictedTaskType: TaskType;
  /** The dataset's label. */
  difficultyBand: DifficultyBand;
  /** Jev's raw 0..3 difficulty score. */
  predictedDifficulty: number;
  /** Jev's `needs_reasoning` noul, 0..1. */
  needsReasoning: number;
  /** The dataset's label. */
  expectedTier: Tier;
  /** What Policy v1 chose. */
  predictedTier: Tier;
  /** The router's one-sentence reason. */
  reason: string;
  /** Jev call latency in ms. */
  latencyMs: number;
  /** The dataset's `notes`. */
  notes: string;
  /** `predictedTier === expectedTier`. */
  agree: boolean;
};

/** One example the router could not score: a Jev failure or a missing fixture. */
export type UnscoredExample = {
  kind: "unscored";
  id: string;
  taskType: TaskType;
  difficultyBand: DifficultyBand;
  expectedTier: Tier;
  notes: string;
  /** The router's degrade cause, or a classified thrown error. Never upstream error text. */
  errorClass: string;
};

export type EvalExampleResult = ScoredExample | UnscoredExample;

export type EvalReport = {
  posture: CostPosture;
  policyVersion: string;
  generatedAt: string;
  scored: ScoredExample[];
  unscored: UnscoredExample[];
};

// ---------------------------------------------------------------------------
// Pure metrics helpers
// ---------------------------------------------------------------------------

/** A rate over `n` items; `NaN`/`n === 0` means "no data", not "0%". */
type Rate = { rate: number; n: number };

function agreementRate(examples: ScoredExample[]): Rate {
  const n = examples.length;
  if (n === 0) return { rate: NaN, n: 0 };
  const agree = examples.filter((e) => e.agree).length;
  return { rate: agree / n, n };
}

/** Overall tier agreement across all scored examples, `NaN` when none are scored. */
export function tierAgreementRate(report: EvalReport): number {
  return agreementRate(report.scored).rate;
}

function taskTypeAccuracy(examples: ScoredExample[]): Rate {
  const n = examples.length;
  if (n === 0) return { rate: NaN, n: 0 };
  const matches = examples.filter((e) => e.predictedTaskType === e.taskType).length;
  return { rate: matches / n, n };
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank p95 over `values`, `NaN` when empty. */
function p95(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

/** `rows[expected][predicted]` counts, always 3x3 over `TIERS`. */
function confusionMatrix(examples: ScoredExample[]): Record<Tier, Record<Tier, number>> {
  const matrix = Object.fromEntries(
    TIERS.map((expected) => [expected, Object.fromEntries(TIERS.map((predicted) => [predicted, 0]))]),
  ) as Record<Tier, Record<Tier, number>>;
  for (const example of examples) {
    matrix[example.expectedTier][example.predictedTier] += 1;
  }
  return matrix;
}

/** Renders a rate as a percentage with one decimal, or `n/a` when there is no data. */
function pct(rate: number): string {
  return Number.isNaN(rate) ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(value: number): string {
  return Number.isNaN(value) ? "n/a" : `${value.toFixed(0)} ms`;
}

function mdTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const divider = header.map(() => "---");
  return [line(header), line(divider), ...rows.map(line)].join("\n");
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function formatMarkdown(report: EvalReport): string {
  const { scored, unscored } = report;
  const total = scored.length + unscored.length;
  const all: EvalExampleResult[] = [...scored, ...unscored];

  const sections: string[] = [];

  sections.push("# Routing eval report");
  sections.push(
    [
      `- Posture: \`${report.posture}\``,
      `- Policy version: \`${report.policyVersion}\``,
      `- Generated: ${report.generatedAt}`,
      `- Examples: ${total} total — ${scored.length} scored, ${unscored.length} unscored`,
    ].join("\n"),
  );

  // --- Unscored -------------------------------------------------------
  sections.push("## Unscored");
  if (unscored.length === 0) {
    sections.push("Every example was scored.");
  } else {
    const byClass = new Map<string, number>();
    for (const example of unscored) {
      byClass.set(example.errorClass, (byClass.get(example.errorClass) ?? 0) + 1);
    }
    const rows = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([errorClass, count]) => [`\`${errorClass}\``, String(count)]);
    const intro =
      scored.length === 0
        ? "No example could be scored. This usually means no fixtures are recorded under " +
          "`packages/evals/fixtures/jev` yet — run in `--mode record` with `JEV_API_KEY` set " +
          "to populate them, then re-run in `--mode fixtures` for a network-free eval."
        : `${unscored.length} of ${total} examples could not be scored.`;
    sections.push(`${intro}\n\n${mdTable(["error class", "count"], rows)}`);
  }

  // --- Tier agreement ---------------------------------------------------
  const overall = agreementRate(scored);
  sections.push("## Tier agreement");
  sections.push(`Overall: ${pct(overall.rate)} (n=${overall.n})`);

  sections.push("### By task type");
  sections.push(
    mdTable(
      ["task type", "agreement", "n"],
      TASK_TYPES.map((taskType) => {
        const group = agreementRate(scored.filter((e) => e.taskType === taskType));
        return [taskType, pct(group.rate), String(group.n)];
      }),
    ),
  );

  sections.push("### By difficulty band");
  sections.push(
    mdTable(
      ["band", "agreement", "n"],
      ([0, 1, 2, 3] as const).map((band) => {
        const group = agreementRate(scored.filter((e) => e.difficultyBand === band));
        return [String(band), pct(group.rate), String(group.n)];
      }),
    ),
  );

  // --- Task-type accuracy -----------------------------------------------
  const typeAcc = taskTypeAccuracy(scored);
  sections.push("## Task-type accuracy");
  sections.push(
    `Jev's \`task_type\` matched the dataset label ${pct(typeAcc.rate)} of the time (n=${typeAcc.n}).`,
  );

  // --- Confusion matrix ---------------------------------------------------
  const matrix = confusionMatrix(scored);
  sections.push("## Tier confusion matrix (rows: expected, columns: predicted)");
  sections.push(
    mdTable(
      ["expected \\ predicted", ...TIERS],
      TIERS.map((expected) => [expected, ...TIERS.map((predicted) => String(matrix[expected][predicted]))]),
    ),
  );

  // --- Latency -------------------------------------------------------
  const latencies = scored.map((e) => e.latencyMs);
  sections.push("## Jev latency");
  sections.push(`Mean: ${fmtMs(mean(latencies))}; p95: ${fmtMs(p95(latencies))} (n=${latencies.length})`);

  // --- Disagreements -------------------------------------------------
  const disagreements = scored.filter((e) => !e.agree);
  sections.push("## Disagreements");
  if (disagreements.length === 0) {
    sections.push(scored.length === 0 ? "No scored examples to compare." : "No disagreements.");
  } else {
    sections.push(
      disagreements
        .map((e) =>
          [
            `- **${e.id}** (${e.taskType}): expected \`${e.expectedTier}\`, predicted \`${e.predictedTier}\`` +
              ` (difficulty ${e.predictedDifficulty.toFixed(2)}, needs_reasoning ${e.needsReasoning.toFixed(2)})`,
            `  - Router: ${e.reason}`,
            `  - Notes: ${e.notes}`,
          ].join("\n"),
        )
        .join("\n"),
    );
  }

  // --- Policy ceiling note -------------------------------------------
  const band2 = all.filter((e) => e.difficultyBand === 2);
  const band2Mid = band2.filter((e) => e.expectedTier === "mid");
  const band2MidShare = band2.length > 0 ? band2Mid.length / band2.length : NaN;
  sections.push("## Policy ceiling note");
  sections.push(
    `${pct(band2MidShare)} (n=${band2Mid.length}/${band2.length}) of difficulty-band-2 examples in the ` +
      "dataset are labeled `mid`. Policy v1 sends difficulty at or above 2.0 under balanced posture to the " +
      "frontier tier (docs/PLAN.md § Policy v1, ADR-002), so the static labels and the policy table " +
      "diverge at band 2 by construction. This is a known divergence between the labels and the table " +
      "that the orchestrator will settle from the live run, not a defect in this report.",
  );

  return sections.join("\n\n");
}
