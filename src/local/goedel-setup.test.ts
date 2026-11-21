import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The Free Key's live verification is out of scope here: a granted key verifies.
vi.mock('./goedel.js', () => ({
  Goedel: class { constructor(private options: { loadGrant?: unknown } = {}) {} async available() { return this.options.loadGrant !== undefined; } }
}));
const { setupGoedel } = await import('./goedel-setup.js');
const { recordDataSharingConsent } = await import('./data-sharing.js');

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'goedel-setup-')); await recordDataSharingConsent(directory, ['goedel']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const key = (allowed_hosts: unknown[]) => ({ service: 'goedel', label: 'Grunt Free', reference: 'vault://goedel-free', field_names: ['value'], allowed_hosts });
function squire(credential: ReturnType<typeof key>) {
  return {
    call: vi.fn(async () => ({ credentials: [credential] })),
    signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-grant' })) },
  };
}
const run = (s: ReturnType<typeof squire>) => setupGoedel({ directory, squire: s as never, notify: () => {}, background: false });

it.each([
  [['api.goedelmachines.com']],
  // The hosts Squire's store writes when the drive captures the key.
  [['api.goedelmachines.com', 'inference.goedelmachines.com', '*.goedelmachines.com']],
])('accepts a stored Free Key whose first host is the API and whose other hosts stay in the provider domain: %j', async hosts => {
  const s = squire(key(hosts));
  await run(s);
  expect(s.credentials.grant).toHaveBeenCalledWith('vault://goedel-free');
  expect(s.signup).not.toHaveBeenCalled();
});

it.each([
  [['inference.goedelmachines.com', 'api.goedelmachines.com']],
  [['api.goedelmachines.com', 'unrelated.example']],
  [['api.goedelmachines.com', 'goedelmachines.com.example']],
  [['api.goedelmachines.com', 7]],
  [[]],
])('never grants a stored key whose hosts could route it elsewhere: %j', async hosts => {
  const s = squire(key(hosts));
  await expect(run(s)).rejects.toThrow();
  expect(s.credentials.grant).not.toHaveBeenCalled();
});
