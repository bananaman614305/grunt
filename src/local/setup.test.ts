import { afterEach, expect, it, vi } from 'vitest';
import { squireEnvironment } from './setup.js';

afterEach(() => vi.unstubAllEnvs());

it('uses primary Squire home overrides and ignores obsolete aliases', () => {
  vi.stubEnv('MILO_SQUIRE_HOME', '/legacy-squire');
  vi.stubEnv('GRUNT_SQUIRE_HOME', '/grunt-squire');
  vi.stubEnv('GRUNT_SQUIRE_XDG_CONFIG_HOME', '/grunt-config');
  expect(squireEnvironment()).toMatchObject({ HOME: '/grunt-squire', XDG_CONFIG_HOME: '/grunt-config' });
  vi.stubEnv('GRUNT_SQUIRE_HOME', undefined);
  vi.stubEnv('GRUNT_SQUIRE_XDG_CONFIG_HOME', undefined);
  expect(squireEnvironment().HOME).not.toBe('/legacy-squire');
});
