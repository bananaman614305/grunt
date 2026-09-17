"""Scores every row of `routing.jsonl` with RouteLLM's BERT router.

Checkpoint: `routellm/bert_gpt4_augmented` on the Hugging Face Hub — the
exact path `config.example.yaml` in https://github.com/lm-sys/RouteLLM wires
up for `router: bert`. It has no model card of its own (HF shows "No model
card"), so there is no per-checkpoint license tag; it is a first-party
artifact of the lm-sys/RouteLLM GitHub repo, which is Apache-2.0
(`LICENSE` at the repo root). Architecture per its `config.json`:
`XLMRobertaForSequenceClassification`, 3 labels, base-sized (~0.3B params,
matching the sibling `routellm/bert` checkpoint's HF-reported size).

Loading and scoring logic below is a direct, unmodified port of
`BERTRouter` in `routellm/routers/routers.py` (verified against the
lm-sys/RouteLLM source): tokenize with `padding=True, truncation=True` (no
explicit `max_length` — the tokenizer's own model_max_length applies),
take the logits, softmax them, and read the strong-model win rate as
`1 - sum(softmax[-2:])` (i.e. the probability mass NOT on the top two of
three labels, which the router code comments as "prob of label 1 and 2
(tie, tier 2 wins)"). We report every intermediate number, not just the
final probability, so `compare.py` and any later reader can audit it.

Output: one JSON line per row in
`packages/evals/reports/cpu-classifiers/routellm.jsonl` with:
  - id
  - p_strong        the RouteLLM strong-model win rate, in [0, 1]
  - logits          raw 3-class logits
  - softmax         softmax over the 3 logits
  - binary_prob     sum of the last two softmax entries (pre-inversion)
  - latency_ms      wall-clock time for tokenize + forward pass, this row only
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

sys.path.insert(0, str(Path(__file__).parent))
from prompt_text import build_prompt_text, load_rows  # noqa: E402

CHECKPOINT = "routellm/bert_gpt4_augmented"
NUM_LABELS = 3

DATA_PATH = "packages/evals/data/routing.jsonl"
OUT_PATH = "packages/evals/reports/cpu-classifiers/routellm.jsonl"


def calculate_strong_win_rate(model, tokenizer, prompt: str) -> dict:
    inputs = tokenizer(prompt, return_tensors="pt", padding=True, truncation=True)
    with torch.no_grad():
        outputs = model(**inputs)
        logits = outputs.logits.numpy()[0]

    exp_scores = np.exp(logits - np.max(logits))
    softmax_scores = exp_scores / np.sum(exp_scores)

    # RouteLLM's own comment: "Compute prob of label 1 and 2 (tie, tier 2 wins)"
    binary_prob = float(np.sum(softmax_scores[-2:]))
    p_strong = 1 - binary_prob

    return {
        "logits": [float(x) for x in logits],
        "softmax": [float(x) for x in softmax_scores],
        "binary_prob": binary_prob,
        "p_strong": float(p_strong),
    }


def main() -> None:
    print(f"Loading {CHECKPOINT} ...")
    tokenizer = AutoTokenizer.from_pretrained(CHECKPOINT)
    model = AutoModelForSequenceClassification.from_pretrained(CHECKPOINT, num_labels=NUM_LABELS)
    model.eval()

    rows = load_rows(DATA_PATH)
    print(f"Scoring {len(rows)} rows ...")

    out_path = Path(OUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", encoding="utf-8") as out:
        for row in rows:
            text = build_prompt_text(row)
            start = time.perf_counter()
            result = calculate_strong_win_rate(model, tokenizer, text)
            latency_ms = (time.perf_counter() - start) * 1000

            record = {
                "id": row["id"],
                **result,
                "latency_ms": latency_ms,
            }
            out.write(json.dumps(record) + "\n")

    print(f"Wrote {len(rows)} rows to {out_path}")


if __name__ == "__main__":
    main()
