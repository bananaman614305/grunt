import { describe, expect, it } from "vitest";
import type { Task } from "./types.js";
import {
  buildWorkerEnv,
  spawnWorker,
  startWorker,
  workerBranch,
  type RunPiInput,
  type SpawnOutcome,
  type WorkerRuntime,
} from "./worker.js";

const TASK: Task = { id: "t-42", prompt: "Add a health check endpoint.", title: "healthz" };

const TURN = JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { output_tokens: 90 } } });
const READ = JSON.stringify({ type: "tool_execution_start", toolName: "read_file" });
const EDIT = JSON.stringify({ type: "tool_execution_start", toolName: "edit" });

type Calls = {
  createWorktree: Array<{ worktreePath: string; baseBranch: string; branch: string }>;
  writePrompt: Array<{ worktreePath: string; prompt: string }>;
  runPi: RunPiInput[];
  captureDiff: Array<{ worktreePath: string; baseBranch: string }>;
};

function fakeRuntime(opts: { lines: string[]; outcome?: SpawnOutcome; diff?: string; throwOnWorktree?: boolean }) {
  const calls: Calls = { createWorktree: [], writePrompt: [], runPi: [], captureDiff: [] };
  const runtime: WorkerRuntime = {
    createWorktree(input) {
      calls.createWorktree.push(input);
      if (opts.throwOnWorktree) return Promise.reject(new Error("worktree add failed"));
      return Promise.resolve();
    },
    writePrompt(input) {
      calls.writePrompt.push(input);
      return Promise.resolve(`${input.worktreePath}/TASK.md`);
    },
    runPi(input) {
      calls.runPi.push(input);
      for (const line of opts.lines) input.onChunk(`${line}\n`);
      return Promise.resolve(opts.outcome ?? { exitCode: 0, timedOut: false });
    },
    captureDiff(input) {
      calls.captureDiff.push(input);
      return Promise.resolve(opts.diff ?? "diff --git a/x b/x");
    },
  };
  return { runtime, calls };
}

const baseOpts = {
  root: "/tmp/fleet",
  baseBranch: "main",
  timeoutMs: 60_000,
  join: (root: string, id: string) => `${root}/${id}`,
};

describe("workerBranch / buildWorkerEnv", () => {
  it("namespaces a worker's branch by task id", () => {
    expect(workerBranch("t-42")).toBe("fleet/t-42");
  });

  it("passes PI_CODING_AGENT_DIR through only when given", () => {
    expect(buildWorkerEnv({ A: "1" }, "/agent").PI_CODING_AGENT_DIR).toBe("/agent");
    expect(buildWorkerEnv({ A: "1" }).PI_CODING_AGENT_DIR).toBeUndefined();
  });
});

describe("spawnWorker", () => {
  it("creates the worktree off base, writes the prompt, and captures the diff", async () => {
    let tick = 0;
    const { runtime, calls } = fakeRuntime({ lines: [READ, TURN, EDIT] });
    const run = await spawnWorker(TASK, runtime, {
      ...baseOpts,
      piAgentDir: "/agent",
      baseEnv: {},
      clock: () => ++tick,
    });

    expect(calls.createWorktree[0]).toEqual({
      worktreePath: "/tmp/fleet/t-42",
      baseBranch: "main",
      branch: "fleet/t-42",
    });
    expect(calls.writePrompt[0]?.prompt).toBe(TASK.prompt);
    expect(calls.runPi[0]?.env.PI_CODING_AGENT_DIR).toBe("/agent");
    expect(calls.runPi[0]?.worktreePath).toBe("/tmp/fleet/t-42");

    expect(run.lifecycle).toBe("finished");
    expect(run.result.diff).toBe("diff --git a/x b/x");
    expect(run.result.stats.turns).toBe(1);
    expect(run.result.stats.toolCallTotal).toBe(2);

    // The ordered window the supervisor reads is populated in stream order.
    expect(run.events.map((e) => e.kind)).toEqual(["tool", "turn", "tool"]);
  });

  it("marks a timed-out run as failed with a note", async () => {
    const { runtime } = fakeRuntime({ lines: [TURN], outcome: { exitCode: null, timedOut: true } });
    const run = await spawnWorker(TASK, runtime, baseOpts);
    expect(run.lifecycle).toBe("failed");
    expect(run.result.note).toMatch(/timeout/);
  });

  it("marks an unstartable pi as failed", async () => {
    const { runtime } = fakeRuntime({ lines: [], outcome: { exitCode: null, timedOut: false, failure: "ENOENT" } });
    const run = await spawnWorker(TASK, runtime, baseOpts);
    expect(run.lifecycle).toBe("failed");
    expect(run.result.note).toMatch(/ENOENT/);
  });
});

describe("startWorker", () => {
  it("returns a live handle that fills and settles", async () => {
    const { runtime } = fakeRuntime({ lines: [READ, TURN] });
    const handle = startWorker(TASK, runtime, baseOpts);

    expect(handle.id).toBe("t-42");
    expect(handle.branch).toBe("fleet/t-42");
    expect(handle.result()).toBeUndefined();

    const result = await handle.done;
    expect(handle.lifecycle()).toBe("finished");
    expect(result.stats.turns).toBe(1);
    expect(handle.events()).toHaveLength(2);
  });

  it("settles a handle to failed when the worktree cannot be created", async () => {
    const { runtime } = fakeRuntime({ lines: [], throwOnWorktree: true });
    const handle = startWorker(TASK, runtime, baseOpts);
    await handle.done;
    expect(handle.lifecycle()).toBe("failed");
    expect(handle.result()?.note).toMatch(/worktree add failed/);
  });
});
