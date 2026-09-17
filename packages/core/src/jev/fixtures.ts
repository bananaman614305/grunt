/**
 * Fixture recorder/replayer for `JevClient` tests. Fixtures are looked up by
 * a stable SHA-256 of `method + url + body`, so a client call reproduces the
 * same fixture file every run. Never records the `authorization` header.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type FixtureRequest = {
  method: string;
  url: string;
  body: string | null;
  headers?: Record<string, string>;
};

export type FixtureResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type Fixture = {
  request: FixtureRequest;
  response: FixtureResponse;
};

/** Headers stripped from a stored response because they describe a transfer
 * encoding for a body we already decoded to text, not the payload itself. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

type FetchInput = string | URL | Request;

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  throw new Error("fixtureFetch/recordingFetch only support string request bodies");
}

function headerEntries(headers: RequestInit["headers"] | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      out.push([pair[0] ?? "", pair[1] ?? ""]);
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out.push([key, typeof value === "string" ? value : value.join(", ")]);
  }
  return out;
}

function requestHeadersWithoutAuth(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headerEntries(init?.headers)) {
    if (key.toLowerCase() === "authorization") continue;
    out[key] = value;
  }
  return out;
}

function responseHeadersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    out[key] = value;
  });
  return out;
}

/** SHA-256 of `method + url + body`, hex-encoded. Stable across runs. */
export function fixtureHash(method: string, url: string, body: string | null): string {
  const hash = createHash("sha256");
  hash.update(method.toUpperCase());
  hash.update("\n");
  hash.update(url);
  hash.update("\n");
  hash.update(body ?? "");
  return hash.digest("hex");
}

function fixtureFile(dir: string, hash: string): string {
  return path.join(dir, `${hash}.json`);
}

function toResponse(fixture: Fixture): Response {
  return new Response(fixture.response.body, {
    status: fixture.response.status,
    headers: fixture.response.headers,
  });
}

/**
 * Returns a `fetch`-compatible function that replays a recorded fixture from
 * `dir`, matched by a hash of method + url + body. Throws (naming the
 * expected hash and file) when no fixture exists for a request.
 */
export function fixtureFetch(dir: string): typeof fetch {
  const impl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const url = requestUrl(input);
    const body = requestBody(init);
    const hash = fixtureHash(method, url, body);
    const file = fixtureFile(dir, hash);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error(
        `no fixture recorded for ${method} ${url} (hash ${hash}); expected file ${file}`,
      );
    }
    const fixture = JSON.parse(raw) as Fixture;
    return toResponse(fixture);
  };
  return impl as typeof fetch;
}

/**
 * Returns a `fetch`-compatible function that replays a fixture from `dir`
 * when one exists, and otherwise calls `realFetch`, records the exchange to
 * `dir`, and returns the real response. The `authorization` request header
 * is never written to disk.
 */
export function recordingFetch(dir: string, realFetch: typeof fetch): typeof fetch {
  const impl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const url = requestUrl(input);
    const body = requestBody(init);
    const hash = fixtureHash(method, url, body);
    const file = fixtureFile(dir, hash);

    try {
      const raw = await readFile(file, "utf8");
      return toResponse(JSON.parse(raw) as Fixture);
    } catch {
      // No fixture yet; fall through and record one.
    }

    const response = await realFetch(input, init);
    const bodyText = await response.clone().text();
    const fixture: Fixture = {
      request: { method, url, body, headers: requestHeadersWithoutAuth(init) },
      response: {
        status: response.status,
        headers: responseHeadersRecord(response.headers),
        body: bodyText,
      },
    };
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    return response;
  };
  return impl as typeof fetch;
}
