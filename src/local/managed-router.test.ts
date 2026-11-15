import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedRouter } from './managed-router.js';
import { FreeLLMAdmin, setupProviders } from './setup.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { KILO_PARTICLE } from './kilo.js';
import type { ModelRequest } from './source.js';

const paths: string[] = [];
async function directory(admin = true) {
  const path = await mkdtemp(join(tmpdir(), 'grunt-managed-router-')); paths.push(path);
  if (admin) await writeFile(join(path, 'router-admin.json'), JSON.stringify({ password: 'a'.repeat(64), encryption: 'b'.repeat(64) }), { mode: 0o600 });
  return path;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request: ModelRequest = { model: 'milo', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: process.cwd(), stream: false };
const backend = () => ({ id: 'freellmapi', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'custom provider answered' })) });

it('retires owned Freebuff despite saved approval and rechecks Kilo consent before forwarding custom routes', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['kilo', 'freebuff']);
  const source = backend(), events: string[] = [];
  source.complete.mockImplementation(async () => { events.push('forward'); return { text: 'custom provider answered' }; });
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'Kilo Free', priority: 999999, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', keyLabel: 'Milo kilo (Squire)', priority: 999996, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 1000000, enabled: true },
    { modelDbId: 4, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'My custom provider', priority: 42, enabled: true },
    { modelDbId: 5, platform: 'custom', modelId: KILO_PARTICLE, keyLabel: 'Kilo Free', priority: 999999, enabled: true },
    { modelDbId: 6, platform: 'custom', modelId: 'freebuff', keyLabel: 'My custom Freebuff-named model', priority: 43, enabled: true }
  ];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (url, body, method) => {
    if (url === '/auth/login') return { token: 'synthetic-login' };
    if (url === '/keys' && method === 'GET') return [];
    if (url === '/fallback' && method === 'GET') return rows;
    if (url === '/fallback' && method === 'PUT') {
      events.push('disable');
      for (const update of body as { modelDbId: number; enabled: boolean }[]) Object.assign(rows.find(row => row.modelDbId === update.modelDbId)!, update);
    }
    return {};
  });
  const wrapped = new ManagedRouter(source, 'http://127.0.0.1:3001/v1', path);
  await wrapped.complete(request, AbortSignal.timeout(1000));
  expect(call).toHaveBeenCalledWith('/fallback', [{ modelDbId: 1, enabled: false, priority: 999999 }, { modelDbId: 2, enabled: false, priority: 999996 }, { modelDbId: 3, enabled: false, priority: 1000000 }], 'PUT');
  await rm(join(path, 'data-sharing-consent.json')); await recordDataSharingConsent(path, ['freebuff']);
  await wrapped.complete(request, AbortSignal.timeout(1000));
  expect(events).toEqual(['disable', 'forward', 'disable', 'forward']);
  expect(call).toHaveBeenCalledWith('/fallback', [{ modelDbId: 5, enabled: false, priority: 999999 }], 'PUT');
  expect(rows[3]).toMatchObject({ enabled: true, priority: 42 });
  expect(rows[5]).toMatchObject({ enabled: true, priority: 43 });
});

it.each(['missing', 'unsafe'])('refuses to forward when unapproved managed rows cannot be checked (%s admin)', async state => {
  const path = await directory(state !== 'missing');
  if (state === 'unsafe') await chmod(join(path, 'router-admin.json'), 0o644);
  const source = backend(), call = vi.spyOn(FreeLLMAdmin.prototype, 'call');
  await expect(new ManagedRouter(source, 'http://127.0.0.1:3001/v1', path).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(source.complete).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});

it('quarantines retired owned providers before failing Kilo discovery and never forwards on an incomplete guard', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['kilo', 'freebuff', 'apinex']);
  const source = backend(), events: string[] = [];
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 11, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId: 'freebuff', keyLabel: 'My custom source', priority: 12, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId: 'free/deepseek-v4.1-flash', keyLabel: 'Milo apinex (Squire)', priority: 13, enabled: true },
    { modelDbId: 4, platform: 'custom', modelId: 'free/deepseek-v4.1-flash', keyLabel: 'My custom APInex', priority: 14, enabled: true }
  ];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (url, body, method) => {
    if (url === '/auth/login') return { token: 'synthetic-login' };
    if (url === '/fallback' && method === 'GET') return structuredClone(rows);
    if (url === '/fallback' && method === 'PUT') {
      events.push('quarantine');
      for (const update of body as { modelDbId: number; enabled: boolean }[]) Object.assign(rows.find(row => row.modelDbId === update.modelDbId)!, update);
      return {};
    }
    if (url === '/keys' && method === 'GET') { events.push('discovery-failed'); throw new Error('Unavailable metadata'); }
    throw new Error('Unexpected mutation');
  });
  await expect(new ManagedRouter(source, 'http://127.0.0.1:3001/v1', path).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(events).toEqual(['quarantine', 'discovery-failed']);
  expect(rows).toMatchObject([{ enabled: false, priority: 11 }, { enabled: true, priority: 12 }, { enabled: false, priority: 13 }, { enabled: true, priority: 14 }]);
  expect(source.complete).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([url, , method]) => url === '/keys/custom' || method === 'DELETE')).toBe(false);
});

it.each(['freebuff', 'apinex'])('quarantines disabled %s Squire labels despite old approval while preserving custom labels', async provider => {
  const modelId = provider === 'apinex' ? 'free/deepseek-v4.1-flash' : 'freebuff';
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId, keyLabel: `Milo ${provider} (Squire)`, priority: 21, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId, keyLabel: `My ${provider}`, priority: 22, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId, keyLabel: `Milo ${provider} (Squire)`, priority: 23, enabled: false }
  ];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (url, body, method) => {
    if (url === '/fallback' && method === 'GET') return structuredClone(rows);
    if (url === '/fallback' && method === 'PUT') for (const update of body as { modelDbId: number; enabled: boolean }[]) Object.assign(rows.find(row => row.modelDbId === update.modelDbId)!, update);
    return {};
  });
  const admin = new FreeLLMAdmin();
  for (const excluded of [[], [provider], ['kilo']]) await admin.configureChain(excluded, ['freebuff', 'apinex', 'kilo']);
  expect(rows).toMatchObject([{ enabled: false, priority: 21 }, { enabled: true, priority: 22 }, { enabled: false, priority: 23 }]);
  expect(call.mock.calls.some(([url, , method]) => url === '/keys/custom' || method === 'DELETE')).toBe(false);
});

it('quarantines disabled Squire rows during legacy setup before failed discovery without deleting keys or custom rows', async () => {
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 31, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId: 'free/deepseek-v4.1-flash', keyLabel: 'Milo apinex (Squire)', priority: 32, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId: 'free/deepseek-v4.1-flash', keyLabel: 'Custom APInex', priority: 33, enabled: true }
  ];
  const events: string[] = [];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (url, body, method) => {
    if (url === '/fallback' && method === 'GET') return structuredClone(rows);
    if (url === '/fallback' && method === 'PUT') {
      events.push('quarantine');
      for (const update of body as { modelDbId: number; enabled: boolean }[]) Object.assign(rows.find(row => row.modelDbId === update.modelDbId)!, update);
      return {};
    }
    if (url === '/keys' && method === 'GET') { events.push('discovery-failed'); throw new Error('Unavailable metadata'); }
    throw new Error('Unexpected mutation');
  });
  await expect(new FreeLLMAdmin().ensureFreeFallbacks(['freebuff', 'apinex', 'kilo'])).rejects.toThrow('Unavailable metadata');
  expect(events).toEqual(['quarantine', 'discovery-failed']);
  expect(rows).toMatchObject([{ enabled: false, priority: 31 }, { enabled: false, priority: 32 }, { enabled: true, priority: 33 }]);
  expect(call.mock.calls.some(([url, , method]) => url === '/keys/custom' || method === 'DELETE')).toBe(false);
});

it('does not import an existing saved Kilo grant during unrelated provider setup without approval', async () => {
  const squire = { credentials: { list: vi.fn(async () => [{ service: 'kilo', reference: 'vault://kilo', field_names: ['api_key'] }]), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const addGrant = vi.fn();
  await setupProviders(squire, { addGrant }, { providers: [], notify: () => {}, dataSharingApproved: [] });
  expect(squire.credentials.grant).not.toHaveBeenCalled(); expect(addGrant).not.toHaveBeenCalled(); expect(squire.runs.start).not.toHaveBeenCalled();
});

it('setup disables unapproved owned Kilo and Freebuff rows while preserving custom model flags and priorities', async () => {
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'Kilo Free', priority: 99, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 100, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId: 'kilo-auto/free', keyLabel: 'My source', priority: 42, enabled: true },
    { modelDbId: 4, platform: 'custom', modelId: 'freebuff', keyLabel: 'Another source', priority: 43, enabled: false }
  ];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (path, _body, method) => path === '/fallback' && method === 'GET' ? rows : {});
  await new FreeLLMAdmin().configureChain([], []);
  expect(call).toHaveBeenCalledWith('/fallback', [
    { modelDbId: 1, enabled: false, priority: 999999 }, { modelDbId: 2, enabled: false, priority: 100 },
    { modelDbId: 3, enabled: true, priority: 42 }, { modelDbId: 4, enabled: false, priority: 43 }
  ], 'PUT');
});

it.each([{ excluded: [] }, { excluded: ['freebuff'] }, { excluded: ['kilo'] }])('never reenables retired Freebuff with old approvals or excluded=$excluded', async ({ excluded }) => {
  const rows = [
    { modelDbId: 1, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 17, enabled: true },
    { modelDbId: 2, platform: 'custom', modelId: 'freebuff', keyLabel: 'My custom source', priority: 18, enabled: true },
    { modelDbId: 3, platform: 'custom', modelId: 'freebuff', keyLabel: 'Freebuff', priority: 19, enabled: false }
  ];
  const call = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockImplementation(async (path, body, method) => {
    if (path === '/fallback' && method === 'GET') return structuredClone(rows);
    if (path === '/fallback' && method === 'PUT') for (const update of body as { modelDbId: number; enabled: boolean }[]) Object.assign(rows.find(row => row.modelDbId === update.modelDbId)!, update);
    return {};
  });
  const admin = new FreeLLMAdmin();
  await admin.configureChain(excluded, ['freebuff', 'kilo']);
  await admin.configureChain(excluded, ['freebuff', 'kilo']);
  expect(rows).toMatchObject([{ enabled: false, priority: 17 }, { enabled: true, priority: 18 }, { enabled: false, priority: 19 }]);
  expect(call.mock.calls.some(([path, , method]) => path === '/keys/custom' || method === 'DELETE')).toBe(false);
});
