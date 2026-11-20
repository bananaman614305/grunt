import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTOMATIC_POOL_FILE, automaticPoolSources, migrateAutomaticPool, writeAutomaticPool } from './automatic-pool.js';

const directories: string[] = [];
const configured = ['opencode', 'kilo'];
const curated = ['opencode', 'kilo', 'reflection-beam'];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'grunt-automatic-pool-'));
  directories.push(path); return path;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('adds newly curated sources only for the matching managed service anchor', async () => {
  const path = await directory();
  await writeAutomaticPool(path, configured);
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(curated);
  expect(automaticPoolSources(path, configured, curated, false)).toEqual(configured);
  expect(automaticPoolSources(path, ['kilo'], curated, true)).toEqual(['kilo']);
  expect(await readFile(join(path, AUTOMATIC_POOL_FILE), 'utf8')).not.toMatch(/token|consent|key|grant|approved/);
});

it('preserves supported explicit additions and the custom API router on an older managed service', async () => {
  const path = await directory();
  await writeAutomaticPool(path, configured, ['kilo', 'antseed-vikey', 'freellmapi']);
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(['opencode', 'kilo', 'antseed-vikey', 'freellmapi', 'reflection-beam']);
  expect(automaticPoolSources(path, ['opencode'], curated, true)).toEqual(['opencode']);
  await expect(writeAutomaticPool(path, configured, ['https://example.test/v1'])).rejects.toThrow('Invalid managed');
});

it('keeps old receipt compatibility without treating malformed selected source data as authority', async () => {
  const path = await directory(), file = join(path, AUTOMATIC_POOL_FILE);
  await writeFile(file, JSON.stringify({ version: 1, mode: 'automatic', serviceSources: configured }), { mode: 0o600 });
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(curated);
  for (const value of [[], ['antseed-vikey', 'antseed-vikey'], ['unknown-source'], ['https://example.test/v1'], 'antseed-vikey']) {
    await writeFile(file, JSON.stringify({ version: 1, mode: 'automatic', serviceSources: configured, selectedSources: value }));
    expect(automaticPoolSources(path, configured, curated, true)).toEqual(configured);
  }
});

it.each(['missing', 'malformed', 'world-readable', 'symlink', 'wrong-owner', 'manual'])('preserves explicit sources for %s automatic selection state', async kind => {
  const path = await directory(), file = join(path, AUTOMATIC_POOL_FILE);
  if (kind !== 'missing') await writeAutomaticPool(path, configured);
  if (kind === 'malformed') await writeFile(file, '{');
  if (kind === 'world-readable') await chmod(file, 0o644);
  if (kind === 'symlink') { await rm(file); await writeFile(join(path, 'target'), JSON.stringify({ version: 1, mode: 'automatic', serviceSources: configured }), { mode: 0o600 }); await symlink(join(path, 'target'), file); }
  if (kind === 'wrong-owner') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
  if (kind === 'manual') await writeFile(file, JSON.stringify({ version: 1, mode: 'manual', serviceSources: configured }));
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(configured);
});

it('does not trust source receipts stored in a shared configuration directory', async () => {
  const path = await directory(); await writeAutomaticPool(path, configured); await chmod(path, 0o755);
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(configured);
});

it('migrates a private setup-owned selection and can roll it back after failed activation', async () => {
  const path = await directory();
  await writeFile(join(path, 'installed-sources.json'), JSON.stringify(configured), { mode: 0o600 });
  const rollback = await migrateAutomaticPool(path, configured);
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(curated);
  await rollback!();
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(configured);
});

it.each(['mismatch', 'world-readable', 'symlink', 'missing'])('does not migrate an unverified %s setup manifest', async kind => {
  const path = await directory(), file = join(path, 'installed-sources.json');
  if (kind !== 'missing') await writeFile(file, JSON.stringify(kind === 'mismatch' ? ['kilo'] : configured), { mode: 0o600 });
  if (kind === 'world-readable') await chmod(file, 0o644);
  if (kind === 'symlink') { await rm(file); await writeFile(join(path, 'target'), JSON.stringify(configured)); await symlink(join(path, 'target'), file); }
  expect(await migrateAutomaticPool(path, configured)).toBeUndefined();
  expect(automaticPoolSources(path, configured, curated, true)).toEqual(configured);
});

it('preserves a deliberate local mode and edits made during activation', async () => {
  const path = await directory(), file = join(path, AUTOMATIC_POOL_FILE);
  await writeFile(join(path, 'installed-sources.json'), JSON.stringify(configured), { mode: 0o600 });
  const rollback = await migrateAutomaticPool(path, configured);
  const manual = JSON.stringify({ version: 1, mode: 'manual' });
  await writeFile(file, manual);
  await rollback!();
  expect(await readFile(file, 'utf8')).toBe(manual);
  expect(await migrateAutomaticPool(path, configured)).toBeUndefined();
});
