# CPU classifiers vs. the `system-one-open` replica

120-row `packages/evals/data/routing.jsonl`, `posture: balanced`. In-sample and two-fold cross-validation (fit on even ids, test on odd, and vice versa, averaged) computed by `compare.py` for all three rows using the same methodology as `packages/evals/src/run.test.ts`.

**Replica's in-sample number is the shipped v2 profile replayed on all 120 rows** (the number in `system-one-open-v2.md`); the two CPU candidates' in-sample numbers are fresh full-grid fits over all 120 rows, since their thresholds have never been fitted before this experiment. All three CV numbers are refit-per-fold, so they are directly comparable to each other.

## Summary

| candidate | in-sample agreement | 2-fold CV agreement | task-type accuracy | mean latency | p95 latency | model size on disk | license |
|---|---|---|---|---|---|---|---|
| replica (`system-one-open`, shipped v2 profile) | 83.3% | 80.8% | 76.7% (Jev's own `task_type` call) | 2 ms | 3 ms | n/a (hosted `system-one-open` backend, not a local model) | n/a (Milo-operated backend, not a redistributable checkpoint) |
| RouteLLM (`bert_gpt4_augmented`), 2 cutoffs on P(strong) | 45.0% | 36.7% | n/a (no task-type output) | 98 ms | 202 ms | ~1.1 GB (`routellm/bert_gpt4_augmented`, XLM-RoBERTa-base, safetensors) | Apache-2.0 (lm-sys/RouteLLM repo license; checkpoint itself ships no HF model card/license tag) |
| NVIDIA complexity classifier, 2 cutoffs on `prompt_complexity_score` | 61.7% | 54.2% | 16.7% (12-way task type mapped onto Milo's 9, see mapping below) | 3832 ms | 4454 ms | ~713 MB (own checkpoint; loading also pulls ~708 MB of `microsoft/deberta-v3-base` backbone weights that get overwritten, per the model card's own loading code) | NVIDIA Open Model License Agreement (commercial use permitted; HF tag `license: other`) |
| NVIDIA complexity classifier + classify/chat cap (same cap Milo applies) | 61.7% | 55.8% | 16.7% (same mapping) | 3832 ms | 4454 ms | ~713 MB (own checkpoint; loading also pulls ~708 MB of `microsoft/deberta-v3-base` backbone weights that get overwritten, per the model card's own loading code) | NVIDIA Open Model License Agreement (commercial use permitted; HF tag `license: other`) |

## Per-band agreement (each candidate's full-120 in-sample fit)

| candidate | band 0 | band 1 | band 2 | band 3 |
|---|---|---|---|---|
| replica | 100.0% (n=27) | 71.4% (n=35) | 75.8% (n=33) | 92.0% (n=25) |
| RouteLLM | 100.0% (n=27) | 54.3% (n=35) | 12.1% (n=33) | 16.0% (n=25) |
| NVIDIA (score only) | 85.2% (n=27) | 62.9% (n=35) | 33.3% (n=33) | 72.0% (n=25) |
| NVIDIA (+ cap) | 85.2% (n=27) | 62.9% (n=35) | 33.3% (n=33) | 72.0% (n=25) |

## Fitted thresholds

- Replica (in-sample, shipped): fastBelowMass=0.05, frontierHardMass=0.1, frontierUpperMass=0.65, cappedFrontierHardMass=0.3 (unchanged, not refit here)
- Replica CV folds: {'fastBelowMass': 0.08, 'frontierHardMass': 0.08, 'frontierUpperMass': 0.6, 'cappedFrontierHardMass': 0.3}, {'fastBelowMass': 0.05, 'frontierHardMass': 0.08, 'frontierUpperMass': 0.65, 'cappedFrontierHardMass': 0.3}
- RouteLLM (in-sample, all 120): fast below P(strong)=0.50, frontier at or above P(strong)=0.52
- NVIDIA score-only (in-sample, all 120): fast below score=0.20, frontier at or above score=0.30
- NVIDIA + cap (in-sample, all 120): fast below score=0.20, frontier at or above score=0.30, classify/chat cap lifts at score>=0.10

## NVIDIA task-type mapping (12-way -> Milo's 9-way)

| NVIDIA `task_type_1` | Milo `task_type` |
|---|---|
| Brainstorming | chat |
| Chatbot | chat |
| Classification | classify |
| Closed QA | research |
| Code Generation | feature |
| Extraction | classify |
| Open QA | research |
| Other | _(unmappable)_ |
| Rewrite | edit |
| Summarization | classify |
| Text Generation | _(unmappable)_ |
| Unknown | _(unmappable)_ |

Milo task types with no NVIDIA source category at all: `debug`, `review`, `ops` -- rows labeled with these can never be matched through this mapping, by construction.

## Notes

- Replica's task-type accuracy (76.7%) and Jev latency figures are quoted from `packages/evals/reports/system-one-open-v2.md`, not recomputed here.
- RouteLLM's `bert_gpt4_augmented` router outputs a single scalar (`P(strong)`); it has no task-type signal, so it cannot support the classify/chat cap or a task-type accuracy figure.
- All latency numbers are single-row, single-threaded CPU wall-clock time from `run_routellm.py`/`run_nvidia.py` on this machine; no batching, no GPU.
- 70/120 dataset rows have a ground-truth `task_type` this mapping can even reach (`debug`/`review`/`ops` rows are automatic misses). Restricted to those rows, NVIDIA's mapped task-type accuracy is 28.6%, vs. 16.7% over all 120.
