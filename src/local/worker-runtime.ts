import { join } from 'node:path';
import type { Sources } from './source.js';
import { WorkerPool } from './worker-pool.js';
import type { WorkerPoolOptions } from './worker-pool.js';
import { WorkerScopes } from './worker-scopes.js';
import { createWorkerWorkspace, restoreWorkerWorkspace } from './worker-workspace.js';

/** Trusted daemon configuration only; tasks never choose execution roots or binaries. */
export function createWorkerRuntime(sources: Pick<Sources, 'complete'>, options: { directory: string; onTransition?: WorkerPoolOptions['onTransition'] }) {
  const scopes = new WorkerScopes();
  const workers = new WorkerPool(sources, undefined, {
    retentionDirectory: join(options.directory, 'worker-retention'),
    restoreAgentWorkspace: (record, signal) => restoreWorkerWorkspace({ ...record, stateDirectory: join(options.directory, 'workers') }, signal),
    createAgentWorkspace: (input, signal) => createWorkerWorkspace({ ...input, stateDirectory: join(options.directory, 'workers') }, signal),
    ...(options.onTransition ? { onTransition: options.onTransition } : {})
  });
  const ready = workers.ready();
  // Recovery failure disables worker execution; the main model route remains usable.
  void ready.catch(() => {});
  return { workers, scopes, ready, close: async () => { await workers.close(); scopes.close(); } };
}
