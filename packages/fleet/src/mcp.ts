/**
 * The MCP tool surface (ADR-015): the four tools the frontier agent calls to
 * drive a fleet. This is the whole "fleet as a tool" contract -- the frontier
 * agent stays the orchestrator and reaches for these the way it reaches for a
 * shell:
 *
 *   fleet_spawn(tasks, baseBranch)  fan out; one worker per task
 *   fleet_status()                  per-worker lifecycle + last supervisor verdict
 *   fleet_results()                 diffs + usage of finished/failed workers
 *   fleet_attention()               supervise once, then the wedged/idle/needs-human list
 *
 * The handlers are wired to a `FleetLike` (the concrete `Fleet` satisfies it),
 * so they unit-test against a fake with no pi, git, or gateway. The MCP server
 * TRANSPORT (stdio JSON-RPC) is a documented STUB: `describeMcpServer` states
 * exactly how a host would register these, but wiring a live @modelcontextprotocol
 * server is out of v0 scope. Bring your own transport and forward each call to
 * the matching handler.
 */

import type { AttentionItem, Task, WorkerState } from "./types.js";

/** The subset of the fleet the tools drive. `Fleet` implements it. */
export interface FleetLike {
  start(tasks: Task[]): void;
  status(): WorkerState[];
  results(): WorkerState[];
  needsAttention(): AttentionItem[];
  superviseOnce(): Promise<void>;
}

/** A minimal JSON-Schema tool descriptor, MCP `tools/list` shape. */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

/** The tool descriptors a host advertises for the fleet. */
export const FLEET_TOOLS: ToolSchema[] = [
  {
    name: "fleet_spawn",
    description:
      "Fan out a set of ready tasks to cheap parallel workers, one git worktree each, all routed through Milo. Call this after you (the planner) have decomposed the work into independent tasks. Returns the spawned workers' ids and branches.",
    inputSchema: {
      type: "object",
      properties: {
        baseBranch: { type: "string", description: "The branch every worktree is based on." },
        tasks: {
          type: "array",
          description: "The tasks to run in parallel; each becomes one worker.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique task id; names the worker's branch." },
              prompt: { type: "string", description: "The full instruction handed to the worker." },
              title: { type: "string", description: "Optional short label." },
            },
            required: ["id", "prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["baseBranch", "tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_status",
    description:
      "Report every worker's process lifecycle and the supervisor's most recent content verdict (progressing / idle / wedged / done) with its confidence.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fleet_results",
    description:
      "Return the diff and token usage of every worker that has finished or failed, for you to review, merge, or discard.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fleet_attention",
    description:
      "Run one supervision pass, then return only the workers that need a look: wedged, idle, flagged for a human decision, or failed. Empty means the fleet is healthy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type SpawnArgs = { baseBranch: string; tasks: Task[] };

export type SpawnToolResult = {
  baseBranch: string;
  workers: Array<{ id: string; branch: string; worktreePath: string; lifecycle: string }>;
};
export type StatusToolResult = { workers: WorkerState[] };
export type ResultsToolResult = { workers: WorkerState[] };
export type AttentionToolResult = { attention: AttentionItem[] };

export type FleetToolHandlers = {
  fleet_spawn: (args: SpawnArgs) => Promise<SpawnToolResult>;
  fleet_status: () => Promise<StatusToolResult>;
  fleet_results: () => Promise<ResultsToolResult>;
  fleet_attention: () => Promise<AttentionToolResult>;
};

/** How the tools get a fleet: a factory keyed on the base branch. */
export type FleetToolDeps = {
  createFleet: (baseBranch: string) => FleetLike;
};

function validateSpawn(args: SpawnArgs): void {
  if (typeof args.baseBranch !== "string" || args.baseBranch === "") {
    throw new Error("fleet_spawn requires a non-empty baseBranch");
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    throw new Error("fleet_spawn requires at least one task");
  }
  const seen = new Set<string>();
  for (const task of args.tasks) {
    if (typeof task.id !== "string" || task.id === "") throw new Error("each task needs an id");
    if (typeof task.prompt !== "string" || task.prompt === "") {
      throw new Error(`task ${task.id} needs a prompt`);
    }
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
}

/**
 * Build the four tool handlers over a fleet factory. One fleet is active at a
 * time; `fleet_spawn` starts a fresh one, and the read tools error until it
 * exists. Wire these into whatever MCP transport the host provides.
 */
export function createFleetToolHandlers(deps: FleetToolDeps): FleetToolHandlers {
  let active: FleetLike | undefined;

  const requireFleet = (): FleetLike => {
    if (active === undefined) throw new Error("no fleet is running; call fleet_spawn first");
    return active;
  };

  return {
    async fleet_spawn(args) {
      validateSpawn(args);
      const fleet = deps.createFleet(args.baseBranch);
      fleet.start(args.tasks);
      active = fleet;
      return {
        baseBranch: args.baseBranch,
        workers: fleet.status().map((s) => ({
          id: s.id,
          branch: s.branch,
          worktreePath: s.worktreePath,
          lifecycle: s.lifecycle,
        })),
      };
    },

    async fleet_status() {
      return { workers: requireFleet().status() };
    },

    async fleet_results() {
      return { workers: requireFleet().results() };
    },

    async fleet_attention() {
      const fleet = requireFleet();
      await fleet.superviseOnce();
      return { attention: fleet.needsAttention() };
    },
  };
}

/**
 * A documented description of how a host wires the stub transport. Returned as
 * data so a CLI can print it; there is no live server in v0.
 */
export function describeMcpServer(): { name: string; version: string; tools: ToolSchema[]; transport: string } {
  return {
    name: "milo-fleet",
    version: "0.0.1",
    tools: FLEET_TOOLS,
    transport:
      "STUB: no live server in v0. Register FLEET_TOOLS in your MCP host's tools/list and route each tools/call to the matching handler from createFleetToolHandlers(). A stdio JSON-RPC server is the intended v1 transport.",
  };
}
