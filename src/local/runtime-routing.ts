import { RoutingHistory } from './routing-history.js';
import type { Sources } from './source.js';

/** Optional private observations never replace an adapter's live access guards. */
export function createRuntimeRoutingHistory(
  sources: Pick<Sources, 'setRoutingHistory' | 'flushRoutingHistory'>,
  options: { directory: string; notify?: (message: string) => void; open?: (directory: string) => Promise<RoutingHistory> }
) {
  let store: RoutingHistory | undefined;
  let closing: Promise<void> | undefined;
  const ready = (options.open ?? RoutingHistory.open)(options.directory).then(async history => {
    store = history;
    await sources.setRoutingHistory(history);
  }).catch(async () => {
    // An unavailable optimization must not strand an otherwise usable free pool.
    await store?.close().catch(() => {});
    store = undefined;
    try { options.notify?.('Routing history is unavailable; using current-session observations.'); } catch { /* Advisory only. */ }
  });
  return {
    ready,
    close: () => closing ??= ready.then(async () => {
      await sources.flushRoutingHistory();
      await store?.close();
    })
  };
}
