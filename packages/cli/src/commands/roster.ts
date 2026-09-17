/** `milo roster [--config <path>]`: the effective tier-to-model table. */
import { parseArgs } from "node:util";
import {
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  TIERS,
  defaultRosterModel,
} from "@milo/core";
import type { Roster } from "@milo/core";
import { loadConfig } from "../config.js";
import type { CliDeps } from "../deps.js";

export const help = `Usage: milo roster [options]

Print the effective tier-to-model roster, what each model costs, how popular
it is, and where the entry came from.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  -h, --help         Show this help
`;

/** `$0.14` / `$1.2`, or a dash for a model Milo has no price for. */
function usd(value: number | undefined): string {
  return value === undefined ? "-" : `$${value}`;
}

/**
 * One line per model: the tier (once), the id, input/output price per million
 * tokens, its weekly usage rank, and whether it came from the shipped roster
 * or from this deployment's config. A model the config added is printed with
 * dashes rather than a guess -- Milo does not know what an operator's own
 * choice costs without asking OpenRouter, and `milo roster` makes no calls.
 */
function formatRoster(roster: Roster): string {
  type Row = { tier: string; id: string; input: string; output: string; rank: string; source: string };
  const rows: Row[] = [];

  for (const tier of TIERS) {
    (roster[tier] ?? []).forEach((id, index) => {
      const known = defaultRosterModel(id);
      rows.push({
        tier: index === 0 ? tier : "",
        id,
        input: usd(known?.inputUsdPerM),
        output: usd(known?.outputUsdPerM),
        rank: known === undefined ? "-" : `#${known.usageRank}`,
        source: known === undefined ? "config" : known.tier === tier ? "default" : `default (${known.tier})`,
      });
    });
  }

  const header: Row = {
    tier: "TIER",
    id: "MODEL",
    input: "IN/M",
    output: "OUT/M",
    rank: "USE",
    source: "SOURCE",
  };
  const all = [header, ...rows];
  const width = (key: keyof Row): number => Math.max(...all.map((r) => r[key].length));
  const widths = {
    tier: width("tier"),
    id: width("id"),
    input: width("input"),
    output: width("output"),
    rank: width("rank"),
  };

  return all
    .map(
      (r) =>
        `  ${r.tier.padEnd(widths.tier)}  ${r.id.padEnd(widths.id)}  ${r.input.padStart(widths.input)}  ` +
        `${r.output.padStart(widths.output)}  ${r.rank.padStart(widths.rank)}  ${r.source}`,
    )
    .join("\n");
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
  deps.stdout.write(`Default roster version: ${DEFAULT_ROSTER_INFO.version}\n`);
  deps.stdout.write(
    `  usage: ${DEFAULT_ROSTER_INFO.source.usage}\n  pricing: ${DEFAULT_ROSTER_INFO.source.pricing}\n\n`,
  );
  deps.stdout.write(`${formatRoster(roster)}\n\n`);
  deps.stdout.write(`${ROSTER_NOTE}\n${ROSTER_OVERRIDE_NOTE}\n`);
  return 0;
}
