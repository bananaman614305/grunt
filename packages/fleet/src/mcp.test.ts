import { describe, expect, it } from "vitest";
import { createFleetToolHandlers, describeMcpServer, FLEET_TOOLS, type FleetLike } from "./mcp.js";
import type { AttentionItem, Task, WorkerState } from "./types.js";

/** A fake fleet recording what the handlers do to it. */
class FakeFleet implements FleetLike {
  started: Task[] = [];
  superviseCount = 0;
  private readonly states: WorkerState[];
  private readonly attention: AttentionItem[];

  constructor(states: WorkerState[] = [], attention: AttentionItem[] = []) {
    this.states = states;
    this.attention = attention;
  }

  start(tasks: Task[]): void {
    this.started.push(...tasks);
  }
  status(): WorkerState[] {
    return this.states;
  }
  results(): WorkerState[] {
    return this.states.filter((s) => s.result !== undefined);
  }
  needsAttention(): AttentionItem[] {
    return this.attention;
  }
  superviseOnce(): Promise<void> {
    this.superviseCount += 1;
    return Promise.resolve();
  }
}

function stateFor(id: string, withResult = false): WorkerState {
  return {
    id,
    task: { id, prompt: "p" },
    lifecycle: withResult ? "finished" : "running",
    worktreePath: `/wt/${id}`,
    branch: `fleet/${id}`,
    ...(withResult
      ? {
          result: {
            exitCode: 0,
            timedOut: false,
            diff: "diff",
            stats: { turns: 1, toolCalls: {}, toolCallTotal: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, malformedLines: 0 },
          },
        }
      : {}),
  };
}

describe("FLEET_TOOLS schema", () => {
  it("advertises exactly the four fleet tools", () => {
    expect(FLEET_TOOLS.map((t) => t.name)).toEqual(["fleet_spawn", "fleet_status", "fleet_results", "fleet_attention"]);
  });

  it("documents the stubbed transport", () => {
    const desc = describeMcpServer();
    expect(desc.transport).toMatch(/STUB/);
    expect(desc.tools).toBe(FLEET_TOOLS);
  });
});

describe("fleet tool handlers", () => {
  function harness() {
    const built: FakeFleet[] = [];
    const handlers = createFleetToolHandlers({
      createFleet: () => {
        const f = new FakeFleet([stateFor("a"), stateFor("b", true)], [
          { id: "a", task: { id: "a", prompt: "p" }, reason: "wedged", detail: "stuck", confidence: 0.8 },
        ]);
        built.push(f);
        return f;
      },
    });
    return { handlers, built };
  }

  it("fleet_spawn builds a fleet, starts the tasks, and returns branches", async () => {
    const { handlers, built } = harness();
    const out = await handlers.fleet_spawn({
      baseBranch: "main",
      tasks: [
        { id: "a", prompt: "do a" },
        { id: "b", prompt: "do b" },
      ],
    });
    expect(built[0]?.started.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out.baseBranch).toBe("main");
    expect(out.workers.map((w) => w.branch)).toEqual(["fleet/a", "fleet/b"]);
  });

  it("read tools error until a fleet is spawned", async () => {
    const { handlers } = harness();
    await expect(handlers.fleet_status()).rejects.toThrow(/no fleet is running/);
    await expect(handlers.fleet_results()).rejects.toThrow(/no fleet is running/);
    await expect(handlers.fleet_attention()).rejects.toThrow(/no fleet is running/);
  });

  it("fleet_status and fleet_results read the active fleet", async () => {
    const { handlers } = harness();
    await handlers.fleet_spawn({ baseBranch: "main", tasks: [{ id: "a", prompt: "p" }] });
    expect((await handlers.fleet_status()).workers.map((w) => w.id)).toEqual(["a", "b"]);
    expect((await handlers.fleet_results()).workers.map((w) => w.id)).toEqual(["b"]);
  });

  it("fleet_attention supervises once, then returns the attention list", async () => {
    const { handlers, built } = harness();
    await handlers.fleet_spawn({ baseBranch: "main", tasks: [{ id: "a", prompt: "p" }] });
    const out = await handlers.fleet_attention();
    expect(built[0]?.superviseCount).toBe(1);
    expect(out.attention.map((a) => a.id)).toEqual(["a"]);
  });

  it("rejects invalid spawn arguments", async () => {
    const { handlers } = harness();
    await expect(handlers.fleet_spawn({ baseBranch: "", tasks: [{ id: "a", prompt: "p" }] })).rejects.toThrow(/baseBranch/);
    await expect(handlers.fleet_spawn({ baseBranch: "main", tasks: [] })).rejects.toThrow(/at least one task/);
    await expect(
      handlers.fleet_spawn({ baseBranch: "main", tasks: [{ id: "a", prompt: "p" }, { id: "a", prompt: "q" }] }),
    ).rejects.toThrow(/duplicate/);
  });
});
