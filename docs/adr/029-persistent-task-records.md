# ADR-029: Persistent fleet task records and Jev dossiers

Status: accepted, 2026-09-22. Builds on ADR-015 (worker fleet) and ADR-019
(ground-truth verification).

## Context

The fleet previously held task intent, supervision verdicts, and done-gate
evidence only in memory. A process restart discarded that audit trail, and the
done-gate reduced every task to one generic completion claim. The planner could
state exact acceptance criteria, but they were not carried into verification.

Adding another agent turn or test command would be the wrong remedy. The fleet
is an execution tool, not an orchestrator, and the harness receipts and git diff
already contain the available ground truth.

## Decision

Each task gets a versioned record containing its input, compiled rubric,
lifecycle, latest supervision classification, and compact Jev dossier. The CLI
persists one atomically replaced JSON file per task under
`.milo/fleet-tasks` by default; task ids are hashed for safe filenames.

Rubric compilation is mechanical and bounded. Explicit `acceptanceCriteria`
come first, followed by checklist items in the prompt, deduplicated and capped
at eight criteria. A task without either gets one completion criterion from its
first prompt line. Compilation makes no model call.

The dossier contains the task goal, rubric, and summarized evidence: exit
state, diff counts and paths, normalized receipts, and the done-gate verdict.
It deliberately omits the raw diff from persistence. The done-gate turns all
rubric criteria into separate questions carried by its existing single Jev
call. Routine supervision receives the goal and rubric beside its existing
content-free activity summary; this changes the state, not the call count.

No fleet MCP tool is added. `fleet_spawn`, `fleet_status`, `fleet_results`, and
`fleet_attention` remain the complete agent-facing surface, so task records do
not expand agent tool execution.

## Consequences

Task intent and verification evidence survive CLI restarts and can be reviewed
without replaying a worker. Verification becomes task-specific while retaining
one Jev call per finish. Persistence is host-side bookkeeping; workers receive
the same prompt and run no additional tools.
