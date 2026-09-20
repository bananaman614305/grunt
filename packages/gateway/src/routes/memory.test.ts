/**
 * `/v1/memory` over HTTP (ADR-017): the list (decrypted), the delete, the
 * kill-switch PUT, and the key-hash scoping that keeps one caller out of
 * another's facts -- driven through `createGateway` with a fake billing store
 * and a real encryption key, like `billing.test.ts`.
 *
 * With billing (and thus MILO_ENCRYPTION_KEY) configured, fact memory is on;
 * the "disabled" block proves the documented degradation when it is not.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "@milo/billing";
import type { Encryptor } from "@milo/core";
import { createGateway } from "../index.js";
import type { Gateway, GatewayOptions } from "../index.js";
import { createFakeBillingStore } from "../test-support.js";

const KEY = "sk-or-v1-FACTOWNER0123456789abcdef";
const OTHER_KEY = "sk-or-v1-SOMEONEELSE9876543210";
const AUTH = { authorization: `Bearer ${KEY}` };
const OTHER_AUTH = { authorization: `Bearer ${OTHER_KEY}` };
const HASH = createHash("sha256").update(`Bearer ${KEY}`, "utf8").digest("hex");
const PROV = "0123456789abcdef0123456789abcdef";

const silent: NonNullable<GatewayOptions["logger"]> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const noUpstream = (() => {
  throw new Error("unexpected upstream call");
}) as unknown as typeof fetch;

const ENC_KEY = generateEncryptionKey();
// The same envelope the gateway builds internally, for seeding rows in a test.
const enc: Encryptor = {
  encrypt: (p) => encryptSecret(p, ENC_KEY),
  decrypt: (s) => decryptSecret(s, ENC_KEY),
};

async function withBilling(): Promise<Gateway> {
  return createGateway({
    jevApiKey: "jev-test-key",
    fetch: noUpstream,
    logger: silent,
    billing: { store: createFakeBillingStore(), encryptionKey: ENC_KEY },
  });
}

let gateway: Gateway;
afterEach(async () => {
  await gateway.close();
});

describe("GET /v1/memory (billing configured)", () => {
  beforeEach(async () => {
    gateway = await withBilling();
  });

  it("requires a key", async () => {
    expect((await gateway.app.request("/v1/memory")).status).toBe(401);
  });

  it("answers empty with the switch on for a key that stored nothing", async () => {
    const res = await gateway.app.request("/v1/memory", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], settings: { enabled: true } });
  });

  it("lists this caller's facts DECRYPTED, without the key hash, scoped by key", async () => {
    await gateway.log.putFact(HASH, { category: "address", text: "my staging box is 10.2.0.7", provenance: PROV }, enc);

    const res = await gateway.app.request("/v1/memory", { headers: AUTH });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ category: "address", text: "my staging box is 10.2.0.7", provenance: PROV });
    expect(body.data[0]).not.toHaveProperty("keyHash");

    // Another key sees nothing.
    const other = await gateway.app.request("/v1/memory", { headers: OTHER_AUTH });
    expect(((await other.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe("DELETE /v1/memory/:id", () => {
  beforeEach(async () => {
    gateway = await withBilling();
  });

  it("deletes this caller's fact", async () => {
    const row = await gateway.log.putFact(HASH, { category: "other", text: "x", provenance: PROV }, enc);
    const res = await gateway.app.request(`/v1/memory/${row.id}`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: row.id });
    expect(await gateway.log.listFacts(HASH, enc)).toEqual([]);
  });

  it("404s a missing id and someone else's id identically", async () => {
    const row = await gateway.log.putFact(HASH, { category: "other", text: "x", provenance: PROV }, enc);
    const missing = await gateway.app.request("/v1/memory/01NOPE", { method: "DELETE", headers: AUTH });
    const foreign = await gateway.app.request(`/v1/memory/${row.id}`, { method: "DELETE", headers: OTHER_AUTH });
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.text()).toBe(await foreign.text());
    expect(await gateway.log.listFacts(HASH, enc)).toHaveLength(1); // survived the foreign attempt
  });
});

describe("PUT /v1/memory/settings (kill switch)", () => {
  beforeEach(async () => {
    gateway = await withBilling();
  });

  it("flips the per-key switch and reflects it in the list", async () => {
    const off = await gateway.app.request("/v1/memory/settings", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ settings: { enabled: false } });

    const list = await gateway.app.request("/v1/memory", { headers: AUTH });
    expect(((await list.json()) as { settings: unknown }).settings).toEqual({ enabled: false });
    // Another key is unaffected.
    expect((await gateway.log.getFactSettings(HASH.replace(/a/g, "b"))).enabled).toBe(true);
  });

  it("rejects a body without a boolean enabled", async () => {
    const res = await gateway.app.request("/v1/memory/settings", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/memory (no encryption key: degraded to disabled)", () => {
  beforeEach(async () => {
    // No billing -> no encryptionKey -> no fact envelope.
    gateway = await createGateway({ jevApiKey: "jev-test-key", fetch: noUpstream, logger: silent });
  });

  it("answers empty and says disabled", async () => {
    const res = await gateway.app.request("/v1/memory", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], settings: { enabled: true }, disabled: true });
  });
});
