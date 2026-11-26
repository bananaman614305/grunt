import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { configRoot, gruntEnv } from './brand.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('Grunt environment values override legacy values, including an explicit empty value', () => {
  expect(gruntEnv('PORT', { GRUNT_PORT: '8792', MILO_PORT: '8788' })).toBe('8792');
  expect(gruntEnv('PORT', { MILO_PORT: '8792' })).toBe('8792');
  expect(gruntEnv('SOURCES', { GRUNT_SOURCES: '', MILO_SOURCES: 'custom' })).toBe('');
  expect(gruntEnv('PORT', {})).toBeUndefined();
});

test('brand-new Grunt-era settings do not fall back to legacy MILO_* variables', () => {
  for (const name of [
    'FLEET_REPORTING',
    'ADOPTION_REPORTING',
    'BACKGROUND_ACCOUNT_ACQUISITION',
    'OPT_IN_SOURCES',
    'SETUP_NO_DATA_SHARING',
    'APPROVE_DATA_SHARING',
    'ANTSEED_VIKEY_PORT',
    'NUMES_MODEL',
    'HERMES_ROOT',
    'SETUP_NO_ANONYMOUS',
  ]) {
    expect(gruntEnv(name, { [`MILO_${name}`]: '1' })).toBeUndefined();
    expect(gruntEnv(name, { [`GRUNT_${name}`]: '1', [`MILO_${name}`]: '0' })).toBe('1');
  }
});

test('new installations use Grunt with explicit config and XDG compatibility', () => {
  expect(configRoot({}, '/synthetic-home')).toBe('/synthetic-home/.config/grunt');
  expect(configRoot({ XDG_CONFIG_HOME: '/synthetic-config' })).toBe('/synthetic-config/grunt');
  expect(configRoot({ GRUNT_CONFIG_DIR: '/new-custom', MILO_CONFIG_DIR: '/old-custom' })).toBe('/new-custom');
  expect(configRoot({ MILO_CONFIG_DIR: '/old-custom' })).toBe('/old-custom');
});

test('upgrades preserve saved legacy keys and consent without moving the directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grunt-brand-'));
  directories.push(base);
  const legacy = join(base, 'milo');
  await mkdir(legacy, { mode: 0o700 });
  await writeFile(join(legacy, 'data-sharing.json'), JSON.stringify({ allowed: ['synthetic'] }), { mode: 0o600 });
  expect(configRoot({ XDG_CONFIG_HOME: base })).toBe(legacy);
  expect(JSON.parse(await readFile(join(legacy, 'data-sharing.json'), 'utf8'))).toEqual({ allowed: ['synthetic'] });
  await mkdir(join(base, 'grunt'), { mode: 0o700 });
  expect(configRoot({ XDG_CONFIG_HOME: base })).toBe(join(base, 'grunt'));
  expect(await readFile(join(legacy, 'data-sharing.json'), 'utf8')).toContain('synthetic');
});
