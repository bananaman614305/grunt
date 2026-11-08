/**
 * `milo replay`: run a capped sample of the routing eval set through a
 * running `milo serve` and report where the work landed. Loaded on demand
 * from `index.ts`, like `canary`, because it imports `@milo/evals`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatReplayReport, loadRoutingSet, runSubscriptionReplay } from "@milo/evals";
import type { CliDeps } from "../deps.js";

export const help = `Usage: milo replay --sample <n> [options]

Send a sample of Milo's labeled routing tasks through a running \`milo serve\`
with model "milo/auto", then report how many tasks each subscription served,
failures, failovers, latency, tokens, and how much of each plan the run used
(from /v1/usage before and after).

Every task spends real subscription quota, so --sample is required.

Options:
  --sample <n>      How many tasks to run (required; the set has 120)
  --url <base>      The running gateway (default http://127.0.0.1:8787)
  --seed <n>        Seed for the stratified sample (default 1)
  --set <path>      Eval set JSONL (default: the committed routing set)
  --out <path>      Also write the full JSON report here
  -h, --help        Show this help
`;

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        sample: { type: "string" },
        url: { type: "string" },
        seed: { type: "string" },
        set: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo replay: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }
  const sample = Number(parsed.values.sample);
  if (parsed.values.sample === undefined || !Number.isInteger(sample) || sample <= 0) {
    deps.stderr.write("milo replay: --sample <n> is required and must be a positive integer\n");
    return 1;
  }
  const seed = parsed.values.seed === undefined ? 1 : Number(parsed.values.seed);
  if (!Number.isInteger(seed)) {
    deps.stderr.write("milo replay: --seed must be an integer\n");
    return 1;
  }

  let examples;
  try {
    examples = loadRoutingSet(parsed.values.set);
  } catch (error) {
    deps.stderr.write(`milo replay: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const report = await runSubscriptionReplay({
    baseUrl: parsed.values.url ?? "http://127.0.0.1:8787",
    examples,
    sample,
    seed,
    fetch: (input, init) => deps.fetch(input, init),
    onTask: (task, index, total) => {
      const where = task.status === 200 ? (task.backend ?? "?") : `failed (${task.error ?? task.status})`;
      deps.stderr.write(`[${index + 1}/${total}] ${task.id} ${task.labelTaskType}: ${where}, ${Math.round(task.latencyMs / 100) / 10}s\n`);
    },
  });

  deps.stdout.write(formatReplayReport(report));
  if (parsed.values.out !== undefined) {
    const path = resolve(parsed.values.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    deps.stdout.write(`wrote ${path}\n`);
  }
  return report.failures === report.sampled ? 1 : 0;
}
