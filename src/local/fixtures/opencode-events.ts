// An idle SSE subscription for tests that exercise other OpenCode behavior.
export function idleEvents() {
  return new Response(new ReadableStream<Uint8Array>(), { headers: { 'Content-Type': 'text/event-stream' } });
}
