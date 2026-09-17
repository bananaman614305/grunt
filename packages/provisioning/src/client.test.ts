import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvisioningClient, ProvisioningError } from "./client.js";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const RAW_KEY = {
  hash: "hash_abc",
  name: "milo-acct_1",
  label: "milo-acct_1",
  disabled: false,
  limit: 12.34,
  limit_remaining: 12.34,
  usage: 0,
  created_at: "2026-09-17T00:00:00.000Z",
  updated_at: "2026-09-17T00:00:00.000Z",
};

describe("OpenRouterProvisioningClient", () => {
  it("requires a provisioning key", () => {
    const prevEnv = process.env.OPENROUTER_PROVISIONING_KEY;
    delete process.env.OPENROUTER_PROVISIONING_KEY;
    try {
      expect(() => new OpenRouterProvisioningClient({ fetch: vi.fn() })).toThrow(ProvisioningError);
    } finally {
      if (prevEnv !== undefined) process.env.OPENROUTER_PROVISIONING_KEY = prevEnv;
    }
  });

  it("createKey sends the right method, path, body, and auth header, and never returns the key twice", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys");
      expect(init.method).toBe("POST");
      const headers = init.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer prov_secret_123");
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({ name: "milo-acct_1", limit: 12.34 });
      return jsonResponse(201, { key: "sk-or-v1-plaintext", data: RAW_KEY });
    });

    const client = new OpenRouterProvisioningClient({ provisioningKey: "prov_secret_123", fetch: fetchMock as unknown as typeof fetch });
    const result = await client.createKey({ name: "milo-acct_1", limitUsd: 12.34 });

    expect(result).toEqual({ key: "sk-or-v1-plaintext", hash: "hash_abc", id: "hash_abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getKey reads usage and limit from the key hash path", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/hash_abc");
      expect(init.method).toBe("GET");
      return jsonResponse(200, { data: { ...RAW_KEY, usage: 3.5, limit_remaining: 8.84 } });
    });
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const info = await client.getKey("hash_abc");
    expect(info.usageUsd).toBe(3.5);
    expect(info.limitUsd).toBe(12.34);
    expect(info.limitRemainingUsd).toBe(8.84);
    expect(info.disabled).toBe(false);
  });

  it("updateKey PATCHes only the given fields", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/hash_abc");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ disabled: true });
      return jsonResponse(200, { data: { ...RAW_KEY, disabled: true } });
    });
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const info = await client.updateKey("hash_abc", { disabled: true });
    expect(info.disabled).toBe(true);
  });

  it("deleteKey DELETEs the key hash path", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/hash_abc");
      expect(init.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    await expect(client.deleteKey("hash_abc")).resolves.toBeUndefined();
  });

  it("listKeys returns the data array", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys");
      return jsonResponse(200, { data: [RAW_KEY, { ...RAW_KEY, hash: "hash_def" }] });
    });
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const keys = await client.listKeys();
    expect(keys.map((k) => k.hash)).toEqual(["hash_abc", "hash_def"]);
  });

  it("getCredits returns Milo's own account balance", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://openrouter.ai/api/v1/credits");
      return jsonResponse(200, { data: { total_credits: 100.5, total_usage: 25.75 } });
    });
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const credits = await client.getCredits();
    expect(credits).toEqual({ totalCreditsUsd: 100.5, totalUsageUsd: 25.75, balanceUsd: 74.75 });
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, { error: "rate limited" }, { "retry-after": "0" });
      }
      return jsonResponse(200, { data: RAW_KEY });
    });
    const client = new OpenRouterProvisioningClient({
      provisioningKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });

    const info = await client.getKey("hash_abc");
    expect(info.hash).toBe("hash_abc");
    expect(calls).toBe(2);
  });

  it("retries on 5xx up to maxRetries, then throws a typed ProvisioningError", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "down" }, { "x-request-id": "req_1" }));
    const client = new OpenRouterProvisioningClient({
      provisioningKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseMs: 1,
    });

    await expect(client.getKey("hash_abc")).rejects.toMatchObject({
      name: "ProvisioningError",
      status: 503,
      requestId: "req_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry a non-retryable 4xx", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { error: "not found" }));
    const client = new OpenRouterProvisioningClient({ provisioningKey: "k", fetch: fetchMock as unknown as typeof fetch });

    await expect(client.getKey("missing")).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
