/**
 * Programmatic entry point. `runCli(argv, deps)` dispatches `argv` (already
 * stripped of the node binary and script path) to one of the subcommands in
 * `src/commands/`, each of which exports `{ help, run }`. `src/cli.ts` is the
 * thin `#!/usr/bin/env node` wrapper around this, wired to `defaultDeps()`.
 */
import * as billing from "./commands/billing.js";
import * as decisions from "./commands/decisions.js";
import * as explain from "./commands/explain.js";
import * as roster from "./commands/roster.js";
import * as serve from "./commands/serve.js";
import * as stats from "./commands/stats.js";
import type { CliDeps } from "./deps.js";

export type { CliDeps } from "./deps.js";
export { defaultDeps } from "./default-deps.js";

type Command = {
  help: string;
  run: (args: string[], deps: CliDeps) => Promise<number | undefined>;
};

const COMMANDS: Record<string, Command> = { serve, explain, decisions, stats, roster, billing };

export const TOP_LEVEL_HELP = `Usage: milo <command> [options]

The Milo CLI: run the gateway locally and inspect its routing decisions.

Commands:
  serve       Start the Milo gateway server
  explain     Explain one routing decision
  decisions   List recent routing decisions
  stats       Summarize the decision log
  roster      Show the effective tier-to-model roster
  billing     Operate the billing database, Stripe, and provisioning

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
