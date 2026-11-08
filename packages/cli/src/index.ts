/**
 * Programmatic entry point. `runCli(argv, deps)` dispatches `argv` (already
 * stripped of the node binary and script path) to one of the subcommands in
 * `src/commands/`, each of which exports `{ help, run }`. `src/cli.ts` is the
 * thin `#!/usr/bin/env node` wrapper around this, wired to `defaultDeps()`.
 */
import * as cost from "./commands/cost.js";
import * as decisions from "./commands/decisions.js";
import * as explain from "./commands/explain.js";
import * as roster from "./commands/roster.js";
import * as serve from "./commands/serve.js";
import * as stats from "./commands/stats.js";
import * as tune from "./commands/tune.js";
import * as usage from "./commands/usage.js";
import * as verify from "./commands/verify.js";
import type { CliDeps } from "./deps.js";

export type { CliDeps } from "./deps.js";
export { defaultDeps } from "./default-deps.js";

type Command = {
  help: string;
  run: (args: string[], deps: CliDeps) => Promise<number | undefined>;
};

// The canary and replay commands import @milo/evals, the eval tooling. Load
// it on demand so `milo serve` never imports it at startup.
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

const replay: Command = {
  help: "Replay a capped sample of Milo's routing tasks through a running `milo serve`.\n\n" + 'Run "milo replay --help" for options.',
  run: async (args, deps) => {
    const mod = await import("./commands/replay.js");
    return mod.run(args, deps);
  },
};

const COMMANDS: Record<string, Command> = { serve, usage, replay, explain, decisions, stats, cost, tune, roster, canary, verify };

export const TOP_LEVEL_HELP = `Usage: milo <command> [options]

The Milo CLI: route requests across your own ChatGPT (codex) and Claude
(claude) subscriptions, and see how much of each plan is left.

Commands:
  serve       Start the local subscription router
  usage       Show how much of each subscription is used, left, and when it resets
  replay      Replay a capped sample of Milo's routing tasks through \`milo serve\`
  verify      Install the ground-truth verification Stop hook into a harness

Tools for decision logs and Jev evals from the OpenRouter version:
  explain     Explain one routing decision
  decisions   List recent routing decisions
  stats       Summarize the decision log
  cost        Show routed-request spend from the decision log
  tune        Propose tuned routing-policy settings from the decision log
  roster      Show the effective tier-to-model roster
  canary      Run the continuous eval canary and check for drift

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
