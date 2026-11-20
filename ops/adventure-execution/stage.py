#!/usr/bin/env python3
"""Prepare owner-runner changes for review; never activate them or run game code."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import stat


FILES = ("supervisor.py", "free-pool.mjs", "worker-brief.md")
WORKERS = """For independent tasks, use `grunt_spawn` to start up to two free Grunt tool-using subworkers with separate `ownedPaths` and enough scoped context to do useful work. Keep working on independent files while they run. Workers edit private snapshots and cannot write the main checkout; they have no account credentials or network access in their command sandbox. Assign nonoverlapping ownership, account for your own current edits, and collect each result with `grunt_worker_result`. Results summarize changes without full file contents. Inspect actual changes with `usegrunt workers artifact JOB_ID --project "$PWD" --port 8793`, redirecting large output to a private temporary file and reading focused excerpts. Review the findings and changes yourself. After successful integration and your own verification, explicitly release retained ownership with `usegrunt workers discard JOB_ID --project "$PWD" --port 8793`. Recover unfinished work with `usegrunt workers retained --project "$PWD" --port 8793` instead of recreating it. To integrate an accepted artifact, use `usegrunt workers apply JOB_ID --project \"$PWD\" --port 8793`; resolve any reported conflict yourself rather than overwriting concurrent work. You own all game implementation, tests and reviews. The older `grunt_delegate` tool remains available for proposals that need no filesystem tools. Do not use the old plain `grunt-worker` helper. Keep at most two subworkers total running. Record the free-source evidence for your work honestly.

For independent checks or other long commands, use `grunt_job_start` instead of a blocking shell sleep or wait. Continue useful independent work, then collect output with `grunt_job_result`; status and cancellation tools are also available. If all useful work is genuinely blocked, `grunt_job_wait` provides a bounded, event-driven wait. These jobs belong to this Pi process: collect or cancel all jobs and subworkers before ending a checkpoint or requesting publication. Do not assume jobs continue after the printed turn exits. Preserve partial worker artifacts when a source is exhausted and inspect retained work before recreating a task."""

WRAPPER = """#!/bin/sh
set -eu
if [ "$#" -lt 2 ] || [ "$1" != workers ]; then
  echo 'This sandbox wrapper only exposes Grunt worker artifact commands.' >&2
  exit 64
fi
case "$2" in
  apply|status|retained|artifact|discard) ;;
  *) echo 'Unsupported sandbox worker command.' >&2; exit 64 ;;
esac
exec /opt/adventure/bin/node /opt/adventure/grunt/dist/local/main.js "$@"
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("Reviewed infrastructure anchor changed; review the new baseline")
    return text.replace(before, after, 1)


def transform(files, runtime_directory):
    supervisor = files["supervisor.py"].decode("utf-8")
    supervisor = replace_once(supervisor,
        "'--ro-bind',str(ROOT/'grunt-worker'),'/opt/adventure/bin/grunt-worker','--clearenv'",
        "'--ro-bind',str(ROOT/'usegrunt'),'/opt/adventure/bin/usegrunt','--clearenv'")
    supervisor = replace_once(supervisor,
        "'PI_CODING_AGENT_DIR':'/worker/state/pi','PI_OFFLINE':'1'",
        "'PI_CODING_AGENT_DIR':'/worker/state/pi','GRUNT_JOBS_STATE_DIR':'/worker/state/jobs','PI_OFFLINE':'1'")
    supervisor = replace_once(supervisor,
        "'--extension',WORKER_EXTENSION,'--grunt-worker-port','8793',",
        "'--extension',WORKER_EXTENSION,'--grunt-worker-port','8793','--grunt-agent-workers','--grunt-background-jobs',")
    supervisor = replace_once(supervisor,
        "failures=0\n            while not STOP:",
        "failures=0\n"
        "            while not STOP and (STATE/'execution-upgrade-hold').exists():\n"
        "                if backend.poll() is not None:raise RuntimeError('Free pool stopped during activation hold')\n"
        "                status.update(phase='paused',workerPid=None)\n"
        "                save(STATE/'status.json',status)\n"
        "                time.sleep(.25)\n"
        "            while not STOP:")
    ast.parse(supervisor)
    pool = files["free-pool.mjs"].decode("utf-8")
    pool = replace_once(pool,
        "import { WorkerPool } from './runtime/dist/local/worker-pool.js';",
        "import { createWorkerRuntime } from './runtime/dist/local/worker-runtime.js';")
    pool = replace_once(pool, "const workers=new WorkerPool(sources);",
        "const workerRuntime=createWorkerRuntime(sources,{directory:" + json.dumps(str(runtime_directory)) + "});\nawait workerRuntime.ready;\nconst {workers,scopes}=workerRuntime;")
    pool = replace_once(pool, "createLocalApp(sources,{port,workers})", "createLocalApp(sources,{port,workers,workerScopes:scopes})")
    pool = replace_once(pool, "sync.close(),workers.close()", "sync.close(),workerRuntime.close()")
    brief = files["worker-brief.md"].decode("utf-8")
    paragraphs = brief.split("\n\n")
    matching = [index for index, text in enumerate(paragraphs) if text.startswith("For independent tasks, use `grunt_delegate`")]
    if len(matching) != 1:
        raise ValueError("Reviewed worker instructions changed; review the new baseline")
    paragraphs[matching[0]] = WORKERS
    return {"supervisor.py": supervisor.encode(), "free-pool.mjs": pool.encode(),
            "worker-brief.md": "\n\n".join(paragraphs).encode(), "usegrunt": WRAPPER.encode()}


def private_write(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def stage(owner_root, destination, runtime_directory, baseline):
    owner_root = Path(owner_root)
    destination = Path(destination)
    runtime_directory = Path(runtime_directory)
    if not all(path.is_absolute() for path in (owner_root, destination, runtime_directory)):
        raise ValueError("Owner, staging and worker-state paths must be absolute")
    if owner_root.is_symlink() or owner_root.resolve() != owner_root:
        raise ValueError("Use a real owner infrastructure directory")
    canonical_destination = destination.resolve(strict=False)
    if canonical_destination == owner_root or owner_root in canonical_destination.parents:
        raise ValueError("Stage outside the active infrastructure directory")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Staging destination must be new; nothing was overwritten")
    files = {}
    for name in FILES:
        fd = os.open(owner_root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 512 * 1024:
                raise ValueError("Unexpected owner infrastructure file")
            data = stream.read(512 * 1024 + 1)
        if digest(data) != baseline.get(name):
            raise ValueError(f"Reviewed baseline mismatch: {name}; no changes staged")
        files[name] = data
    outputs = transform(files, runtime_directory)
    destination.mkdir(mode=0o700, parents=False)
    (destination / "original").mkdir(mode=0o700)
    (destination / "next").mkdir(mode=0o700)
    for name, data in files.items():
        private_write(destination / "original" / name, data)
    for name, data in outputs.items():
        private_write(destination / "next" / name, data, 0o700 if name == "usegrunt" else 0o600)
    receipt = {"schema": "grunt-owner-execution-stage/v1", "activated": False,
               "ownerRoot": str(owner_root), "workerStateDirectory": str(runtime_directory),
               "originalSha256": {name: digest(data) for name, data in files.items()},
               "nextSha256": {name: digest(data) for name, data in outputs.items()}}
    private_write(destination / "receipt.json", (json.dumps(receipt, indent=2) + "\n").encode())
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-root", type=Path, required=True)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--worker-state", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, default=Path(__file__).with_name("baseline.json"))
    args = parser.parse_args()
    receipt = stage(args.owner_root, args.stage, args.worker_state, json.loads(args.baseline.read_text()))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
