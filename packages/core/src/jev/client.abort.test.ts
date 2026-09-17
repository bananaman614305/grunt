import { describe, expect, it } from "vitest";
import { JevClient, JevError } from "./client.js";

/** A fetch that never answers and rejects with AbortError when its signal fires. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const fail = (): void => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail);
  });

describe("JevClient abort classification", () => {
  it("reports a caller AbortSignal.timeout as a timeout, not a network failure", async () => {
    const client = new JevClient({ apiKey: "k", fetch: hangingFetch, timeoutMs: 5_000, retries: 0 });
    const err = await client
      .systemone({ state: "x", questions: { q: { type: "noul" } } }, { signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe("timeout");
  });

  it("reports a plain caller abort as a network failure", async () => {
    const client = new JevClient({ apiKey: "k", fetch: hangingFetch, timeoutMs: 5_000, retries: 0 });
    const controller = new AbortController();
    const pending = client.systemone({ state: "x", questions: { q: { type: "noul" } } }, { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as JevError).kind).toBe("network");
  });
});
