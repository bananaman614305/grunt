export async function fetchBoundedJson(url: string, fetcher: typeof fetch, limitBytes: number, signal?: AbortSignal): Promise<unknown> {
  const combined = signal ? AbortSignal.any([AbortSignal.timeout(4000), signal]) : AbortSignal.timeout(4000);
  const response = await fetcher(url, { signal: combined, redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limitBytes) throw new Error('Response exceeded size bound');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
