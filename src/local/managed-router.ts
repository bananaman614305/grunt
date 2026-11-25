import { DelegatingSource } from './delegating-source.js';
import { guardRouterSharing, RouterSetupPending } from './setup.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

// The legacy backend can contain Grunt-created sharing providers alongside the
// user's custom rows. Enforce current consent without disabling custom sources.
export class ManagedRouter extends DelegatingSource {
  constructor(source: Source, private url: string, private directory: string) { super(source); }
  async complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    signal.throwIfAborted();
    try { await guardRouterSharing(this.url, this.directory); }
    catch (error) {
      if (error instanceof RouterSetupPending) throw new SourceError('not_installed', 'A managed provider is still being verified; other ready sources remain available');
      throw new SourceError('refused', 'Cannot enforce saved router data-sharing choices; rerun usegrunt setup');
    }
    return super.complete(request, signal, output, beforeNativeWork);
  }
}
