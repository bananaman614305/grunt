import { disabledAdapters, isDeclarativeAdapter, knownAdapters, localOptInAdapterIds } from '../registry.js';
import type { Registry } from '../registry.js';
import { readDataSharingConsent, registryDataSharingPolicies, requiresDataSharing } from './data-sharing.js';
import { DailyMaintenance } from './maintenance.js';
import { readSetupSession } from './setup-session.js';
import type { Sources } from './source.js';

interface RuntimeMaintenanceOptions {
  directory: string;
  providers?: () => readonly string[];
  registry?: () => Registry;
  refreshSession?: () => ReturnType<typeof readSetupSession>;
  notify?: (message: string) => void;
}

/** All runtime entry points use the same consent/setup gates and daily queue.
 * Sibling daemons coordinate through DailyMaintenance's private local lock. */
export function createSourceMaintenance(sources: Sources, options: RuntimeMaintenanceOptions) {
  const refreshSession = options.refreshSession ?? (() => readSetupSession(options.directory));
  const extraPolicies = () => options.registry ? registryDataSharingPolicies(options.registry()) : [];
  const maintenance = new DailyMaintenance({ directory: options.directory,
    providers: options.providers ?? (() => {
      const declarative = new Set((options.registry?.().adapters ?? []).filter(isDeclarativeAdapter).map(adapter => adapter.id));
      return sources.sources.filter(source => !disabledAdapters.has(source.id)
        && (knownAdapters.has(source.id) || localOptInAdapterIds.has(source.id) || declarative.has(source.id))).map(source => source.id);
    }),
    check: async (id, signal) => {
      signal.throwIfAborted();
      const session = await refreshSession();
      if (session && (!session.owned.size || session.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      const policies = extraPolicies();
      const approved = await readDataSharingConsent(options.directory, [id], policies);
      signal.throwIfAborted();
      if (requiresDataSharing(id, policies) && !approved.includes(id)) return { outcome: 'deferred', code: 'consent' };
      const current = await refreshSession();
      signal.throwIfAborted();
      if (current && (!current.owned.size || current.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      return sources.check(id, signal);
    }, ...(options.notify ? { notify: options.notify } : {})
  });
  sources.setMaintenance(() => maintenance.snapshot());
  return maintenance;
}
