import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER, ROUTED_MODEL_ID, TIERS } from "../index.js";
import type { Roster } from "../types.js";
import { PI_API, PI_API_KEY_ENV, PI_PROVIDER_ID, piModels, piProviderBlock, piSetup } from "./pi.js";

const CUSTOM_ROSTER: Roster = {
  fast: ["custom/fast-cheap"],
  mid: ["openai/gpt-5.6-luna"],
  frontier: ["anthropic/claude-opus-5"],
};

describe("piModels", () => {
  it("lists milo/auto first, then every tier's models in order", () => {
    const models = piModels(DEFAULT_ROSTER);

    expect(models[0].id).toBe(ROUTED_MODEL_ID);
    const afterAuto = models.slice(1).map((m) => m.id);
    const expected = TIERS.flatMap((tier) => DEFAULT_ROSTER[tier]);
    expect(afterAuto).toEqual(expected);
  });

  it("fills real numbers for a default-roster model, generic bounds and no cost for a custom one", () => {
    const models = piModels(CUSTOM_ROSTER);
    const gpt = models.find((m) => m.id === "openai/gpt-5.6-luna");
    const custom = models.find((m) => m.id === "custom/fast-cheap");

    expect(gpt?.contextWindow).toBe(1_050_000);
    expect(gpt?.maxTokens).toBeDefined();
    expect(gpt?.cost).toEqual({ input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 });

    // Milo ships no price for an id it does not ship, so none is invented.
    expect(custom?.contextWindow).toBe(200_000);
    expect(custom?.maxTokens).toBe(128_000);
    expect(custom?.cost).toBeUndefined();

    // milo/auto: present once, first, with a name and no cost.
    const auto = models.filter((m) => m.id === ROUTED_MODEL_ID);
    expect(auto).toHaveLength(1);
    expect(auto[0].name).toBe("Milo (auto-routed)");
    expect(auto[0].cost).toBeUndefined();
  });
});

describe("piProviderBlock", () => {
  it("points at the api base url with the key referenced by env name, never a literal", () => {
    const block = piProviderBlock("http://localhost:8787/v1", CUSTOM_ROSTER);

    expect(block.api).toBe(PI_API);
    expect(block.apiKey).toBe(`$${PI_API_KEY_ENV}`);
    expect(JSON.stringify(block)).not.toContain("sk-");
    expect(block.baseUrl).toBe("http://localhost:8787/v1");
    expect(block.models.map((m) => m.id)).toContain(ROUTED_MODEL_ID);
  });
});

describe("piSetup", () => {
  it("builds the setup document from the origin and the running roster", () => {
    const setup = piSetup("http://milo.test", CUSTOM_ROSTER);

    expect(setup.title).toContain("pi coding agent");
    expect(setup.baseUrl).toBe("http://milo.test");
    expect(setup.apiBaseUrl).toBe("http://milo.test/v1");
    expect(setup.model).toBe(ROUTED_MODEL_ID);
    expect(setup.apiKeyEnv).toBe(PI_API_KEY_ENV);
    expect(setup.providerId).toBe(PI_PROVIDER_ID);
    expect(setup.providers[PI_PROVIDER_ID].baseUrl).toBe("http://milo.test/v1");
    expect(setup.roster).toEqual(CUSTOM_ROSTER);
  });

  it("does not double a trailing slash on the origin", () => {
    expect(piSetup("http://milo.test/", DEFAULT_ROSTER).apiBaseUrl).toBe("http://milo.test/v1");
  });
});