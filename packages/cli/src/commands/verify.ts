/**
 * `milo verify install <claude-code|codex|goose>` (ADR-019): wire the
 * ground-truth Stop hook into a harness.
 *
 * It writes the self-contained hook script (`verify/hook-script.ts`) into the
 * harness config dir and merges a Stop-hook entry into the harness config
 * (`verify/config.ts` does the pure computation; this command is the fs glue,
 * like `serve` is for the server). The user then sets `MILO_ENDPOINT` and a
 * `MILO_KEY` -- a Milo key, since Milo holds the Jev key server-side and does
 * the auditing -- and turn-end checks begin. Warn-primary; `MILO_VERIFY_BLOCK`
 * opts into a block on a confident contradiction, at most twice per session.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { defaultRoot, HARNESSES, isHarness, planInstall } from "../verify/config.js";
import { hookScript } from "../verify/hook-script.js";
import type { CliDeps } from "../deps.js";

export const help = `Usage: milo verify install <harness> [options]

Wire Milo's ground-truth verification Stop hook into a coding harness. The hook
checks each turn's load-bearing claims ("tests pass", "implemented X") against
read-only git probes and receipts, via Milo's /v1/verify, and warns at the next
prompt. Push-not-pull and fail-open: a hiccup never blocks the agent.

Harnesses:
  ${HARNESSES.join(" | ")}

Options:
  --dir <path>   Config root to install into (default: the harness's own)
  -h, --help     Show this help

After install, set in the harness environment:
  MILO_ENDPOINT  your Milo base URL (e.g. https://milo-gateway.fly.dev)
  MILO_KEY       your Milo key (NOT a TypeSafe key -- Milo holds Jev server-side)
  MILO_VERIFY_BLOCK=1  optional: allow a block on a confident contradiction
`;

function parseFlags(args: string[]): { positionals: string[]; dir?: string; help: boolean } {
  const positionals: string[] = [];
  let dir: string | undefined;
  let wantsHelp = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") wantsHelp = true;
    else if (arg === "--dir") {
      dir = args[i + 1];
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  return { positionals, ...(dir !== undefined ? { dir } : {}), help: wantsHelp };
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, dir, help: wantsHelp } = parseFlags(args);

  if (wantsHelp || positionals.length === 0) {
    deps.stdout.write(help);
    return wantsHelp ? 0 : 1;
  }

  const [subcommand, harnessArg] = positionals;
  if (subcommand !== "install") {
    deps.stderr.write(`milo verify: unknown subcommand "${subcommand ?? ""}"\n\n`);
    deps.stderr.write(help);
    return 1;
  }
  if (harnessArg === undefined || !isHarness(harnessArg)) {
    deps.stderr.write(`milo verify install: pick a harness (${HARNESSES.join(" | ")})\n`);
    return 1;
  }

  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  if (dir === undefined && (home === undefined || home === "")) {
    deps.stderr.write("milo verify install: no HOME set; pass --dir <config root>\n");
    return 1;
  }
  const root = dir ?? defaultRoot(harnessArg, home as string);

  // Read the existing config (if any) so the merge preserves it.
  const { configPath } = planInstall(harnessArg, root, undefined);
  let existing: string | undefined;
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    existing = undefined;
  }

  const plan = planInstall(harnessArg, root, existing);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(plan.hookScriptPath, hookScript(), { mode: 0o755 });
    await writeFile(plan.configPath, plan.configText);
  } catch (err) {
    deps.stderr.write(`milo verify install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  deps.stdout.write(`Installed the Milo ground-truth Stop hook for ${harnessArg}.\n`);
  for (const note of plan.notes) deps.stdout.write(`  - ${note}\n`);
  return 0;
}
