#!/usr/bin/env node
/**
 * Agentic benchmark runner (ADR-013 Phase B): drives the pi coding agent
 * through Milo over the small repository tasks in `tasks/` and scores each
 * run with the task's own `test.js`.
 *
 *   pnpm --filter @milo/evals exec tsx agentic/run.ts \
 *     --tasks all --gateway http://127.0.0.1:8787/v1
 *
 * Per task: the task dir is copied to a fresh temp workdir, `pi -p --mode
 * json "<task.md>"` runs there (pi's provider config -- pointing provider
 * "milo" at the gateway with model `milo/auto` -- comes from
 * PI_CODING_AGENT_DIR, either inherited or set with --pi-agent-dir), the
 * JSONL event stream is parsed for turns / tool calls / usage, and the
 * verdict is `node test.js` exiting 0. Afterwards the gateway's recent
 * decisions are fetched (bearer: OPENROUTER_API_KEY, sent to the gateway
 * only) and the ones in the task's time window are attributed to it --
 * approximately, as the report says on every row.
 *
 * Flags: --tasks <ids|all>  --gateway <url>  --out <dir>  --json <path>
 *        --timeout <seconds>  --keep  --pi-agent-dir <dir>
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAttribution } from "./decisions.js";
import { parseAgenticArgs, selectTasks } from "./options.js";
import { PiEventParser } from "./pi-events.js";
import type { TaskResult, Verdict } from "./report.js";
import { buildReport, formatAgenticMarkdown } from "./report.js";

const AGENTIC_ROOT = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(AGENTIC_ROOT, "tasks");
const DEFAULT_OUT = join(AGENTIC_ROOT, "reports");
const TEST_TIMEOUT_MS = 60_000;

type SpawnOutcome = { exitCode: number | null; timedOut: boolean; failure?: string };

function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onStdout?: (chunk: string) => void },
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => opts.onStdout?.(chunk));
    child.stderr.resume(); // drain; agent stderr is chatter, not data

    child.once("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, timedOut: false, failure: err.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut });
    });
  });
}

async function runTask(
  id: string,
  opts: { gateway: string; timeoutMs: number; keep: boolean; piAgentDir?: string },
): Promise<TaskResult> {
  const workdir = await mkdtemp(join(tmpdir(), `milo-agentic-${id}-`));
  await cp(join(TASKS_DIR, id), workdir, { recursive: true });
  const prompt = await readFile(join(workdir, "task.md"), "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.piAgentDir !== undefined) env["PI_CODING_AGENT_DIR"] = resolve(opts.piAgentDir);

  const parser = new PiEventParser();
  const startedAt = Date.now();
  const pi = await runProcess("pi", ["-p", "--mode", "json", prompt], {
    cwd: workdir,
    env,
    timeoutMs: opts.timeoutMs,
    onStdout: (chunk) => parser.feed(chunk),
  });
  const endedAt = Date.now();
  parser.end();

  let verdict: Verdict;
  let testExitCode: number | null = null;
  let note: string | undefined;
  if (pi.failure !== undefined) {
    verdict = "error";
    note = `pi failed to start: ${pi.failure}`;
  } else if (pi.timedOut) {
    verdict = "timeout";
    note = `pi exceeded ${opts.timeoutMs / 1000}s`;
  } else {
    const test = await runProcess("node", ["test.js"], { cwd: workdir, env, timeoutMs: TEST_TIMEOUT_MS });
    testExitCode = test.exitCode;
    if (test.failure !== undefined || test.timedOut) {
      verdict = "error";
      note = test.failure ?? "test.js timed out";
    } else {
      verdict = test.exitCode === 0 ? "pass" : "fail";
    }
  }

  const gateway = await fetchAttribution(opts.gateway, process.env["OPENROUTER_API_KEY"], startedAt, endedAt);

  if (opts.keep) {
    console.log(`[${id}] workdir kept at ${workdir}`);
  } else {
    await rm(workdir, { recursive: true, force: true });
  }

  return {
    id,
    verdict,
    testExitCode,
    wallTimeMs: endedAt - startedAt,
    pi: parser.stats(),
    gateway,
    ...(opts.keep ? { workdir } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseAgenticArgs(process.argv.slice(2), DEFAULT_OUT);
  const ids = selectTasks(TASKS_DIR, options.tasks);
  console.log(`Running ${ids.length} task(s) against ${options.gateway}`);

  const results: TaskResult[] = [];
  for (const id of ids) {
    console.log(`[${id}] starting`);
    const result = await runTask(id, options);
    results.push(result);
    console.log(`[${id}] ${result.verdict} in ${(result.wallTimeMs / 1000).toFixed(1)}s`);
  }

  const report = buildReport(results, { gateway: options.gateway, timeoutMs: options.timeoutMs });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(options.out, { recursive: true });
  const mdPath = join(options.out, `agentic-${stamp}.md`);
  const jsonPath = options.json ?? join(options.out, `agentic-${stamp}.json`);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(mdPath, formatAgenticMarkdown(report));
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");

  console.log(formatAgenticMarkdown(report));
  console.log(`Report: ${mdPath}`);
  console.log(`JSON:   ${jsonPath}`);
  // No solve-rate gate yet: ADR-013 baselines the current gateway first, and
  // each phase-C gate lands against that number.
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
