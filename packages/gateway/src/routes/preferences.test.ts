/**
 * `/v1/preferences` over HTTP (ADR-011): the list, the delete, and the
 * key-hash scoping that keeps one caller out of another's rows -- driven
 * through `createGateway` with stub upstreams, like `roster.test.ts`.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreferenceCandidate } from "@milo/core";
import { createGateway } from "../index.js";
import type { Gateway, GatewayOptions } from "../index.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const OTHER_KEY = "sk-or-v1-SOMEONEELSE9876543210fedcba";
const AUTH = { authorization: `Bearer ${KEY}` };
const OTHER_AUTH = { authorization: `Bearer ${OTHER_KEY}` };

const HASH = createHash("sha256").update(`Bearer ${KEY}`, "utf8").digest("hex");
const PROVENANCE = "0123456789abcdef0123456789abcdef";

function candidate(overrides: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    scope: "global",
    field: "verbosity",
    value: "concise",
    confidence: 0.8,
    provenance: PROVENANCE,
    ...overrides,
  };
}

const silent: NonNullable<GatewayOptions["logger"]> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// Nothing under test talks to any upstream.
const noUpstream = (() => {
  throw new Error("unexpected upstream call");
}) as unknown as typeof fetch;

let gateway: Gateway;

beforeEach(async () => {
  gateway = await createGateway({ jevApiKey: "jev-test-key", fetch: noUpstream, logger: silent });
});

afterEach(async () => {
  await gateway.close();
});

describe("GET /v1/preferences", () => {
  it("requires a key like every /v1 route", async () => {
    const res = await gateway.app.request("/v1/preferences");
    expect(res.status).toBe(401);
  });

  it("answers empty, with both switches on, for a key that stored nothing", async () => {
    const res = await gateway.app.request("/v1/preferences", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      settings: { captureEnabled: true, briefEnabled: true },
    });
  });

  it("lists this caller's rows -- with provenance, without the key hash", async () => {
    await gateway.log.upsertPreference(HASH, candidate());
    await gateway.log.upsertPreference(HASH, candidate({ field: "testing_depth", value: "none", confidence: 0.6 }));

    const res = await gateway.app.request("/v1/preferences", { headers: AUTH });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      scope: "global",
      field: "verbosity",
      value: "concise",
      confidence: 0.8,
      version: 1,
      provenance: PROVENANCE,
    });
    expect(body.data[0]).toHaveProperty("id");
    expect(body.data[0]).not.toHaveProperty("keyHash");
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("shows another key nothing", async () => {
    await gateway.log.upsertPreference(HASH, candidate());
    const res = await gateway.app.request("/v1/preferences", { headers: OTHER_AUTH });
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("reflects the per-key switches", async () => {
    await gateway.log.setPreferenceSettings(HASH, { captureEnabled: false });
    const res = await gateway.app.request("/v1/preferences", { headers: AUTH });
    expect(((await res.json()) as { settings: unknown }).settings).toEqual({
      captureEnabled: false,
      briefEnabled: true,
    });
  });
});

describe("DELETE /v1/preferences/:id", () => {
  it("deletes this caller's row", async () => {
    const row = await gateway.log.upsertPreference(HASH, candidate());
    const res = await gateway.app.request(`/v1/preferences/${row.id}`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: row.id });
    expect(await gateway.log.listPreferences(HASH)).toEqual([]);
  });

  it("404s a missing id and someone else's id identically", async () => {
    const row = await gateway.log.upsertPreference(HASH, candidate());

    const missing = await gateway.app.request("/v1/preferences/01NOPE", { method: "DELETE", headers: AUTH });
    const foreign = await gateway.app.request(`/v1/preferences/${row.id}`, {
      method: "DELETE",
      headers: OTHER_AUTH,
    });

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.text()).toBe(await foreign.text());
    // And the row survived the foreign attempt.
    expect(await gateway.log.listPreferences(HASH)).toHaveLength(1);
  });
});
