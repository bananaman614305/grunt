import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { bundledRegistry, validateRegistry } from '../registry.js';

afterEach(() => { vi.restoreAllMocks(); });

async function driveCalls(provider: string, url: string) {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: `${provider}-session` } : {});
  await squire.signup(provider, url, 'Sign in and capture one API key.');
  return call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => args as Record<string, unknown>);
}

it('appends registry hints to the drive goal and passes the registry capture as store', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'aperture-ai')!;
  const [first] = await driveCalls('aperture-ai', 'https://www.aperture-ai.run/login.html');
  expect(String(first!.goal)).toContain(`Provider hints (page, control, value, in order): ${entry.hints}`);
  expect(first!.store).toEqual(entry.capture);
});

it('finds the registry entry by signup host when the vault service differs from the registry id', async () => {
  const entry = bundledRegistry.adapters.find(a => a.id === 'millionseek')!;
  const [first] = await driveCalls('100milionseek', 'https://100milionseek.top/signup');
  expect(String(first!.goal)).toContain(entry.hints!);
  expect(first!.store).toEqual({ ...entry.capture, service: '100milionseek' });
});

it('leaves the goal and call unchanged for an entry without hints or capture', async () => {
  const [first] = await driveCalls('kilo', 'https://app.kilo.ai/profile');
  expect(String(first!.goal)).not.toContain('Provider hints');
  expect(first).not.toHaveProperty('store');
});

it('keeps every drive goal within operate_drive\'s 4000-character limit', async () => {
  for (const entry of bundledRegistry.adapters.filter(a => a.hints)) {
    const [first] = await driveCalls(entry.id, entry.signup ?? `https://${entry.id}.test/`);
    expect(String(first!.goal).length).toBeLessThanOrEqual(4000);
  }
});

it.each([
  { hints: '' }, { hints: 7 }, { hints: 'x'.repeat(2001) },
  { capture: 'zro' }, { capture: {} }, { capture: { service: 'zro', label: '' } },
  { capture: { service: 'zro', api_hosts: 'zro.moonmath.ai' } }, { capture: { service: 'zro', auth_shape: 'basic' } },
  { capture: { service: 'zro', egress_hosts: ['zro.moonmath.ai'] } },
])('rejects an invalid hints or capture field: %j', fields => {
  const registry = structuredClone(bundledRegistry);
  Object.assign(registry.adapters.find(a => a.id === 'zro')!, fields);
  expect(() => validateRegistry(registry)).toThrow('Invalid adapter registry');
});
