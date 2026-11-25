import type { ModelRequest, Source, SourceError } from './source.js';

/** Preserve adapter capabilities when adding a guard around dispatch. */
export class DelegatingSource implements Source {
  readonly acceptsRequest?: NonNullable<Source['acceptsRequest']>;

  constructor(readonly source: Source) {
    if (source.acceptsRequest) this.acceptsRequest = source.acceptsRequest.bind(source);
  }

  get id() { return this.source.id; }
  get supportsFunctionTools() { return this.source.supportsFunctionTools ?? false; }
  get inferenceOnly() { return this.source.inferenceOnly ?? false; }
  get reportsOutput() { return this.source.reportsOutput ?? false; }
  get reportsProgress() { return this.source.reportsProgress ?? false; }
  get firstOutputMs() { return this.source.firstOutputMs; }
  get idleMs() { return this.source.idleMs; }
  get availabilityTimeoutMs() { return this.source.availabilityTimeoutMs; }
  get slowUpstream() { return this.source.slowUpstream; }

  available(signal?: AbortSignal) { return this.source.available(signal); }
  quotaWindow() { return this.source.quotaWindow?.(); }
  sellerQuota() { return this.source.sellerQuota?.(); }
  failed(error: SourceError) { this.source.failed?.(error); }

  complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    signal.throwIfAborted();
    return this.source.complete(request, signal, output, beforeNativeWork);
  }

  async close() { await this.source.close?.(); }
}
