/**
 * Regenerates `packages/core/src/router/roster-default.json`.
 *
 *   pnpm --filter @milo/evals run roster:refresh            # dry run, prints the diff
 *   pnpm --filter @milo/evals run roster:refresh -- --write
 *
 * Two inputs, both public and neither needing a key:
 *
 * - **Prices and capabilities** from `https://openrouter.ai/api/v1/models`.
 * - **Popularity** from OpenRouter's rankings page for the programming
 *   category, weekly view. There is no public usage API; the ranking is
 *   embedded in the page, so the script scrapes the `model_permaslug` /
 *   `total_tokens` rows out of the body. When the page's shape changes and
 *   the scrape comes back empty, it falls back to the committed snapshot in
 *   `popular.json` next to this file and says so loudly, rather than writing
 *   a roster built on nothing.
 *
 * The rule itself lives in `../src/roster-select.ts` and is unit-tested on a
 * fixture; this script is only the fetching, the diff, and the write. The
 * weekly job in `.github/workflows/roster-refresh.yml` runs it with `--write`
 * and opens a pull request when the output changes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildRosterFile,
  diffRosterFiles,
  scrapeRankingRows,
  selectRoster,
  DEFAULT_RULES,
  TIER_ORDER,
} from "../src/roster-select.js";
import type {
  OpenRouterModelsPayload,
  RankingRow,
  RankingSnapshot,
  RosterFile,
} from "../src/roster-select.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const RANKINGS_URL = "https://openrouter.ai/rankings?category=programming&view=week";
const SNAPSHOT_PATH = fileURLToPath(new URL("./popular.json", import.meta.url));
const ROSTER_PATH = fileURLToPath(new URL("../../core/src/router/roster-default.json", import.meta.url));

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const warn = (line: string): void => void process.stderr.write(`${line}\n`);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The live ranking, or the committed snapshot when the page stops parsing. */
async function fetchRanking(snapshot: RankingSnapshot): Promise<{ rows: RankingRow[]; live: boolean }> {
  try {
    const response = await fetch(RANKINGS_URL, {
      headers: { accept: "text/html,application/json", "user-agent": "milo-roster-refresh" },
    });
    if (!response.ok) {
      warn(`roster-refresh: rankings page answered ${response.status}; using the committed snapshot`);
      return { rows: snapshot.rows, live: false };
    }
    const rows = scrapeRankingRows(await response.text());
    if (rows.length === 0) {
      warn(
        "roster-refresh: found no model_permaslug/total_tokens rows on the rankings page -- " +
          "its shape has probably changed. Using the committed snapshot in popular.json; " +
          "re-read the page and update that file.",
      );
      return { rows: snapshot.rows, live: false };
    }
    out(`  ${rows.length} ranking rows scraped`);
    return { rows, live: true };
  } catch (error) {
    warn(
      `roster-refresh: could not read the rankings page (${error instanceof Error ? error.message : String(error)}); ` +
        "using the committed snapshot",
    );
    return { rows: snapshot.rows, live: false };
  }
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes("--write");

  const snapshot = readJson<RankingSnapshot>(SNAPSHOT_PATH);
  if (snapshot === undefined) {
    warn(`roster-refresh: could not read ${SNAPSHOT_PATH}`);
    return 1;
  }

  out(`Fetching ${MODELS_URL} ...`);
  const response = await fetch(MODELS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    warn(`roster-refresh: OpenRouter answered ${response.status} for the models catalogue`);
    return 1;
  }
  const payload = (await response.json()) as OpenRouterModelsPayload;
  out(`  ${payload.data.length} models in the catalogue`);

  out(`Fetching ${RANKINGS_URL} ...`);
  const ranking = await fetchRanking(snapshot);
  out("");

  const selection = selectRoster(
    payload,
    { ...snapshot, rows: ranking.rows, collected: ranking.live ? today() : snapshot.collected },
    DEFAULT_RULES,
  );
  const next = buildRosterFile(selection, DEFAULT_RULES, {
    version: today(),
    source: {
      usage: ranking.live
        ? `OpenRouter weekly usage ranking, ${snapshot.category} category, read ${today()}`
        : `OpenRouter weekly usage ranking, ${snapshot.category} category, week ending ${snapshot.weekEnding} (committed snapshot)`,
      pricing: `OpenRouter /api/v1/models on ${today()}`,
    },
  });

  for (const tier of TIER_ORDER) {
    out(`${tier} (output at most $${DEFAULT_RULES.bands[tier].maxOutputUsdPerM}/M)`);
    for (const model of next.tiers[tier]) {
      const note =
        model.demotedForSmallOutput === true ? `  (max output ${model.maxOutputTokens}, sorts last)` : "";
      out(
        `  ${model.id.padEnd(38)} $${model.inputUsdPerM}/$${model.outputUsdPerM} per M` +
          `  rank ${model.usageRank}  ${(model.weeklyTokens / 1e12).toFixed(1)}T/wk${note}`,
      );
    }
    out("");
  }

  if (selection.skipped.length > 0) {
    out("Not selected:");
    for (const { id, reason } of selection.skipped) out(`  ${id.padEnd(46)} ${reason}`);
    out("");
  }

  const previous = readJson<RosterFile>(ROSTER_PATH);
  const diff = diffRosterFiles(previous, next);
  out(diff === "" ? "No change to the shipped roster." : `Diff:\n${diff}`);

  if (!write) {
    out("\nDry run. Pass --write to update roster-default.json.");
    return 0;
  }

  writeFileSync(ROSTER_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  out(`\nWrote ${ROSTER_PATH}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    warn(`roster-refresh: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
