import { readDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

// Every request rechecks the policy receipt, including requests made with an
// existing grant. A daemon cannot silently keep sharing after approval changes.
export class ConsentSource implements Source {
  readonly id: string;
  readonly supportsFunctionTools?: boolean;
  constructor(readonly source: Source, private directory: string) {
    this.id = source.id;
    if (source.supportsFunctionTools !== undefined) this.supportsFunctionTools = source.supportsFunctionTools;
  }
  private async approved() { return (await readDataSharingConsent(this.directory, [this.id])).includes(this.id); }
  async available() { return await this.approved() && await this.source.available(); }
  quotaWindow() { return this.source.quotaWindow?.(); }
  async healthCheck() { return await this.approved() && await (this.source.healthCheck?.() ?? this.source.available()); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', `${this.id} data sharing is not approved; rerun usegrunt setup`);
    return this.source.complete(request, signal);
  }
  async close() { await this.source.close?.(); }
}
