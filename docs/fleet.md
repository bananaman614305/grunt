# The Milo worker fleet

The fleet is a tool your frontier agent **calls** to fan out cheap parallel
execution. It is not an orchestrator. See ADR-015 for the decision record;
this is the working guide.

## What it is

Your frontier agent — Claude Code or Codex, running on your own subscription —
stays the planner. It decides what to build, breaks the work into independent
tasks, reviews diffs, and merges. When it has a batch of tasks that can run in
parallel, it hands them to the fleet. The fleet runs each task as a **worker**:
a pi coding agent in its own isolated git **worktree**, with every model call
routed through Milo (DeepSeek mode) so the cheap tier does the execution.

The frontier agent is the expensive brain on top; the fleet is the cheap hands
underneath. Milo never plans — it executes and watches.

## Why route workers through Milo

Because Milo sits in the model path, it sees every worker's traffic. That is
the fleet's one advantage over a process-liveness supervisor (the thing
firstmate-style tools do badly): a supervisor that only checks whether the
child process is alive cannot tell a worker thinking hard from a worker looping
forever or waiting on nothing. Milo can, because it watches what the worker is
*doing* over time and asks Jev to judge it.

## Vocabulary

Used strictly, everywhere:

| term | meaning |
|---|---|
| **task** | one unit of work assigned to a worker |
| **worker** | a coding agent (pi) running a task in isolation |
| **worktree** | the isolated git checkout a worker owns (`fleet/<task-id>`) |
| **fleet** | the set of workers the frontier agent fanned out |
| **supervisor** | the Jev-backed classifier watching a worker's traffic |

## The worker lifecycle

1. A worktree is created off the fleet's base branch on a fresh branch.
2. The task prompt is written into the worktree.
3. `pi -p --mode json` runs there, with `PI_CODING_AGENT_DIR` passed through so
   pi routes its model calls at Milo.
4. pi's JSONL event stream is parsed for turns, tool calls, and usage (the
   reused `PiEventParser`) and into an ordered event window for the supervisor.
5. The worktree diff against the base branch is captured as the result.

A worker's process **lifecycle** is `pending → running → finished | failed`.
Its content **verdict** is separate, and comes from the supervisor.

## The Jev supervision gates

Every supervision pass reduces a worker's recent event window to a
**content-free summary** — how many turns and tool calls, a tool histogram, how
repetitive the tools are, how long since the last event, whether any edit has
landed. No message content ever goes into the call. Jev answers two questions
(`packages/fleet/src/questions.ts`):

- **`worker_state`** (choice): `progressing`, `idle`, `wedged`, or `done`, with
  a confidence.
  - **progressing** — varied work, edits landing, recent activity.
  - **idle** — quiet without finishing; a long gap, no diff.
  - **wedged** — active but stuck: the same tools cycle, a failing action
    repeats, no new ground. *This is the signal a process supervisor lacks.*
  - **done** — a diff has landed and activity has wound down.
- **`needs_human`** (noul): does a person need to step in now — a decision, a
  credential, an ambiguous requirement — rather than more time or a nudge.

The verdict is a pure mapping from Jev's answers; the fleet adds no heuristic
of its own.

## How a frontier agent uses it

Four tools (`packages/fleet/src/mcp.ts`) are the whole interface:

```
fleet_spawn(tasks[], baseBranch)   fan out; one worker per task
fleet_status()                     per-worker lifecycle + last verdict
fleet_results()                    diffs + usage of finished/failed workers
fleet_attention()                  supervise once, then the workers needing a look
```

A typical loop the planner runs:

1. Decompose the goal into independent tasks.
2. `fleet_spawn(tasks, baseBranch)`.
3. Poll `fleet_attention()` on an interval. An empty list means the fleet is
   healthy; entries name the **wedged**, **idle**, **needs-human**, or
   **failed** workers to look at.
4. When workers finish, `fleet_results()` returns their diffs to review, merge,
   or discard.

`fleet_attention()` is where the edge shows up: it runs a supervision pass and
returns only the workers a human (or the planner) should look at, so the
frontier agent is not polling raw process state.

## Running a fleet directly (optional)

`packages/fleet/src/cli.ts` (`milo-fleet`) runs a fleet from a tasks JSON:

```
JEV_API_KEY=... milo-fleet --tasks tasks.json --base main --repo . \
  --root .fleet-worktrees --interval 5 --timeout 900
```

`tasks.json` is `{ "tasks": [{ "id": "...", "prompt": "...", "title"?: "..." }] }`.
This is live glue — it spawns pi and mutates git — and is not covered by the
test suite.

## v0 limits and the cost note

This is a foundation. It builds and supervises workers; it does **not** yet act
on a verdict (no automatic nudging, re-spawning, or killing), merge worker
diffs, or cap spend, and the MCP server transport is a documented stub. Those
are on the post-launch horizon (ADR-015).

**Cost.** A fleet multiplies token spend by its size, and every supervision
pass is an extra Jev call per running worker per interval. It pays off only
when the tasks are genuinely parallel and cheap-tier workers beat doing the
work serially on the frontier plan. The fleet quiesces to zero Jev calls once
every worker has settled.
