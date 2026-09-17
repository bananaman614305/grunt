"""Scores every row of `routing.jsonl` with NVIDIA's prompt task and
complexity classifier.

Checkpoint: `nvidia/prompt-task-and-complexity-classifier` on the Hugging
Face Hub. License: "NVIDIA Open Model License Agreement"
(https://developer.download.nvidia.com/licenses/nvidia-open-model-license-agreement-june-2024.pdf),
tagged `license: other` on the model card since it predates a matching HF
license shortcode; the agreement permits commercial use. Architecture per
its model card and `config.json`: a `microsoft/deberta-v3-base` backbone
with 8 linear classification heads over mean-pooled hidden states (task
type, creativity_scope, reasoning, contextual_knowledge,
number_of_few_shots, domain_knowledge, no_label_reason, constraint_ct), one
of which (task type) is 12-way and the rest are ordinal buckets folded into
a 0..1 score by a fixed per-target weight/divisor map baked into
`config.json`.

Note on `trust_remote_code`: the task brief describes this model as using
"custom code (`trust_remote_code=True`)". In practice the Hub repo ships no
`modeling_*.py`, so there is nothing for `trust_remote_code` to fetch — the
model card instead documents a `CustomModel` class (using
`huggingface_hub.PyTorchModelHubMixin`) that the caller defines locally and
loads weights into via `.from_pretrained(...)`. That is what
`CustomModel` below is: a direct, unmodified copy of the class from the
model card, not code pulled from the Hub. No `trust_remote_code` flag is
passed or needed.

Output: one JSON line per row in
`packages/evals/reports/cpu-classifiers/nvidia.jsonl` with:
  - id
  - task_type_1, task_type_2, task_type_prob   top-2 predicted task types + prob of the top one
  - creativity_scope, reasoning, contextual_knowledge, number_of_few_shots,
    domain_knowledge, no_label_reason, constraint_ct   the 7 complexity sub-scores, each in ~[0, 1]
  - prompt_complexity_score   the model's own weighted overall score
  - latency_ms   wall-clock time for tokenize + forward pass, this row only
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn
from huggingface_hub import PyTorchModelHubMixin, hf_hub_download
from transformers import AutoModel, AutoTokenizer

sys.path.insert(0, str(Path(__file__).parent))
from prompt_text import build_prompt_text, load_rows  # noqa: E402

CHECKPOINT = "nvidia/prompt-task-and-complexity-classifier"

DATA_PATH = "packages/evals/data/routing.jsonl"
OUT_PATH = "packages/evals/reports/cpu-classifiers/nvidia.jsonl"


# ---------------------------------------------------------------------------
# Verbatim (structurally) from the model card, https://huggingface.co/nvidia/prompt-task-and-complexity-classifier
# ---------------------------------------------------------------------------


class MeanPooling(nn.Module):
    def __init__(self):
        super(MeanPooling, self).__init__()

    def forward(self, last_hidden_state, attention_mask):
        input_mask_expanded = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        sum_embeddings = torch.sum(last_hidden_state * input_mask_expanded, 1)
        sum_mask = input_mask_expanded.sum(1)
        sum_mask = torch.clamp(sum_mask, min=1e-9)
        return sum_embeddings / sum_mask


class MulticlassHead(nn.Module):
    def __init__(self, input_size, num_classes):
        super(MulticlassHead, self).__init__()
        self.fc = nn.Linear(input_size, num_classes)

    def forward(self, x):
        return self.fc(x)


class CustomModel(nn.Module, PyTorchModelHubMixin):
    def __init__(self, target_sizes, task_type_map, weights_map, divisor_map):
        super(CustomModel, self).__init__()
        self.backbone = AutoModel.from_pretrained("microsoft/deberta-v3-base")
        self.target_sizes = target_sizes.values()
        self.task_type_map = task_type_map
        self.weights_map = weights_map
        self.divisor_map = divisor_map

        self.heads = [MulticlassHead(self.backbone.config.hidden_size, sz) for sz in self.target_sizes]
        for i, head in enumerate(self.heads):
            self.add_module(f"head_{i}", head)

        self.pool = MeanPooling()

    def compute_results(self, preds, target, decimal=4):
        import numpy as np

        if target == "task_type":
            top2_indices = torch.topk(preds, k=2, dim=1).indices
            softmax_probs = torch.softmax(preds, dim=1)
            top2_probs = softmax_probs.gather(1, top2_indices)
            top2 = top2_indices.detach().cpu().tolist()
            top2_prob = top2_probs.detach().cpu().tolist()

            top2_strings = [[self.task_type_map[str(idx)] for idx in sample] for sample in top2]
            top2_prob_rounded = [[round(value, 3) for value in sublist] for sublist in top2_prob]

            for counter, sublist in enumerate(top2_prob_rounded):
                if sublist[1] < 0.1:
                    top2_strings[counter][1] = "NA"

            task_type_1 = [sublist[0] for sublist in top2_strings]
            task_type_2 = [sublist[1] for sublist in top2_strings]
            task_type_prob = [sublist[0] for sublist in top2_prob_rounded]
            return (task_type_1, task_type_2, task_type_prob)

        preds = torch.softmax(preds, dim=1)
        weights = np.array(self.weights_map[target])
        weighted_sum = np.sum(np.array(preds.detach().cpu()) * weights, axis=1)
        scores = weighted_sum / self.divisor_map[target]
        scores = [round(value, decimal) for value in scores]
        if target == "number_of_few_shots":
            scores = [x if x >= 0.05 else 0 for x in scores]
        return scores

    def process_logits(self, logits):
        result = {}

        task_type_results = self.compute_results(logits[0], target="task_type")
        result["task_type_1"] = task_type_results[0]
        result["task_type_2"] = task_type_results[1]
        result["task_type_prob"] = task_type_results[2]

        for i, target in enumerate(
            [
                "creativity_scope",
                "reasoning",
                "contextual_knowledge",
                "number_of_few_shots",
                "domain_knowledge",
                "no_label_reason",
                "constraint_ct",
            ],
            start=1,
        ):
            result[target] = self.compute_results(logits[i], target=target)

        result["prompt_complexity_score"] = [
            round(
                0.35 * creativity
                + 0.25 * reasoning
                + 0.15 * constraint
                + 0.15 * domain_knowledge
                + 0.05 * contextual_knowledge
                + 0.05 * few_shots,
                5,
            )
            for creativity, reasoning, constraint, domain_knowledge, contextual_knowledge, few_shots in zip(
                result["creativity_scope"],
                result["reasoning"],
                result["constraint_ct"],
                result["domain_knowledge"],
                result["contextual_knowledge"],
                result["number_of_few_shots"],
            )
        ]
        return result

    def forward(self, batch):
        input_ids = batch["input_ids"]
        attention_mask = batch["attention_mask"]
        outputs = self.backbone(input_ids=input_ids, attention_mask=attention_mask)
        last_hidden_state = outputs.last_hidden_state
        mean_pooled_representation = self.pool(last_hidden_state, attention_mask)
        logits = [self.heads[k](mean_pooled_representation) for k in range(len(self.target_sizes))]
        return self.process_logits(logits)


# ---------------------------------------------------------------------------


def main() -> None:
    print(f"Loading {CHECKPOINT} ...")
    # This checkpoint's config.json is a plain custom dict (no `model_type`),
    # written by `PyTorchModelHubMixin.save_pretrained`'s config-saving path
    # rather than a transformers `PretrainedConfig` -- `AutoConfig` refuses it
    # ("Unrecognized model ... Should have a `model_type` key"). Read it
    # directly instead; the fields we need are plain dicts either way.
    config_path = hf_hub_download(CHECKPOINT, "config.json")
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    tokenizer = AutoTokenizer.from_pretrained(CHECKPOINT)
    model = CustomModel.from_pretrained(
        CHECKPOINT,
        target_sizes=config["target_sizes"],
        task_type_map=config["task_type_map"],
        weights_map=config["weights_map"],
        divisor_map=config["divisor_map"],
    )
    model.eval()

    rows = load_rows(DATA_PATH)
    print(f"Scoring {len(rows)} rows ...")

    out_path = Path(OUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", encoding="utf-8") as out:
        for row in rows:
            text = build_prompt_text(row)
            encoded = tokenizer(
                [text],
                return_tensors="pt",
                add_special_tokens=True,
                max_length=512,
                padding="max_length",
                truncation=True,
            )
            start = time.perf_counter()
            with torch.no_grad():
                result = model(encoded)
            latency_ms = (time.perf_counter() - start) * 1000

            record = {"id": row["id"]}
            for key, value in result.items():
                record[key] = value[0]
            record["latency_ms"] = latency_ms

            out.write(json.dumps(record) + "\n")

    print(f"Wrote {len(rows)} rows to {out_path}")


if __name__ == "__main__":
    main()
