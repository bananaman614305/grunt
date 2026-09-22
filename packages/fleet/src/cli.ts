#!/usr/bin/env node
/**
 * A thin fleet runner (ADR-015): read a tasks JSON, fan out real workers, and
 * poll the supervisor until they settle. This is the live glue -- it spawns pi
 * and mutates git -- so it is deliberately NOT covered by `pnpm test`; the
 * fleet's logic is tested through injected fakes elsewhere. Not required to be
 * live-run for v0.
 *
 *   JEV_API_KEY=... milo-fleet --tasks tasks.json --base main --repo . \
 *     --root .fleet-worktrees --interval 5 --timeout 900
 *
 * tasks.json is `{ "tasks": [{ "id": "...", "prompt": "...", "title"?: "..." }] }`.
 * pi routes through Milo via the provider config in PI_CODING_AGENT_DIR, which
 * is inherited from the environment or set with --pi-agent-dir.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JevClient } from "@milo/core";
import { Fleet, runSupervisionLoop } from "./fleet.js";
import { nodeWorkerRuntime } from "./node-runtime.js";
import { JsonTaskRecordStore } from "./task-records.js";
import type { Task } from "./types.js";
import { startWorker } from "./worker.js";

type Args = {
  tasks: string;
  base: string;
  repo: string;
  root: string;
  interval: number;
  timeout: number;
  piAgentDir?: string;
  records: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const tasks = get("--tasks");
  if (tasks === undefined) throw new Error("--tasks <path> is required");
  const piAgentDir = get("--pi-agent-dir");
  return {
    tasks,
    base: get("--base", "main") as string,
    repo: get("--repo", ".") as string,
    root: get("--root", ".fleet-worktrees") as string,
    interval: Number(get("--interval", "5")) * 1000,
    timeout: Number(get("--timeout", "900")) * 1000,
    records: get("--records", ".milo/fleet-tasks") as string,
    ...(piAgentDir !== undefined ? { piAgentDir } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env["JEV_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new Error("JEV_API_KEY must be set");

  const raw = JSON.parse(await readFile(resolve(args.tasks), "utf8")) as { tasks: Task[] };
  const runtime = nodeWorkerRuntime(args.repo);
  const jev = new JevClient({ apiKey });

  const fleet = new Fleet({
    jev,
    records: new JsonTaskRecordStore(resolve(args.records)),
    spawn: (task) =>
      startWorker(task, runtime, {
        root: resolve(args.root),
        baseBranch: args.base,
        timeoutMs: args.timeout,
        ...(args.piAgentDir !== undefined ? { piAgentDir: resolve(args.piAgentDir) } : {}),
      }),
  });

  fleet.start(raw.tasks);
  console.log(`Spawned ${raw.tasks.length} worker(s) off ${args.base}`);

  await runSupervisionLoop(fleet, {
    intervalMs: args.interval,
    onPass: (f) => {
      for (const item of f.needsAttention()) {
        console.log(`[attention] ${item.id}: ${item.reason} -- ${item.detail}`);
      }
    },
  });

  for (const worker of fleet.results()) {
    const lines = worker.result?.diff ? worker.result.diff.split("\n").length : 0;
    console.log(`[${worker.id}] ${worker.lifecycle} (${lines} diff lines)`);
  }
  console.log(`Task records: ${resolve(args.records)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
