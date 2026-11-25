import { DelegatingSource } from './delegating-source.js';
import { readDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

// Every request rechecks the policy receipt, including requests made with an
// existing grant. A daemon cannot silently keep sharing after approval changes.
export class ConsentSource extends DelegatingSource {
  constructor(source: Source, private directory: string) { super(source); }
  private async approved() { return (await readDataSharingConsent(this.directory, [this.id])).includes(this.id); }
  async available(signal?: AbortSignal) { return await this.approved() && await super.available(signal); }
  async healthCheck(signal?: AbortSignal) {
    if (!await this.approved()) return false;
    signal?.throwIfAborted();
    return await (this.source.healthCheck?.(signal) ?? super.available(signal));
  }
  async complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', `${this.id} data sharing is not approved; rerun usegrunt setup`);
    return super.complete(request, signal, output, beforeNativeWork);
  }
}
