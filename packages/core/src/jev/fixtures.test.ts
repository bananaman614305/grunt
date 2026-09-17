import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureFetch, fixtureHash, recordingFetch, type Fixture } from "./fixtures.js";

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
    const hash = fixtureHash("GET", "https://api.typesafe.ai/v1/models", null);
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
    const hash = fixtureHash("POST", "https://api.typesafe.ai/v1/systemone", "{}");
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

    const hash = fixtureHash("GET", "https://api.typesafe.ai/v1/models", null);
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

    const hash = fixtureHash("POST", "https://api.typesafe.ai/v1/systemone", "{}");
    const raw = await readFile(path.join(dir, `${hash}.json`), "utf8");
    expect(raw).not.toContain("super-secret-key");
    expect(raw).not.toContain("authorization");
    const fixture = JSON.parse(raw) as Fixture;
    expect(fixture.request.headers).toEqual({ "content-type": "application/json" });
  });
});
