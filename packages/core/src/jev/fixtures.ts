/**
 * Fixture recorder/replayer for `JevClient` tests. Fixtures are looked up by
 * a stable SHA-256 of `method + API-relative path + body`, so a client call
 * reproduces the same fixture file every run. Never records the
 * `authorization` header.
 *
 * The key deliberately leaves out everything about the front door the call
 * went through: the scheme, host, port, *and* any path prefix the API was
 * mounted under. A recording session usually goes through a key-injecting
 * proxy -- a Squire egress grant serves Jev at
 * `https://<proxy-host>/v1/egress/<grant-id>/v1/systemone` -- while a replay
 * runs against `https://api.typesafe.ai/v1/systemone`. Hashing the whole URL
 * made those two disagree, so a replay only worked when `JEV_BASE_URL` was
 * pinned to the exact proxy address the recording used, which is why CI
 * carried a grant URL in its environment. Worse, that prefix carries a grant
 * id, which has no business being baked into a committed filename.
 *
 * What identifies a Jev call is the endpoint and the body, not the route
 * taken to reach it, so that is what the key hashes. The full `request.url`
 * is still written into the fixture file, unhashed, so a recording can be
 * traced back to where it came from.
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

/** Every Jev route lives under this segment, which is what anchors the path. */
const API_ROOT_SEGMENT = "/v1/";

/**
 * The API-relative part of a URL: the endpoint path plus query string, with
 * no scheme, host, port, or proxy prefix.
 *
 * Jev's own routes all sit directly under `/v1/`, so the API-relative path
 * starts at the *last* `/v1/` segment. That is what drops a proxy mount
 * point: `/v1/egress/<grant-id>/v1/systemone` and `/v1/systemone` both
 * reduce to `/v1/systemone`, so a fixture recorded through an egress grant
 * replays against the real host, and the grant id never reaches a filename.
 *
 * A URL that does not parse (a bare path, say) is handled the same way, so a
 * caller that already passes a path still keys stably.
 */
export function apiPathAndQuery(url: string): string {
  let pathname: string;
  let search: string;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    const queryAt = url.indexOf("?");
    pathname = queryAt === -1 ? url : url.slice(0, queryAt);
    search = queryAt === -1 ? "" : url.slice(queryAt);
  }

  const mount = pathname.lastIndexOf(API_ROOT_SEGMENT);
  const endpoint = mount === -1 ? pathname : pathname.slice(mount);
  return `${endpoint}${search}`;
}

/**
 * The fixture lookup key: SHA-256 of `method + API-relative path + body`,
 * hex-encoded. Stable across runs, origins, and proxy mount points, so a
 * fixture recorded through an egress proxy replays against the real API host
 * and vice versa.
 */
export function fixtureKeyFor(method: string, url: string, body: string | null): string {
  const hash = createHash("sha256");
  hash.update(method.toUpperCase());
  hash.update("\n");
  hash.update(apiPathAndQuery(url));
  hash.update("\n");
  hash.update(body ?? "");
  return hash.digest("hex");
}

function fixtureFile(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

function toResponse(fixture: Fixture): Response {
  return new Response(fixture.response.body, {
    status: fixture.response.status,
    headers: fixture.response.headers,
  });
}

/**
 * Returns a `fetch`-compatible function that replays a recorded fixture from
 * `dir`, matched by `fixtureKeyFor`. Throws (naming the expected key and
 * file) when no fixture exists for a request.
 */
export function fixtureFetch(dir: string): typeof fetch {
  const impl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const url = requestUrl(input);
    const body = requestBody(init);
    const key = fixtureKeyFor(method, url, body);
    const file = fixtureFile(dir, key);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error(
        `no fixture recorded for ${method} ${apiPathAndQuery(url)} (key ${key}); expected file ${file}`,
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
    const key = fixtureKeyFor(method, url, body);
    const file = fixtureFile(dir, key);

    try {
      const raw = await readFile(file, "utf8");
      return toResponse(JSON.parse(raw) as Fixture);
    } catch {
      // No fixture yet; fall through and record one.
    }

    const response = await realFetch(input, init);
    const bodyText = await response.clone().text();
    const fixture: Fixture = {
      // `url` is the full URL as sent, origin included: it is reference
      // material for tracing a recording, not part of the lookup key.
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
