# SWE-bench (Verified) harness

Infrastructure to run **SWE-bench Verified** with **pi driving DeepSeek through
Milo** as the coding agent. It lives in `packages/evals/swebench/` and is built
as two clean, independent halves:

1. **Generation (ours).** For each instance, clone the repo at its base commit,
   run pi over the problem statement through the Milo gateway, and capture the
   resulting diff as `model_patch`. Output: `predictions.jsonl` (the evaluator's
   input) plus a `run.json` sidecar of pi/gateway efficiency metrics.
2. **Grading (theirs).** The official [`swebench`](https://github.com/princeton-nlp/SWE-bench)
   Python harness applies each patch in a Docker container and runs the
   instance's `FAIL_TO_PASS` / `PASS_TO_PASS` tests. We do **not** reimplement
   this; we hand it our `predictions.jsonl` and read its report back.

Keeping the halves apart means our generator is pure TypeScript with no Docker
or dataset dependency, and grading uses the canonical, trusted evaluator so the
number is comparable to published results.

## What this score means (read this first)

This measures an **agent scaffold + model**, not a raw model. The agent is pi;
the model is whatever DeepSeek tier Milo routes each call to. A resolved
instance means *pi, orchestrated over many tool-calling turns, produced a patch
that passes the tests* — comparable to other agent submissions on the
SWE-bench leaderboard (DeepSWE, SWE-agent, etc.), **not** to a single-shot
"model X scores Y%" number. Report it as "pi + DeepSeek via Milo", with the pi
turn/tool-call counts from `run.json` alongside, so the scaffolding cost is
visible.

## Prerequisites

- **Generation:** Node 22, pnpm, `git`, and network access at run time to clone
  repos (or a pre-warmed `--repo-cache`). A running Milo gateway pointed at
  DeepSeek, and pi configured to route through it (provider `milo`, model
  `milo/auto`) via `PI_CODING_AGENT_DIR`.
- **Grading:** Docker (daemon running) and the `swebench` Python package
  (`python -m pip install swebench`, Python 3.10+). Grading pulls/builds one
  Docker image per repo and needs substantial disk — budget **tens of GB** for
  a full Verified run; a 20-instance pilot is much smaller but still image-heavy.

## Operator runbook

### 1. Get the dataset (once)

The harness never downloads the dataset. Export SWE-bench Verified to a local
JSONL — for example with the `datasets` library — where each line has at least
`instance_id`, `repo`, `base_commit`, `problem_statement`, `FAIL_TO_PASS`,
`PASS_TO_PASS`, `test_patch`, `patch`:

```python
from datasets import load_dataset
ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
ds.to_json("SWE-bench_Verified.jsonl", lines=True)
```

`FAIL_TO_PASS` / `PASS_TO_PASS` may be JSON-encoded strings or arrays; the
loader accepts both.

### 2. (Optional) Warm a repo cache

Cloning at run time needs network. To run the generator offline and avoid
re-downloading a repo per instance, pre-clone bare mirrors under a cache dir at
`<cache>/<owner>/<name>.git`:

```
git clone --bare https://github.com/astropy/astropy.git \
  repo-cache/astropy/astropy.git
```

Pass `--repo-cache repo-cache`; the generator clones from the local mirror when
one exists and falls back to GitHub otherwise.

### 3. Generate predictions (this repo)

The two commands for a **20-instance pilot**:

```
# (1) GENERATE — pi drives DeepSeek via Milo, writes predictions.jsonl + run.json
pnpm --filter @milo/evals exec tsx swebench/generate.ts \
  --dataset ./SWE-bench_Verified.jsonl --instances all --limit 20 \
  --gateway http://127.0.0.1:8787/v1 --out ./swebench-pilot

# (2) GRADE — official evaluator (checks Docker + swebench, prints/execs the command)
packages/evals/swebench/run-evaluation.sh \
  ./swebench-pilot/predictions.jsonl milo-pilot-01 8 --exec
```

Generation flags: `--dataset <path>` (required), `--instances <ids|all>`,
`--limit <n>`, `--repo-cache <dir>`, `--gateway <url>`, `--out <dir>`,
`--timeout <seconds>` (default 1800 per instance), `--pi-agent-dir <dir>`
(sets `PI_CODING_AGENT_DIR`), `--keep` (retain workdirs).

Per-instance failures never abort the run: a clone failure, a pi timeout, or an
empty diff each produce a (possibly empty, always marked) prediction line and a
status in `run.json` (`generated` | `empty-patch` | `clone-failed` | `timeout`
| `error`).

### 4. Grade with the official evaluator (not this repo)

`run-evaluation.sh` verifies Docker and the `swebench` package are present
(printing install guidance if not), then prints — or with `--exec` runs — the
canonical command:

```
python -m swebench.harness.run_evaluation \
  --predictions_path predictions.jsonl \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --run_id milo-pilot-01 --max_workers 8
```

### 5. Read the result with efficiency joined

The evaluator writes a report JSON (a `results`/`<run_id>` file listing
`resolved_ids`, `unresolved_ids`, and counts). Join it with our `run.json` to
print solve rate next to pi turns, tool calls, and gateway cost per instance:

```
pnpm --filter @milo/evals exec tsx swebench/summarize.ts \
  --report <evaluator-report.json> --run ./swebench-pilot/run.json \
  --run-id milo-pilot-01
```

## Module map

| File | Role |
|---|---|
| `instances.ts` | Zod instance schema, JSONL loader, `--instances`/`--limit` subset selection. |
| `options.ts` | Generator flag parsing. |
| `generate.ts` | Per-instance clone → checkout → pi → capture; writes `predictions.jsonl` + `run.json`. Reuses the agentic harness's pi-event parser and decision attribution. |
| `gitdiff.ts` | `git add -A` + `git diff --cached` capture, normalized to a `model_patch`. |
| `predictions.ts` | `predictions.jsonl` shaping (the evaluator's exact contract). |
| `run-report.ts` | `run.json` sidecar types + summary. |
| `evaluate.ts` | Canonical evaluator command, official-report parser, efficiency join. |
| `summarize.ts` | CLI: join evaluator report + `run.json`, print markdown. |
| `run-evaluation.sh` | Prerequisite checks + canonical grading command (dry-run by default). |
| `fixtures/` | Committed mock instances and a sample evaluator report, for tests only. |

Grading is delegated on purpose: the only contract we own is the shape of
`predictions.jsonl`.
