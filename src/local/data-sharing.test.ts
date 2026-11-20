import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { approveDataSharing, DATA_SHARING_POLICIES, NUMES_DEEPSEEK_FLASH_CONSENT, readDataSharingConsent, recordDataSharingConsent } from './data-sharing.js';
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
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: await directory(), providers: ['zro', 'livekit'], interactive: true, prompt })).toEqual({ approved: [], skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('does not silently approve material trace-sale terms in default or unattended setup', async () => {
  for (const interactive of [undefined, false]) {
    const path = await directory(), prompt = vi.fn(async () => true);
    expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'freepi'], interactive, prompt }))
      .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
    expect(prompt).not.toHaveBeenCalled();
    expect(await readDataSharingConsent(path, ['tokenharbor', 'freepi'])).toEqual(['tokenharbor']);
  }
});

it('groups new material terms once and records only an affirmative current-policy decision', async () => {
  const path = await directory();
  (DATA_SHARING_POLICIES as DataSharingPolicy[]).push({ provider: 'second-material', name: 'Second', version: '1', disclosure: 'Sells identifiable traces.', url: 'https://second.test/privacy', approval: 'material' });
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => {
    expect(policies.map(policy => policy.provider)).toEqual(['freepi', 'second-material']);
    expect(policies[0]!.disclosure).toMatch(/sell.*no ordinary opt-out/);
    return true;
  });
  const providers = ['tokenharbor', 'freepi', 'second-material'];
  expect(await approveDataSharing({ directory: path, providers, interactive: true, prompt })).toEqual({ approved: providers, skipped: [] });
  expect(prompt).toHaveBeenCalledOnce();
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  expect(await approveDataSharing({ directory: path, providers, interactive: false, prompt })).toEqual({ approved: providers, skipped: [] });
  expect(prompt).toHaveBeenCalledOnce();
});

it.each([false, Symbol('cancel'), 'yes'])('keeps other providers available when a material decision is %s', async answer => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'freepi'], interactive: true, prompt: async () => answer }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
  expect(await readDataSharingConsent(path, ['freepi'])).toEqual([]);
});

it('handles a cancelled material prompt without aborting ordinary source setup', async () => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'freepi'], interactive: true, prompt: async () => { throw new Error('cancel'); } }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
});

it('requires a fresh material decision after a policy change and revokes it on opt-out', async () => {
  const path = await directory(), providers = ['tokenharbor', 'freepi'];
  const prompt = vi.fn(async () => true);
  await approveDataSharing({ directory: path, providers, interactive: true, prompt });
  DATA_SHARING_POLICIES.find(policy => policy.provider === 'freepi')!.version = 'new-sale-terms';
  expect(await readDataSharingConsent(path, ['freepi'])).toEqual([]);
  expect(await approveDataSharing({ directory: path, providers, interactive: false, prompt }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
  expect(prompt).toHaveBeenCalledOnce();
  await approveDataSharing({ directory: path, providers, interactive: true, prompt });
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(await approveDataSharing({ directory: path, providers, interactive: true, prompt, env: { GRUNT_SETUP_NO_DATA_SHARING: '1' } }))
    .toEqual({ approved: ['tokenharbor'], skipped: ['freepi'] });
  expect(await readDataSharingConsent(path, ['freepi'])).toEqual([]);
});

it('does not treat acceptance of a displayed policy as acceptance of a concurrent policy change', async () => {
  const path = await directory();
  const prompt = async () => { DATA_SHARING_POLICIES.find(policy => policy.provider === 'freepi')!.disclosure = 'Changed sale conditions.'; return true; };
  expect(await approveDataSharing({ directory: path, providers: ['freepi'], interactive: true, prompt }))
    .toEqual({ approved: [], skipped: ['freepi'] });
  expect(await readDataSharingConsent(path, ['freepi'])).toEqual([]);
});

it('groups the new native providers without renewing existing provider approvals', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, sharingIds);
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => {
    expect(policies.map(policy => policy.provider)).toEqual(['clixad', 'perch']);
    expect(policies[0]!.disclosure).toContain('does not require zero retention');
    expect(policies[1]!.disclosure).toContain('Data Program must remain off');
    return true;
  });
  const providers = [...sharingIds, 'clixad', 'perch'];
  expect(await approveDataSharing({ directory: path, providers, interactive: true, prompt })).toEqual({ approved: providers, skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
});

it('approves a whole provider batch without prompting and saves a private receipt', async () => {
  const path = await directory();
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => { expect(policies.map(policy => policy.provider)).toEqual(sharingIds); return true; });
  expect(await approveDataSharing({ directory: path, providers: ['zro', ...sharingIds, 'tokenharbor'], interactive: true, prompt })).toEqual({ approved: sharingIds, skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
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

it('refreshes the default enablement receipt when a provider policy changes', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  const index = DATA_SHARING_POLICIES.findIndex(policy => policy.provider === 'tokenharbor');
  (DATA_SHARING_POLICIES as DataSharingPolicy[])[index] = { ...DATA_SHARING_POLICIES[index]!, disclosure: 'A materially different sharing policy.' };
  expect(await readDataSharingConsent(path, ['tokenharbor'])).toEqual([]);
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor'], interactive: true, prompt })).toEqual({ approved: ['tokenharbor'], skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('enables sharing providers in an interactive terminal', async () => {
  const path = await directory();
  expect(await approveDataSharing({ directory: path, providers: ['zro', 'livekit', ...sharingIds], interactive: true })).toEqual({ approved: sharingIds, skipped: [] });
  expect(await readDataSharingConsent(path, sharingIds)).toEqual(sharingIds);
  expect(JSON.parse(await readFile(join(path, 'data-sharing-consent.json'), 'utf8')).approved).toHaveProperty('kilo');
});

it('enables a noninteractive setup batch without asking', async () => {
  const path = await directory();
  const prompt = vi.fn(async () => true);
  expect(await approveDataSharing({ directory: path, providers: sharingIds, interactive: false, prompt })).toEqual({ approved: sharingIds, skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('enables Nous and Kenari in an interactive terminal without asking and prints one notice', async () => {
  const { confirm } = await import('@clack/prompts');
  const path = await directory();
  const notice = vi.fn();
  const providers = ['tokenharbor', 'nous', 'kenari'];
  expect(await approveDataSharing({ directory: path, providers, interactive: true, env: {}, notice })).toEqual({ approved: providers, skipped: [] });
  expect(confirm).not.toHaveBeenCalled();
  expect(await readDataSharingConsent(path, providers)).toEqual(providers);
  expect(notice).toHaveBeenCalledOnce();
  expect(notice.mock.calls[0]![0]).toMatch(/^Data sharing on: nous, kenari\. Off: GRUNT_SETUP_NO_DATA_SHARING=1$/);
  await approveDataSharing({ directory: path, providers, interactive: true, env: {}, notice });
  expect(notice).toHaveBeenCalledOnce();
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
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'nous', 'kenari'], interactive: true, env: { GRUNT_SETUP_NO_DATA_SHARING: '1' }, notice }))
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
  const prompt = vi.fn(async () => false);
  expect(await approveDataSharing({ directory: path, providers: ['tokenharbor', 'new-sharing'], interactive: true, prompt })).toEqual({ approved: ['tokenharbor', 'new-sharing'], skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});

it('adds Pollinations to the existing consent batch without inheriting old approvals or reprompting for them', async () => {
  const path = await directory();
  const previous = sharingIds.filter(id => id !== 'pollinations');
  await recordDataSharingConsent(path, previous);
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => {
    expect(policies.map(policy => policy.provider)).toEqual(['pollinations']);
    expect(policies[0]!.disclosure).toMatch(/OSAII.*Poe\/Together/);
    expect(policies[0]!.disclosure).toContain('guarantees are not established');
    return true;
  });
  expect(await readDataSharingConsent(path, ['pollinations'])).toEqual([]);
  expect(await approveDataSharing({ directory: path, providers: ['livekit', ...sharingIds], interactive: true, prompt })).toEqual({ approved: sharingIds, skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
  await approveDataSharing({ directory: path, providers: sharingIds, interactive: true, prompt });
  expect(prompt).not.toHaveBeenCalled();
});

it('groups both new sharing sources into one approval while reusing the previous pool consent', async () => {
  const path = await directory();
  const previous = sharingIds.filter(id => !['pollinations', 'beatapi'].includes(id));
  await recordDataSharingConsent(path, previous);
  const prompt = vi.fn(async (policies: readonly DataSharingPolicy[]) => {
    expect(policies.map(policy => policy.provider)).toEqual(['pollinations', 'beatapi']);
    expect(policies[1]!.disclosure).toContain('upstream retention and training guarantees are not established');
    return true;
  });
  expect(await approveDataSharing({ directory: path, providers: ['zro', 'livekit', ...sharingIds], interactive: true, prompt })).toEqual({ approved: sharingIds, skipped: [] });
  expect(prompt).not.toHaveBeenCalled();
});
