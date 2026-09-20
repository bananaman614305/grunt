# ADR-015: The Milo worker fleet

Status: accepted (v0 foundation), 2026-09-18. Builds on ADR-012 (DeepSeek
compute controller) and ADR-013 (agentic gates, the pi benchmark). New
package `packages/fleet`; no change to `packages/core/src/types.ts`.

## Context

Milo routes single requests well. The next expensive thing above one request
is a *fleet of agents*: a planner decomposes work into many independent
tasks and runs coding agents in parallel, each in its own git worktree. Tools
like firstmate already spawn parallel agents, but they supervise by process
liveness — is the child still running — which cannot tell a worker thinking
hard from a worker looping forever or waiting on nothing. Both are "alive".

Milo has a structural advantage no external supervisor has: every worker's
model traffic already flows through the gateway (workers route through Milo in
DeepSeek mode, ADR-012). So Milo can watch what a worker is *doing* — its
turns and tool calls over time — and ask Jev, in content terms, whether it is
progressing, idle, wedged, or done. That is the signal a process supervisor
lacks, and it is cheap because the classifier is the same Jev we already hold
a key for.

## Decision

Build the fleet as a **tool the frontier agent calls**, not as an
orchestrator.

The contrast is the whole design. The user's frontier agent (Claude Code,
Codex) stays the planner: it decides what to build, decomposes the work, reads
diffs, and merges. Milo does **not** plan or decide — it is emphatically not
"Milo-as-orchestrator". The fleet is fanned-out cheap execution plus one
thing the planner cannot see from outside: per-worker content supervision. The
frontier agent runs on the user's own subscription; the workers run on the
cheap half of the pair, exactly as the roster note frames Milo's job.

### Vocabulary (binding)

Strict terms, everywhere — code, comments, docs, identifiers:

- **task** — one unit of work assigned to a worker
- **worker** — a coding agent (pi) running a task in isolation
- **worktree** — the isolated git checkout a worker owns
- **fleet** — the set of workers the frontier agent fanned out
- **supervisor** — the Jev-backed classifier watching a worker's traffic

No metaphor or borrowed vernacular from the source project appears anywhere in
this package. The concept was adapted from a different project; its vocabulary
is not carried over.

### Worker lifecycle

1. Create a git worktree off the fleet's base branch on a fresh branch
   (`fleet/<task-id>`).
2. Write the task prompt into the worktree.
3. Run `pi -p --mode json` with cwd = the worktree and `PI_CODING_AGENT_DIR`
   passed through, so pi's provider config points model calls at Milo.
4. Stream pi's JSONL events into the reused `PiEventParser` (turns / tool
   calls / usage, ADR-013 phase B) and an ordered `WorkerEventLog` — the
   window the supervisor reads.
5. Capture the worktree diff against the base branch.

Process lifecycle (`pending` / `running` / `finished` / `failed`) is kept
separate from the supervisor's content verdict, because they answer different
questions.

### Jev supervision gates

Over a worker's recent event window the supervisor sends Jev a **content-free
summary** — counts, a tool histogram, a repetition share, an idle gap, whether
an edit landed; never message content — and asks two questions
(`packages/fleet/src/questions.ts`, in the router's `questions.ts` style):

- `worker_state` (**choice**) → `progressing | idle | wedged | done`, with a
  confidence and a probability over the four. **wedged** is the firstmate gap:
  active but repeating, same tools cycling, no new ground. **idle** is quiet
  without finishing. **done** is a landed diff winding down. **progressing** is
  varied forward motion.
- `needs_human` (**noul**) → whether a person must intervene now (a decision,
  a credential, a failing action that will not self-clear) rather than more
  time or an automatic nudge.

The mapping from Jev's answers to a verdict is pure: the supervisor adds no
heuristic of its own. That keeps the classifier honest and unit-testable —
a fake Jev that grades the summary makes fixture event streams (looping →
wedged, finished-diff → done, quiet → idle) flow end-to-end.

### Surface

Four MCP tools (`packages/fleet/src/mcp.ts`) are the frontier agent's whole
interface: `fleet_spawn(tasks[], baseBranch)`, `fleet_status()`,
`fleet_results()`, `fleet_attention()`. The handlers wrap the controller; the
MCP server *transport* is a documented stub in v0 (bring your own JSON-RPC
transport, forward each call to the matching handler).

## Scope and honesty

This is a **v0 foundation**. What is real and unit-tested with fakes: the
worker runtime (injectable spawn + git), the supervisor and its questions, the
fleet controller and its attention list, and the MCP handlers. What is *not*
exercised by `pnpm test`, by design: spawning real pi, real git worktrees, and
a live gateway — the node runtime (`node-runtime.ts`) and the CLI
(`cli.ts`) are the live glue and are kept out of the test path.

`PiEventParser` is vendored (copied) from `packages/evals/agentic/` rather
than imported: it is standalone by design, and `@milo/evals` is a dev/eval
package the fleet should not depend on. If a third consumer appears, promote
it into `@milo/core`.

**Cost is the honest caveat.** A fleet multiplies token spend by its size,
and every supervision pass is an extra Jev call per running worker per
interval. The economics only make sense when the tasks are genuinely parallel
and each worker's cheap-tier execution beats doing the work serially on the
frontier plan. The fleet quiesces to zero Jev calls once every worker settles.

## Post-launch horizon

Not in v0: acting on a verdict automatically (nudging a wedged worker,
re-spawning an idle one, killing a runaway); merging or conflict-resolving
worker diffs; a spend cap that pauses the fleet; a live MCP transport; and
folding the parser into core. These wait until the foundation has run against
real workers.
