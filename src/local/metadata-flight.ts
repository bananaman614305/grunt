import { SourceError } from './source.js';

interface Flight {
  controller: AbortController;
  result: Promise<unknown>;
  waiters: number;
  settled: boolean;
}

/** Share only overlapping metadata reads; settled access evidence is never cached. */
export class MetadataFlights {
  private flights = new Map<string, Flight>();
  private closed = false;
  constructor(private timeoutMs = 5000) {}

  run<T>(key: string, read: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal | null, timeoutMs = this.timeoutMs): Promise<T> {
    caller?.throwIfAborted();
    if (this.closed) return Promise.reject(new SourceError('cancelled', 'Metadata checks stopped'));
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, result: Promise.resolve(), waiters: 0, settled: false };
      const owned = flight;
      const timer = setTimeout(() => controller.abort(new SourceError('timeout', 'Metadata check timed out')), timeoutMs);
      timer.unref();
      const clearDeadline = () => clearTimeout(timer);
      controller.signal.addEventListener('abort', clearDeadline, { once: true });
      owned.result = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); });
      const settled = () => {
        clearDeadline();
        controller.signal.removeEventListener('abort', clearDeadline);
        owned.settled = true;
        if (this.flights.get(key) === owned) this.flights.delete(key);
      };
      // Keep an aborted, uncooperative read in its slot until it really settles.
      // A timeout must not repeatedly launch replacement network requests.
      void owned.result.then(settled, settled);
      this.flights.set(key, owned);
    }
    const shared = flight;
    shared.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (ok: boolean, value: unknown) => {
        if (done) return;
        done = true;
        caller?.removeEventListener('abort', cancelled);
        shared.controller.signal.removeEventListener('abort', stopped);
        shared.waiters--;
        if (!shared.waiters && !shared.settled) shared.controller.abort(new SourceError('cancelled', 'Metadata check has no waiters'));
        if (ok) resolve(value as T); else reject(value);
      };
      const cancelled = () => finish(false, caller!.reason);
      const stopped = () => finish(false, shared.controller.signal.reason);
      caller?.addEventListener('abort', cancelled, { once: true });
      shared.controller.signal.addEventListener('abort', stopped, { once: true });
      void shared.result.then(value => finish(true, value), error => finish(false, error));
      if (caller?.aborted) cancelled();
      else if (shared.controller.signal.aborted) stopped();
    });
  }

  close() {
    this.closed = true;
    for (const flight of this.flights.values()) flight.controller.abort(new SourceError('cancelled', 'Metadata checks stopped'));
  }
}
