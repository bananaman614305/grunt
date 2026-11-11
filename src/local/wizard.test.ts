import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configurePi } from './wizard.js';

let dir: string;
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
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
