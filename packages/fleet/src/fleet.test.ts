import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "@milo/core";
import type { WorkerEvent } from "./events.js";
import { Fleet } from "./fleet.js";
import type { WindowSummary } from "./supervisor.js";
import type { Task, WorkerLifecycle, WorkerResult } from "./types.js";
import type { WorkerHandle } from "./worker.js";

/** A hand-driven worker handle: push events, then finish or fail it. */
class FakeHandle implements WorkerHandle {
  private readonly _events: WorkerEvent[] = [];
  private _lifecycle: WorkerLifecycle = "running";
  private _result: WorkerResult | undefined;
  private resolveDone!: (r: WorkerResult) => void;
  readonly done: Promise<WorkerResult>;

  constructor(
    readonly id: string,
    readonly task: Task,
    readonly worktreePath: string,
    readonly branch: string,
  ) {
    this.done = new Promise((res) => (this.resolveDone = res));
  }

  push(...events: WorkerEvent[]): void {
    this._events.push(...events);
  }

  finish(result: WorkerResult): void {
    this._lifecycle = "finished";
    this._result = result;
    this.resolveDone(result);
  }

  fail(note: string): void {
    this._lifecycle = "failed";
    this._result = { exitCode: null, timedOut: false, diff: "", stats: emptyStats(), note };
    this.resolveDone(this._result);
  }

  lifecycle(): WorkerLifecycle {
    return this._lifecycle;
  }
  events(): readonly WorkerEvent[] {
    return this._events;
  }
  result(): WorkerResult | undefined {
    return this._result;
  }
}

function emptyStats() {
  return {
    turns: 0,
    toolCalls: {},
    toolCallTotal: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    malformedLines: 0,
  };
}

function doneResult(): WorkerResult {
  return { exitCode: 0, timedOut: false, diff: "diff --git a/x b/x", stats: emptyStats() };
}

/** A grading Jev with a call counter, so tests assert which workers it saw. */
function gradingJev(): JevClientLike & { count: number } {
  const jev = {
    count: 0,
    systemone(req: { state: unknown }) {
      jev.count += 1;
      const s = req.state as unknown as WindowSummary;
      if (s.eventCount === 0) return Promise.reject(new Error("empty window"));
      let choice: string;
      let needsHuman = 0.1;
      if (s.toolCalls >= 3 && s.topToolShare >= 0.8 && !s.editsLanded) {
        choice = "wedged";
        needsHuman = 0.85;
      } else if (s.editsLanded) {
        choice = "progressing";
      } else {
        choice = "idle";
      }
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          worker_state: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
          needs_human: { type: "noul", noul: needsHuman },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
        requestId: "req",
        latencyMs: 15,
      } satisfies SystemOneResult);
    },
  };
  return jev;
}

const LOOP: WorkerEvent[] = [
  { kind: "tool", at: 10, tool: "run_tests", edits: false },
  { kind: "tool", at: 20, tool: "run_tests", edits: false },
  { kind: "tool", at: 30, tool: "run_tests", edits: false },
];
const PROGRESS: WorkerEvent[] = [
  { kind: "tool", at: 10, tool: "edit", edits: true },
  { kind: "turn", at: 20, outputTokens: 200 },
];

/** Build a fleet whose spawn hands back pre-made fake handles by id. */
function fleetOf(handles: Record<string, FakeHandle>, jev: JevClientLike): Fleet {
  return new Fleet({
    jev,
    now: () => 1_000,
    spawn: (task) => {
      const h = handles[task.id];
      if (h === undefined) throw new Error(`no fake handle for ${task.id}`);
      return h;
    },
  });
}

describe("Fleet", () => {
  it("spawns one worker per task and reports their branches", () => {
    const handles = {
      a: new FakeHandle("a", { id: "a", prompt: "p" }, "/wt/a", "fleet/a"),
      b: new FakeHandle("b", { id: "b", prompt: "p" }, "/wt/b", "fleet/b"),
    };
    const fleet = fleetOf(handles, gradingJev());
    fleet.start([
      { id: "a", prompt: "p" },
      { id: "b", prompt: "p" },
    ]);
    expect(fleet.ids()).toEqual(["a", "b"]);
    expect(fleet.status().map((s) => s.branch)).toEqual(["fleet/a", "fleet/b"]);
    expect(fleet.status().every((s) => s.lifecycle === "running")).toBe(true);
  });

  it("classifies running workers and surfaces the wedged one for attention", async () => {
    const wedged = new FakeHandle("w", { id: "w", prompt: "p" }, "/wt/w", "fleet/w");
    const healthy = new FakeHandle("h", { id: "h", prompt: "p" }, "/wt/h", "fleet/h");
    wedged.push(...LOOP);
    healthy.push(...PROGRESS);

    const fleet = fleetOf({ w: wedged, h: healthy }, gradingJev());
    fleet.start([
      { id: "w", prompt: "p" },
      { id: "h", prompt: "p" },
    ]);
    await fleet.superviseOnce();

    expect(fleet.worker("w")?.classification?.verdict).toBe("wedged");
    expect(fleet.worker("h")?.classification?.verdict).toBe("progressing");

    const attention = fleet.needsAttention();
    expect(attention.map((a) => a.id)).toEqual(["w"]);
    expect(attention[0]?.reason).toBe("needs_human"); // the gate fires before the verdict reason
    expect(attention[0]?.confidence).toBe(0.9);
  });

  it("does not supervise finished workers and returns them as results", async () => {
    const done = new FakeHandle("d", { id: "d", prompt: "p" }, "/wt/d", "fleet/d");
    const jev = gradingJev();
    const fleet = fleetOf({ d: done }, jev);
    fleet.start([{ id: "d", prompt: "p" }]);
    done.finish(doneResult());

    await fleet.superviseOnce();
    expect(jev.count).toBe(0); // settled workers cost no Jev calls
    expect(fleet.allSettled()).toBe(true);
    expect(fleet.results().map((r) => r.id)).toEqual(["d"]);
    expect(fleet.results()[0]?.result?.diff).toBe("diff --git a/x b/x");
    expect(fleet.needsAttention()).toEqual([]);
  });

  it("lists a failed worker for attention", async () => {
    const bad = new FakeHandle("x", { id: "x", prompt: "p" }, "/wt/x", "fleet/x");
    const fleet = fleetOf({ x: bad }, gradingJev());
    fleet.start([{ id: "x", prompt: "p" }]);
    bad.fail("pi exceeded its timeout");
    await fleet.superviseOnce();
    const attention = fleet.needsAttention();
    expect(attention[0]).toMatchObject({ id: "x", reason: "failed", detail: "pi exceeded its timeout" });
  });

  it("records a supervision error without blinding the rest of the fleet", async () => {
    const quiet = new FakeHandle("q", { id: "q", prompt: "p" }, "/wt/q", "fleet/q"); // no events -> jev throws
    const busy = new FakeHandle("z", { id: "z", prompt: "p" }, "/wt/z", "fleet/z");
    busy.push(...PROGRESS);
    const fleet = fleetOf({ q: quiet, z: busy }, gradingJev());
    fleet.start([
      { id: "q", prompt: "p" },
      { id: "z", prompt: "p" },
    ]);

    await expect(fleet.superviseOnce()).resolves.toBeUndefined();
    expect(fleet.worker("q")?.classification).toBeUndefined(); // its call failed
    expect(fleet.worker("z")?.classification?.verdict).toBe("progressing"); // the other still classified
  });

  it("drains to completed results", async () => {
    const a = new FakeHandle("a", { id: "a", prompt: "p" }, "/wt/a", "fleet/a");
    const fleet = fleetOf({ a }, gradingJev());
    fleet.start([{ id: "a", prompt: "p" }]);
    a.finish(doneResult());
    const results = await fleet.drain();
    expect(results.map((r) => r.id)).toEqual(["a"]);
  });
});
