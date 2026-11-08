/**
 * ADR-031's hard rule, checked in CI: Milo never reads, copies, stores or
 * forwards a Claude or ChatGPT login. It only spawns the official CLIs, which
 * read their own logins. So no source file outside the docs may name the
 * files (or keychain entries) where those CLIs keep their credentials.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Where `codex` and `claude` keep their logins. */
const FORBIDDEN: RegExp[] = [
  /\bauth\.json\b/i, // ~/.codex/auth.json
  /\.credentials\.json\b/i, // ~/.claude/.credentials.json
  /\.claude\.json\b/i, // ~/.claude.json (account and OAuth state)
  /Claude Code-credentials/i, // macOS keychain item
  /\boauthAccount\b/,
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "docs", "coverage", ".milo", "trials", ".codegraph"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|sh|ya?ml|toml)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (SOURCE.test(name) && name !== "pnpm-lock.yaml") out.push(path);
  }
}

describe("no access to subscription logins (ADR-031)", () => {
  it("no source file outside docs names a CLI credential file", () => {
    const files: string[] = [];
    walk(ROOT, files);
    expect(files.length).toBeGreaterThan(50);

    const hits: string[] = [];
    for (const file of files) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${relative(ROOT, file).split(sep).join("/")}: ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
