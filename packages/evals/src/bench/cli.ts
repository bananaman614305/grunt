#!/usr/bin/env node
/**
 * `pnpm bench` entry point. Sends the labeled routing set through Milo and
 * through one fixed model per tier, grades every answer, and writes a
 * markdown report (and optionally the full JSON) under `reports/`.
 *
 * Needs `OPENROUTER_API_KEY` in the environment: it is sent as the bearer to
 * the gateway and to OpenRouter (or the proxy given by `--openrouter`) and
 * nowhere else. The gateway needs its own Jev key; this command never sees it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CostPosture } from "@milo/core";
import { COST_POSTURES, DEFAULT_ROSTER, JevClient } from "@milo/core";
import { loadRoutingSet } from "../schema.js";
import { DEFAULT_GRADERS_PATH, loadGraders } from "./graders.js";
import { BASELINE_FALLBACK_PRICE, BASELINE_MODEL_ID, fetchPrices } from "./prices.js";
import { formatBenchMarkdown } from "./report.js";
import { fixedModelsFromRoster, runBench } from "./run.js";
import { DEFAULT_PROVIDER_PINS } from "./providers.js";
import type { ProviderPins } from "./providers.js";
import type { ArmName, FixedArm } from "./types.js";
import { ARM_NAMES, FIXED_ARMS } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");

export const DEFAULT_GATEWAY = "http://127.0.0.1:8787/v1";
export const DEFAULT_OPENROUTER = "https://openrouter.ai/api/v1";
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-5";
export const DEFAULT_SAMPLE_TIMEOUT_MS = 90_000;

export type BenchCliOptions = {
  gateway: string;
  openrouter: string;
  posture: CostPosture;
  arms: ArmName[];
  judge: boolean;
  judgeModel: string;
  limit: number | undefined;
  ids: string[] | undefined;
  concurrency: number;
  timeoutMs: number;
  salt: string | undefined;
  pins: ProviderPins;
  sampleTimeoutMs: number;
  samples: number;
  sampleTier: FixedArm;
  vary: boolean;
  graders: string;
  out: string;
  json: string | undefined;
};

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function parseArgs(argv: string[]): BenchCliOptions {
  const options: BenchCliOptions = {
    gateway: DEFAULT_GATEWAY,
    openrouter: DEFAULT_OPENROUTER,
    posture: "balanced",
    arms: [...ARM_NAMES],
    judge: true,
    judgeModel: DEFAULT_JUDGE_MODEL,
    limit: undefined,
    ids: undefined,
    concurrency: 3,
    timeoutMs: 180_000,
    salt: undefined,
    pins: DEFAULT_PROVIDER_PINS,
    sampleTimeoutMs: DEFAULT_SAMPLE_TIMEOUT_MS,
    samples: 1,
    sampleTier: "fast",
    vary: false,
    graders: DEFAULT_GRADERS_PATH,
    out: resolve(PACKAGE_ROOT, "reports/bench-latest.md"),
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
    const positiveInt = (value: string, flag: string): number => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${value}"`);
      return n;
    };

    switch (arg) {
      case "--gateway":
        options.gateway = next().replace(/\/+$/, "");
        break;
      case "--openrouter":
        options.openrouter = next().replace(/\/+$/, "");
        break;
      case "--posture": {
        const value = next();
        if (!isOneOf(COST_POSTURES, value)) throw new Error(`--posture must be one of ${COST_POSTURES.join("|")}, got "${value}"`);
        options.posture = value;
        break;
      }
      case "--arms": {
        const arms = next().split(",").map((a) => a.trim()).filter((a) => a !== "");
        for (const arm of arms) {
          if (!isOneOf(ARM_NAMES, arm)) throw new Error(`--arms must be a comma list of ${ARM_NAMES.join("|")}, got "${arm}"`);
        }
        options.arms = arms as ArmName[];
        break;
      }
      case "--no-judge":
        options.judge = false;
        break;
      case "--judge-model":
        options.judgeModel = next();
        break;
      case "--limit":
        options.limit = positiveInt(next(), "--limit");
        break;
      case "--ids":
        options.ids = next().split(",").map((s) => s.trim()).filter((s) => s !== "");
        break;
      case "--concurrency":
        options.concurrency = positiveInt(next(), "--concurrency");
        break;
      case "--timeout":
        options.timeoutMs = positiveInt(next(), "--timeout");
        break;
      case "--salt":
        options.salt = next();
        break;
      case "--no-pins":
        options.pins = {};
        break;
      case "--sample-timeout":
        options.sampleTimeoutMs = positiveInt(next(), "--sample-timeout");
        break;
      case "--samples":
        options.samples = positiveInt(next(), "--samples");
        break;
      case "--sample-tier": {
        const value = next();
        if (!isOneOf(FIXED_ARMS, value)) throw new Error(`--sample-tier must be one of ${FIXED_ARMS.join("|")}, got "${value}"`);
        options.sampleTier = value;
        break;
      }
      case "--vary":
        options.vary = true;
        break;
      case "--graders":
        options.graders = resolve(process.cwd(), next());
        break;
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

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const options = parseArgs(argv);
  const apiKey = env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENROUTER_API_KEY is not set; the benchmark sends it as the bearer to the gateway and to OpenRouter");
  }

  let jev: JevClient | undefined;
  if (options.samples > 1) {
    const jevKey = env["JEV_API_KEY"];
    if (jevKey === undefined || jevKey === "") {
      throw new Error("--samples needs JEV_API_KEY (and JEV_BASE_URL for a key-injecting proxy) so Jev can rank the samples");
    }
    const jevBase = env["JEV_BASE_URL"];
    jev = new JevClient({ apiKey: jevKey, ...(jevBase !== undefined && jevBase !== "" ? { baseUrl: jevBase } : {}) });
  }

  let examples = loadRoutingSet();
  if (options.ids !== undefined) {
    const wanted = new Set(options.ids);
    examples = examples.filter((e) => wanted.has(e.id));
  }
  if (options.limit !== undefined) examples = examples.slice(0, options.limit);
  const graders = loadGraders(options.graders);

  const fixedModels = fixedModelsFromRoster(DEFAULT_ROSTER);
  const priceIds = [BASELINE_MODEL_ID, options.judgeModel, ...Object.values(fixedModels)];
  let prices;
  try {
    prices = await fetchPrices(priceIds);
  } catch (error) {
    process.stderr.write(`could not read OpenRouter's catalogue (${error instanceof Error ? error.message : String(error)}); using the committed baseline price\n`);
    prices = new Map();
  }
  const baseline = prices.get(BASELINE_MODEL_ID) ?? BASELINE_FALLBACK_PRICE;

  const report = await runBench({
    examples,
    graders,
    gatewayBaseUrl: options.gateway,
    openRouterBaseUrl: options.openrouter,
    apiKey,
    posture: options.posture,
    arms: options.arms,
    fixedModels,
    judgeModel: options.judgeModel,
    judge: options.judge,
    prices,
    baseline,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    ...(options.salt !== undefined ? { salt: options.salt } : {}),
    providerPins: options.pins,
    sampleTimeoutMs: options.sampleTimeoutMs,
    ...(options.samples > 1 && jev !== undefined ? { samples: options.samples, sampleTier: options.sampleTier, vary: options.vary, jev } : {}),
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });

  const markdown = formatBenchMarkdown(report);
  process.stdout.write(`${markdown}\n`);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${markdown}\n`, "utf8");
  if (options.json !== undefined) {
    await mkdir(dirname(options.json), { recursive: true });
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main(process.argv.slice(2).filter((a) => a !== "--"))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
