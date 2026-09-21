/**
 * Programmatic entry point. `runCli(argv, deps)` dispatches `argv` (already
 * stripped of the node binary and script path) to one of the subcommands in
 * `src/commands/`, each of which exports `{ help, run }`. `src/cli.ts` is the
 * thin `#!/usr/bin/env node` wrapper around this, wired to `defaultDeps()`.
 */
import * as billing from "./commands/billing.js";
import * as cost from "./commands/cost.js";
import * as decisions from "./commands/decisions.js";
import * as explain from "./commands/explain.js";
import * as roster from "./commands/roster.js";
import * as serve from "./commands/serve.js";
import * as stats from "./commands/stats.js";
import * as tune from "./commands/tune.js";
import * as verify from "./commands/verify.js";
import type { CliDeps } from "./deps.js";

export type { CliDeps } from "./deps.js";
export { defaultDeps } from "./default-deps.js";

type Command = {
  help: string;
  run: (args: string[], deps: CliDeps) => Promise<number | undefined>;
};

// The canary command imports @milo/evals, a dev/CI-only package that
// `pnpm deploy --prod` prunes from the runtime image. Load it on demand so
// `milo serve` -- and everything else the deployed gateway runs -- never
// imports it (and never crashes on its absence) at startup.
const canary: Command = {
  help:
    "Run the continuous eval canary and check for drift.\n\n" +
    "Requires the dev eval package (@milo/evals); intended for cron/CI, not the deployed gateway.\n" +
    'Run "milo canary --help" for options.',
  run: async (args, deps) => {
    const mod = await import("./commands/canary.js");
    return mod.run(args, deps);
  },
};

const COMMANDS: Record<string, Command> = { serve, explain, decisions, stats, cost, tune, roster, canary, billing, verify };

export const TOP_LEVEL_HELP = `Usage: milo <command> [options]

The Milo CLI: run the gateway locally and inspect its routing decisions.

Commands:
  serve       Start the Milo gateway server
  explain     Explain one routing decision
  decisions   List recent routing decisions
  stats       Summarize the decision log
  cost        Show routed-request spend from the decision log
  tune        Propose tuned routing-policy settings from the decision log
  roster      Show the effective tier-to-model roster
  canary      Run the continuous eval canary and check for drift
  billing     Operate the billing database, Stripe, and provisioning
  verify      Install the ground-truth verification Stop hook into a harness

Run "milo <command> --help" for command-specific options.
`;

/**
 * Dispatches to a subcommand. Returns the process exit code, or `undefined`
 * when the process should keep running (only `serve`, on a successful
 * start, does this -- the open server keeps the event loop alive).
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number | undefined> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    deps.stderr.write(TOP_LEVEL_HELP);
    return 1;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout.write(TOP_LEVEL_HELP);
    return 0;
  }

  const impl = COMMANDS[command];
  if (!impl) {
    deps.stderr.write(`milo: unknown command "${command}"\n\n`);
    deps.stderr.write(TOP_LEVEL_HELP);
    return 1;
  }

  return impl.run(rest, deps);
}
