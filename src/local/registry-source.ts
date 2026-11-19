import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { Registry } from '../registry.js';

// Mixed legacy/custom source lists do not use StickyRouter. Keep the current
// registry's revocation boundary around every known source in that path too.
export class RegistrySource implements Source {
  readonly id: string;
  readonly supportsFunctionTools?: boolean;
  readonly acceptsRequest?: NonNullable<Source['acceptsRequest']>;
  constructor(readonly source: Source, private registry: () => Registry) {
    this.id = source.id;
    if (source.acceptsRequest) this.acceptsRequest = source.acceptsRequest.bind(source);
    if (source.supportsFunctionTools !== undefined) this.supportsFunctionTools = source.supportsFunctionTools;
  }
  private listed() { return this.registry().adapters.some(adapter => adapter.id === this.id); }
  async available() { return this.listed() && await this.source.available(); }
  quotaWindow() { return this.source.quotaWindow?.(); }
  sellerQuota() { return this.source.sellerQuota?.(); }
  async healthCheck() { return this.listed() && await (this.source.healthCheck?.() ?? this.source.available()); }
  complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.listed()) throw new SourceError('refused', `${this.id} is not in the current adapter registry`);
    return this.source.complete(request, signal);
  }
  async close() { await this.source.close?.(); }
}
