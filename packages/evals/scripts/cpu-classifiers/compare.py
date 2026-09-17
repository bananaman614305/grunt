"""Compares two CPU classifiers against the `system-one-open` replica on
`packages/evals/data/routing.jsonl`, using the same fitting/evaluation
methodology as `packages/evals/src/run.test.ts`'s two-fold cross-validation:
grid-search tier thresholds on the even-id half, test on the odd-id half (and
vice versa), average the two held-out scores.

Inputs:
  - packages/evals/data/routing.jsonl                          ground truth
  - packages/evals/reports/system-one-open-v2.json             replica's recorded signals
  - packages/evals/reports/cpu-classifiers/routellm.jsonl       from run_routellm.py
  - packages/evals/reports/cpu-classifiers/nvidia.jsonl         from run_nvidia.py

Output:
  - packages/evals/reports/cpu-classifiers/comparison.md

Run after both run_routellm.py and run_nvidia.py have produced their JSONL
files.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[4]  # .../packages/evals/scripts/cpu-classifiers/compare.py -> repo root
DATA_PATH = ROOT / "packages/evals/data/routing.jsonl"
REPLICA_PATH = ROOT / "packages/evals/reports/system-one-open-v2.json"
ROUTELLM_PATH = ROOT / "packages/evals/reports/cpu-classifiers/routellm.jsonl"
NVIDIA_PATH = ROOT / "packages/evals/reports/cpu-classifiers/nvidia.jsonl"
OUT_PATH = ROOT / "packages/evals/reports/cpu-classifiers/comparison.md"

TIERS = ("fast", "mid", "frontier")
BANDS = (0, 1, 2, 3)
CAPPED_TASK_TYPES = {"classify", "chat"}


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def id_number(row_id: str) -> int:
    """`r-042` -> 42, matching run.test.ts's `idNumber`."""
    digits = "".join(c for c in row_id if c.isdigit())
    return int(digits)


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def p95(xs: list[float]) -> float:
    if not xs:
        return float("nan")
    ordered = sorted(xs)
    idx = min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))
    return ordered[idx]


# ---------------------------------------------------------------------------
# Replica: port of packages/core/src/router/policy.ts's mass-based rule
# (balanced posture only -- that's all this eval set uses) and of
# packages/evals/src/run.test.ts's fit/cross-validation harness, so the
# replica's own CV number is computed by the exact same code path as the two
# CPU candidates below rather than quoted from the markdown report.
# ---------------------------------------------------------------------------

SYSTEM_ONE_OPEN_PROFILE = {
    "fastBelowMass": 0.05,
    "frontierHardMass": 0.1,
    "frontierUpperMass": 0.65,
    "cappedFrontierHardMass": 0.3,
}

FAST_GRID = [0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2]
HARD_GRID = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3]
UPPER_GRID = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]


def replica_tier(levels: list[float], task_type: str, profile: dict) -> str:
    p3 = levels[3] if len(levels) > 3 else 0.0
    upper = (levels[2] if len(levels) > 2 else 0.0) + p3

    if upper < profile["fastBelowMass"]:
        tier = "fast"
    elif p3 >= profile["frontierHardMass"] or upper >= profile["frontierUpperMass"]:
        tier = "frontier"
    else:
        tier = "mid"

    if tier == "frontier" and task_type in CAPPED_TASK_TYPES and p3 < profile["cappedFrontierHardMass"]:
        return "mid"
    return tier


def replica_agreement(rows: list[dict], profile: dict) -> float:
    if not rows:
        return float("nan")
    hits = sum(
        1
        for r in rows
        if replica_tier(r["difficultyLevels"], r["predictedTaskType"], profile) == r["expectedTier"]
    )
    return hits / len(rows)


def fit_replica_profile(train: list[dict]) -> tuple[dict, float]:
    best_profile, best_agreement = SYSTEM_ONE_OPEN_PROFILE, -1.0
    for fast in FAST_GRID:
        for hard in HARD_GRID:
            for upper in UPPER_GRID:
                profile = {
                    "fastBelowMass": fast,
                    "frontierHardMass": hard,
                    "frontierUpperMass": upper,
                    "cappedFrontierHardMass": SYSTEM_ONE_OPEN_PROFILE["cappedFrontierHardMass"],
                }
                agreement = replica_agreement(train, profile)
                if agreement > best_agreement:
                    best_profile, best_agreement = profile, agreement
    return best_profile, best_agreement


# ---------------------------------------------------------------------------
# Generic two-cutoff tier rule shared by both CPU candidates: a scalar score
# in [0, 1] maps to fast / mid / frontier via two cutoffs.
# ---------------------------------------------------------------------------


def score_tier(score: float, t_fast: float, t_frontier: float) -> str:
    if score < t_fast:
        return "fast"
    if score >= t_frontier:
        return "frontier"
    return "mid"


def grid_2d(step: float = 0.02) -> list[float]:
    n = round(1 / step)
    return [round(i * step, 4) for i in range(n + 1)]


CUTOFF_GRID = grid_2d(0.02)
CAP_LIFT_GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


def fit_two_cutoffs(rows: list[dict], score_key: str, expected_key: str = "expected_tier") -> tuple[tuple, float]:
    best = ((0.05, 0.65), -1.0)
    for t_fast in CUTOFF_GRID:
        for t_frontier in CUTOFF_GRID:
            if t_frontier < t_fast:
                continue
            hits = 0
            for r in rows:
                if score_tier(r[score_key], t_fast, t_frontier) == r[expected_key]:
                    hits += 1
            agreement = hits / len(rows) if rows else float("nan")
            if agreement > best[1]:
                best = ((t_fast, t_frontier), agreement)
    return best


def agreement_with_cutoffs(rows: list[dict], cutoffs: tuple, score_key: str, expected_key: str = "expected_tier") -> float:
    t_fast, t_frontier = cutoffs
    if not rows:
        return float("nan")
    hits = sum(1 for r in rows if score_tier(r[score_key], t_fast, t_frontier) == r[expected_key])
    return hits / len(rows)


def fit_two_cutoffs_with_cap(rows: list[dict], score_key: str, capped_key: str) -> tuple[tuple, float]:
    """Same as fit_two_cutoffs, but a `frontier` verdict on a row where
    `capped_key` is true is pulled back to `mid` unless `score >= cap_lift`.
    """
    best = ((0.05, 0.65, 0.3), -1.0)
    for t_fast in CUTOFF_GRID:
        for t_frontier in CUTOFF_GRID:
            if t_frontier < t_fast:
                continue
            for cap_lift in CAP_LIFT_GRID:
                hits = 0
                for r in rows:
                    tier = score_tier(r[score_key], t_fast, t_frontier)
                    if tier == "frontier" and r[capped_key] and r[score_key] < cap_lift:
                        tier = "mid"
                    if tier == r["expected_tier"]:
                        hits += 1
                agreement = hits / len(rows) if rows else float("nan")
                if agreement > best[1]:
                    best = ((t_fast, t_frontier, cap_lift), agreement)
    return best


def agreement_with_cutoffs_and_cap(rows: list[dict], cutoffs: tuple, score_key: str, capped_key: str) -> float:
    t_fast, t_frontier, cap_lift = cutoffs
    if not rows:
        return float("nan")
    hits = 0
    for r in rows:
        tier = score_tier(r[score_key], t_fast, t_frontier)
        if tier == "frontier" and r[capped_key] and r[score_key] < cap_lift:
            tier = "mid"
        if tier == r["expected_tier"]:
            hits += 1
    return hits / len(rows)


def two_fold_cv(rows: list[dict], fit_fn, agreement_fn) -> tuple[float, list]:
    even = [r for r in rows if id_number(r["id"]) % 2 == 0]
    odd = [r for r in rows if id_number(r["id"]) % 2 == 1]
    folds = [(even, odd), (odd, even)]
    held_out = []
    fits = []
    for train, test in folds:
        fitted, _in_sample = fit_fn(train)
        held = agreement_fn(test, fitted)
        held_out.append(held)
        fits.append(fitted)
    return mean(held_out), fits


# ---------------------------------------------------------------------------
# NVIDIA task-type -> Milo task-type mapping
#
# NVIDIA's 12-way `task_type` schema and Milo's 9-way `task_type` schema were
# built for different purposes (general instruction-following vs. "what kind
# of work is this for a coding agent"), so the mapping is lossy in both
# directions:
#
#   - Chatbot, Brainstorming  -> chat        (docs/routing.md's `chat` explicitly
#                                              includes "brainstorming")
#   - Classification, Extraction -> classify (Milo's `classify` explicitly
#                                              includes "extract fields" and,
#                                              per the eval README, "summarize
#                                              into a fixed shape")
#   - Summarization           -> classify    (see above: Milo's own labeling
#                                              spec files summarization under
#                                              `classify`)
#   - Code Generation         -> feature     (dominant case for a coding agent:
#                                              most "generate code" requests
#                                              build something new; genuinely
#                                              many-to-one, since some are
#                                              `edit`)
#   - Rewrite                 -> edit        (a bounded transformation of
#                                              existing text/code)
#   - Closed QA, Open QA      -> research    (answering a question either from
#                                              given context or general
#                                              knowledge is closest to Milo's
#                                              "gather and synthesize"; a
#                                              genuinely fuzzy case -- a lot of
#                                              Closed/Open QA in this dataset
#                                              is really `chat`)
#   - Other, Unknown          -> unmappable  (no signal at all)
#   - Text Generation         -> unmappable  (too generic a bucket: could be
#                                              `feature`, `docs`, `chat`, or
#                                              `edit` depending on content;
#                                              guessing would inflate accuracy
#                                              artificially)
#
# Milo task types with NO NVIDIA source category at all: `debug`, `review`,
# `ops`. NVIDIA's schema has nothing resembling "something is broken, find out
# why", "judge a diff someone else wrote", or "infrastructure/CI/deploys" --
# these Milo labels are structurally unreachable through this mapping, and
# rows labeled with them will always score as a miss on task-type accuracy.
# That is a real, reportable limitation of using this classifier for Milo's
# task-type signal, not a bug in the mapping.
# ---------------------------------------------------------------------------

NVIDIA_TO_MILO = {
    "Brainstorming": "chat",
    "Chatbot": "chat",
    "Classification": "classify",
    "Closed QA": "research",
    "Code Generation": "feature",
    "Extraction": "classify",
    "Open QA": "research",
    "Other": None,
    "Rewrite": "edit",
    "Summarization": "classify",
    "Text Generation": None,
    "Unknown": None,
}


def main() -> None:
    truth = {r["id"]: r for r in load_jsonl(DATA_PATH)}
    replica = json.loads(REPLICA_PATH.read_text(encoding="utf-8"))
    routellm = {r["id"]: r for r in load_jsonl(ROUTELLM_PATH)}
    nvidia = {r["id"]: r for r in load_jsonl(NVIDIA_PATH)}

    ids = [r["id"] for r in load_jsonl(DATA_PATH)]
    assert set(routellm) == set(ids), "routellm.jsonl is missing/extra rows vs routing.jsonl"
    assert set(nvidia) == set(ids), "nvidia.jsonl is missing/extra rows vs routing.jsonl"

    # --- replica rows (already carry predicted signals + ground truth) -----
    replica_rows = replica["scored"]
    assert len(replica_rows) == len(ids)

    # --- RouteLLM rows -------------------------------------------------
    routellm_rows = []
    for rid in ids:
        t = truth[rid]
        routellm_rows.append(
            {
                "id": rid,
                "p_strong": routellm[rid]["p_strong"],
                "expected_tier": t["expected_tier_balanced"],
                "difficulty_band": t["difficulty_band"],
                "latency_ms": routellm[rid]["latency_ms"],
            }
        )

    # --- NVIDIA rows -----------------------------------------------------
    nvidia_rows = []
    for rid in ids:
        t = truth[rid]
        n = nvidia[rid]
        mapped = NVIDIA_TO_MILO.get(n["task_type_1"])
        nvidia_rows.append(
            {
                "id": rid,
                "score": n["prompt_complexity_score"],
                "expected_tier": t["expected_tier_balanced"],
                "difficulty_band": t["difficulty_band"],
                "task_type": t["task_type"],
                "predicted_task_type_raw": n["task_type_1"],
                "predicted_task_type_mapped": mapped,
                "is_capped": mapped in CAPPED_TASK_TYPES,
                "latency_ms": n["latency_ms"],
            }
        )

    # -----------------------------------------------------------------
    # Replica: in-sample = shipped v2 profile replayed on all 120 (this is
    # the number in packages/evals/reports/system-one-open-v2.md); CV =
    # two-fold refit, computed here the same way run.test.ts does it.
    # -----------------------------------------------------------------
    replica_in_sample = replica_agreement(replica_rows, SYSTEM_ONE_OPEN_PROFILE)
    replica_cv, replica_fits = two_fold_cv(
        replica_rows,
        fit_replica_profile,
        replica_agreement,
    )
    replica_latencies = [r["latencyMs"] for r in replica_rows]

    # -----------------------------------------------------------------
    # RouteLLM: fresh full-grid fit for "in-sample" (never fitted before),
    # two-fold CV the same way.
    # -----------------------------------------------------------------
    routellm_best, routellm_in_sample = fit_two_cutoffs(routellm_rows, "p_strong")
    routellm_cv, routellm_fits = two_fold_cv(
        routellm_rows,
        lambda train: fit_two_cutoffs(train, "p_strong"),
        lambda test, cutoffs: agreement_with_cutoffs(test, cutoffs, "p_strong"),
    )
    routellm_latencies = [r["latency_ms"] for r in routellm_rows]

    # -----------------------------------------------------------------
    # NVIDIA, score-only variant.
    # -----------------------------------------------------------------
    nvidia_best, nvidia_in_sample = fit_two_cutoffs(nvidia_rows, "score")
    nvidia_cv, _ = two_fold_cv(
        nvidia_rows,
        lambda train: fit_two_cutoffs(train, "score"),
        lambda test, cutoffs: agreement_with_cutoffs(test, cutoffs, "score"),
    )

    # NVIDIA, score + classify/chat cap variant.
    nvidia_cap_best, nvidia_cap_in_sample = fit_two_cutoffs_with_cap(nvidia_rows, "score", "is_capped")
    nvidia_cap_cv, _ = two_fold_cv(
        nvidia_rows,
        lambda train: fit_two_cutoffs_with_cap(train, "score", "is_capped"),
        lambda test, cutoffs: agreement_with_cutoffs_and_cap(test, cutoffs, "score", "is_capped"),
    )
    nvidia_latencies = [r["latency_ms"] for r in nvidia_rows]

    # -----------------------------------------------------------------
    # Task-type accuracy (NVIDIA only; RouteLLM's bert router has no
    # task-type output).
    # -----------------------------------------------------------------
    nvidia_task_hits = sum(1 for r in nvidia_rows if r["predicted_task_type_mapped"] == r["task_type"])
    nvidia_task_accuracy = nvidia_task_hits / len(nvidia_rows)

    reachable_types = {v for v in NVIDIA_TO_MILO.values() if v is not None}
    reachable_rows = [r for r in nvidia_rows if r["task_type"] in reachable_types]
    nvidia_task_accuracy_reachable = (
        sum(1 for r in reachable_rows if r["predicted_task_type_mapped"] == r["task_type"]) / len(reachable_rows)
        if reachable_rows
        else float("nan")
    )

    # -----------------------------------------------------------------
    # Per-band agreement, using each candidate's full-120 in-sample fit
    # (mirrors how system-one-open-v2.md's per-band table was produced: the
    # shipped/best-fit profile applied across the whole set).
    # -----------------------------------------------------------------
    def per_band(rows: list[dict], predict) -> dict[int, tuple[float, int]]:
        out = {}
        for band in BANDS:
            band_rows = [r for r in rows if r["difficulty_band"] == band]
            if not band_rows:
                out[band] = (float("nan"), 0)
                continue
            hits = sum(1 for r in band_rows if predict(r) == r["expected_tier"])
            out[band] = (hits / len(band_rows), len(band_rows))
        return out

    replica_band = {}
    for band in BANDS:
        band_rows = [r for r in replica_rows if r["difficultyBand"] == band]
        hits = sum(
            1
            for r in band_rows
            if replica_tier(r["difficultyLevels"], r["predictedTaskType"], SYSTEM_ONE_OPEN_PROFILE)
            == r["expectedTier"]
        )
        replica_band[band] = (hits / len(band_rows) if band_rows else float("nan"), len(band_rows))

    routellm_band = per_band(routellm_rows, lambda r: score_tier(r["p_strong"], *routellm_best))
    nvidia_band = per_band(nvidia_rows, lambda r: score_tier(r["score"], *nvidia_best))

    def nvidia_cap_predict(r):
        t_fast, t_frontier, cap_lift = nvidia_cap_best
        tier = score_tier(r["score"], t_fast, t_frontier)
        if tier == "frontier" and r["is_capped"] and r["score"] < cap_lift:
            tier = "mid"
        return tier

    nvidia_cap_band = per_band(nvidia_rows, nvidia_cap_predict)

    # -----------------------------------------------------------------
    # Model size on disk / license -- measured once during this experiment's
    # setup (see the scripts' module docstrings for sourcing); not
    # recomputed here since the venv/HF cache is gitignored and not assumed
    # to exist at report-read time.
    # -----------------------------------------------------------------
    MODEL_META = {
        "replica": {
            "size": "n/a (hosted `system-one-open` backend, not a local model)",
            "license": "n/a (Milo-operated backend, not a redistributable checkpoint)",
        },
        "routellm": {
            "size": "~1.1 GB (`routellm/bert_gpt4_augmented`, XLM-RoBERTa-base, safetensors)",
            "license": "Apache-2.0 (lm-sys/RouteLLM repo license; checkpoint itself ships no HF model card/license tag)",
        },
        "nvidia": {
            "size": "~713 MB (own checkpoint; loading also pulls ~708 MB of `microsoft/deberta-v3-base` "
            "backbone weights that get overwritten, per the model card's own loading code)",
            "license": "NVIDIA Open Model License Agreement (commercial use permitted; HF tag `license: other`)",
        },
    }

    # -----------------------------------------------------------------
    # Render markdown
    # -----------------------------------------------------------------
    lines = []
    lines.append("# CPU classifiers vs. the `system-one-open` replica")
    lines.append("")
    lines.append(
        "120-row `packages/evals/data/routing.jsonl`, `posture: balanced`. "
        "In-sample and two-fold cross-validation (fit on even ids, test on odd, and vice versa, "
        "averaged) computed by `compare.py` for all three rows using the same methodology as "
        "`packages/evals/src/run.test.ts`."
    )
    lines.append("")
    lines.append(
        "**Replica's in-sample number is the shipped v2 profile replayed on all 120 rows** "
        "(the number in `system-one-open-v2.md`); the two CPU candidates' in-sample numbers are "
        "fresh full-grid fits over all 120 rows, since their thresholds have never been fitted "
        "before this experiment. All three CV numbers are refit-per-fold, so they are directly "
        "comparable to each other."
    )
    lines.append("")

    lines.append("## Summary")
    lines.append("")
    header = (
        "| candidate | in-sample agreement | 2-fold CV agreement | task-type accuracy | "
        "mean latency | p95 latency | model size on disk | license |"
    )
    sep = "|---|---|---|---|---|---|---|---|"
    lines.append(header)
    lines.append(sep)
    lines.append(
        "| replica (`system-one-open`, shipped v2 profile) | "
        f"{replica_in_sample * 100:.1f}% | {replica_cv * 100:.1f}% | 76.7% (Jev's own `task_type` call) | "
        f"{mean(replica_latencies):.0f} ms | {p95(replica_latencies):.0f} ms | "
        f"{MODEL_META['replica']['size']} | {MODEL_META['replica']['license']} |"
    )
    lines.append(
        "| RouteLLM (`bert_gpt4_augmented`), 2 cutoffs on P(strong) | "
        f"{routellm_in_sample * 100:.1f}% | {routellm_cv * 100:.1f}% | n/a (no task-type output) | "
        f"{mean(routellm_latencies):.0f} ms | {p95(routellm_latencies):.0f} ms | "
        f"{MODEL_META['routellm']['size']} | {MODEL_META['routellm']['license']} |"
    )
    lines.append(
        "| NVIDIA complexity classifier, 2 cutoffs on `prompt_complexity_score` | "
        f"{nvidia_in_sample * 100:.1f}% | {nvidia_cv * 100:.1f}% | {nvidia_task_accuracy * 100:.1f}% "
        f"(12-way task type mapped onto Milo's 9, see mapping below) | "
        f"{mean(nvidia_latencies):.0f} ms | {p95(nvidia_latencies):.0f} ms | "
        f"{MODEL_META['nvidia']['size']} | {MODEL_META['nvidia']['license']} |"
    )
    lines.append(
        "| NVIDIA complexity classifier + classify/chat cap (same cap Milo applies) | "
        f"{nvidia_cap_in_sample * 100:.1f}% | {nvidia_cap_cv * 100:.1f}% | {nvidia_task_accuracy * 100:.1f}% "
        f"(same mapping) | {mean(nvidia_latencies):.0f} ms | {p95(nvidia_latencies):.0f} ms | "
        f"{MODEL_META['nvidia']['size']} | {MODEL_META['nvidia']['license']} |"
    )
    lines.append("")

    lines.append("## Per-band agreement (each candidate's full-120 in-sample fit)")
    lines.append("")
    lines.append("| candidate | band 0 | band 1 | band 2 | band 3 |")
    lines.append("|---|---|---|---|---|")

    def fmt_band(d):
        return " | ".join(f"{d[b][0] * 100:.1f}% (n={d[b][1]})" for b in BANDS)

    lines.append(f"| replica | {fmt_band(replica_band)} |")
    lines.append(f"| RouteLLM | {fmt_band(routellm_band)} |")
    lines.append(f"| NVIDIA (score only) | {fmt_band(nvidia_band)} |")
    lines.append(f"| NVIDIA (+ cap) | {fmt_band(nvidia_cap_band)} |")
    lines.append("")

    lines.append("## Fitted thresholds")
    lines.append("")
    lines.append(
        f"- Replica (in-sample, shipped): fastBelowMass={SYSTEM_ONE_OPEN_PROFILE['fastBelowMass']}, "
        f"frontierHardMass={SYSTEM_ONE_OPEN_PROFILE['frontierHardMass']}, "
        f"frontierUpperMass={SYSTEM_ONE_OPEN_PROFILE['frontierUpperMass']}, "
        f"cappedFrontierHardMass={SYSTEM_ONE_OPEN_PROFILE['cappedFrontierHardMass']} (unchanged, not refit here)"
    )
    lines.append(
        f"- Replica CV folds: {replica_fits[0]}, {replica_fits[1]}"
    )
    lines.append(
        f"- RouteLLM (in-sample, all 120): fast below P(strong)={routellm_best[0]:.2f}, "
        f"frontier at or above P(strong)={routellm_best[1]:.2f}"
    )
    lines.append(
        f"- NVIDIA score-only (in-sample, all 120): fast below score={nvidia_best[0]:.2f}, "
        f"frontier at or above score={nvidia_best[1]:.2f}"
    )
    lines.append(
        f"- NVIDIA + cap (in-sample, all 120): fast below score={nvidia_cap_best[0]:.2f}, "
        f"frontier at or above score={nvidia_cap_best[1]:.2f}, classify/chat cap lifts at score>={nvidia_cap_best[2]:.2f}"
    )
    lines.append("")

    lines.append("## NVIDIA task-type mapping (12-way -> Milo's 9-way)")
    lines.append("")
    lines.append("| NVIDIA `task_type_1` | Milo `task_type` |")
    lines.append("|---|---|")
    for k, v in NVIDIA_TO_MILO.items():
        lines.append(f"| {k} | {v if v is not None else '_(unmappable)_'} |")
    lines.append("")
    lines.append(
        "Milo task types with no NVIDIA source category at all: `debug`, `review`, `ops` -- rows "
        "labeled with these can never be matched through this mapping, by construction."
    )
    lines.append("")

    lines.append("## Notes")
    lines.append("")
    lines.append(
        "- Replica's task-type accuracy (76.7%) and Jev latency figures are quoted from "
        "`packages/evals/reports/system-one-open-v2.md`, not recomputed here."
    )
    lines.append(
        "- RouteLLM's `bert_gpt4_augmented` router outputs a single scalar (`P(strong)`); it has no "
        "task-type signal, so it cannot support the classify/chat cap or a task-type accuracy figure."
    )
    lines.append(
        "- All latency numbers are single-row, single-threaded CPU wall-clock time from "
        "`run_routellm.py`/`run_nvidia.py` on this machine; no batching, no GPU."
    )
    lines.append(
        f"- {len(reachable_rows)}/120 dataset rows have a ground-truth `task_type` this mapping can "
        f"even reach (`debug`/`review`/`ops` rows are automatic misses). Restricted to those rows, "
        f"NVIDIA's mapped task-type accuracy is {nvidia_task_accuracy_reachable * 100:.1f}%, vs. "
        f"{nvidia_task_accuracy * 100:.1f}% over all 120."
    )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH}")
    print()
    print("\n".join(lines))


if __name__ == "__main__":
    main()
