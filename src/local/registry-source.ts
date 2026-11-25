import { DelegatingSource } from './delegating-source.js';
import { scoutRetired } from './routing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { Registry } from '../registry.js';

// Mixed legacy/custom source lists do not use StickyRouter. Keep the current
// registry's revocation boundary around every known source in that path too.
export class RegistrySource extends DelegatingSource {
  constructor(source: Source, private registry: () => Registry) { super(source); }
  private listed() { return this.registry().adapters.some(adapter => adapter.id === this.id && !scoutRetired(adapter)); }
  async available(signal?: AbortSignal) { return this.listed() && await super.available(signal); }
  async healthCheck(signal?: AbortSignal) {
    return this.listed() && await (this.source.healthCheck?.(signal) ?? super.available(signal));
  }
  complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    signal.throwIfAborted();
    if (!this.listed()) throw new SourceError('refused', `${this.id} is not in the current adapter registry`);
    return super.complete(request, signal, output, beforeNativeWork);
  }
}
