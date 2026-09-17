/**
 * The rule that turns OpenRouter's weekly usage ranking plus its price
 * catalogue into Milo's default roster.
 *
 * This module is pure: it takes an already-fetched `/api/v1/models` payload
 * and an already-fetched ranking snapshot and returns the record that
 * `packages/core/src/router/roster-default.json` holds. The network, the
 * HTML scraping and the file writing live in `scripts/roster-refresh.ts`, so
 * the rule can be tested on a fixture without touching any of them.
 *
 * ## The rule
 *
 * 1. Fold the ranking's rows onto current model ids: a dated build
 *    (`...-2026-08-12`) counts as its undated id, and a plan variant
 *    (`:free`, `:batch`, `:contributor` and the other data-sharing tiers) is
 *    dropped rather than counted as its own model. Tokens are summed per
 *    folded id.
 * 2. A model must be in the catalogue, must support tools -- Milo's users are
 *    running agents, and a model that cannot call a tool is no substitute --
 *    and must quote a usable price.
 * 3. Anything whose output price is at or above `excludedAbove` is never a
 *    default. That is what keeps Fable, Opus, Astra, Sonnet and the rest of
 *    the premium shelf out: people buy those on a subscription and orchestrate
 *    *with* them, and a default that quietly spends $25/M is a bad default
 *    however good the model is.
 * 4. Take the first `topModels` survivors, in usage order. Their `usageRank`
 *    is their position in that surviving list, 1..N.
 * 5. Tier by output price: the cheapest band whose ceiling the model fits.
 * 6. Within a tier, order by usage rank, except that a model whose max output
 *    is below `smallOutputBelowTokens` sorts last -- the router skips those
 *    on a long-output request, so one must never be a tier's default.
 */

import type { Tier } from "@milo/core";

/** The fields this module reads off an OpenRouter `/api/v1/models` entry. */
export type OpenRouterModelEntry = {
  id: string;
  canonical_slug?: string | null;
  context_length?: number | null;
  pricing?: { prompt?: string | null; completion?: string | null } | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
  supported_parameters?: string[] | null;
};

export type OpenRouterModelsPayload = { data: OpenRouterModelEntry[] };

/**
 * One row of OpenRouter's rankings payload, named as the page names it. The
 * committed `scripts/popular.json` fallback uses the same shape, so the live
 * path and the fallback path feed identical data into the rule.
 */
export type RankingRow = { model_permaslug: string; total_tokens: number };

export type RankingSnapshot = {
  /** When the ranking was read, `YYYY-MM-DD`. */
  collected: string;
  /** The last day of the ranking week, `YYYY-MM-DD`. */
  weekEnding: string;
  category: string;
  /** How it was read. OpenRouter publishes no usage API. */
  how?: string;
  rows: RankingRow[];
};

export type SelectionRules = {
  bands: Record<Tier, { maxOutputUsdPerM: number }>;
  /** Output USD per million at or above which a model is never a default. */
  excludedAbove: number;
  /** A model whose max output is below this cannot be a tier default. */
  smallOutputBelowTokens: number;
  /** How many of the surviving ranking entries make up the roster. */
  topModels: number;
};

export type SelectedModel = {
  id: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
  usageRank: number;
  weeklyTokens: number;
  contextLength: number;
  maxOutputTokens?: number;
  demotedForSmallOutput?: boolean;
};

export type RosterFile = {
  version: string;
  source: { usage: string; pricing: string };
  topModels: number;
  bands: Record<Tier, { maxOutputUsdPerM: number }>;
  excludedAbove: number;
  smallOutputBelowTokens: number;
  tiers: Record<Tier, SelectedModel[]>;
};

export type SkippedModel = { id: string; reason: string };

export type Selection = { tiers: Record<Tier, SelectedModel[]>; skipped: SkippedModel[] };

export const TIER_ORDER = ["fast", "mid", "frontier"] as const satisfies readonly Tier[];

export const DEFAULT_RULES: SelectionRules = {
  bands: {
    fast: { maxOutputUsdPerM: 0.35 },
    mid: { maxOutputUsdPerM: 1.5 },
    frontier: { maxOutputUsdPerM: 5 },
  },
  excludedAbove: 5,
  smallOutputBelowTokens: 65_536,
  topModels: 10,
};

/**
 * Plan variants that are the same model on different commercial terms. They
 * are dropped rather than folded, so a model is not counted twice and a
 * data-sharing slug never becomes a default.
 */
export const DROPPED_VARIANTS = ["free", "batch", "contributor", "beta", "preview-free"];

/** `openai/gpt-5.6-luna-2026-08-12` -> `openai/gpt-5.6-luna`. */
function stripDateSuffix(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{6,8}$/, "");
}

/**
 * Folds a ranking permaslug onto a catalogue id, or returns why it was
 * dropped. Tries the slug itself, then the slug with any date suffix removed,
 * against both `id` and `canonical_slug`.
 */
export function foldPermaslug(
  permaslug: string,
  catalogue: Map<string, string>,
): { id: string } | { dropped: string } {
  const [base = permaslug, variant] = permaslug.split(":");
  if (variant !== undefined && DROPPED_VARIANTS.includes(variant)) {
    return { dropped: `:${variant} plan variant` };
  }

  const direct = catalogue.get(base);
  if (direct !== undefined) return { id: direct };

  const undated = stripDateSuffix(base);
  const folded = catalogue.get(undated);
  if (folded !== undefined) return { id: folded };

  return { dropped: "not in OpenRouter's catalogue" };
}

/**
 * OpenRouter quotes prices in USD per token as decimal strings. A missing or
 * unparseable price is `null`, which disqualifies the model: a default roster
 * that cannot say what an entry costs is not a disclosure.
 */
export function usdPerMillion(price: string | null | undefined): number | null {
  if (price === null || price === undefined || price.trim() === "") return null;
  const perToken = Number(price);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  // Round to the cent-per-million OpenRouter's own pricing page shows;
  // floating point on 1e-7 values otherwise prints 0.30000000000000004.
  return Math.round(perToken * 1_000_000 * 10_000) / 10_000;
}

/** The cheapest band whose ceiling this output price fits, or `undefined`. */
export function bandFor(outputUsdPerM: number, rules: SelectionRules): Tier | undefined {
  return TIER_ORDER.find((tier) => outputUsdPerM <= rules.bands[tier].maxOutputUsdPerM);
}

function supportsTools(entry: OpenRouterModelEntry): boolean {
  return (entry.supported_parameters ?? []).includes("tools");
}

function maxOutputTokens(entry: OpenRouterModelEntry): number | undefined {
  const max = entry.top_provider?.max_completion_tokens;
  return typeof max === "number" && max > 0 ? max : undefined;
}

function contextLength(entry: OpenRouterModelEntry): number {
  return entry.top_provider?.context_length ?? entry.context_length ?? 0;
}

/** Applies the rule. Pure: no network, no clock, no file system. */
export function selectRoster(
  payload: OpenRouterModelsPayload,
  ranking: RankingSnapshot,
  rules: SelectionRules = DEFAULT_RULES,
): Selection {
  const entries = new Map(payload.data.map((entry) => [entry.id, entry]));
  const byId = new Map<string, string>();
  for (const entry of payload.data) {
    byId.set(entry.id, entry.id);
    if (typeof entry.canonical_slug === "string" && entry.canonical_slug !== "") {
      if (!byId.has(entry.canonical_slug)) byId.set(entry.canonical_slug, entry.id);
    }
  }

  const skipped: SkippedModel[] = [];

  // 1. Fold dated builds and plan variants together, summing their tokens.
  const folded = new Map<string, number>();
  for (const row of ranking.rows) {
    const result = foldPermaslug(row.model_permaslug, byId);
    if ("dropped" in result) {
      skipped.push({ id: row.model_permaslug, reason: result.dropped });
      continue;
    }
    folded.set(result.id, (folded.get(result.id) ?? 0) + row.total_tokens);
  }

  // 2-4. Filter, then take the top N survivors in usage order.
  const ordered = [...folded.entries()].sort((a, b) => b[1] - a[1]);
  const survivors: Array<Omit<SelectedModel, "usageRank"> & { tier: Tier }> = [];

  for (const [id, weeklyTokens] of ordered) {
    if (survivors.length >= rules.topModels) {
      skipped.push({ id, reason: `outside the top ${rules.topModels} by weekly usage` });
      continue;
    }
    const entry = entries.get(id);
    if (entry === undefined) {
      skipped.push({ id, reason: "not in OpenRouter's catalogue" });
      continue;
    }
    if (!supportsTools(entry)) {
      skipped.push({ id, reason: "does not support tools" });
      continue;
    }
    const inputUsdPerM = usdPerMillion(entry.pricing?.prompt);
    const outputUsdPerM = usdPerMillion(entry.pricing?.completion);
    if (inputUsdPerM === null || outputUsdPerM === null) {
      skipped.push({ id, reason: "OpenRouter quotes no usable price" });
      continue;
    }
    if (outputUsdPerM >= rules.excludedAbove) {
      skipped.push({
        id,
        reason: `output $${outputUsdPerM}/M is at or above the $${rules.excludedAbove}/M default ceiling`,
      });
      continue;
    }
    const tier = bandFor(outputUsdPerM, rules);
    if (tier === undefined) {
      skipped.push({ id, reason: `output $${outputUsdPerM}/M fits no band` });
      continue;
    }

    const max = maxOutputTokens(entry);
    survivors.push({
      id,
      inputUsdPerM,
      outputUsdPerM,
      weeklyTokens,
      contextLength: contextLength(entry),
      ...(max !== undefined ? { maxOutputTokens: max } : {}),
      ...(max !== undefined && max < rules.smallOutputBelowTokens ? { demotedForSmallOutput: true } : {}),
      tier,
    });
  }

  // 5-6. Tier them, small-output models last within each tier.
  const tiers: Record<Tier, SelectedModel[]> = { fast: [], mid: [], frontier: [] };
  survivors.forEach(({ tier, ...model }, index) => {
    tiers[tier].push({ ...model, usageRank: index + 1 });
  });
  for (const tier of TIER_ORDER) {
    tiers[tier].sort((a, b) => {
      const small = (a.demotedForSmallOutput === true ? 1 : 0) - (b.demotedForSmallOutput === true ? 1 : 0);
      return small !== 0 ? small : a.usageRank - b.usageRank;
    });
  }

  return { tiers, skipped };
}

/** Wraps a selection in the provenance the shipped JSON carries. */
export function buildRosterFile(
  selection: Selection,
  rules: SelectionRules,
  meta: { version: string; source: { usage: string; pricing: string } },
): RosterFile {
  return {
    version: meta.version,
    source: meta.source,
    topModels: rules.topModels,
    bands: rules.bands,
    excludedAbove: rules.excludedAbove,
    smallOutputBelowTokens: rules.smallOutputBelowTokens,
    tiers: selection.tiers,
  };
}

/**
 * A human-readable diff of two roster files, for the refresh script to print
 * and for the weekly pull request's body. Empty string means nothing changed.
 */
export function diffRosterFiles(before: RosterFile | undefined, after: RosterFile): string {
  const lines: string[] = [];
  if (before === undefined) {
    lines.push("no previous roster-default.json; writing a new one");
    return lines.join("\n");
  }
  if (before.version !== after.version) lines.push(`version ${before.version} -> ${after.version}`);

  for (const tier of TIER_ORDER) {
    const old = before.tiers[tier] ?? [];
    const next = after.tiers[tier];
    const oldIds = old.map((m) => m.id);
    const nextIds = next.map((m) => m.id);

    for (const id of nextIds.filter((id) => !oldIds.includes(id))) lines.push(`+ ${tier}  ${id}`);
    for (const id of oldIds.filter((id) => !nextIds.includes(id))) lines.push(`- ${tier}  ${id}`);
    if (oldIds.length === nextIds.length && oldIds.join(",") !== nextIds.join(",")) {
      if (nextIds.every((id) => oldIds.includes(id))) {
        lines.push(`~ ${tier}  order: ${oldIds.join(", ")} -> ${nextIds.join(", ")}`);
      }
    }
    for (const model of next) {
      const previous = old.find((m) => m.id === model.id);
      if (previous === undefined) continue;
      if (previous.inputUsdPerM !== model.inputUsdPerM || previous.outputUsdPerM !== model.outputUsdPerM) {
        lines.push(
          `~ ${tier}  ${model.id} price $${previous.inputUsdPerM}/$${previous.outputUsdPerM} -> ` +
            `$${model.inputUsdPerM}/$${model.outputUsdPerM} per M`,
        );
      }
      if (previous.usageRank !== model.usageRank) {
        lines.push(`~ ${tier}  ${model.id} usage rank ${previous.usageRank} -> ${model.usageRank}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Pulls ranking rows out of whatever JSON the rankings page embeds, by walking
 * it for objects that carry both `model_permaslug` and `total_tokens`. The
 * page's envelope changes shape from time to time; the rows have not, and a
 * walk survives a rename one level up. Returns `[]` when the shape is
 * unrecognizable, which is the refresh script's signal to fall back to the
 * committed snapshot.
 */
export function extractRankingRows(payload: unknown): RankingRow[] {
  const rows: RankingRow[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const slug = record["model_permaslug"];
    const tokens = record["total_tokens"];
    if (typeof slug === "string" && slug !== "") {
      const count = typeof tokens === "number" ? tokens : Number(tokens);
      if (Number.isFinite(count)) {
        rows.push({ model_permaslug: slug, total_tokens: count });
        return;
      }
    }
    for (const value of Object.values(record)) walk(value);
  };

  walk(payload);
  rows.sort((a, b) => b.total_tokens - a.total_tokens);
  return rows;
}

/** The first `{` that encloses `at`, or -1. */
function objectStart(body: string, at: number): number {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const ch = body[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** The `}` that closes the object opening at `start`, or -1. */
function objectEnd(body: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Pulls ranking rows out of the rankings page's body.
 *
 * OpenRouter embeds the ranking in the page rather than serving it from an
 * API, and the envelope it is embedded in (a Next.js flight payload today)
 * changes shape without notice. So this does not parse the envelope at all:
 * it finds every `model_permaslug` in the text, takes the smallest JSON
 * object that encloses it, and reads the two fields it needs. A body whose
 * rows have been renamed yields `[]`, which is the refresh script's signal to
 * fall back to the committed snapshot rather than ship an empty roster.
 *
 * Rows repeated across the page (the table and its preloaded data) are
 * deduplicated, keeping the largest token count seen for a slug.
 */
export function scrapeRankingRows(body: string): RankingRow[] {
  let fromJson: RankingRow[] = [];
  try {
    fromJson = extractRankingRows(JSON.parse(body));
  } catch {
    // Not a bare JSON document. Scan the text instead.
  }

  const scan = (text: string): RankingRow[] => {
    const found: RankingRow[] = [];
    const key = '"model_permaslug"';
    let from = 0;
    for (;;) {
      const at = text.indexOf(key, from);
      if (at === -1) break;
      from = at + key.length;
      const start = objectStart(text, at);
      if (start === -1) continue;
      const end = objectEnd(text, start);
      if (end === -1) continue;
      try {
        const record = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        const slug = record["model_permaslug"];
        const tokens = Number(record["total_tokens"]);
        if (typeof slug === "string" && slug !== "" && Number.isFinite(tokens)) {
          found.push({ model_permaslug: slug, total_tokens: tokens });
        }
      } catch {
        // A partial or escaped object. The unescaped pass below may catch it.
      }
    }
    return found;
  };

  // A flight payload carries its JSON escaped inside a JS string literal.
  const scanned = scan(body);
  const rows =
    fromJson.length > 0 ? fromJson : scanned.length > 0 ? scanned : scan(body.replace(/\\"/g, '"'));

  const best = new Map<string, number>();
  for (const row of rows) {
    best.set(row.model_permaslug, Math.max(best.get(row.model_permaslug) ?? 0, row.total_tokens));
  }
  return [...best.entries()]
    .map(([model_permaslug, total_tokens]) => ({ model_permaslug, total_tokens }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}
