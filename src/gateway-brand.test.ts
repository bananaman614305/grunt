import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultGatewayDb } from './gateway-db.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('retains the existing gateway database for shared services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-db-brand-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  expect(defaultGatewayDb(directory)).toBe(`file:${join(directory, 'grunt.db')}`);
  await writeFile(join(directory, 'milo.db'), 'existing conversations');
  expect(defaultGatewayDb(directory)).toBe(`file:${join(directory, 'milo.db')}`);
  await writeFile(join(directory, 'grunt.db'), 'current conversations');
  expect(defaultGatewayDb(directory)).toBe(`file:${join(directory, 'grunt.db')}`);
});
