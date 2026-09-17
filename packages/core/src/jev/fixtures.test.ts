import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureFetch,
  fixtureKeyFor,
  recordingFetch,
  apiPathAndQuery,
  type Fixture,
} from "./fixtures.js";

describe("fixtures", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "jev-fixtures-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fixtureFetch replays a recorded response for a matching request", async () => {
    const fixture: Fixture = {
      request: { method: "GET", url: "https://api.typesafe.ai/v1/models", body: null },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models: [] }),
      },
    };
    const hash = fixtureKeyFor("GET", "https://api.typesafe.ai/v1/models", null);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path.join(dir, `${hash}.json`), JSON.stringify(fixture)),
    );

    const fetchFn = fixtureFetch(dir);
    const response = await fetchFn("https://api.typesafe.ai/v1/models", { method: "GET" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [] });
  });

  it("fixtureFetch throws a clear error naming the hash when no fixture exists", async () => {
    const fetchFn = fixtureFetch(dir);
    const hash = fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", "{}");
    await expect(
      fetchFn("https://api.typesafe.ai/v1/systemone", { method: "POST", body: "{}" }),
    ).rejects.toThrow(new RegExp(hash));
  });

  it("recordingFetch records a miss to disk and replays it on the next call without hitting realFetch again", async () => {
    const realFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fetchFn = recordingFetch(dir, realFetch as unknown as typeof fetch);

    const first = await fetchFn("https://api.typesafe.ai/v1/models", { method: "GET" });
    expect(first.status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1);

    const hash = fixtureKeyFor("GET", "https://api.typesafe.ai/v1/models", null);
    const raw = await readFile(path.join(dir, `${hash}.json`), "utf8");
    const fixture = JSON.parse(raw) as Fixture;
    expect(fixture.response.body).toBe(JSON.stringify({ ok: true }));

    const second = await fetchFn("https://api.typesafe.ai/v1/models", { method: "GET" });
    expect(second.status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1); // second call replayed from disk
  });

  it("recordingFetch never writes the authorization header to disk", async () => {
    const realFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fetchFn = recordingFetch(dir, realFetch as unknown as typeof fetch);

    await fetchFn("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: "Bearer super-secret-key", "content-type": "application/json" },
      body: "{}",
    });

    const hash = fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", "{}");
    const raw = await readFile(path.join(dir, `${hash}.json`), "utf8");
    expect(raw).not.toContain("super-secret-key");
    expect(raw).not.toContain("authorization");
    const fixture = JSON.parse(raw) as Fixture;
    expect(fixture.request.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("fixtureKeyFor is origin-independent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "jev-fixtures-origin-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives the same key for the same request through two different origins", () => {
    // A recording often goes through a key-injecting proxy whose origin is
    // neither stable nor committable; the replay runs against the real API
    // host. Same call, same fixture.
    const body = JSON.stringify({ model: "jev-latest", state: "hi", questions: {} });
    const viaProxy = fixtureKeyFor("POST", "https://proxy.example.test:8443/v1/systemone", body);
    const viaApi = fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", body);
    const viaLocal = fixtureKeyFor("POST", "http://127.0.0.1:9000/v1/systemone", body);

    expect(viaProxy).toBe(viaApi);
    expect(viaLocal).toBe(viaApi);
  });

  it("also ignores a proxy's path prefix, where the grant id actually lives", () => {
    // An egress grant serves Jev under /v1/egress/<grant-id>/, so dropping
    // only the origin is not enough -- and a grant id must never end up in a
    // committed filename.
    const body = JSON.stringify({ model: "jev-latest", state: "hi", questions: {} });
    const viaGrant = fixtureKeyFor(
      "POST",
      "https://proxy.example.test/v1/egress/g_55825d9a0f80e719d04c25c3/v1/systemone",
      body,
    );
    const viaApi = fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", body);

    expect(viaGrant).toBe(viaApi);
  });

  it("reduces a mounted path to the API-relative one", () => {
    expect(apiPathAndQuery("https://proxy.example.test/v1/egress/g_abc/v1/systemone")).toBe("/v1/systemone");
    expect(apiPathAndQuery("https://proxy.example.test/proxy/v1/models?x=1")).toBe("/v1/models?x=1");
    // Nothing to anchor on: used as written rather than mangled.
    expect(apiPathAndQuery("https://api.typesafe.ai/healthz")).toBe("/healthz");
  });

  it("still separates different paths, queries, methods and bodies", () => {
    const base = fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", "{}");
    expect(fixtureKeyFor("POST", "https://api.typesafe.ai/v1/models", "{}")).not.toBe(base);
    expect(fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone?trace=1", "{}")).not.toBe(base);
    expect(fixtureKeyFor("GET", "https://api.typesafe.ai/v1/systemone", "{}")).not.toBe(base);
    expect(fixtureKeyFor("POST", "https://api.typesafe.ai/v1/systemone", '{"a":1}')).not.toBe(base);
  });

  it("reads the path and query without the origin", () => {
    expect(apiPathAndQuery("https://api.typesafe.ai/v1/systemone")).toBe("/v1/systemone");
    expect(apiPathAndQuery("https://api.typesafe.ai:443/v1/models?x=1&y=2")).toBe("/v1/models?x=1&y=2");
    // A value that is not a URL at all is used as written rather than thrown.
    expect(apiPathAndQuery("/v1/systemone")).toBe("/v1/systemone");
  });

  it("replays a fixture recorded through a proxy against the real host", async () => {
    const realFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await recordingFetch(dir, realFetch as unknown as typeof fetch)(
      "https://grant-abc123.example.test/v1/systemone",
      { method: "POST", body: "{}" },
    );
    expect(realFetch).toHaveBeenCalledTimes(1);

    // No base-URL pinning needed for the replay to find it.
    const replayed = await fixtureFetch(dir)("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      body: "{}",
    });
    await expect(replayed.json()).resolves.toEqual({ ok: true });
  });

  it("keeps the full recorded URL in the fixture file for tracing", async () => {
    const realFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await recordingFetch(dir, realFetch as unknown as typeof fetch)(
      "https://grant-abc123.example.test/v1/systemone",
      { method: "POST", body: "{}" },
    );

    const key = fixtureKeyFor("POST", "/v1/systemone", "{}");
    const fixture = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")) as Fixture;
    expect(fixture.request.url).toBe("https://grant-abc123.example.test/v1/systemone");
  });
});
