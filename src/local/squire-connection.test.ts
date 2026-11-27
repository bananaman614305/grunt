import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SignupProfileIsolationError,
  SignupSessionIsolationError,
  writeSignupSession
} from '@trusty-squire/mcp/signup';
import type { SignupSession } from '@trusty-squire/mcp/signup';
import { BrowserSquire } from './setup.js';
import { GRUNT_BROWSER_PROFILE_DIR, GRUNT_SIGNUP_SESSION_FILE, gruntSignupPaths } from './signup-mcp.js';

let dir: string;
const sampleSession: SignupSession = {
  apiBaseUrl: 'https://trusty-squire-api.fly.dev',
  accountId: 'acct_embedded_test',
  agentSessionToken: 'tok_embedded_session_secret_value',
  machineToken: 'mach_embedded_token_secret_value',
  savedAt: '2026-11-26T00:00:00.000Z',
  consentOperatorInboxOtp: true
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-squire-connection-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', dir);
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('connects in-process using Grunt-owned isolated browser-profile and signup-session.json paths', async () => {
  const canonicalDir = realpathSync(dir);
  const ensureSession = vi.fn(async options => {
    expect(options.profileDir).toBe(join(canonicalDir, GRUNT_BROWSER_PROFILE_DIR));
    expect(options.sessionPath).toBe(join(canonicalDir, GRUNT_SIGNUP_SESSION_FILE));
    expect(options.agentIdentity).toBe('grunt');
    return {
      status: 'already_connected' as const,
      session: sampleSession,
      providers: ['google' as const],
      browserLocation: { kind: 'none' as const }
    };
  });

  const squire = new BrowserSquire({ directory: dir, embeddedRuntime: { ensureSession } });
  await squire.connect();
  expect(squire.connectState).toBe('existing');
  expect(ensureSession).toHaveBeenCalledOnce();
  await squire.close();
});

it('refuses paths aliasing Trusty Squire personal Chrome profile or personal session store', async () => {
  const personalSquireConfig = join(homedir(), '.config', 'trusty-squire');
  await expect(gruntSignupPaths(personalSquireConfig)).rejects.toThrow(SignupSessionIsolationError);

  const symlinkDir = await mkdtemp(join(tmpdir(), 'grunt-squire-symlink-'));
  try {
    await symlink(join(homedir(), '.trusty-squire', 'chrome-profile'), join(symlinkDir, GRUNT_BROWSER_PROFILE_DIR));
    await expect(gruntSignupPaths(symlinkDir)).rejects.toThrow(SignupProfileIsolationError);
  } finally {
    await rm(symlinkDir, { recursive: true, force: true });
  }
});

it('stops before interactive sign-in when GRUNT_SETUP_NO_HUMAN=1 and no saved session exists', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const ensureSession = vi.fn();
  const squire = new BrowserSquire({ directory: dir, embeddedRuntime: { ensureSession } });
  await expect(squire.connect()).rejects.toThrow('Squire login needs human verification; stopped before onboarding');
  expect(ensureSession).not.toHaveBeenCalled();
  await squire.close();
});

it('reuses a saved isolated session when GRUNT_SETUP_NO_HUMAN=1 without starting a browser ceremony', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const { sessionPath } = await gruntSignupPaths(dir);
  await writeSignupSession(sessionPath, sampleSession);

  const ensureSession = vi.fn(async (_options, runtime) => {
    expect(runtime?.issueMachineToken).toBeTypeOf('function');
    return {
      status: 'already_connected' as const,
      session: sampleSession,
      providers: ['google' as const],
      browserLocation: { kind: 'none' as const }
    };
  });
  const squire = new BrowserSquire({ directory: dir, embeddedRuntime: { ensureSession } });
  await squire.connect();
  expect(squire.connectState).toBe('existing');
  expect(ensureSession).toHaveBeenCalledOnce();
  await squire.close();
});

const secrets = [
  'sk-fake-short-secret',
  'gsk_fake_short_secret',
  'ghp_fake_short_secret',
  'eyJfake.short.signature.payload',
  'fake-bearer-token',
  'a'.repeat(40)
];

it('redacts secrets and bounds embedded sign-in errors to a single clean line', async () => {
  const dirtyReason = `Embedded sign-in failed:\n${secrets.slice(0, 4).join(' ')} Bearer ${secrets[4]} ${secrets[5]} ${'more detail '.repeat(40)}`;
  const ensureSession = vi.fn(async () => ({
    status: 'timed_out' as const,
    confirmUrl: 'https://trusty-squire.example/confirm',
    browserLocation: { kind: 'host_screen' as const },
    reason: dirtyReason
  }));
  const squire = new BrowserSquire({ directory: dir, embeddedRuntime: { ensureSession } });
  const error = await squire.connect().then(() => undefined, err => err as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain('Could not connect Grunt embedded signup session');
  expect(error!.message).toContain('[redacted]');
  expect(error!.message).not.toMatch(/[\r\n]/);
  expect(error!.message.length).toBeLessThanOrEqual(300);
  for (const secret of secrets) {
    expect(error!.message).not.toContain(secret);
  }
  await squire.close();
});
