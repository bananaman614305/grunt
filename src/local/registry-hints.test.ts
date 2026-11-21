import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { bundledRegistry, validateRegistry } from '../registry.js';
import type { Registry } from '../registry.js';

afterEach(() => { vi.restoreAllMocks(); });

async function driveCalls(provider: string, url: string, options: { facts?: Record<string, string>; registry?: Registry; goal?: string } = {}) {
  const squire = new BrowserSquire(options.registry ? { registry: () => options.registry! } : {});
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: `${provider}-session` } : {});
  await squire.signup(provider, url, options.goal ?? 'Sign in and capture one API key.', options.facts);
  return call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => args as Record<string, unknown>);
}
const synced = (id: string, fields: Record<string, unknown>): Registry => {
  const registry = structuredClone(bundledRegistry);
  Object.assign(registry.adapters.find(a => a.id === id)!, fields);
  return registry;
};

it('appends registry hints to the drive goal and passes the shipped capture as store', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'aperture-ai')!;
  const [first] = await driveCalls('aperture-ai', 'https://www.aperture-ai.run/login.html');
  expect(String(first!.goal)).toContain(`Provider hints (page, control, value, in order): ${entry.hints}`);
  expect(first!.store).toEqual(entry.capture);
});

it('puts hints before the shared safety rules, which stay last', async () => {
  const [custom] = await driveCalls('aperture-ai', 'https://www.aperture-ai.run/login.html');
  const goal = String(custom!.goal);
  expect(goal.indexOf('Provider hints')).toBeLessThan(goal.indexOf('Accept required provider Terms of Service'));
  expect(goal.indexOf('Provider hints')).toBeLessThan(goal.search(/Grunt setup enables this free source|Do not opt in to optional/));
  expect(goal.endsWith('Leave optional consent unchecked.')).toBe(true);
});

it('uses hints from the synced registry, as for provider routes', async () => {
  const registry = synced('goedel', { hints: 'Synced hint: press Create key.' });
  const [first] = await driveCalls('goedel', 'https://inference.goedelmachines.com/keys', { registry });
  expect(String(first!.goal)).toContain('Synced hint: press Create key.');
  expect(String(first!.goal)).not.toContain(bundledRegistry.adapters.find(a => a.id === 'goedel')!.hints!);
});

it('never takes capture from a synced registry; only the shipped one supplies store', async () => {
  const shipped = bundledRegistry.adapters.find(a => a.id === 'goedel')!.capture;
  const registry = synced('goedel', { capture: { service: 'goedel', label: 'other', api_hosts: ['elsewhere.test'] } });
  const [first] = await driveCalls('goedel', 'https://inference.goedelmachines.com/keys', { registry });
  expect(first!.store).toEqual(shipped);
  const added = synced('kilo', { capture: { service: 'kilo', label: 'grunt' } });
  const [kilo] = await driveCalls('kilo', 'https://app.kilo.ai/profile', { registry: added });
  expect(kilo).not.toHaveProperty('store');
});

it('passes store only when the shipped capture names the vault service this signup checks', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'millionseek')!;
  // Found by signup host; its capture names the service the setup drives under.
  const [matched] = await driveCalls('100milionseek', 'https://100milionseek.top/signup');
  expect(String(matched!.goal)).toContain(entry.hints!);
  expect(matched!.store).toEqual(entry.capture);
  // Same host, different vault service: hints still apply, store does not.
  const [other] = await driveCalls('millionseek-other', 'https://100milionseek.top/signup');
  expect(String(other!.goal)).toContain(entry.hints!);
  expect(other).not.toHaveProperty('store');
});

it('leaves the goal and call unchanged for an entry without hints or capture', async () => {
  const [first] = await driveCalls('kilo', 'https://app.kilo.ai/profile');
  expect(String(first!.goal)).not.toContain('Provider hints');
  expect(first).not.toHaveProperty('store');
});

it('drops the hints at runtime rather than exceed the 4000-character drive goal', async () => {
  const long = 'x'.repeat(1990);
  const registry = synced('goedel', { hints: long });
  const [first] = await driveCalls('goedel', 'https://inference.goedelmachines.com/keys', { registry, goal: 'g'.repeat(2500) });
  expect(String(first!.goal)).not.toContain('Provider hints');
  expect(String(first!.goal).length).toBeLessThanOrEqual(4000);
  const [fits] = await driveCalls('goedel', 'https://inference.goedelmachines.com/keys', { registry });
  expect(String(fits!.goal)).toContain(long);
});

it('keeps every shipped hinted drive goal within the limit', async () => {
  for (const entry of bundledRegistry.adapters.filter(a => a.hints)) {
    const [first] = await driveCalls(entry.capture?.service ?? entry.id, entry.signup ?? `https://${entry.id}.test/`);
    expect(String(first!.goal).length).toBeLessThanOrEqual(4000);
    expect(String(first!.goal)).toContain('Provider hints');
  }
});

it('passes per-signup facts such as a device code to the drive, alongside the Grunt values', async () => {
  const [first] = await driveCalls('freepi', 'https://github.com/login/device', { facts: { user_code: 'ABCD-EFGH' } });
  expect(first!.facts).toEqual({ user_code: 'ABCD-EFGH', plan: 'free', project_name: 'grunt' });
  const [later] = await driveCalls('freepi', 'https://github.com/login/device');
  expect(later!.facts).toEqual({ plan: 'free', project_name: 'grunt' });
});

it.each([
  { hints: '' }, { hints: 7 }, { hints: 'x'.repeat(2001) },
  { capture: 'zro' }, { capture: {} }, { capture: { service: 'zro', label: '' } },
  { capture: { service: 'zro', api_hosts: 'zro.moonmath.ai' } }, { capture: { service: 'zro', auth_shape: 'basic' } },
  { capture: { service: 'zro', egress_hosts: ['zro.moonmath.ai'] } },
])('rejects an invalid hints or capture field: %j', fields => {
  expect(() => validateRegistry(synced('zro', fields))).toThrow('Invalid adapter registry');
});

function vaultedSquire(label: string, status: string) {
  const entry = bundledRegistry.adapters.find(a => a.id === 'goedel')!;
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'list_credentials'
    ? { credentials: [{ service: entry.capture!.service, label, reference: 'vault://goedel-existing', field_names: ['value'] }] }
    : name === 'operate_drive' ? { status, session_id: 'goedel-session' } : {});
  return { entry, squire, call };
}

it('still runs the drive when a saved key with the right label is in the vault', async () => {
  const { entry, squire, call } = vaultedSquire(bundledRegistry.adapters.find(a => a.id === 'goedel')!.capture!.label!, 'complete');
  await squire.signup('goedel', entry.signup!, 'Sign in and capture one API key.');
  expect(call.mock.calls.some(([name]) => name === 'operate_drive')).toBe(true);
});

it('counts a stopped drive as success when the vault holds the key under the shipped label', async () => {
  const { entry, squire } = vaultedSquire(bundledRegistry.adapters.find(a => a.id === 'goedel')!.capture!.label!, 'blocked');
  await expect(squire.signup('goedel', entry.signup!, 'Sign in and capture one API key.')).resolves.toBeUndefined();
});

it('still fails a stopped drive when the vault holds that service only under another label', async () => {
  const { entry, squire } = vaultedSquire('something else', 'blocked');
  await expect(squire.signup('goedel', entry.signup!, 'Sign in and capture one API key.')).rejects.toThrow();
});

it('looks up synced hints by registry id only, never by signup host', async () => {
  const registry = synced('millionseek', { hints: 'Synced millionseek hint.' });
  const [byHost] = await driveCalls('100milionseek', 'https://100milionseek.top/signup', { registry });
  expect(String(byHost!.goal)).not.toContain('Synced millionseek hint.');
  const [byId] = await driveCalls('millionseek', 'https://100milionseek.top/signup', { registry });
  expect(String(byId!.goal)).toContain('Synced millionseek hint.');
});
