import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { disabledAdapters } from "./registry.js";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const redirects = readFileSync(new URL("../site/_redirects", import.meta.url), "utf8");
const headers = readFileSync(new URL("../site/_headers", import.meta.url), "utf8");
const siteWorkflow = readFileSync(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry/adapters.json", import.meta.url), "utf8")) as { adapters: { id: string }[] };
const enabled = registry.adapters.map((a) => a.id).filter((id) => !disabledAdapters.has(id));
const idOf = (name: string) => name.toLowerCase().replace(/\s+/g, "");
const texts = (pattern: RegExp) => [...html.matchAll(pattern)].map((m) => m[1].trim());

describe("grunt.run landing page", () => {
  it("leads with the too-free-to-meter hero", () => {
    const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    expect(h1).toContain('<span class="sr">Intelligence too free to meter.</span>');
  });

  it("ends with only the CTA line, the setup command and the miner", () => {
    const end = html.match(/<section class="cta-end">([\s\S]*?)<\/section>/)?.[1] ?? "";
    expect(end.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .toBe("Put grunt to work on your hardest problems, free of charge. $ npx usegrunt setup COPY");
    expect(end).toContain('data-cmd="npx usegrunt setup"');
    expect(html.indexOf("</section>", html.indexOf('class="cta-end"'))).toBeLessThan(html.indexOf("<footer>"));
  });

  it("names only sources grunt draws from today", () => {
    const named = [
      ...texts(/<div class="tag">([^<]+)<\/div>/g).filter((t) => t !== "YOUR AGENT"),
      ...texts(/<div class="hd"><b>([^<]+)<\/b>/g),
      ...texts(/<div class="src">[\s\S]*?<span>([^<]+)<\/span>/g),
    ];
    const more = named.filter((n) => /^\+ \d+ more$/.test(n));
    const names = named.filter((n) => !more.includes(n));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(enabled, name).toContain(idOf(name));
    const listed = new Set(texts(/<div class="src">[\s\S]*?<span>([^<]+)<\/span>/g).filter((n) => !more.includes(n)).map(idOf));
    expect(more).toEqual([`+ ${enabled.length - listed.size} more`]);
    for (const id of disabledAdapters) expect(html.toLowerCase()).not.toContain(id);
    for (const gone of ["dots", "codex"]) expect(html.toLowerCase()).not.toMatch(new RegExp(`\\b${gone}\\b`));
  });

  it("publishes static registry.json on Cloudflare Pages with a 200 internal rewrite for /v1/registry", () => {
    expect(existsSync(new URL("../site/registry.json", import.meta.url))).toBe(true);
    const redirectLines = redirects.trim().split(/\r?\n/).map((line) => line.trim());
    expect(redirectLines).toContain("/v1/registry /registry.json 200");
    expect(redirectLines.some((line) => /^\/v1\/registry\s+\S+\s+3\d\d$/.test(line))).toBe(false);

    for (const route of ["/registry.json", "/v1/registry"]) {
      const section = headers.split(/\r?\n\r?\n/).find((block) => block.trimStart().startsWith(`${route}\n`));
      expect(section, `missing _headers block for ${route}`).toBeDefined();
      expect(section).toContain("Content-Type: application/json; charset=utf-8");
      expect(section).toContain("Cache-Control: public, max-age=300");
      expect(section).toContain("Access-Control-Allow-Origin: *");
    }

    expect(siteWorkflow).toContain('"registry/adapters.json"');
    expect(siteWorkflow).toContain("src/registry.ts registry/adapters.json");
    expect(siteWorkflow).toContain("cp registry/adapters.json site/registry.json");
    expect(siteWorkflow.indexOf("cp registry/adapters.json site/registry.json"))
      .toBeLessThan(siteWorkflow.indexOf("wrangler@4 pages deploy site"));
  });
});
