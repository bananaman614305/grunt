/** `milo roster [--config <path>]`: the effective tier-to-model table. */
import { parseArgs } from "node:util";
import { DEFAULT_ROSTER, TIERS } from "@milo/core";
import type { Roster } from "@milo/core";
import { loadConfig } from "../config.js";
import type { CliDeps } from "../deps.js";

export const help = `Usage: milo roster [options]

Print the effective tier-to-model roster and where it came from.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  -h, --help         Show this help
`;

function formatRoster(roster: Roster): string {
  const width = Math.max(...TIERS.map((tier) => tier.length));
  return TIERS.map((tier) => `  ${tier.padEnd(width)}  ${(roster[tier] ?? []).join(", ")}`).join("\n");
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { config: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo roster: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  let loaded;
  try {
    loaded = loadConfig(parsed.values.config);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const roster = loaded.config.roster ?? DEFAULT_ROSTER;
  const source =
    loaded.config.roster !== undefined && loaded.source.kind === "file"
      ? `config file (${loaded.source.path})`
      : "defaults";

  deps.stdout.write(`Roster source: ${source}\n`);
  deps.stdout.write(`${formatRoster(roster)}\n`);
  return 0;
}
