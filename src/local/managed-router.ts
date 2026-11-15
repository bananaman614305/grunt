import { guardRouterSharing } from './setup.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

// The legacy backend can contain Grunt-created sharing providers alongside the
// user's custom rows. Enforce current consent without disabling custom sources.
export class ManagedRouter implements Source {
  readonly id: string;
  readonly supportsFunctionTools?: boolean;
  constructor(readonly source: Source, private url: string, private directory: string) {
    this.id = source.id;
    if (source.supportsFunctionTools !== undefined) this.supportsFunctionTools = source.supportsFunctionTools;
  }
  available() { return this.source.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    try { await guardRouterSharing(this.url, this.directory); }
    catch { throw new SourceError('refused', 'Cannot enforce saved router data-sharing choices; rerun usegrunt setup'); }
    signal.throwIfAborted();
    return this.source.complete(request, signal);
  }
  async close() { await this.source.close?.(); }
}
