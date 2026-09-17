import { describe, expect, it } from "vitest";
import { proxiedSdkOptions } from "./client.js";

describe("proxiedSdkOptions", () => {
  it("is empty without a base", () => {
    expect(proxiedSdkOptions(undefined)).toEqual({});
  });

  it("points the SDK at the proxy host and prefixes the API path", async () => {
    const opts = proxiedSdkOptions("https://vault.example.test/v1/egress/g_abc");
    expect(opts.host).toBe("vault.example.test");
    expect(opts.protocol).toBe("https");
    expect(opts.httpClient).toBeDefined();
  });
});
