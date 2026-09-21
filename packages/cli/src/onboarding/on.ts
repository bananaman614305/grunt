/**
 * `milo on <harness>` for the pi coding agent -- the onboarding surface the
 * published `usemilo` package bundles.
 *
 * pi has no project-local config (it reads `~/.pi/agent/models.json`
 * globally), so plain `milo on pi` IS the machine-wide switch: it registers
 * the `milo` provider at the host level (one command, no flags), and says so
 * explicitly. `--dir` overrides the config root for a throwaway session.
 * The switch MERGES a `milo` provider into models.json additively: every
 * provider the user already has and their chosen `default` model are left
 * untouched, only the `milo` provider is added or updated, and the pre-merge
 * file is backed up to a sibling `models.json.milo-backup` first (never
 * stacked by repeated runs). After the write, one `milo/auto` request is
 * routed through the gateway and the `x-milo-model` header is printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PI_PROVIDER_ID } from "@milo/core";
import type { CliDeps } from "../deps.js";
import { backupPathFor, makeBackup } from "./backup.js";
import { resolveKey } from "./key.js";
import { PI_CONFIG_REL, PI_KEY_STORE_REL, enablePi, nextSteps, renderAuth, statusPi } from "./pi.js";
import { normalizeGatewayRoot } from "./paths.js";
import { smokeVerify } from "./smoke.js";

export const help = `Usage: milo on <harness> [options]

Point the pi coding agent at the Milo gateway: it will see model "milo/auto",
which Milo routes through Jev and on to OpenRouter with your key.

pi has no project-local config (it reads ~/.pi/agent/models.json globally), so
plain "milo on pi" registers the provider at the HOST level -- machine-wide
for the pi agent -- in one command, and says so. The switch MERGES a "milo"
provider into models.json additively: every provider you already have and
your chosen default model are left untouched, only the "milo" provider is
added or updated. The pre-merge file is backed up to a sibling
models.json.milo-backup first, so it can always be restored. Pass --dir to
write into a throwaway config root instead (no host-level change).

After writing, milo routes one "milo/auto" request through the gateway and
prints the x-milo-model header -- proof that Jev classified, policy chose, and
OpenRouter answered. Use --no-verify to skip that step.

Harnesses:
  pi

Options:
  --global           Explicit form of the default: host-level (~/.pi/agent/models.json)
  --local            Point at a local "milo serve" (http://127.0.0.1:8787)
  --gateway <url>    Point at this gateway (default: https://milo-gateway.fly.dev)
  --dir <path>       Explicit pi config root to write into (scope-neutral)
  --no-verify        Write the provider only; skip the smoke request
  -h, --help         Show this help

The OpenRouter key: if OPENROUTER_API_KEY is set it is used and never written
to any config. Otherwise, in an interactive terminal you are prompted for it
(masked) and it is stored in pi's own credential store (~/.pi/agent/auth.json).
In a non-interactive run (CI/script) with no key set, it prints the export
instruction and exits non-zero rather than blocking on a prompt:
  export OPENROUTER_API_KEY=sk-or-...
`;

export const statusHelp = `Usage: milo status pi

Report whether pi is routed through Milo: whether ~/.pi/agent/models.json has
a "milo" provider and where it points.

Options:
  --dir <path>  Check this pi config root instead of ~/.pi
  -h, --help    Show this help
`;

const DEFAULT_GATEWAY = "https://milo-gateway.fly.dev";
const LOCAL_GATEWAY = "http://127.0.0.1:8787";

type OnFlags = {
  positionals: string[];
  global: boolean;
  local: boolean;
  gateway?: string;
  dir?: string;
  noVerify: boolean;
  help: boolean;
};

function parseFlags(args: string[]): OnFlags {
  const positionals: string[] = [];
  let global = false;
  let local = false;
  let gateway: string | undefined;
  let dir: string | undefined;
  let noVerify = false;
  let wantsHelp = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      wantsHelp = true;
    } else if (arg === "--global") {
      global = true;
    } else if (arg === "--local") {
      local = true;
    } else if (arg === "--no-verify") {
      noVerify = true;
    } else if (arg === "--gateway") {
      gateway = args[i + 1];
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--gateway=")) {
      gateway = arg.slice("--gateway=".length);
    } else if (arg === "--dir") {
      dir = args[i + 1];
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return {
    positionals,
    global,
    local,
    ...(gateway !== undefined ? { gateway } : {}),
    ...(dir !== undefined ? { dir } : {}),
    noVerify,
    help: wantsHelp,
  };
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function runOn(args: string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help || flags.positionals.length === 0) {
    deps.stdout.write(help);
    return flags.help ? 0 : 1;
  }

  const harnessArg = flags.positionals[0];
  if (harnessArg !== "pi") {
    deps.stderr.write(`milo on: unsupported harness "${harnessArg}" (this build routes pi only)\n`);
    return 1;
  }
  if (flags.local && flags.gateway !== undefined) {
    deps.stderr.write("milo on: pass either --local or --gateway, not both\n");
    return 1;
  }
  if (flags.dir !== undefined && flags.global) {
    deps.stderr.write("milo on: pass either --global or --dir, not both\n");
    return 1;
  }

  const gatewayRoot = flags.local
    ? LOCAL_GATEWAY
    : flags.gateway !== undefined
      ? normalizeGatewayRoot(flags.gateway)
      : DEFAULT_GATEWAY;

  const root = flags.dir !== undefined ? resolve(process.cwd(), flags.dir) : join(homedir(), ".pi");
  const configPath = join(root, PI_CONFIG_REL);
  const backupPath = backupPathFor(configPath);
  const keyStorePath = join(root, PI_KEY_STORE_REL);

  let existing: string | undefined;
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, "utf8");
    } catch (error) {
      deps.stderr.write(
        `milo on: could not read "${configPath}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    if (existing !== undefined) {
      try {
        JSON.parse(existing);
      } catch (error) {
        deps.stderr.write(
          `milo on: "${configPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }
  }

  const keyRes = await resolveKey({ env: deps.env, isTTY: deps.isTTY, prompt: deps.prompt });
  if (keyRes.kind === "cancelled") {
    deps.stderr.write("milo on: cancelled; no key entered, nothing was changed.\n");
    return 1;
  }
  const hasEnvKey = keyRes.kind === "env";
  const promptedKey = keyRes.kind === "prompted" ? keyRes.key : undefined;
  const enableCtx = { gatewayRoot };

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, makeBackup("pi", existing, new Date().toISOString()));
    }
    writeFileSync(configPath, enablePi(existing, enableCtx));
    if (promptedKey !== undefined) {
      mkdirSync(dirname(keyStorePath), { recursive: true });
      writeFileSync(keyStorePath, renderAuth(readIfExists(keyStorePath), promptedKey), { mode: 0o600 });
    }
  } catch (error) {
    deps.stderr.write(`milo on: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (flags.dir !== undefined) {
    deps.stdout.write(`Configured pi to route through Milo (config root: ${root}).\n`);
  } else {
    // Plain `milo on pi` is the host-level switch; pi has no project-local
    // config, so the one command registers the provider machine-wide. Say so
    // explicitly, and name what the additive merge did not touch.
    deps.stdout.write(
      "Registered the milo provider at the HOST level (~/.pi): pi now routes through Milo machine-wide.\n",
    );
    deps.stdout.write("  Your existing providers and default model were left untouched; only milo was added.\n");
  }
  deps.stdout.write(`  Config: ${configPath}\n`);
  deps.stdout.write(`  Backup: ${backupPath}\n`);
  for (const step of nextSteps(enableCtx)) {
    deps.stdout.write(`  - ${step}\n`);
  }

  if (flags.noVerify) {
    deps.stdout.write("  - Smoke verify skipped (--no-verify).\n");
    return 0;
  }

  if (hasEnvKey || promptedKey !== undefined) {
    if (keyRes.kind === "env" || keyRes.kind === "prompted") {
      const ok = await smokeVerify(deps, { gatewayRoot, openRouterKey: keyRes.key });
      if (ok) {
        deps.stdout.write("  - OPENROUTER_API_KEY is set in this environment.\n");
        return 0;
      }
    }
    return 1;
  }

  deps.stderr.write("\nOPENROUTER_API_KEY is not set and this is not an interactive terminal.\n");
  deps.stderr.write("Set it before using pi (or re-run in a terminal to be prompted):\n");
  deps.stderr.write("  export OPENROUTER_API_KEY=sk-or-...\n");
  return 1;
}

export async function runStatus(args: string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    deps.stdout.write(statusHelp);
    return 0;
  }
  const root = flags.dir !== undefined ? resolve(process.cwd(), flags.dir) : join(homedir(), ".pi");
  const configPath = join(root, PI_CONFIG_REL);
  const existing = readIfExists(configPath);
  const state = statusPi(existing);
  if (state.enabled) {
    deps.stdout.write(`pi: routed to Milo at ${state.gateway as string} as "${state.model}".\n`);
    deps.stdout.write(`  Config: ${configPath}\n`);
    deps.stdout.write(`  Key: read from $OPENROUTER_API_KEY at call time, else ${join(root, PI_KEY_STORE_REL)}.\n`);
    return 0;
  }
  deps.stdout.write(`pi: not routed to Milo (no "${PI_PROVIDER_ID}" provider in ${configPath}).\n`);
  return 0;
}