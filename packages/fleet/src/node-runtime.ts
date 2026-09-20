/**
 * The real `WorkerRuntime` (ADR-015): git worktrees and a spawned pi, wired
 * for the CLI. Nothing here is exercised by `pnpm test` -- the fleet's unit
 * tests inject a fake runtime -- because it spawns processes and mutates a git
 * repository. It mirrors the process handling in
 * `packages/evals/agentic/run.ts`: SIGKILL on timeout, stderr drained, stdout
 * streamed to the caller.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunPiInput, SpawnOutcome, WorkerRuntime } from "./worker.js";

type ProcOpts = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
};

function runProcess(command: string, args: string[], opts: ProcOpts): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => opts.onStdout?.(chunk));
    child.stderr.resume(); // drain; agent stderr is chatter, not data

    child.once("error", (err) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ exitCode: null, timedOut: false, failure: err.message });
    });
    child.once("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut });
    });
  });
}

/** Collect a command's stdout into a string (used for `git diff`). */
function captureStdout(command: string, args: string[], cwd: string): Promise<string> {
  let out = "";
  return runProcess(command, args, { cwd, onStdout: (chunk) => (out += chunk) }).then(() => out);
}

/**
 * The production runtime. `repoDir` is the repository the worktrees branch off.
 */
export function nodeWorkerRuntime(repoDir: string): WorkerRuntime {
  const repo = resolve(repoDir);
  return {
    async createWorktree({ worktreePath, baseBranch, branch }) {
      await mkdir(worktreePath, { recursive: true });
      const outcome = await runProcess(
        "git",
        ["-C", repo, "worktree", "add", "-B", branch, worktreePath, baseBranch],
        { cwd: repo },
      );
      if (outcome.exitCode !== 0) {
        throw new Error(`git worktree add failed for ${branch} (exit ${String(outcome.exitCode)})`);
      }
    },

    async writePrompt({ worktreePath, prompt }) {
      const path = resolve(worktreePath, "TASK.md");
      await writeFile(path, prompt, "utf8");
      return path;
    },

    runPi(input: RunPiInput): Promise<SpawnOutcome> {
      return runProcess("pi", ["-p", "--mode", "json", input.prompt], {
        cwd: input.worktreePath,
        env: input.env,
        timeoutMs: input.timeoutMs,
        onStdout: input.onChunk,
      });
    },

    async captureDiff({ worktreePath, baseBranch }) {
      // Stage intents so new files show in the diff, then diff against base.
      await runProcess("git", ["-C", worktreePath, "add", "-A", "-N"], { cwd: worktreePath });
      return captureStdout("git", ["-C", worktreePath, "diff", baseBranch], worktreePath);
    },

    async removeWorktree({ worktreePath }) {
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktreePath], { cwd: repo });
    },
  };
}
