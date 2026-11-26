import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SignupProfileIsolationError,
  SignupSessionIsolationError
} from '@trusty-squire/mcp/signup';
import type { RunSignupOptions, SignupResult, SignupSession } from '@trusty-squire/mcp/signup';
import { recordDataSharingConsent } from './data-sharing.js';
import { BrowserSquire, setup } from './setup.js';
import { GRUNT_BROWSER_PROFILE_DIR, GRUNT_SIGNUP_SESSION_FILE, gruntSignupPaths, runEmbeddedSignup } from './signup-mcp.js';
import { SQUIRE_EGRESS_ORIGIN, credentialFingerprint, readVaultEntry, vaultPath } from './vault.js';
import { ZRO_DEEPSEEK, Zro, readZroGrant } from './zro.js';
import { RUNCRATE_BILLING_ORIGIN, RUNCRATE_DEEPSEEK, RUNCRATE_ORIGIN, Runcrate, RuncrateVerificationError, readRuncrateGrant } from './runcrate.js';
import { BEATAPI_MODELS, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant } from './beatapi.js';
import { setupBeatAPI } from './beatapi-setup.js';
import { POLLINATIONS_MODEL, POLLINATIONS_ORIGIN, pollinationsGrantPath, readPollinationsGrant } from './pollinations.js';
import { setupPollinations } from './pollinations-setup.js';
import { setupGoedel } from './goedel-setup.js';
import { Goedel } from './goedel.js';

let directory: string;

const embeddedSession: SignupSession = {
  apiBaseUrl: 'https://trusty-squire-api.fly.dev',
  accountId: 'acct_grunt_embedded',
  agentSessionToken: 'tok_grunt_embedded_secret',
  machineToken: 'mach_grunt_embedded_secret',
  savedAt: '2026-11-26T00:00:00.000Z',
  consentOperatorInboxOtp: true
};

function makeSuccessResult(options: RunSignupOptions, captured: boolean, extra: Partial<SignupResult> = {}): SignupResult {
  return {
    status: 'completed',
    service: options.service ?? 'unknown',
    url: options.url,
    captured,
    credentials: captured ? [{
      kind: 'api_key',
      service: options.service ?? 'unknown',
      url: options.url,
      captured: true,
      fieldNames: ['api_key'],
      source: 'extract',
      observedHosts: [new URL(options.url).hostname]
    }] : [],
    steps: 3,
    seconds: 1.2,
    jevCalls: 2,
    driveStatus: 'complete',
    trajectory: [],
    ...extra
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-embedded-signup-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('uses Grunt-owned isolated browser-profile and signup-session.json paths and blocks Squire personal paths', async () => {
  const canonicalDir = realpathSync(directory);
  const paths = gruntSignupPaths(directory);
  expect(paths.profileDir).toBe(join(canonicalDir, GRUNT_BROWSER_PROFILE_DIR));
  expect(paths.sessionPath).toBe(join(canonicalDir, GRUNT_SIGNUP_SESSION_FILE));
  expect(paths.profileDir).not.toContain('.trusty-squire');
  expect(paths.sessionPath).not.toContain('trusty-squire');

  // Personal Trusty Squire session store directory is rejected.
  const squireConfig = join(homedir(), '.config', 'trusty-squire');
  expect(() => gruntSignupPaths(squireConfig)).toThrow(SignupSessionIsolationError);

  // Symlink aliasing Trusty Squire's personal Chrome profile is rejected.
  const aliasDir = await mkdtemp(join(tmpdir(), 'grunt-alias-profile-'));
  try {
    await symlink(join(homedir(), '.trusty-squire', 'chrome-profile'), join(aliasDir, GRUNT_BROWSER_PROFILE_DIR));
    expect(() => gruntSignupPaths(aliasDir)).toThrow(SignupProfileIsolationError);
  } finally {
    await rm(aliasDir, { recursive: true, force: true });
  }
});

it('captures a Zro API key via onCredentialCaptured into vault.json and dispatches directly over HTTPS without leaking secrets', async () => {
  const secret = 'sk-zro-embedded-capture-secret-998877';
  const seenUrls: string[] = [];
  const seenAuth: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const canonicalDir = realpathSync(directory);
  const ensureSession = vi.fn(async options => {
    expect(options.profileDir).toBe(join(canonicalDir, 'browser-profile'));
    expect(options.sessionPath).toBe(join(canonicalDir, 'signup-session.json'));
    expect(options.agentIdentity).toBe('grunt');
    return {
      status: 'connected' as const,
      session: embeddedSession,
      providers: ['google' as const],
      browserLocation: { kind: 'host_screen' as const }
    };
  });

  const runSignup = vi.fn(async (options: RunSignupOptions) => {
    expect(options.profileDir).toBe(join(canonicalDir, 'browser-profile'));
    expect(options.session).toEqual(embeddedSession);
    expect(options.agentIdentity).toBe('grunt');
    await options.onCredentialCaptured({
      kind: 'api_key',
      service: 'zro',
      url: 'https://zro.moonmath.ai/overview',
      fields: { api_key: secret },
      fieldNames: ['api_key'],
      source: 'extract',
      observedHosts: ['zro.moonmath.ai'],
      capturedAt: new Date().toISOString()
    });
    return makeSuccessResult(options, true, {
      done: `Captured key ${secret}`,
      reason: `Stored ${secret}`
    });
  });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const href = String(url);
    seenUrls.push(href);
    seenAuth.push(new Headers(init?.headers).get('Authorization') ?? '');
    return Response.json({
      id: 'chatcmpl-zro-direct',
      model: ZRO_DEEPSEEK,
      choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1 }
    });
  }));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, runSignup } });
  const notes: string[] = [];
  try {
    await squire.connect();
    await setup(line => notes.push(line), ['zro'], { squire, directory });
  } finally {
    await squire.close();
  }

  expect(ensureSession).toHaveBeenCalledOnce();
  expect(runSignup).toHaveBeenCalledOnce();
  expect(await readVaultEntry('zro', directory)).toMatchObject({
    api_key: secret,
    origin: 'https://zro.moonmath.ai',
    source: 'squire'
  });
  expect((await stat(vaultPath(directory))).mode & 0o777).toBe(0o600);

  // zro.json receipt stays bound to vault without embedding raw secret.
  const zroReceiptRaw = await readFile(join(directory, 'zro.json'), 'utf8');
  expect(zroReceiptRaw).not.toContain(secret);
  expect(JSON.parse(zroReceiptRaw)).toMatchObject({
    base_url: 'https://zro.moonmath.ai',
    credential_source: 'vault',
    credential_sha256: credentialFingerprint({ base_url: 'https://zro.moonmath.ai', token: secret }),
    free_account_verified: true
  });
  expect(await readZroGrant(directory, {})).toMatchObject({ base_url: 'https://zro.moonmath.ai', token: secret });

  // Direct HTTPS dispatch to pinned Zro origin (never Squire egress proxy).
  const zro = new Zro({ directory });
  try {
    const completion = await zro.complete({
      model: 'zro', cwd: directory, messages: [{ role: 'user', content: 'hello' }], tools: [], stream: false
    }, new AbortController().signal);
    expect(completion.text).toBe('ready');
  } finally {
    await zro.close();
  }
  expect(seenUrls.every(href => href.startsWith('https://zro.moonmath.ai/') && !href.includes(SQUIRE_EGRESS_ORIGIN))).toBe(true);
  expect(seenAuth.every(header => header === `Bearer ${secret}`)).toBe(true);

  // Captured secret never leaked to notifications, stdout, stderr, or console.
  const allOutput = [
    ...notes,
    ...stdoutSpy.mock.calls.map(c => String(c[0])),
    ...stderrSpy.mock.calls.map(c => String(c[0])),
    ...logSpy.mock.calls.flat().map(String),
    ...errSpy.mock.calls.flat().map(String)
  ].join('\n');
  expect(allOutput).not.toContain(secret);
});

it('verifies Runcrate billing invariants on embedded capture and deletes unsafe captured keys from vault.json', async () => {
  await recordDataSharingConsent(directory, ['runcrate']);
  const safeKey = 'rc_live_embedded_safe_free_key_12345';
  const unsafeKey = 'rc_live_embedded_unsafe_paid_key_67890';
  let activeKey = unsafeKey;
  let autoRechargeEnabled = true;
  const seenUrls: string[] = [];

  const runSignup = vi.fn(async (options: RunSignupOptions) => {
    await options.onCredentialCaptured({
      kind: 'api_key',
      service: 'runcrate',
      url: 'https://www.runcrate.ai/dashboard/api-keys',
      fields: { api_key: activeKey },
      fieldNames: ['api_key'],
      source: 'extract',
      observedHosts: ['api.runcrate.ai', 'www.runcrate.ai'],
      capturedAt: new Date().toISOString()
    });
    return makeSuccessResult(options, true);
  });

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const href = String(url);
    seenUrls.push(href);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${activeKey}`);
    if (href === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/balance`) {
      return Response.json({ data: { creditsBalance: 0, activeUsageCost: 0 } });
    }
    if (href === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/auto-recharge`) {
      return Response.json({ data: { enabled: autoRechargeEnabled } });
    }
    if (href === `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/payment-methods`) {
      return Response.json({ data: [] });
    }
    if (href === `${RUNCRATE_ORIGIN}/v1/models`) {
      return Response.json({ data: [{ id: RUNCRATE_DEEPSEEK }] });
    }
    if (href === `${RUNCRATE_ORIGIN}/v1/chat/completions`) {
      return Response.json({
        id: 'chatcmpl-runcrate-direct',
        model: RUNCRATE_DEEPSEEK,
        choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }]
      });
    }
    return new Response('not found', { status: 404 });
  }));

  // 1. Unsafe captured key (auto-recharge enabled) is rejected and deleted from vault.json.
  const unsafeSquire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, runSignup } });
  try {
    await unsafeSquire.connect();
    await expect(setup(() => {}, ['runcrate'], { squire: unsafeSquire, directory, dataSharingApproved: ['runcrate'] }))
      .rejects.toBeInstanceOf(RuncrateVerificationError);
  } finally {
    await unsafeSquire.close();
  }
  expect(await readVaultEntry('runcrate', directory)).toBeUndefined();
  await expect(readRuncrateGrant(directory, {})).rejects.toThrow();

  // 2. Safe captured key (free account + top-ups disabled) persists to vault.json and writes vault-backed receipt.
  activeKey = safeKey;
  autoRechargeEnabled = false;
  seenUrls.length = 0;
  const safeSquire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, runSignup } });
  try {
    await safeSquire.connect();
    await setup(() => {}, ['runcrate'], { squire: safeSquire, directory, dataSharingApproved: ['runcrate'] });
  } finally {
    await safeSquire.close();
  }

  expect(await readVaultEntry('runcrate', directory)).toMatchObject({
    api_key: safeKey,
    origin: RUNCRATE_ORIGIN,
    source: 'squire'
  });
  const receiptRaw = await readFile(join(directory, 'runcrate.json'), 'utf8');
  expect(receiptRaw).not.toContain(safeKey);
  expect(JSON.parse(receiptRaw)).toMatchObject({
    base_url: RUNCRATE_ORIGIN,
    credential_source: 'vault',
    credential_sha256: credentialFingerprint({ base_url: RUNCRATE_ORIGIN, token: safeKey }),
    free_account_verified: true,
    key_topups_disabled: true
  });
  expect(seenUrls).toEqual([
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/balance`,
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/auto-recharge`,
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/payment-methods`,
    `${RUNCRATE_ORIGIN}/v1/models`,
    `${RUNCRATE_ORIGIN}/v1/chat/completions`
  ]);
  expect(await new Runcrate({ directory }).available()).toBe(true);
});

it('wires embedded capture into local Grunt vault for BeatAPI, Pollinations, and Goedel without Squire egress', async () => {
  await recordDataSharingConsent(directory, ['beatapi', 'pollinations', 'goedel']);
  const keys = {
    beatapi: 'sk-beatapi-embedded-direct-key-111',
    pollinations: 'sk-poll-embedded-direct-key-222',
    goedel: 'sk-gm-free-embedded-direct-key-333'
  };

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const runSignup = vi.fn(async (options: RunSignupOptions) => {
    const service = options.service as keyof typeof keys;
    await options.onCredentialCaptured({
      kind: 'api_key',
      service,
      url: options.url,
      fields: { api_key: keys[service] },
      fieldNames: ['api_key'],
      source: 'extract',
      observedHosts: [new URL(options.url).hostname],
      capturedAt: new Date().toISOString()
    });
    return makeSuccessResult(options, true);
  });

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, runSignup } });
  try {
    await squire.connect();

    // BeatAPI
    const beatFetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith(BEATAPI_ORIGIN)).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${keys.beatapi}`);
      return String(url).endsWith('/v1/models')
        ? Response.json({ data: BEATAPI_MODELS.map(id => ({ id })) })
        : Response.json({ data: { object: 'usage', credit_balance: 0, credits_settled: 0 } });
    });
    await setupBeatAPI({ directory, squire, fetcher: beatFetcher, dataSharingApproved: ['beatapi'] });
    expect(await readVaultEntry('beatapi', directory)).toMatchObject({ api_key: keys.beatapi, origin: BEATAPI_ORIGIN });
    expect(await readFile(beatapiGrantPath(directory), 'utf8')).not.toContain(keys.beatapi);
    expect(await readBeatAPIGrant(directory, {})).toMatchObject({ base_url: BEATAPI_ORIGIN, token: keys.beatapi, version: 2 });

    // Pollinations
    const pollFetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith(POLLINATIONS_ORIGIN)).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${keys.pollinations}`);
      const route = String(url).slice(POLLINATIONS_ORIGIN.length);
      if (route === '/account/key') return Response.json({ valid: true, type: 'secret', expiresAt: null, pollenBudget: 0, questPollenOnly: true, permissions: { models: null, account: ['usage'] } });
      if (route === '/account/balance') return Response.json({ balance: 0, accountBalance: { total: 0.25, tier: 0.25, paid: 0 } });
      return Response.json({ id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII', category: 'text', community: true, paid_only: false, pricing: { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] });
    });
    await setupPollinations({ directory, squire, fetcher: pollFetcher, dataSharingApproved: ['pollinations'] });
    expect(await readVaultEntry('pollinations', directory)).toMatchObject({ api_key: keys.pollinations, origin: POLLINATIONS_ORIGIN });
    expect(await readFile(pollinationsGrantPath(directory), 'utf8')).not.toContain(keys.pollinations);
    expect(await readPollinationsGrant(directory, {})).toMatchObject({ base_url: POLLINATIONS_ORIGIN, token: keys.pollinations });

    // Goedel (stores directly in vault.json and does not leave a legacy goedel.json file)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://api.goedelmachines.com/v1/key');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${keys.goedel}`);
      return Response.json({ data: { tier: 'free' } }, { headers: { 'X-Data-Policy': 'retained' } });
    }));
    const goedelNotes: string[] = [];
    await setupGoedel({ directory, squire, notify: line => goedelNotes.push(line), background: false });
    expect(await readVaultEntry('goedel', directory)).toMatchObject({ api_key: keys.goedel, origin: 'https://api.goedelmachines.com' });
    await expect(readFile(join(directory, 'goedel.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(goedelNotes.join('\n')).toContain('local Grunt vault');
    expect(goedelNotes.join('\n')).not.toContain(keys.goedel);
    expect(await new Goedel({ directory }).available()).toBe(true);
  } finally {
    await squire.close();
  }
});

it('redacts captured secrets from embedded signup transcripts and failure reasons', async () => {
  const leaked = 'sk-super-secret-transcript-token-987654321';
  const { driveResult, signupResult } = await runEmbeddedSignup(
    {
      provider: 'groq',
      url: 'https://console.groq.com/keys',
      goal: 'Create a free Groq API key',
      directory,
      session: embeddedSession
    },
    {
      runSignup: async options => {
        await options.onCredentialCaptured({
          kind: 'api_key',
          service: 'groq',
          url: options.url,
          fields: { api_key: leaked },
          fieldNames: ['api_key'],
          source: 'extract',
          observedHosts: ['api.groq.com'],
          capturedAt: new Date().toISOString()
        });
        return makeSuccessResult(options, true, {
          status: 'failed',
          driveStatus: 'stuck',
          reason: `Upstream echoed ${leaked} in error`,
          remaining: `Check ${leaked}`,
          question: `Did you save ${leaked}?`
        });
      }
    }
  );

  expect(JSON.stringify(driveResult)).not.toContain(leaked);
  expect(JSON.stringify(signupResult)).not.toContain(leaked);
  expect(await readVaultEntry('groq', directory)).toMatchObject({
    api_key: leaked,
    origin: 'https://api.groq.com',
    source: 'squire'
  });
});

it('captures OpenCode API keys in-process without Squire cloud vault and clears in-memory secrets on close', async () => {
  const opencodeSecret = 'sk-opencode-embedded-secret-445566';
  const runSignup = vi.fn(async (options: RunSignupOptions) => {
    await options.onCredentialCaptured({
      kind: 'api_key',
      service: 'opencode',
      url: 'https://opencode.ai/auth',
      fields: { api_key: opencodeSecret },
      fieldNames: ['api_key'],
      source: 'extract',
      observedHosts: ['opencode.ai'],
      capturedAt: new Date().toISOString()
    });
    return makeSuccessResult(options, true);
  });
  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, runSignup } });
  await squire.connect();
  await squire.signup('opencode', 'https://opencode.ai/auth', 'Capture OpenCode Zen API key');
  const listed = await squire.credentials.list();
  const match = listed.find(item => item.service === 'opencode');
  expect(match).toBeDefined();
  expect(JSON.stringify(listed)).not.toContain(opencodeSecret);
  expect(await squire.credentials.grant(match!.reference)).toEqual({
    base_url: 'https://opencode.ai',
    token: opencodeSecret
  });
  await squire.close();
});
