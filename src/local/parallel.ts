// Limit browser/build pressure as the vetted catalog grows. Wait for started
// jobs before rejecting so callers can safely close shared resources.
export async function parallelMap<T, R>(items: readonly T[], task: (item: T) => Promise<R>, limit = 4, signal?: AbortSignal): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}
