#!/usr/bin/env node
/**
 * `pnpm eval` entry point. Runs the routing eval set through the router,
 * prints the markdown report to stdout, and writes it (and optionally a JSON
 * dump) to disk. Exits 0 even when every example is unscored -- that is a
 * legitimate outcome when no Jev fixtures are recorded yet -- but exits 2
 * when at least one example was scored and tier agreement falls below 0.85,
 * so CI can gate on it once real fixtures exist (ADR-002).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CostPosture } from "@milo/core";
import { COST_POSTURES } from "@milo/core";
import { JEV_SOURCE_MODES, makeJevClient } from "./jev-source.js";
import type { JevSourceMode } from "./jev-source.js";
import { formatMarkdown, tierAgreementRate } from "./report.js";
import { runRoutingEval } from "./run.js";
import { loadRoutingSet } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");

/** Tier agreement below this, with at least one scored example, fails the eval (ADR-002). */
export const MIN_TIER_AGREEMENT = 0.85;

export type CliOptions = {
  mode: JevSourceMode;
  posture: CostPosture;
  limit: number | undefined;
  out: string;
  json: string | undefined;
};

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "fixtures",
    posture: "balanced",
    limit: undefined,
    out: resolve(PACKAGE_ROOT, "reports/latest.md"),
    json: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "--mode": {
        const value = next();
        if (!isOneOf(JEV_SOURCE_MODES, value)) {
          throw new Error(`--mode must be one of ${JEV_SOURCE_MODES.join("|")}, got "${value}"`);
        }
        options.mode = value;
        break;
      }
      case "--posture": {
        const value = next();
        if (!isOneOf(COST_POSTURES, value)) {
          throw new Error(`--posture must be one of ${COST_POSTURES.join("|")}, got "${value}"`);
        }
        options.posture = value;
        break;
      }
      case "--limit": {
        const value = next();
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--limit must be a positive integer, got "${value}"`);
        }
        options.limit = n;
        break;
      }
      case "--out":
        options.out = resolve(process.cwd(), next());
        break;
      case "--json":
        options.json = resolve(process.cwd(), next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/** Runs the eval end to end and returns the process exit code. Never throws for a routing failure. */
export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  const allExamples = loadRoutingSet();
  const examples = options.limit !== undefined ? allExamples.slice(0, options.limit) : allExamples;

  const jev = makeJevClient(options.mode);
  const report = await runRoutingEval({ examples, jev, posture: options.posture });

  const markdown = formatMarkdown(report);
  process.stdout.write(`${markdown}\n`);

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${markdown}\n`, "utf8");

  if (options.json !== undefined) {
    await mkdir(dirname(options.json), { recursive: true });
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const agreement = tierAgreementRate(report);
  if (report.scored.length > 0 && agreement < MIN_TIER_AGREEMENT) {
    return 2;
  }
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
