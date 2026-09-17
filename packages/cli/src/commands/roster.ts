/**
 * `milo roster`: the effective tier-to-model table.
 *
 * Three things to print, because since ADR-007 one deployment can be running
 * more than one roster at a time:
 *
 *   - `milo roster` -- what this deployment picks for a caller who stored
 *     nothing: the config file's table, else the shipped default.
 *   - `milo roster --key-hash <hash>` -- one user's own table, looked up by
 *     the hash their row is keyed under. There is no way to go from a key to
 *     its hash here, and that is deliberate: an operator reads the hash off
 *     `milo roster list` or a log line, never off a key.
 *   - `milo roster list` -- every stored roster as a shape (hash, model count,
 *     when it last moved), so an operator can see that per-key rosters are in
 *     use without reading anybody's model list.
 */
import { parseArgs } from "node:util";
import {
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  ROSTER_NOTE,
  ROSTER_OVERRIDE_NOTE,
  TIERS,
  defaultRosterModel,
} from "@milo/core";
import type { Roster, StoredRosterSummary } from "@milo/core";
import { DEFAULT_DECISION_LOG_URL, loadConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import { formatTable } from "../format.js";

export const help = `Usage: milo roster [list] [options]

Print the effective tier-to-model roster, what each model costs, how popular
it is, and where the entry came from.

Subcommands:
  list               List the per-key rosters stored in the decision log

Options:
  --config <path>    Path to milo.config.json (default: ./milo.config.json if present)
  --key-hash <hash>  Print the roster stored for one key hash (SHA-256 hex)
  --db <url>         Decision log libsql URL (default: ${DEFAULT_DECISION_LOG_URL})
  -h, --help         Show this help
`;

/** The hash `--key-hash` takes: what `PUT /v1/roster` keyed the row under. */
const KEY_HASH = /^[0-9a-f]{64}$/;

/** `milo roster list`, as a table of shapes rather than model lists. */
export function formatStoredRosters(rows: StoredRosterSummary[]): string {
  if (rows.length === 0) return "(no per-key rosters stored)";
  return formatTable(
    ["KEY HASH", "MODELS", "SOURCE", "UPDATED"],
    rows.map((row) => [row.keyHash, String(row.modelCount), row.source, row.updatedAt]),
  );
}

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
function formatRoster(roster: Roster, unknownSource = "config"): string {
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
        source:
          known === undefined ? unknownSource : known.tier === tier ? "default" : `default (${known.tier})`,
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
      options: {
        config: { type: "string" },
        "key-hash": { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo roster: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const [subcommand, ...extra] = parsed.positionals;
  if (subcommand !== undefined && subcommand !== "list") {
    deps.stderr.write(`milo roster: unknown subcommand "${subcommand}"\n\n${help}`);
    return 1;
  }
  if (extra.length > 0) {
    deps.stderr.write(`milo roster: unexpected argument "${extra[0]}"\n\n${help}`);
    return 1;
  }

  const dbUrl = parsed.values.db ?? DEFAULT_DECISION_LOG_URL;
  if (subcommand === "list") return listStored(dbUrl, deps);

  const keyHash = parsed.values["key-hash"];
  if (keyHash !== undefined) return showStored(keyHash, dbUrl, deps);

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

/** `milo roster list`: every per-key roster in the log, most recent first. */
async function listStored(dbUrl: string, deps: CliDeps): Promise<number> {
  const log = await deps.openLog(dbUrl);
  try {
    const rows = await log.listRosters();
    deps.stdout.write(`${formatStoredRosters(rows)}\n`);
    return 0;
  } finally {
    await log.close();
  }
}

/** `milo roster --key-hash <hash>`: one user's stored table. */
async function showStored(keyHash: string, dbUrl: string, deps: CliDeps): Promise<number> {
  if (!KEY_HASH.test(keyHash)) {
    deps.stderr.write(
      `milo roster: --key-hash takes the SHA-256 hex digest a roster is stored under, ` +
        `not a key. Run "milo roster list" to see the hashes.\n`,
    );
    return 1;
  }

  const log = await deps.openLog(dbUrl);
  try {
    const stored = await log.getRoster(keyHash);
    if (stored === undefined) {
      deps.stderr.write(`milo roster: no stored roster for key hash ${keyHash}\n`);
      return 1;
    }

    deps.stdout.write(`Roster source: user (key hash ${stored.keyHash})\n`);
    deps.stdout.write(`Stored: ${stored.createdAt}\nUpdated: ${stored.updatedAt}\n\n`);
    deps.stdout.write(`${formatRoster(stored.roster, "user")}\n\n`);
    // A user's own ids are not the shipped ones, so most rows print dashes:
    // this command makes no network call, so it has no prices for them.
    deps.stdout.write(
      "Prices and usage ranks are printed only for models Milo ships; " +
        "`GET /v1/roster` with the user's own key fills in the rest.\n",
    );
    return 0;
  } finally {
    await log.close();
  }
}
