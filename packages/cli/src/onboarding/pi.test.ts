import { describe, expect, it } from "vitest";
import { PI_API_KEY_ENV, PI_PROVIDER_ID } from "@milo/core";
import { enablePi, nextSteps, parseJsonObject, renderAuth, statusPi } from "./pi.js";

const EXISTING = `{
  "default": "deepseek/deepseek-v4-pro",
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.example/v1",
      "api": "openai-completions",
      "apiKey": "abc",
      "models": [{ "id": "deepseek/deepseek-v4-pro" }]
    }
  }
}
`;

describe("onboarding pi harness", () => {
  it("merges the milo provider additively, keeping every other provider and the default", () => {
    const next = enablePi(EXISTING, { gatewayRoot: "http://127.0.0.1:9090" });
    const parsed = JSON.parse(next) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;

    // The user's default model and every existing provider survive untouched.
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    expect(providers.openrouter).toEqual({
      name: "OpenRouter",
      baseUrl: "https://openrouter.example/v1",
      api: "openai-completions",
      apiKey: "abc",
      models: [{ id: "deepseek/deepseek-v4-pro" }],
    });

    // The milo provider is the shared pi shape from @milo/core, keyed by
    // environment-variable name instead of a literal.
    const milo = providers[PI_PROVIDER_ID] as Record<string, unknown>;
    expect(milo.baseUrl).toBe("http://127.0.0.1:9090/v1");
    expect(milo.api).toBe("openai-completions");
    expect(milo.apiKey).toBe(`$${PI_API_KEY_ENV}`);
    const models = milo.models as Array<{ id: string }>;
    expect(models[0]?.id).toBe("milo/auto");
    expect(models).toContainEqual(expect.objectContaining({ id: "milo/auto" }));
  });

  it("updates an existing milo provider in place without touching the rest", () => {
    const withMilo = enablePi(EXISTING, { gatewayRoot: "http://a.example" });
    const next = enablePi(withMilo, { gatewayRoot: "http://b.example" });
    const parsed = JSON.parse(next) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    expect((providers.openrouter as { baseUrl: string }).baseUrl).toBe("https://openrouter.example/v1");
    expect((providers[PI_PROVIDER_ID] as { baseUrl: string }).baseUrl).toBe("http://b.example/v1");
  });

  it("scaffolds a document with only the milo provider when nothing exists", () => {
    const next = enablePi(undefined, { gatewayRoot: "https://milo-gateway.fly.dev" });
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(Object.keys(parsed.providers as Record<string, unknown>)).toEqual([PI_PROVIDER_ID]);
    expect(parsed.default).toBeUndefined();
  });

  it("reports enabled only when a milo provider with a baseUrl is present", () => {
    expect(statusPi(EXISTING).enabled).toBe(false);
    expect(statusPi(enablePi(EXISTING, { gatewayRoot: "http://127.0.0.1:9090" }))).toEqual({
      enabled: true,
      gateway: "http://127.0.0.1:9090/v1",
      model: "milo/auto",
    });
    expect(statusPi(undefined).enabled).toBe(false);
  });

  it("renders the key store additively under the milo provider id, as pi's api_key credential object", () => {
    // pi's auth.json (core/auth-storage.js) requires each provider's
    // credential to be an object: { type: "api_key", key }. A bare string
    // makes pi reject the file and hides the provider's models.
    expect(JSON.parse(renderAuth(undefined, "sk-or-1"))).toEqual({ [PI_PROVIDER_ID]: { type: "api_key", key: "sk-or-1" } });
    expect(JSON.parse(renderAuth(JSON.stringify({ openrouter: "sk-other" }), "sk-or-1"))).toEqual({
      openrouter: "sk-other",
      [PI_PROVIDER_ID]: { type: "api_key", key: "sk-or-1" },
    });
  });

  it("tells the user the default was left alone and how the key is read", () => {
    const steps = nextSteps({ gatewayRoot: "http://127.0.0.1:9090" });
    expect(steps.join("\n")).toContain('pick milo/auto in pi\'s /model');
    expect(steps.join("\n")).toContain("$OPENROUTER_API_KEY");
  });

  it("treats a missing or empty file as an empty document", () => {
    expect(parseJsonObject(undefined)).toEqual({});
    expect(parseJsonObject("")).toEqual({});
    expect(parseJsonObject("   \n")).toEqual({});
  });

  it("emits pi-valid model objects: every models entry is an object with a string id (regression: usemilo 0.3.0 wrote a string array)", () => {
    // usemilo 0.3.0 wrote `models: ["milo/auto"]` -- an array of strings --
    // which pi rejects when loading models.json: `pi --list-models milo`
    // fails with "providers.milo.models.0: must be object". The merged
    // document must keep pi's schema: a `models` array of objects, each with
    // a string `id`, and no legacy keys on the provider block.
    const next = enablePi(undefined, { gatewayRoot: "https://milo-gateway.fly.dev" });
    const parsed = JSON.parse(next) as { providers: Record<string, unknown> };
    const milo = parsed.providers[PI_PROVIDER_ID] as {
      baseUrl: string;
      api: string;
      apiKey: string;
      models: unknown;
    };

    expect(milo.baseUrl).toBe("https://milo-gateway.fly.dev/v1");
    expect(milo.api).toBe("openai-completions");
    expect(milo.apiKey).toBe(`$${PI_API_KEY_ENV}`);
    expect(Array.isArray(milo.models)).toBe(true);
    expect(milo.models.length).toBeGreaterThan(0);
    for (const entry of milo.models as unknown[]) {
      // pi's schema (docs/models.md): each model is an object, `id` required.
      expect(typeof entry).toBe("object");
      expect(entry).not.toBeNull();
      expect(typeof (entry as { id?: unknown }).id).toBe("string");
    }
    expect((milo.models as Array<{ id: string }>)[0]?.id).toBe("milo/auto");

    // The routed entry carries the room-verified known-good values: id
    // milo/auto, reasoning false, contextWindow 128000, maxTokens 32000.
    const auto = (milo.models as Array<{
      id: string;
      name?: string;
      reasoning?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>)[0];
    expect(auto).toMatchObject({
      id: "milo/auto",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 32_000,
    });

    // No legacy usemilo-0.3.0 keys (type/base_url/api_key_env) may leak in.
    const flat = milo as unknown as Record<string, unknown>;
    expect(flat["type"]).toBeUndefined();
    expect(flat["base_url"]).toBeUndefined();
    expect(flat["api_key_env"]).toBeUndefined();
  });
});