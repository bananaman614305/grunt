import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const daemonFile = 'daemon.mjs';
export const legacyDaemonFile = 'dist/local/main.js';
export const daemonRegistry = 'registry/adapters.json';

export async function copyDaemon(dist: string, runtime: string, signal?: AbortSignal) {
  const staging = join(runtime, `.daemon-${randomUUID()}`);
  const registry = join(runtime, daemonRegistry);
  await mkdir(staging, { mode: 0o700 });
  try {
    await copyFile(join(dist, daemonRegistry), join(staging, 'adapters.json'));
    await copyFile(join(dist, 'local', daemonFile), join(staging, daemonFile));
    signal?.throwIfAborted();
    await mkdir(dirname(registry), { recursive: true, mode: 0o700 });
    if (!(await lstat(dirname(registry))).isDirectory()) throw new Error('The Grunt runtime registry directory is unsafe');
    signal?.throwIfAborted();
    await rename(join(staging, 'adapters.json'), registry);
    await rename(join(staging, daemonFile), join(runtime, daemonFile));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
