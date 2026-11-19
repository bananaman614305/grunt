import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('prints Squire\'s own stop reason for a dropped signup in debug mode', async () => {
  vi.stubEnv('GRUNT_SETUP_DEBUG', '1');
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'failed', session_id: 'zro-tab', reason: 'Google sign-in page did not load', remaining: 'open the account page' }
    : {});
  const debug = vi.spyOn(console, 'error').mockImplementation(() => {});
  const setupProvider = vi.fn(async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); });
  await expect(setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider })).resolves.toEqual({ unavailable: ['zro'] });
  const lines = debug.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('grunt setup: zro:'));
  expect(lines).toEqual(['grunt setup: zro: browser could not continue (squire status: failed; reason: Google sign-in page did not load; remaining: open the account page;)']);
});

it('keeps the plain reason when debug mode is off', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'failed', session_id: 'zro-tab', reason: 'blocked' } : {});
  const debug = vi.spyOn(console, 'error').mockImplementation(() => {});
  const setupProvider = async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); };
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider });
  expect(squire.signupFailure('zro')).toBe('browser could not continue');
  expect(debug.mock.calls.some(call => String(call[0]).startsWith('grunt setup:'))).toBe(false);
});
