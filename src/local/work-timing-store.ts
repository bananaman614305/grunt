import { DiagnosticsStore } from './diagnostics.js';
import type { DiagnosticEvent } from './diagnostics.js';
import { installedRuntimeVersion } from './runtime-version.js';
import { createWorkTimingObserver } from './work-timing.js';

/** Private, lazy, bounded observation. No storage is opened for an unused observer. */
export function runtimeWorkTiming(directory: string) {
  let pending: Promise<DiagnosticsStore> | undefined;
  let store: DiagnosticsStore | undefined;
  let bufferLoss = 0;
  let queued = 0, closed = false;
  const writes = new Set<Promise<void>>();
  const runtimeVersion = installedRuntimeVersion();
  const timing = createWorkTimingObserver({ sink: { record(event: DiagnosticEvent) {
    if (closed) return;
    if (queued >= 1000) { bufferLoss++; return; }
    queued++;
    pending ??= DiagnosticsStore.open({ directory, ...(runtimeVersion ? { runtimeVersion } : {}) });
    const write = pending.then(value => {
      store = value;
      if (bufferLoss) { value.recordDropped(bufferLoss); bufferLoss = 0; }
      value.record(event);
    }).catch(() => { bufferLoss++; /* Observation cannot change work. */ }).finally(() => { queued--; writes.delete(write); });
    writes.add(write);
  } }, ...(runtimeVersion ? { runtimeVersion } : {}) });
  return { timing, health() {
    return { queued, droppedEvents: bufferLoss + (store?.health().droppedEvents ?? 0), available: store?.health().available ?? null, closed };
  }, async close() {
    closed = true;
    await Promise.allSettled([...writes]);
    if (pending) await pending.then(async value => {
      if (bufferLoss) { value.recordDropped(bufferLoss); bufferLoss = 0; }
      await value.close();
    }).catch(() => {});
  } };
}
