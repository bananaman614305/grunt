import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

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

it('carries the provider page\'s own refusal words into the setup result', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  await recordDataSharingConsent(directory, ['fikra']);
  const page = '{"detail": "This network has been blocked for automated signup abuse.", "code": "source_blocked"}';
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'stuck', session_id: 'fikra-tab', observation: { url: 'https://fikraapi.co.ke/account/signup', dom: page, safe_table: [] } }
    : {});
  const settled: (string | undefined)[] = [];
  const setupProvider = async () => { await squire.signup('fikra', 'https://fikraapi.co.ke/account/signup', 'Capture one key'); };
  await setupFallbacks({ directory, squire, adapters: ['fikra'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider, onSettled: (_id, _ok, reason) => { settled.push(reason); } });
  expect(settled).toEqual(['browser could not continue; the page says: This network has been blocked for automated signup abuse.']);
});

it('does not quote page text while the page still offers controls', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'stuck', session_id: 'zro-tab', observation: { dom: 'Welcome back, person@example.com', safe_table: [['@e1', 'b', 'Continue']] } }
    : {});
  const setupProvider = async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); };
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider });
  expect(squire.signupFailure('zro')).toBe('browser could not continue');
});

it('names the real Runcrate failure instead of a fixed GitHub-age message', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  const lines: string[] = [];
  const setupProvider = async () => { throw new Error('Squire operate_drive is unavailable; resume setup after reconnecting Squire'); };
  await setupFallbacks({ directory, squire, adapters: ['runcrate'], dataSharingApproved: ['runcrate'], signal: new AbortController().signal,
    notify: line => lines.push(line), connect: async () => {}, run: async () => {}, setupProvider });
  expect(lines).toContain('Runcrate free setup incomplete (Squire unavailable); rerun usegrunt setup to resume. Other routes remain available.');
  expect(lines.join('\n')).not.toContain('30 days');
});
