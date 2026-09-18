/**
 * The brief compiler (ADR-011): fixed templates, confidence-then-recency
 * ranking, the chars/4 cap, a version that names its inputs, and the strict
 * separation of routing-shaping rows into `routingDefaults`.
 */

import { describe, expect, it } from "vitest";
import {
  BRIEF_CHAR_CAP,
  BRIEF_PREAMBLE,
  BRIEF_TEMPLATES,
  compileBrief,
  effectiveRows,
  routingDefaults,
} from "./brief.js";
import { OUTPUT_SHAPING_FIELDS, PREFERENCE_VALUES } from "./store.js";
import type { PreferenceField, PreferenceRow, PreferenceScope } from "./store.js";

let seq = 0;

function row(
  field: PreferenceField,
  value: string,
  overrides: Partial<Pick<PreferenceRow, "scope" | "confidence" | "version" | "updatedAt">> = {},
): PreferenceRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    keyHash: "a".repeat(64),
    scope: overrides.scope ?? "global",
    field,
    value,
    confidence: overrides.confidence ?? 0.8,
    version: overrides.version ?? 1,
    provenance: "0123456789abcdef",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-18T00:00:00.000Z",
  };
}

describe("templates", () => {
  it("covers every value of every output-shaping field", () => {
    for (const field of OUTPUT_SHAPING_FIELDS) {
      for (const value of PREFERENCE_VALUES[field]) {
        expect(BRIEF_TEMPLATES[field][value]).toBeTypeOf("string");
      }
    }
  });
});

describe("compileBrief", () => {
  it("is deterministic: the same rows compile to the same text and version", () => {
    const rows = [row("verbosity", "concise"), row("testing_depth", "thorough", { confidence: 0.6 })];
    const first = compileBrief(rows);
    const second = compileBrief([...rows].reverse());
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    expect(first?.text.startsWith(BRIEF_PREAMBLE)).toBe(true);
    expect(first?.text).toContain(BRIEF_TEMPLATES.verbosity["concise"]);
    expect(first?.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ranks by confidence, then recency", () => {
    const brief = compileBrief([
      row("testing_depth", "none", { confidence: 0.5 }),
      row("verbosity", "detailed", { confidence: 0.9, updatedAt: "2026-09-18T01:00:00.000Z" }),
      row("format", "bullets", { confidence: 0.9, updatedAt: "2026-09-18T02:00:00.000Z" }),
    ]);
    const lines = brief?.text.split("\n").slice(1) ?? [];
    expect(lines[0]).toContain(BRIEF_TEMPLATES.format["bullets"]); // 0.9, newer
    expect(lines[1]).toContain(BRIEF_TEMPLATES.verbosity["detailed"]); // 0.9, older
    expect(lines[2]).toContain(BRIEF_TEMPLATES.testing_depth["none"]); // 0.5
  });

  it("marks task-scoped rows as such", () => {
    const brief = compileBrief([row("testing_depth", "thorough", { scope: "feature" })]);
    expect(brief?.text).toContain("For feature tasks:");
  });

  it("excludes routing-shaping rows entirely", () => {
    expect(compileBrief([row("posture_default", "low"), row("tier_floor", "mid")])).toBeUndefined();
    const mixed = compileBrief([row("posture_default", "low"), row("verbosity", "concise")]);
    expect(mixed?.text).not.toContain("cheap");
    expect(mixed?.text.split("\n")).toHaveLength(2);
  });

  it("returns undefined for no rows, or a value the templates do not know", () => {
    expect(compileBrief([])).toBeUndefined();
    expect(compileBrief([row("verbosity", "florid" as never)])).toBeUndefined();
  });

  it("caps at 300 tokens (chars/4), dropping the lowest-ranked whole lines", () => {
    // Many task-scoped rows for the same fields: enough lines to overflow.
    const scopes: PreferenceScope[] = [
      "global",
      "chat",
      "edit",
      "feature",
      "debug",
      "research",
      "review",
      "docs",
      "ops",
      "classify",
    ];
    const rows = scopes.flatMap((scope, i) =>
      OUTPUT_SHAPING_FIELDS.map((field) =>
        row(field, PREFERENCE_VALUES[field][2] ?? PREFERENCE_VALUES[field][0] ?? "", {
          scope,
          confidence: 1 - i * 0.05,
        }),
      ),
    );
    const brief = compileBrief(rows);
    expect(brief).toBeDefined();
    expect(brief!.text.length).toBeLessThanOrEqual(BRIEF_CHAR_CAP);
    // The highest-confidence (global) lines survived.
    expect(brief!.text).toContain(BRIEF_TEMPLATES.verbosity["detailed"]);
    // Something was actually dropped, or the cap test is vacuous.
    expect(brief!.text.split("\n").length - 1).toBeLessThan(rows.length);
  });

  it("changes version when a row's value or version changes, not when nothing did", () => {
    const base = [row("verbosity", "concise")];
    const same = compileBrief(base)?.version;
    expect(compileBrief([{ ...base[0]! }])?.version).toBe(same);
    expect(compileBrief([{ ...base[0]!, value: "detailed" }])?.version).not.toBe(same);
    expect(compileBrief([{ ...base[0]!, version: 2 }])?.version).not.toBe(same);
  });
});

describe("effectiveRows and routingDefaults", () => {
  it("lets a task-scoped row beat the global row for the routed task type only", () => {
    const rows = [
      row("posture_default", "balanced"),
      row("posture_default", "quality", { scope: "review" }),
    ];
    expect(routingDefaults(rows, "review").posture).toBe("quality");
    expect(routingDefaults(rows, "edit").posture).toBe("balanced");
    expect(routingDefaults(rows).posture).toBe("balanced");
  });

  it("maps the three routing fields onto typed knobs", () => {
    const defaults = routingDefaults([
      row("posture_default", "low"),
      row("tier_floor", "mid"),
      row("sampling", "off"),
      row("verbosity", "concise"), // output-shaping: ignored here
    ]);
    expect(defaults).toEqual({ posture: "low", tierFloor: "mid", sampling: "off" });
  });

  it("skips a routing row whose value fell outside the vocabulary", () => {
    expect(routingDefaults([row("tier_floor", "hyper" as never)])).toEqual({});
  });

  it("effectiveRows drops rows scoped to other task types", () => {
    const rows = [row("verbosity", "concise", { scope: "docs" })];
    expect(effectiveRows(rows, "edit")).toEqual([]);
    expect(effectiveRows(rows, "docs")).toHaveLength(1);
  });
});
