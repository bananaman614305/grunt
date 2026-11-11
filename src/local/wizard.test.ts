import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { configurePi, connectSquire, preflight } from './wizard.js';

let dir: string;
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('adds the Pi provider without removing user providers and preserves it on repeat setup', async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-pi-test-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ providers: { existing: { baseUrl: 'https://example.test' } }, other: 'keep' }));
  await configurePi(19878);
  await configurePi(19878);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ other: 'keep', providers: {
    existing: { baseUrl: 'https://example.test' }, milo: { baseUrl: 'http://127.0.0.1:19878/v1', models: [{ id: 'milo' }] }
  } });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, '{invalid');
  await expect(configurePi()).rejects.toThrow('Cannot read Pi');
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});

it('bootstraps a fresh Squire install before connecting, and leaves an existing session alone', async () => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {});
  await connectSquire({ hasSession: async () => false, run, installer: '/fixture/bin.js' });
  expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('bin.js'), 'connect', '--target=opencode', '--json'], true);
  expect(connect).toHaveBeenCalledOnce();
  run.mockClear();
  await connectSquire({ hasSession: async () => true, run });
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv('MILO_SETUP_NO_HUMAN', '1');
  await expect(connectSquire({ hasSession: async () => false, run, installer: '/fixture/bin.js' })).rejects.toThrow('stopped before onboarding');
  expect(run).not.toHaveBeenCalled();
});
it('stops at a missing prerequisite with its fix before Squire or service changes', async () => {
  const run = vi.fn(async (binary: string) => { if (binary === 'pi') throw new Error('missing'); });
  await expect(preflight(run)).rejects.toThrow('npm install --global @mariozechner/pi-coding-agent');
  expect(run.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'pi']);
});
