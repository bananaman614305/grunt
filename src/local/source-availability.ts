import { randomUUID } from 'node:crypto';
import { currentDiagnosticContext, withDiagnosticContext } from './diagnostics.js';
import { SourceError } from './source.js';
import type { Source } from './source.js';
import { AVAILABILITY_NEGATIVE_MS, type SourceStatus } from './source-status.js';
export { AVAILABILITY_NEGATIVE_MS } from './source-status.js';

export const AVAILABILITY_POSITIVE_MS = 30000;
export const AVAILABILITY_DEADLINE_MS = 5000;
const MAX_PROBES = 4;

// Admission metadata is not a dispatch authorization. Every selected adapter
// retains its own current consent, model, balance and free-access guards.
export class SourceAvailability {
  private closed = false;
  private active = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private waiting = new Set<() => void>();
  private unsettled = new Set<string>();

  constructor(private observation: SourceStatus, private timeoutMs = AVAILABILITY_DEADLINE_MS) {}

  peek(id: string) {
    return this.observation.routingAvailability(id, AVAILABILITY_POSITIVE_MS, AVAILABILITY_NEGATIVE_MS);
  }

  start(sources: readonly Source[]) {
    if (this.closed) return 0;
    let started = 0;
    for (const source of sources) {
      // Bound foreground admission waits and keep at most one underlying
      // probe per source. A hung probe cannot hide other routes indefinitely.
      if (this.active.size >= MAX_PROBES) break;
      if (this.active.has(source.id) || this.unsettled.has(source.id) || this.peek(source.id) !== undefined) continue;
      this.unsettled.add(source.id);
      started++;
      const controller = new AbortController();
      const parent = currentDiagnosticContext();
      const context = { requestId: randomUUID(), kind: 'diagnostic' as const, ...(parent?.sink ? { sink: parent.sink } : {}) };
      let timer: ReturnType<typeof setTimeout> | undefined, launched = false;
      const guarded: Source = { id: source.id, available: () => {
        // SourceStatus may have received newer negative evidence since peek().
        // Start the real check lazily so a cached denial cannot detach a probe.
        launched = true;
        const raw = withDiagnosticContext(context, () => Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return source.available(controller.signal);
        }));
        void raw.then(() => this.unsettled.delete(source.id), () => this.unsettled.delete(source.id));
        const cancelled = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          timer = setTimeout(() => controller.abort(new SourceError('timeout', 'Source admission metadata timed out')), source.availabilityTimeoutMs ?? this.timeoutMs);
          timer.unref();
        });
        return Promise.race([raw, cancelled]);
      }, complete: source.complete.bind(source) };
      const settled = withDiagnosticContext(context, () => this.observation.available(guarded)).then(() => {}, () => {}).finally(() => {
        clearTimeout(timer);
        if (!launched) this.unsettled.delete(source.id);
        this.active.delete(source.id);
        for (const wake of this.waiting) wake();
      });
      this.active.set(source.id, { controller, settled });
    }
    return started;
  }

  hasPending() { return this.active.size > 0; }

  async changed(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.active.size || this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.waiting.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.waiting.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async close() {
    this.closed = true;
    const running = [...this.active.values()];
    for (const item of running) item.controller.abort(new SourceError('cancelled', 'Source metadata checks stopped'));
    for (const wake of this.waiting) wake();
    await Promise.all(running.map(item => item.settled));
  }
}
