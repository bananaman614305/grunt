import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire, setupProviders, squireStore } from './setup.js';
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

it('appends registry hints to the drive goal and derives the Squire store from the vault service', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'aperture-ai')!;
  const [first] = await driveCalls('aperture-ai', 'https://www.aperture-ai.run/login.html');
  expect(String(first!.goal)).toContain(`Provider hints (page, control, value, in order): ${entry.hints}`);
  expect(first!.store).toEqual({ service: 'aperture-ai', label: 'Grunt Free', api_hosts: ['www.aperture-ai.run'], auth_shape: 'bearer' });
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

it('never takes the Squire store from registry data', async () => {
  expect(bundledRegistry.adapters.some(a => 'capture' in a)).toBe(false);
  const registry = synced('goedel', { capture: { service: 'goedel', label: 'other', api_hosts: ['elsewhere.test'] } });
  const [first] = await driveCalls('goedel', 'https://inference.goedelmachines.com/keys', { registry });
  expect(first!.store).toEqual(squireStore('goedel'));
  expect(first!.store).toEqual({ service: 'goedel', label: 'Grunt Free', api_hosts: ['api.goedelmachines.com'], auth_shape: 'bearer' });
  const added = synced('kilo', { capture: { service: 'kilo', label: 'grunt' } });
  const [kilo] = await driveCalls('kilo', 'https://app.kilo.ai/profile', { registry: added });
  expect(kilo).not.toHaveProperty('store');
});

it('passes store only for the vault service this signup checks', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'millionseek')!;
  // Found by signup host; the store names the service the setup drives under.
  const [matched] = await driveCalls('100milionseek', 'https://100milionseek.top/signup');
  expect(String(matched!.goal)).toContain(entry.hints!);
  expect(matched!.store).toEqual({ service: '100milionseek', label: 'Grunt Free', api_hosts: ['100milionseek.top'], auth_shape: 'bearer' });
  // Same host, different vault service: hints still apply, store does not.
  const [other] = await driveCalls('millionseek-other', 'https://100milionseek.top/signup');
  expect(String(other!.goal)).toContain(entry.hints!);
  expect(other).not.toHaveProperty('store');
});

it('leaves the goal and call unchanged for an entry without hints or a Squire store', async () => {
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
    const [first] = await driveCalls(entry.id, entry.signup ?? `https://${entry.id}.test/`);
    expect(String(first!.goal).length).toBeLessThanOrEqual(4000);
    expect(String(first!.goal)).toContain('Provider hints');
  }
});

it('passes per-signup facts such as a device code to the drive, alongside the Grunt values', async () => {
  const [first] = await driveCalls('freepi', 'https://github.com/login/device', { facts: { user_code: 'ABCD-EFGH' } });
  expect(first!.facts).toEqual({ key_name: 'grunt', user_code: 'ABCD-EFGH', plan: 'free', project_name: 'grunt' });
  const [later] = await driveCalls('freepi', 'https://github.com/login/device');
  expect(later!.facts).toEqual({ key_name: 'grunt', plan: 'free', project_name: 'grunt' });
});

it('names key-name values key_name, which a provider fact can override', async () => {
  const [first] = await driveCalls('pollinations', 'https://enter.pollinations.ai/keys', { facts: { key_name: 'grunt-free-pollinations' } });
  expect(first!.facts).toEqual({ key_name: 'grunt-free-pollinations', plan: 'free', project_name: 'grunt' });
});

it.each([
  { hints: '' }, { hints: 7 }, { hints: 'x'.repeat(2001) },
])('rejects an invalid hints field: %j', fields => {
  expect(() => validateRegistry(synced('zro', fields))).toThrow('Invalid adapter registry');
});


it.each(['complete', 'dropped', 'error'])('reports one actual signup outcome for a %s browser attempt', async status => {
  const signedUp = vi.fn();
  const squire = new BrowserSquire({ signedUp });
  vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name !== 'operate_drive') return {};
    if (status === 'error') throw new Error('browser unavailable');
    return { status, session_id: 'synthetic-session' };
  });
  const signup = squire.signup('100milionseek', 'https://100milionseek.top/signup', 'Sign up.');
  if (status === 'complete') await signup;
  else await expect(signup).rejects.toThrow();
  expect(signedUp.mock.calls).toEqual([['millionseek', status === 'complete']]);
});

it('reports legacy provisioning outcomes through the same browser lifecycle', async () => {
  const signedUp = vi.fn(), squire = new BrowserSquire({ signedUp });
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: 'synthetic-session' } : {});
  await squire.runs.start({ service: 'zro', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none', idempotency_key: 'synthetic' });
  expect(signedUp.mock.calls).toEqual([['zro', true]]);
});

it('does not report a signup when cancellation prevents a browser attempt', async () => {
  const signedUp = vi.fn(), controller = new AbortController();
  controller.abort();
  const squire = new BrowserSquire({ signedUp, signal: controller.signal });
  const call = vi.spyOn(squire, 'call');
  await expect(squire.signup('goedel', 'https://inference.goedelmachines.com/keys', 'Sign up.')).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  expect(signedUp).not.toHaveBeenCalled();
});


it.each([
  ['zro', 'grunt', 'zro.moonmath.ai'],
  ['tokenharbor', 'grunt', 'tokenharbor.ai'],
  ['pollinations', 'grunt-free-pollinations', 'gen.pollinations.ai'],
  ['beatapi', 'grunt', 'api.beatapi.io'],
  ['kenari', 'Grunt Free', 'kenari.id'],
  ['goedel', 'Grunt Free', 'api.goedelmachines.com'],
  ['fikra', 'Grunt Free', 'api.fikraapi.co.ke'],
  ['darus', 'Grunt Free', 'gateway.darusalfatah.id'],
  ['aperture-ai', 'Grunt Free', 'www.aperture-ai.run'],
  ['100milionseek', 'Grunt Free', '100milionseek.top']
])('preserves the existing vault contract for %s', async (service, label, host) => {
  const [drive] = await driveCalls(service, `https://${host}/`);
  expect(drive!.store).toEqual({ service, label, api_hosts: [host], auth_shape: 'bearer' });
});


it.each(['zro', 'tokenharbor', 'runcrate', 'nvidia'])('counts one failed signup when %s legacy polling times out', async provider => {
  let clock = 0, drives = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const signedUp = vi.fn(), squire = new BrowserSquire({ background: true, signedUp });
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name === 'list_credentials') return { credentials: [] };
    if (name !== 'operate_drive') return {};
    if (++drives === 2) clock = 120001;
    return { status: 'needs_human', session_id: 'synthetic-session' };
  });
  const addGrant = vi.fn();
  const result = await setupProviders(squire, { addGrant }, { providers: [provider], notify: () => {}, reuseSaved: false });
  expect(result.dropped).toEqual([provider]);
  expect(signedUp.mock.calls).toEqual([[provider, false]]);
  expect(call).toHaveBeenCalledWith('operate_finish', expect.objectContaining({ session_id: 'synthetic-session' }));
  expect(addGrant).not.toHaveBeenCalled();
});
