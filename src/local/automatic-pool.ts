import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { knownAdapters, localOptInAdapterIds } from '../registry.js';

export const AUTOMATIC_POOL_FILE = 'automatic-pool.json';
interface AutomaticPool { version: 1; mode: 'automatic'; serviceSources: string[]; selectedSources?: string[] }
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 100
  && value.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id)) && new Set(value).size === value.length;
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => b[i] === id);
const selected = (value: unknown): value is string[] => ids(value) && value.every(id => knownAdapters.has(id) || localOptInAdapterIds.has(id) || id === 'freellmapi');
const owned = (stat: Stats, mode: number) => !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === mode;
const serialized = (serviceSources: readonly string[], selectedSources: readonly string[] = serviceSources) => {
  if (!ids(serviceSources) || !selected(selectedSources)) throw new Error('Invalid managed Grunt source selection');
  return JSON.stringify({ version: 1, mode: 'automatic', serviceSources, selectedSources } satisfies AutomaticPool);
};

// This receipt changes source discovery only. It never grants provider access,
// copies credentials or substitutes for a provider's current consent receipt.
export function automaticPoolSelection(directory: string, configured: readonly string[], curated: readonly string[], managed: boolean): { sources: string[]; automatic: boolean; explicit?: string[] } {
  if (!managed) return { sources: [...configured], automatic: false };
  let fd: number | undefined;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || !owned(parent, 0o700)) return { sources: [...configured], automatic: false };
    fd = openSync(join(directory, AUTOMATIC_POOL_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info, 0o600) || info.size > 16384) return { sources: [...configured], automatic: false };
    const value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<AutomaticPool>;
    if (value.version !== 1 || value.mode !== 'automatic' || !ids(value.serviceSources) || !same(value.serviceSources, configured)) return { sources: [...configured], automatic: false };
    if (value.selectedSources !== undefined && !selected(value.selectedSources)) return { sources: [...configured], automatic: false };
    // Setup may explicitly add a supported source outside the curated pool.
    // Keep that selection even when the owned service still has its old env.
    return { sources: [...new Set([...configured, ...(value.selectedSources ?? []), ...curated])], automatic: true, explicit: [...new Set([...configured, ...(value.selectedSources ?? [])])] };
  } catch { return { sources: [...configured], automatic: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function writeAutomaticPool(directory: string, serviceSources: readonly string[], selectedSources: readonly string[] = serviceSources) {
  const value = serialized(serviceSources, selectedSources);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || !owned(parent, 0o700)) throw new Error('Automatic pool selection requires private owned state');
  const temporary = join(directory, `.${AUTOMATIC_POOL_FILE}-${randomUUID()}`);
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, AUTOMATIC_POOL_FILE));
  } finally { await rm(temporary, { force: true }); }
}

// Only a service already verified by the managed-runtime updater may supply
// this anchor. A private setup manifest must independently match it; a manual
// GRUNT_SOURCES override or unowned/malformed state cannot enroll new sources.
export async function migrateAutomaticPool(directory: string, serviceSources: readonly string[] | undefined): Promise<(() => Promise<void>) | undefined> {
  if (!serviceSources || !ids(serviceSources)) return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(directory, AUTOMATIC_POOL_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return; // Existing explicit state, including an opt-out, remains authoritative.
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  finally { await handle?.close(); }
  try {
    handle = await open(join(directory, 'installed-sources.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || !owned(info, 0o600) || info.size > 16384) return;
    const installed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!ids(installed) || !same(installed, serviceSources)) return;
  } catch { return; }
  finally { await handle?.close(); }
  await writeAutomaticPool(directory, serviceSources);
  const written = serialized(serviceSources);
  return async () => {
    // Preserve any user change made during activation instead of rolling it back.
    let current: string;
    try { current = readFileSync(join(directory, AUTOMATIC_POOL_FILE), 'utf8'); } catch { return; }
    if (current === written) await rm(join(directory, AUTOMATIC_POOL_FILE));
  };
}
