import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { approveDataSharing, DATA_SHARING_POLICIES, NUMES_DEEPSEEK_FLASH_CONSENT, readDataSharingConsent, recordDataSharingConsent, refreshDataSharingConsent } from './data-sharing.js';
import type { DataSharingPolicy } from './data-sharing.js';

vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), isCancel: (value: unknown) => typeof value === 'symbol' }));
const originalPolicies = DATA_SHARING_POLICIES.map(policy => ({ ...policy }));
const sharingIds = ['freebuff', 'opencode', 'kilo', 'tokenharbor', 'runcrate', 'apinex', 'mistral-vibe', 'pollinations', 'beatapi'];
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-data-sharing-')); directories.push(path); return path; }

it('includes both Numes policies in grouped setup and revokes both on opt-out', async () => {
  const path = await directory();
  const providers = ['numes', NUMES_DEEPSEEK_FLASH_CONSENT];
  await recordDataSharingConsent(path, ['numes']);
  expect(await readDataSharingConsent(path, providers)).toEqual(['numes']);
  expect(await approveDataSharing({ directory: path, providers: ['numes'], env: {}, notice: () => {} }))
    .toEqual({ approved: providers, skipped: [] });
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  expect(await approveDataSharing({ directory: path, providers: ['numes'], env: { GRUNT_SETUP_NO_DATA_SHARING: '1' } }))
    .toEqual({ approved: [], skipped: providers });
  expect(await readDataSharingConsent(path, providers)).toEqual([]);
});
afterEach(async () => {
  (DATA_SHARING_POLICIES as DataSharingPolicy[]).splice(0, DATA_SHARING_POLICIES.length, ...originalPolicies.map(policy => ({ ...policy })));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('does not ask for providers without a known data-sharing requirement', async () => {
  expect(await approveDataSharing({ directory: await directory(), providers: ['zro', 'livekit'] })).toEqual({ approved: [], skipped: [] });
});

// Oracle: setup accepts every current policy by default, including trace-sale
// policies; skipping Free-Pi without a TTY would violate that contract.
it('automatically accepts material terms and refreshes changed policies', async () => {
  const path = await directory(), providers = ['tokenharbor', 'freepi'];
  expect(await approveDataSharing({ directory: path, providers, env: {}, notice: () => {} }))
    .toEqual({ approved: providers, skipped: [] });
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  DATA_SHARING_POLICIES.find(policy => policy.provider === 'freepi')!.version = 'new-sale-terms';
  expect(await readDataSharingConsent(path, ['freepi'])).toEqual([]);
  expect(await approveDataSharing({ directory: path, providers, env: {}, notice: () => {} }))
    .toEqual({ approved: providers, skipped: [] });
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  expect(await approveDataSharing({ directory: path, providers, env: { GRUNT_SETUP_NO_DATA_SHARING: '1' } }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
  expect(await readDataSharingConsent(path, providers)).toEqual(['tokenharbor']);
});

it('groups the new native providers without renewing existing provider approvals', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, sharingIds);
  const providers = [...sharingIds, 'clixad', 'perch'];
  expect(await approveDataSharing({ directory: path, providers })).toEqual({ approved: providers, skipped: [] });
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
});

it('approves a whole provider batch without prompting and saves a private receipt', async () => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['zro', ...sharingIds, 'tokenharbor'] })).toEqual({ approved: sharingIds, skipped: [] });
  expect(await readDataSharingConsent(path, ['zro', ...sharingIds])).toEqual(sharingIds);
  expect((await stat(join(path, 'data-sharing-consent.json'))).mode & 0o777).toBe(0o600);
});

it('reuses an existing approval without another terminal or background prompt', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'] })).toEqual({ approved: ['tokenharbor'], skipped: [] });
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'] })).toEqual({ approved: ['tokenharbor'], skipped: [] });
});

it('refreshes the default enablement receipt when a provider policy changes', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  const index = DATA_SHARING_POLICIES.findIndex(policy => policy.provider === 'tokenharbor');
  (DATA_SHARING_POLICIES as DataSharingPolicy[])[index] = { ...DATA_SHARING_POLICIES[index]!, disclosure: 'A materially different sharing policy.' };
  expect(await readDataSharingConsent(path, ['tokenharbor'])).toEqual([]);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'] })).toEqual({ approved: ['tokenharbor'], skipped: [] });
});

it('enables sharing providers in an interactive terminal', async () => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['zro', 'livekit', ...sharingIds] })).toEqual({ approved: sharingIds, skipped: [] });
  expect(await readDataSharingConsent(path, sharingIds)).toEqual(sharingIds);
  expect(JSON.parse(await readFile(join(path, 'data-sharing-consent.json'), 'utf8')).approved).toHaveProperty('kilo');
});

it('enables a noninteractive setup batch without asking', async () => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: sharingIds })).toEqual({ approved: sharingIds, skipped: [] });
});

it('enables Nous and Kenari in an interactive terminal without asking and prints one notice', async () => {
  const { confirm } = await import('@clack/prompts');
  const path = await directory();
  const notice = vi.fn();
  const providers = ['tokenharbor', 'nous', 'kenari'];
  expect(await approveDataSharing({ directory: path, providers, env: {}, notice })).toEqual({ approved: providers, skipped: [] });
  expect(confirm).not.toHaveBeenCalled();
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  expect(notice).toHaveBeenCalledOnce();
  expect(notice.mock.calls[0]![0]).toMatch(/^Data sharing on: nous, kenari\. Off: GRUNT_SETUP_NO_DATA_SHARING=1$/);
  await approveDataSharing({ directory: path, providers, env: {}, notice });
  expect(notice).toHaveBeenCalledOnce();
});

it('renews approvals for changed policies without setup, leaving unapproved providers off', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['kilo', 'tokenharbor']);
  DATA_SHARING_POLICIES.find(policy => policy.provider === 'kilo')!.version = 'changed';
  expect(await readDataSharingConsent(path, ['kilo', 'tokenharbor', 'runcrate'])).toEqual(['tokenharbor']);
  expect(await refreshDataSharingConsent(path, {})).toEqual(['kilo']);
  expect(await readDataSharingConsent(path, ['kilo', 'tokenharbor', 'runcrate'])).toEqual(['kilo', 'tokenharbor']);
  expect(await refreshDataSharingConsent(path, {})).toEqual([]);
});

it('does not renew a changed explicit policy under the setup opt-out', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['kilo', 'nous']);
  for (const policy of DATA_SHARING_POLICIES) if (['kilo', 'nous'].includes(policy.provider)) policy.version = 'changed';
  expect(await refreshDataSharingConsent(path, { GRUNT_SETUP_NO_DATA_SHARING: '1' })).toEqual(['kilo']);
  expect(await readDataSharingConsent(path, ['kilo', 'nous'])).toEqual(['kilo']);
});

it('re-enables only a changed explicit policy and says so again', async () => {
  const path = await directory();
  const notice = vi.fn();
  await approveDataSharing({ directory: path, providers: ['nous', 'kenari'], env: {}, notice });
  DATA_SHARING_POLICIES.find(policy => policy.provider === 'kenari')!.version = 'changed';
  expect(await readDataSharingConsent(path, ['nous', 'kenari'])).toEqual(['nous']);
  expect(await approveDataSharing({ directory: path, providers: ['nous', 'kenari'], env: {}, notice })).toEqual({ approved: ['nous', 'kenari'], skipped: [] });
  expect(notice.mock.calls[1]![0]).toMatch(/on: kenari\./);
});

it('keeps explicit sources off and revokes their saved consent with the opt-out', async () => {
  const path = await directory();
  await approveDataSharing({ directory: path, providers: ['tokenharbor', 'nous', 'kenari'], env: {}, notice: () => {} });
  const notice = vi.fn();
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'nous', 'kenari'], env: { GRUNT_SETUP_NO_DATA_SHARING: '1' }, notice }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['nous', 'kenari'] });
  expect(await readDataSharingConsent(path, ['tokenharbor', 'nous', 'kenari'])).toEqual(['tokenharbor']);
  expect(notice).not.toHaveBeenCalled();
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

it('records current policies for newly requested sources without asking', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  (DATA_SHARING_POLICIES as DataSharingPolicy[]).push({ provider: 'new-sharing', name: 'New Sharing', version: '1', disclosure: 'Provider training.', url: 'https://new.test/privacy' });
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'new-sharing'] })).toEqual({ approved: ['tokenharbor', 'new-sharing'], skipped: [] });
});

it('adds Pollinations to the existing consent batch without inheriting old approvals or reprompting for them', async () => {
  const path = await directory();
  const previous = sharingIds.filter(id => id !== 'pollinations');
  await recordDataSharingConsent(path, previous);
  expect(await readDataSharingConsent(path, ['pollinations'])).toEqual([]);
  expect(await approveDataSharing({ directory: path, providers: ['livekit', ...sharingIds] })).toEqual({ approved: sharingIds, skipped: [] });
  await approveDataSharing({ directory: path, providers: sharingIds });
});

it('groups both new sharing sources into one approval while reusing the previous pool consent', async () => {
  const path = await directory();
  const previous = sharingIds.filter(id => !['pollinations', 'beatapi'].includes(id));
  await recordDataSharingConsent(path, previous);
  expect(await approveDataSharing({ directory: path, providers: ['zro', 'livekit', ...sharingIds] })).toEqual({ approved: sharingIds, skipped: [] });
});
