import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { approveDataSharing, DATA_SHARING_POLICIES, readDataSharingConsent, recordDataSharingConsent } from './data-sharing.js';
import type { DataSharingPolicy } from './data-sharing.js';

vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), isCancel: (value: unknown) => typeof value === 'symbol' }));
const originalPolicies = DATA_SHARING_POLICIES.map(policy => ({ ...policy }));
const sharingIds = ['freebuff', 'opencode', 'kilo', 'tokenharbor'];
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-data-sharing-')); directories.push(path); return path; }
afterEach(async () => {
  (DATA_SHARING_POLICIES as DataSharingPolicy[]).splice(0, DATA_SHARING_POLICIES.length, ...originalPolicies.map(policy => ({ ...policy })));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('does not ask for providers without a known data-sharing requirement', async () => {
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: await directory(), providers: ['zro'], interactive: true, prompt })).toEqual({ approved: [], skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('approves a whole provider batch with one prompt and saves a private receipt', async () => {
  const path = await directory();
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => { expect(policies.map(policy => policy.provider)).toEqual(sharingIds); return true; });
  expect(await approveDataSharing({ directory: path, providers: ['zro', ...sharingIds, 'tokenharbor'], interactive: true, prompt })).toEqual({ approved: sharingIds, skipped: [] });
  expect(prompt).toHaveBeenCalledOnce();
  expect(await readDataSharingConsent(path, ['zro', ...sharingIds])).toEqual(sharingIds);
  expect((await stat(join(path, 'data-sharing-consent.json'))).mode & 0o777).toBe(0o600);
});

it('reuses an existing approval without another terminal or background prompt', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  const prompt = vi.fn(async () => { throw new Error('must not prompt again'); });
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'], interactive: true, prompt })).toEqual({ approved: ['tokenharbor'], skipped: [] });
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'], interactive: false, prompt })).toEqual({ approved: ['tokenharbor'], skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('requires new approval when a provider policy changes', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  const index = DATA_SHARING_POLICIES.findIndex(policy => policy.provider === 'tokenharbor');
  (DATA_SHARING_POLICIES as DataSharingPolicy[])[index] = { ...DATA_SHARING_POLICIES[index]!, disclosure: 'A materially different sharing policy.' };
  expect(await readDataSharingConsent(path, ['tokenharbor'])).toEqual([]);
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'], interactive: true, prompt })).toEqual({ approved: ['tokenharbor'], skipped: [] });
  expect(prompt).toHaveBeenCalledOnce();
});

it.each([false, Symbol('cancel')])('skips only sharing providers when the group approval is declined or cancelled', async answer => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['zro', ...sharingIds], interactive: true, prompt: async () => answer })).toEqual({ approved: [], skipped: sharingIds });
  expect(await readDataSharingConsent(path, sharingIds)).toEqual([]);
  await expect(readFile(join(path, 'data-sharing-consent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed in background setup without asking or recording approval', async () => {
  const path = await directory();
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: path, providers: sharingIds, interactive: false, prompt })).toEqual({ approved: [], skipped: sharingIds });
  expect(prompt).not.toHaveBeenCalled();
});

it('does not trust an unsafe, linked, or malformed consent receipt', async () => {
  const path = await directory(), other = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  const file = join(path, 'data-sharing-consent.json');
  await chmod(file, 0o644);
  expect(await readDataSharingConsent(path, ['tokenharbor'])).toEqual([]);
  await chmod(file, 0o600);
  await symlink(file, join(other, 'data-sharing-consent.json'));
  expect(await readDataSharingConsent(other, ['tokenharbor'])).toEqual([]);
  await writeFile(file, '{invalid', { mode: 0o600 });
  expect(await readDataSharingConsent(path, ['tokenharbor'])).toEqual([]);
});

it('does not let a provider outside the approved batch inherit consent', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  (DATA_SHARING_POLICIES as DataSharingPolicy[]).push({ provider: 'new-sharing', name: 'New Sharing', version: '1', disclosure: 'Provider training.', url: 'https://new.test/privacy' });
  const prompt = vi.fn(async () => false);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'new-sharing'], interactive: true, prompt })).toEqual({ approved: ['tokenharbor'], skipped: ['new-sharing'] });
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]![0].map(policy => policy.provider)).toEqual(['new-sharing']);
});
