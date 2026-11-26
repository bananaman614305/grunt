import { isDeepSeekV41Model } from './free-api.js';

// A provider must acknowledge the pinned model before its completion can be
// attributed to this route. Error payloads and model mismatches stay private.
export function verifiedDeepSeekFetch(fetcher?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (fetcher ?? fetch)(input, init);
    if (response.ok && String(input).endsWith('/chat/completions')) {
      // Streaming SSE responses verify chunk.model incrementally inside FreeApi
      // before any delta is emitted; cloning and buffering them here would break streaming.
      if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
      const result = await response.clone().json() as { model?: unknown };
      if (!isDeepSeekV41Model(result.model)) {
        await response.body?.cancel();
        return new Response(null, { status: 502 });
      }
    }
    return response;
  };
}
