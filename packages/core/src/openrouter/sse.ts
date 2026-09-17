/**
 * Sniffs the `model` field out of an OpenRouter SSE stream's first chunk
 * without altering or delaying the stream itself. The returned `stream` is
 * a byte-for-byte tee of the input: whatever arrives in the first `read()`
 * is handed to the caller immediately, independent of whether (or how
 * quickly) the parse resolves.
 */
export function teeFirstChunkModel(stream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  model: Promise<string | undefined>;
} {
  const [passthrough, sniff] = stream.tee();

  const model = sniffFirstChunkModel(sniff);
  // Nobody may ever await `model`; don't let that surface as an unhandled rejection.
  model.catch(() => {});

  return { stream: passthrough, model };
}

async function sniffFirstChunkModel(sniff: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = sniff.getReader();
  try {
    const { done, value } = await reader.read();
    if (done || !value || value.byteLength === 0) return undefined;

    const text = new TextDecoder().decode(value);
    for (const rawLine of text.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) continue;

      const data = line.slice("data:".length).trim();
      if (data === "") continue;
      if (data === "[DONE]") return undefined;

      try {
        const parsed = JSON.parse(data) as { model?: unknown };
        return typeof parsed.model === "string" ? parsed.model : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    // Stop consuming the sniff branch; the passthrough branch is unaffected.
    reader.cancel().catch(() => {});
  }
}
