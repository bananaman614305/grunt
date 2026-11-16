import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureNativeRouter, FREELLMAPI_REVISION } from './native-router.js';

const service = vi.hoisted(() => vi.fn());
vi.mock('./wizard.js', async () => {
  const { configRoot } = await import('../brand.js');
  return { configDir: () => configRoot(), command: vi.fn(), installBackgroundService: service };
});

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); service.mockClear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('creates the Grunt native service with primary settings while its runner can still load legacy settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-native-router-'));
  directories.push(directory);
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
  vi.stubEnv('GRUNT_FREELLMAPI_URL', 'http://127.0.0.1:18792/v1');
  vi.stubEnv('MILO_FREELLMAPI_URL', 'http://127.0.0.1:3001/v1');
  const router = join(directory, 'freellmapi');
  const entry = join(router, 'source/server/dist/index.js');
  await mkdir(join(router, 'source/server/dist'), { recursive: true });
  await writeFile(entry, '');
  await writeFile(join(router, FREELLMAPI_REVISION), '');
  await ensureNativeRouter();
  expect(service).toHaveBeenCalledOnce();
  expect(service.mock.calls[0]).toEqual(['grunt-router', join(router, 'runner.mjs'), expect.objectContaining({
    GRUNT_CONFIG_DIR: directory, GRUNT_ROUTER_ENTRY: entry, HOST: '127.0.0.1', PORT: '18792'
  })]);
  const runner = await readFile(join(router, 'runner.mjs'), 'utf8');
  expect(runner).toContain('process.env.GRUNT_CONFIG_DIR ?? process.env.MILO_CONFIG_DIR');
  expect(runner).toContain('process.env.GRUNT_ROUTER_ENTRY ?? process.env.MILO_ROUTER_ENTRY');
});
