#!/usr/bin/env bash
#
# Grade Milo's SWE-bench predictions with the OFFICIAL swebench Python harness.
# This script does not reimplement grading -- it checks prerequisites, then
# prints (and, with --exec, runs) the canonical run_evaluation command. Grading
# runs each instance's tests in Docker, so Docker and the `swebench` package
# must be installed. See docs/swebench.md for the full runbook.
#
# Usage:
#   swebench/run-evaluation.sh <predictions.jsonl> <run_id> [max_workers] [--exec]
#
#   <predictions.jsonl>  output of swebench/generate.ts
#   <run_id>             a label for this evaluation run (e.g. milo-pilot-01)
#   [max_workers]        parallel Docker workers (default 8)
#   --exec               actually run the command (default: print it only)
#
set -euo pipefail

PREDICTIONS="${1:-}"
RUN_ID="${2:-}"
MAX_WORKERS="8"
EXEC="no"
for arg in "${@:3}"; do
  case "$arg" in
    --exec) EXEC="yes" ;;
    *[0-9]) MAX_WORKERS="$arg" ;;
  esac
done

DATASET_NAME="princeton-nlp/SWE-bench_Verified"

if [[ -z "$PREDICTIONS" || -z "$RUN_ID" ]]; then
  echo "usage: $0 <predictions.jsonl> <run_id> [max_workers] [--exec]" >&2
  exit 2
fi

missing=0
if ! command -v docker >/dev/null 2>&1; then
  echo "MISSING: docker is not on PATH." >&2
  echo "  Install Docker Engine/Desktop and ensure the daemon is running:" >&2
  echo "  https://docs.docker.com/engine/install/" >&2
  missing=1
elif ! docker info >/dev/null 2>&1; then
  echo "MISSING: docker is installed but the daemon is not reachable (is it running?)." >&2
  missing=1
fi

if ! python -c "import swebench" >/dev/null 2>&1; then
  echo "MISSING: the 'swebench' Python package is not importable." >&2
  echo "  Install it into your active environment:" >&2
  echo "    python -m pip install swebench" >&2
  echo "  (Python 3.10+; see https://github.com/princeton-nlp/SWE-bench )" >&2
  missing=1
fi

if [[ ! -f "$PREDICTIONS" ]]; then
  echo "MISSING: predictions file not found: $PREDICTIONS" >&2
  missing=1
fi

CMD=(python -m swebench.harness.run_evaluation
  --predictions_path "$PREDICTIONS"
  --dataset_name "$DATASET_NAME"
  --run_id "$RUN_ID"
  --max_workers "$MAX_WORKERS")

echo "# Canonical evaluation command:"
printf '%q ' "${CMD[@]}"; echo

if [[ "$missing" -ne 0 ]]; then
  echo >&2
  echo "Prerequisites missing (see above); not running. Fix them, then re-run with --exec." >&2
  exit 1
fi

if [[ "$EXEC" == "yes" ]]; then
  echo "# Running..."
  exec "${CMD[@]}"
else
  echo "# Dry run (prerequisites OK). Re-run with --exec to grade, or copy the command above."
  echo "# After grading, join efficiency metrics with:"
  echo "#   tsx swebench/summarize.ts --report <results.json> --run <run.json> --run-id $RUN_ID"
fi
