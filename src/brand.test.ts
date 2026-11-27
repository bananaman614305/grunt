import { expect, test } from 'vitest';
import { configRoot, gruntEnv } from './brand.js';

test('uses only Grunt environment settings, including explicit empty values', () => {
  expect(gruntEnv('PORT', { GRUNT_PORT: '8792', MILO_PORT: '8788' })).toBe('8792');
  expect(gruntEnv('PORT', { MILO_PORT: '8792' })).toBeUndefined();
  expect(gruntEnv('SOURCES', { GRUNT_SOURCES: '', MILO_SOURCES: 'custom' })).toBe('');
  expect(gruntEnv('PORT', {})).toBeUndefined();
});

test('uses the explicit Grunt path or the default Grunt directory', () => {
  expect(configRoot({}, '/synthetic-home')).toBe('/synthetic-home/.config/grunt');
  expect(configRoot({ XDG_CONFIG_HOME: '/synthetic-config' })).toBe('/synthetic-config/grunt');
  expect(configRoot({ GRUNT_CONFIG_DIR: '/new-custom' })).toBe('/new-custom');
});
