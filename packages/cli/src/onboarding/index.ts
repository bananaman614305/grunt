/**
 * The lean onboarding entry, `@milo/cli/onboarding` -- the module the
 * publishable `usemilo` package bundles into its single-file CLI. It
 * registers only the onboarding commands (`on`, `status`) and imports only
 * pure onboarding modules: no gateway server, no decision log, nothing that
 * drags native dependencies into the published bundle.
 */
import type { CliDeps } from "../deps.js";
import { runOn, runStatus } from "./on.js";

export const ONBOARDING_HELP = `Usage: milo <command> [options]

Point the pi coding agent at the Milo routing gateway, and check where it
points.

Commands:
  on          Point pi at Milo (merges a "milo" provider into models.json
              additively, keeps a .milo-backup, smoke-verifies x-milo-model)
  status      Show whether pi is routed through Milo

  --help      Show this help
  --version   Print the version

Run "milo <command> --help" for command-specific options.
`;

export const ONBOARDING_CLI_VERSION = "0.4.0";

const COMMANDS: Record<string, { run: (args: string[], deps: CliDeps) => Promise<number> }> = {
  on: { run: runOn },
  status: { run: runStatus },
};

export async function runOnboardingCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    deps.stdout.write(`${ONBOARDING_CLI_VERSION}\n`);
    return 0;
  }
  if (command === undefined) {
    deps.stderr.write(ONBOARDING_HELP);
    return 1;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout.write(ONBOARDING_HELP);
    return 0;
  }
  const impl = COMMANDS[command];
  if (impl === undefined) {
    deps.stderr.write(`milo: unknown command "${command}"\n\n`);
    deps.stderr.write(ONBOARDING_HELP);
    return 1;
  }
  return impl.run(rest, deps);
}