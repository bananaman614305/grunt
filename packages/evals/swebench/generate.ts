#!/usr/bin/env node
/**
 * SWE-bench generation phase: drive pi (DeepSeek via Milo) over the selected
 * instances and write `predictions.jsonl` (the official evaluator's input) plus
 * a `run.json` sidecar of pi/gateway efficiency metrics. Grading is a separate
 * phase run with the official `swebench` Python harness -- see docs/swebench.md.
 *
 *   pnpm --filter @milo/evals exec tsx swebench/generate.ts \
 *     --dataset ./SWE-bench_Verified.jsonl --instances all --limit 20 \
 *     --gateway http://127.0.0.1:8787/v1
 *
 * Per instance: clone the repo into a fresh temp workdir (from --repo-cache if a
 * pre-cloned bare mirror is present, otherwise from GitHub -- which needs
 * network at run time), `git checkout <base_commit>`, run `pi -p --mode json
 * <problem_statement>` there (pi's provider config, pointing provider "milo" at
 * the gateway with model milo/auto, comes from PI_CODING_AGENT_DIR, inherited or
 * set with --pi-agent-dir), parse the JSONL event stream for turns/tool
 * calls/usage with the agentic harness's parser, then capture the staged diff as
 * model_patch. Clone failure, pi timeout, and an empty diff are all handled
 * per-instance and never abort the whole run.
 *
 * This file spawns git and pi; its pure collaborators (options, instances,
 * gitdiff, predictions, run-report, evaluate) are unit-tested without either.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAttribution } from "../agentic/decisions.js";
import { PiEventParser } from "../agentic/pi-events.js";
import { captureModelPatch } from "./gitdiff.js";
import { loadInstances, selectInstances, type SwebenchInstance } from "./instances.js";
import { parseSwebenchArgs } from "./options.js";
import { formatPredictionsJsonl, toPrediction, type Prediction } from "./predictions.js";
import { buildRunReport, type InstanceRun, type InstanceStatus } from "./run-report.js";

const SWEBENCH_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(SWEBENCH_ROOT, "reports");
const CLONE_TIMEOUT_MS = 600_000;

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

/**
 * Resolve the clone source for an instance. A `--repo-cache <dir>` holding
 * pre-cloned bare mirrors at `<dir>/<owner>/<name>.git` lets a run work offline
 * (and skip re-downloading a repo per instance); otherwise we clone the public
 * GitHub URL, which needs network at run time.
 */
export function cloneSource(repo: string, repoCache: string | undefined): string {
  if (repoCache !== undefined) {
    const cached = join(repoCache, `${repo}.git`);
    if (existsSync(cached)) return cached;
  }
  return `https://github.com/${repo}.git`;
}

async function generateOne(
  instance: SwebenchInstance,
  opts: {
    gateway: string;
    timeoutMs: number;
    modelName: string;
    keep: boolean;
    repoCache?: string;
    piAgentDir?: string;
  },
): Promise<{ run: InstanceRun; prediction: Prediction }> {
  const id = instance.instance_id;
  const workdir = await mkdtemp(join(tmpdir(), `milo-swebench-${id.replace(/[^A-Za-z0-9_-]/g, "_")}-`));

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.piAgentDir !== undefined) env["PI_CODING_AGENT_DIR"] = resolve(opts.piAgentDir);

  const parser = new PiEventParser();
  let status: InstanceStatus = "generated";
  let note: string | undefined;
  let emptyPatch = true;
  let modelPatch = "";
  const startedAt = Date.now();

  // 1. Clone + checkout. A failure here ends this instance with an empty patch.
  const source = cloneSource(instance.repo, opts.repoCache);
  const clone = await runProcess("git", ["clone", "--quiet", source, workdir], {
    cwd: tmpdir(),
    env,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  let checkoutOk = false;
  if (clone.failure !== undefined || clone.timedOut || clone.exitCode !== 0) {
    status = "clone-failed";
    note = clone.failure ?? (clone.timedOut ? "git clone timed out" : `git clone exited ${clone.exitCode}`);
  } else {
    const checkout = await runProcess("git", ["-C", workdir, "checkout", "--quiet", instance.base_commit], {
      cwd: workdir,
      env,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (checkout.failure !== undefined || checkout.timedOut || checkout.exitCode !== 0) {
      status = "clone-failed";
      note = checkout.failure ?? `git checkout ${instance.base_commit} exited ${checkout.exitCode}`;
    } else {
      checkoutOk = true;
    }
  }

  // 2. Run pi, then capture whatever it changed (partial work on timeout counts).
  if (checkoutOk) {
    const pi = await runProcess("pi", ["-p", "--mode", "json", instance.problem_statement], {
      cwd: workdir,
      env,
      timeoutMs: opts.timeoutMs,
      onStdout: (chunk) => parser.feed(chunk),
    });
    parser.end();

    if (pi.failure !== undefined) {
      status = "error";
      note = `pi failed to start: ${pi.failure}`;
    } else if (pi.timedOut) {
      status = "timeout";
      note = `pi exceeded ${opts.timeoutMs / 1000}s`;
    }

    try {
      const captured = captureModelPatch(workdir);
      modelPatch = captured.patch;
      emptyPatch = captured.empty;
      if (status === "generated" && emptyPatch) {
        status = "empty-patch";
        note = "pi made no changes";
      }
    } catch (err) {
      status = "error";
      note = `diff capture failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const endedAt = Date.now();
  const gateway = await fetchAttribution(opts.gateway, process.env["OPENROUTER_API_KEY"], startedAt, endedAt);

  if (opts.keep) {
    console.log(`[${id}] workdir kept at ${workdir}`);
  } else {
    await rm(workdir, { recursive: true, force: true });
  }

  const run: InstanceRun = {
    instance_id: id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    status,
    emptyPatch,
    wallTimeMs: endedAt - startedAt,
    pi: parser.stats(),
    gateway,
    ...(opts.keep ? { workdir } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  return { run, prediction: toPrediction(id, modelPatch, opts.modelName) };
}

async function main(): Promise<void> {
  const options = parseSwebenchArgs(process.argv.slice(2), DEFAULT_OUT);
  const dataset = loadInstances(options.dataset);
  const selected = selectInstances(dataset, options.instances, options.limit);
  console.log(`Generating predictions for ${selected.length} instance(s) against ${options.gateway}`);

  const runs: InstanceRun[] = [];
  const predictions: Prediction[] = [];
  for (const instance of selected) {
    console.log(`[${instance.instance_id}] starting (${instance.repo})`);
    const { run, prediction } = await generateOne(instance, options);
    runs.push(run);
    predictions.push(prediction);
    console.log(`[${instance.instance_id}] ${run.status} in ${(run.wallTimeMs / 1000).toFixed(1)}s`);
  }

  const report = buildRunReport(runs, {
    gateway: options.gateway,
    dataset: options.dataset,
    modelName: options.modelName,
    timeoutMs: options.timeoutMs,
  });
  await mkdir(options.out, { recursive: true });
  const predictionsPath = join(options.out, "predictions.jsonl");
  const runPath = join(options.out, "run.json");
  await writeFile(predictionsPath, formatPredictionsJsonl(predictions));
  await writeFile(runPath, JSON.stringify(report, null, 2) + "\n");

  const s = report.summary;
  console.log(
    `Done: ${s.generated} generated, ${s.emptyPatches} empty, ${s.failures} failed of ${s.instances} instance(s).`,
  );
  console.log(`Predictions: ${predictionsPath}`);
  console.log(`Run sidecar: ${runPath}`);
  console.log("Next: grade with the official evaluator -- see swebench/run-evaluation.sh and docs/swebench.md.");
}

// Only run when invoked directly, so the module can be imported by tests
// without spawning anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
