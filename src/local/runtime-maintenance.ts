import { disabledAdapters, knownAdapters, localOptInAdapterIds } from '../registry.js';
import { readDataSharingConsent, requiresDataSharing } from './data-sharing.js';
import { DailyMaintenance } from './maintenance.js';
import { readSetupSession } from './setup-session.js';
import type { Sources } from './source.js';

interface RuntimeMaintenanceOptions {
  directory: string;
  providers?: () => readonly string[];
  refreshSession?: () => ReturnType<typeof readSetupSession>;
  notify?: (message: string) => void;
}

/** All runtime entry points use the same consent/setup gates and daily queue.
 * Sibling daemons coordinate through DailyMaintenance's private local lock. */
export function createSourceMaintenance(sources: Sources, options: RuntimeMaintenanceOptions) {
  const refreshSession = options.refreshSession ?? (() => readSetupSession(options.directory));
  const maintenance = new DailyMaintenance({ directory: options.directory,
    providers: options.providers ?? (() => sources.sources.filter(source => !disabledAdapters.has(source.id)
      && (knownAdapters.has(source.id) || localOptInAdapterIds.has(source.id))).map(source => source.id)),
    check: async (id, signal) => {
      signal.throwIfAborted();
      const session = await refreshSession();
      if (session && (!session.owned.size || session.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      const approved = await readDataSharingConsent(options.directory, [id]);
      signal.throwIfAborted();
      if (requiresDataSharing(id) && !approved.includes(id)) return { outcome: 'deferred', code: 'consent' };
      const current = await refreshSession();
      signal.throwIfAborted();
      if (current && (!current.owned.size || current.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      return sources.check(id, signal);
    }, ...(options.notify ? { notify: options.notify } : {})
  });
  sources.setMaintenance(() => maintenance.snapshot());
  return maintenance;
}
