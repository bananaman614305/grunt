import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { disabledAdapters } from "./registry.js";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const cname = readFileSync(new URL("../site/CNAME", import.meta.url), "utf8");
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

  it("publishes static site, registry.json, and v1/registry to GitHub Pages without Cloudflare secrets", () => {
    expect(existsSync(new URL("../site/registry.json", import.meta.url))).toBe(true);
    expect(cname.trim()).toBe("grunt.run");
    expect(existsSync(new URL("../site/_redirects", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../site/_headers", import.meta.url))).toBe(false);

    expect(siteWorkflow).toContain('"site/**"');
    expect(siteWorkflow).toContain('"registry/adapters.json"');
    expect(siteWorkflow).toContain('".github/workflows/site.yml"');
    expect(siteWorkflow).toContain("contents: read");
    expect(siteWorkflow).toContain("pages: write");
    expect(siteWorkflow).toContain("id-token: write");
    expect(siteWorkflow).toContain("name: github-pages");
    expect(siteWorkflow).toContain("url: ${{ steps.deployment.outputs.page_url }}");
    expect(siteWorkflow).toContain("src/registry.ts registry/adapters.json");
    expect(siteWorkflow).toContain("src/registry.ts registry/adapters.json --publish dist/site/registry.json");
    expect(siteWorkflow).toContain("dist/site/v1/registry");
    expect(siteWorkflow).toContain("dist/site/.nojekyll");
    expect(siteWorkflow).toContain("site/CNAME");
    expect(siteWorkflow).toContain("site/favicon.svg");
    expect(siteWorkflow).toContain("actions/configure-pages@");
    expect(siteWorkflow).toContain("actions/upload-pages-artifact@");
    expect(siteWorkflow).toContain("include-hidden-files: true");
    expect(siteWorkflow).toContain("actions/deploy-pages@");

    const publishIndex = siteWorkflow.indexOf("src/registry.ts registry/adapters.json --publish dist/site/registry.json");
    const legacyCopyIndex = siteWorkflow.indexOf("cp dist/site/registry.json dist/site/v1/registry");
    const uploadIndex = siteWorkflow.indexOf("actions/upload-pages-artifact@");
    const deployIndex = siteWorkflow.indexOf("actions/deploy-pages@");
    expect(publishIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeLessThan(legacyCopyIndex);
    expect(legacyCopyIndex).toBeLessThan(uploadIndex);
    expect(uploadIndex).toBeLessThan(deployIndex);

    for (const forbidden of ["wrangler", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_PAGES_PROJECT"]) {
      expect(siteWorkflow).not.toContain(forbidden);
    }
  });
});
