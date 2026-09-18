/**
 * The default-roster rule, on a fixture. No network: the OpenRouter catalogue
 * is a trimmed recorded copy in `__fixtures__/openrouter-models.json` and the
 * ranking is the committed snapshot the refresh script falls back to.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER, DEFAULT_ROSTER_INFO } from "@milo/core";
import {
  bandFor,
  buildRosterFile,
  diffRosterFiles,
  foldPermaslug,
  preReleaseSuffix,
  scrapeRankingRows,
  selectRoster,
  usdPerMillion,
  DEFAULT_RULES,
  TIER_ORDER,
} from "./roster-select.js";
import type { OpenRouterModelsPayload, RankingSnapshot, SelectedModel } from "./roster-select.js";

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

const MODELS = readJson<OpenRouterModelsPayload>("./__fixtures__/openrouter-models.json");
const RANKING = readJson<RankingSnapshot>("../scripts/popular.json");

function ids(models: SelectedModel[]): string[] {
  return models.map((m) => m.id);
}

describe("usdPerMillion", () => {
  it("converts OpenRouter's per-token strings without float noise", () => {
    expect(usdPerMillion("0.0000003")).toBe(0.3);
    expect(usdPerMillion("0.0000012")).toBe(1.2);
    expect(usdPerMillion("0.00000312")).toBe(3.12);
    expect(usdPerMillion("0")).toBe(0);
  });

  it("refuses a price it cannot read, rather than guessing one", () => {
    expect(usdPerMillion(undefined)).toBeNull();
    expect(usdPerMillion(null)).toBeNull();
    expect(usdPerMillion("")).toBeNull();
    expect(usdPerMillion("free")).toBeNull();
    expect(usdPerMillion("-0.001")).toBeNull();
  });
});

describe("bandFor", () => {
  it("puts a model in the cheapest band whose ceiling it fits", () => {
    expect(bandFor(0.14, DEFAULT_RULES)).toBe("fast");
    expect(bandFor(0.35, DEFAULT_RULES)).toBe("fast");
    expect(bandFor(0.36, DEFAULT_RULES)).toBe("mid");
    expect(bandFor(1.5, DEFAULT_RULES)).toBe("mid");
    expect(bandFor(2.5, DEFAULT_RULES)).toBe("frontier");
    expect(bandFor(5, DEFAULT_RULES)).toBe("frontier");
    expect(bandFor(5.01, DEFAULT_RULES)).toBeUndefined();
  });
});

describe("foldPermaslug", () => {
  const catalogue = new Map([["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"]]);

  it("folds a dated build onto its current id", () => {
    expect(foldPermaslug("deepseek/deepseek-v4-flash-2026-08-12", catalogue)).toEqual({
      id: "deepseek/deepseek-v4-flash",
    });
  });

  it("drops a data-sharing plan variant rather than counting it as a model", () => {
    for (const variant of ["free", "batch", "contributor"]) {
      expect(foldPermaslug(`deepseek/deepseek-v4-flash:${variant}`, catalogue)).toEqual({
        dropped: `:${variant} plan variant`,
      });
    }
  });

  it("reports a slug the catalogue does not know", () => {
    expect(foldPermaslug("nobody/nothing", catalogue)).toEqual({
      dropped: "not in OpenRouter's catalogue",
    });
  });

  it("resolves through canonical_slug", () => {
    const withCanonical = new Map([["vendor/model-canonical", "vendor/model"]]);
    expect(foldPermaslug("vendor/model-canonical", withCanonical)).toEqual({ id: "vendor/model" });
  });
});

describe("preReleaseSuffix", () => {
  it("matches a pre-release marker on the id's final path segment", () => {
    expect(preReleaseSuffix("tencent/hy4-preview")).toBe("-preview");
    expect(preReleaseSuffix("vendor/model-beta")).toBe("-beta");
    expect(preReleaseSuffix("vendor/model-alpha")).toBe("-alpha");
    expect(preReleaseSuffix("vendor/model-rc")).toBe("-rc");
  });

  it("does not match a marker that merely appears mid-name", () => {
    // "preview" is present but not as a hyphen-delimited suffix of the segment.
    expect(preReleaseSuffix("vendor/preview-turbo")).toBeUndefined();
    expect(preReleaseSuffix("openai/gpt-preview-mini")).toBeUndefined();
    expect(preReleaseSuffix("some/betamax-9")).toBeUndefined();
    expect(preReleaseSuffix("deepseek/deepseek-v4-flash")).toBeUndefined();
    // The marker in the provider segment must not count either.
    expect(preReleaseSuffix("preview/stable-model")).toBeUndefined();
  });
});

describe("selectRoster", () => {
  const selection = selectRoster(MODELS, RANKING, DEFAULT_RULES);

  it("skips a pre-release build and keeps a normal id that only contains 'preview'", () => {
    const ranking: RankingSnapshot = {
      ...RANKING,
      rows: [
        { model_permaslug: "tencent/hy4-preview", total_tokens: 99_000_000_000_000 },
        { model_permaslug: "openai/gpt-5.6-luna", total_tokens: 42_000_000_000_000 },
      ],
    };
    const result = selectRoster(MODELS, ranking, DEFAULT_RULES);
    const all = TIER_ORDER.flatMap((tier) => result.tiers[tier]).map((m) => m.id);
    // The pre-release frontier build is dropped even as the single most used.
    expect(all).not.toContain("tencent/hy4-preview");
    expect(result.skipped).toContainEqual({
      id: "tencent/hy4-preview",
      reason: "-preview pre-release build, never a default",
    });
    // gpt-5.6-luna carries no pre-release suffix, so it survives.
    expect(all).toContain("openai/gpt-5.6-luna");
  });

  it("never lets a pre-release build be a tier default in the shipped roster", () => {
    for (const tier of TIER_ORDER) {
      for (const model of selection.tiers[tier]) {
        expect(preReleaseSuffix(model.id)).toBeUndefined();
      }
    }
    expect(selection.skipped).toContainEqual({
      id: "tencent/hy4-preview",
      reason: "-preview pre-release build, never a default",
    });
  });

  it("reproduces the roster that ships in roster-default.json", () => {
    expect(selection.tiers).toEqual(DEFAULT_ROSTER_INFO.tiers);
  });

  it("takes exactly the top ten by weekly usage", () => {
    const all = TIER_ORDER.flatMap((tier) => selection.tiers[tier]);
    expect(all).toHaveLength(DEFAULT_RULES.topModels);
    expect([...all].map((m) => m.usageRank).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("folds a dated build into its current id and sums the tokens", () => {
    const flash = selection.tiers.fast.find((m) => m.id === "deepseek/deepseek-v4-flash");
    // 9.1T on the dated slug plus 6.3T on the undated one; the 5.9T `:free`
    // row is dropped, not added.
    expect(flash?.weeklyTokens).toBe(15_400_000_000_000);
    expect(flash?.usageRank).toBe(2);
    expect(selection.skipped).toContainEqual({
      id: "deepseek/deepseek-v4-flash:free",
      reason: ":free plan variant",
    });
  });

  it("never picks a model at or above the $5/M output ceiling", () => {
    const all = TIER_ORDER.flatMap((tier) => selection.tiers[tier]);
    for (const model of all) expect(model.outputUsdPerM).toBeLessThan(DEFAULT_RULES.excludedAbove);
    for (const premium of [
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
      "moonshotai/kimi-k3",
      "qwen/qwen3.8-max-0902",
    ]) {
      expect(all.map((m) => m.id)).not.toContain(premium);
    }
  });

  it("rejects a cheap model that cannot call a tool", () => {
    const ranking: RankingSnapshot = {
      ...RANKING,
      rows: [{ model_permaslug: "some-lab/chatty-nano", total_tokens: 99_000_000_000_000 }],
    };
    const result = selectRoster(MODELS, ranking, DEFAULT_RULES);
    expect(TIER_ORDER.flatMap((t) => result.tiers[t])).toEqual([]);
    expect(result.skipped).toContainEqual({ id: "some-lab/chatty-nano", reason: "does not support tools" });
  });

  it("excludes a premium model by price even when it is the single most used", () => {
    const ranking: RankingSnapshot = {
      ...RANKING,
      rows: [
        { model_permaslug: "anthropic/claude-opus-5", total_tokens: 99_000_000_000_000 },
        { model_permaslug: "tencent/hy3", total_tokens: 1_000_000_000_000 },
      ],
    };
    const result = selectRoster(MODELS, ranking, DEFAULT_RULES);
    expect(ids(result.tiers.fast)).toEqual(["tencent/hy3"]);
    expect(result.skipped).toContainEqual({
      id: "anthropic/claude-opus-5",
      reason: "output $25/M is at or above the $5/M default ceiling",
    });
  });

  it("orders each tier by usage rank, with small-output models last", () => {
    expect(ids(selection.tiers.fast)).toEqual([
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.3-flash",
      "xiaomi/mimo-v2.5",
      "tencent/hy3",
    ]);
    expect(ids(selection.tiers.mid)).toEqual([
      "openai/gpt-5.6-luna",
      "deepseek/deepseek-v4.1-flash",
      "minimax/minimax-m3",
    ]);
    // hy4-preview is the pre-release build that used to lead this tier; it is
    // skipped now, so glm-5.3 (rank 8) leads. nemotron caps output below
    // 65,536, so it sorts behind gemini-3.8-flash (rank 9).
    expect(ids(selection.tiers.frontier)).toEqual([
      "z-ai/glm-5.3",
      "google/gemini-3.8-flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
    expect(selection.tiers.frontier[0]?.demotedForSmallOutput).toBeUndefined();
  });

  it("marks exactly the models whose max output cannot hold a long answer", () => {
    const demoted = TIER_ORDER.flatMap((t) => selection.tiers[t])
      .filter((m) => m.demotedForSmallOutput === true)
      .map((m) => m.id);
    expect(demoted).toEqual(["nvidia/nemotron-3-ultra-550b-a55b"]);
  });

  it("never makes a small-output model a tier default", () => {
    for (const tier of TIER_ORDER) {
      expect(DEFAULT_ROSTER[tier][0]).toBe(selection.tiers[tier][0]?.id);
      expect(selection.tiers[tier][0]?.demotedForSmallOutput).toBeUndefined();
    }
  });
});

describe("buildRosterFile", () => {
  it("carries the rules and the provenance alongside the tiers", () => {
    const file = buildRosterFile(selectRoster(MODELS, RANKING, DEFAULT_RULES), DEFAULT_RULES, {
      version: "2026-09-24",
      source: { usage: "u", pricing: "p" },
    });
    expect(file.version).toBe("2026-09-24");
    expect(file.bands).toEqual(DEFAULT_RULES.bands);
    expect(file.excludedAbove).toBe(5);
    expect(file.topModels).toBe(10);
    expect(file.smallOutputBelowTokens).toBe(60_000);
  });
});

describe("diffRosterFiles", () => {
  const base = buildRosterFile(selectRoster(MODELS, RANKING, DEFAULT_RULES), DEFAULT_RULES, {
    version: "2026-09-17",
    source: { usage: "u", pricing: "p" },
  });

  it("says nothing when nothing moved", () => {
    expect(diffRosterFiles(base, base)).toBe("");
  });

  it("names an added and a removed model", () => {
    const next = structuredClone(base);
    next.tiers.mid = [{ ...base.tiers.mid[0]!, id: "vendor/newcomer" }];
    const diff = diffRosterFiles(base, next);
    expect(diff).toContain("+ mid  vendor/newcomer");
    expect(diff).toContain("- mid  openai/gpt-5.6-luna");
    expect(diff).toContain("- mid  deepseek/deepseek-v4.1-flash");
  });

  it("names a price move", () => {
    const next = structuredClone(base);
    next.version = "2026-09-24";
    next.tiers.fast[0] = { ...base.tiers.fast[0]!, outputUsdPerM: 0.2 };
    const diff = diffRosterFiles(base, next);
    expect(diff).toContain("version 2026-09-17 -> 2026-09-24");
    expect(diff).toContain("deepseek/deepseek-v4-flash price $0.07/$0.14 -> $0.07/$0.2 per M");
  });

  it("names a reorder", () => {
    const next = structuredClone(base);
    // Same set of models, rotated, so the diff reports an order change rather
    // than an add and a remove.
    next.tiers.mid = [base.tiers.mid.at(-1)!, ...base.tiers.mid.slice(0, -1)];
    expect(diffRosterFiles(base, next)).toContain("~ mid  order:");
  });
});

describe("scrapeRankingRows", () => {
  it("reads rows out of a bare JSON document", () => {
    const body = JSON.stringify({
      data: { rows: [{ model_permaslug: "a/b", total_tokens: 5 }, { model_permaslug: "c/d", total_tokens: 9 }] },
    });
    expect(scrapeRankingRows(body)).toEqual([
      { model_permaslug: "c/d", total_tokens: 9 },
      { model_permaslug: "a/b", total_tokens: 5 },
    ]);
  });

  it("reads rows embedded in a page, escaped inside a script string", () => {
    const rows = '[{\\"model_permaslug\\":\\"a/b\\",\\"total_tokens\\":5,\\"rank\\":1}]';
    const body = `<!doctype html><script>self.__next_f.push([1,"3:${rows}\\n"])</script>`;
    expect(scrapeRankingRows(body)).toEqual([{ model_permaslug: "a/b", total_tokens: 5 }]);
  });

  it("keeps the largest count when the page repeats a row", () => {
    const body = JSON.stringify([
      { model_permaslug: "a/b", total_tokens: 5 },
      { model_permaslug: "a/b", total_tokens: 11 },
    ]);
    expect(scrapeRankingRows(body)).toEqual([{ model_permaslug: "a/b", total_tokens: 11 }]);
  });

  it("returns nothing when the rows have been renamed, so the caller can fall back", () => {
    expect(scrapeRankingRows('<html><body>{"model_slug":"a/b","tokens":5}</body></html>')).toEqual([]);
  });
});
