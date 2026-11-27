import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SignupProfileIsolationError,
  SignupSessionIsolationError
} from '@trusty-squire/mcp/signup';
import type { SignupRunRuntime, SignupSession } from '@trusty-squire/mcp/signup';
import { recordDataSharingConsent } from './data-sharing.js';
import { BrowserSquire, setup } from './setup.js';
import {
  GRUNT_BROWSER_PROFILE_DIR,
  GRUNT_SIGNUP_SESSION_FILE,
  gruntSignupPaths,
  runEmbeddedSignup
} from './signup-mcp.js';
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

type RuntimeDriveFn = NonNullable<SignupRunRuntime['runDrive']>;
type RuntimeCreateBrowserFn = NonNullable<SignupRunRuntime['createBrowser']>;
type RuntimeCreateApiClientFn = NonNullable<SignupRunRuntime['createApiClient']>;
type RuntimeStartHarnessFn = NonNullable<SignupRunRuntime['startHarnessSession']>;
type RuntimeFinishSessionFn = NonNullable<SignupRunRuntime['finishSession']>;
type RuntimeForceFinishSessionFn = NonNullable<SignupRunRuntime['forceFinishSession']>;
type RuntimeActFn = NonNullable<SignupRunRuntime['act']>;
type RuntimeObserveFn = NonNullable<SignupRunRuntime['observe']>;

function createRealSessionRuntime(input: {
  onDrive: (
    args: Parameters<RuntimeDriveFn>[0],
    context: NonNullable<Parameters<RuntimeDriveFn>[2]>,
    deps: NonNullable<Parameters<RuntimeDriveFn>[3]>,
    state: {
      browserStarts: number;
      browserCloses: number;
      harnessStarts: number;
      finishCalls: number;
      forceFinishCalls: number;
      activeSessionId?: string;
      profileDirs: string[];
    }
  ) => ReturnType<RuntimeDriveFn>;
  onAct?: RuntimeActFn;
  onObserve?: RuntimeObserveFn;
  onStartHarness?: (opts: Parameters<RuntimeStartHarnessFn>[0], sessionId: string) => void;
  onBrowserClose?: () => void;
  onFinish?: (sessionId: string) => void;
}) {
  let seq = 0;
  const state: {
    browserStarts: number;
    browserCloses: number;
    harnessStarts: number;
    finishCalls: number;
    forceFinishCalls: number;
    activeSessionId?: string;
    profileDirs: string[];
    currentUrls: Map<string, string>;
  } = {
    browserStarts: 0,
    browserCloses: 0,
    harnessStarts: 0,
    finishCalls: 0,
    forceFinishCalls: 0,
    profileDirs: [],
    currentUrls: new Map()
  };

  const signupRuntime: SignupRunRuntime = {
    createBrowser: ((opts => {
      if (opts.profileDir) state.profileDirs.push(opts.profileDir);
      return {
        start: vi.fn(async () => { state.browserStarts += 1; }),
        goto: vi.fn(async () => {}),
        close: vi.fn(async () => {
          state.browserCloses += 1;
          input.onBrowserClose?.();
        })
      };
    }) as unknown) as RuntimeCreateBrowserFn,
    createApiClient: (() => ({
      setRequestingAgent: vi.fn()
    })) as unknown as RuntimeCreateApiClientFn,
    startHarnessSession: (async opts => {
      state.harnessStarts += 1;
      const sessionId = `prov-session-${++seq}`;
      state.activeSessionId = sessionId;
      state.currentUrls.set(sessionId, opts.serviceUrl);
      input.onStartHarness?.(opts, sessionId);
      return {
        session_id: sessionId,
        url: opts.serviceUrl,
        safe_table: []
      };
    }) as RuntimeStartHarnessFn,
    finishSession: (async sessionId => {
      state.finishCalls += 1;
      if (state.activeSessionId === sessionId) delete state.activeSessionId;
      input.onFinish?.(sessionId);
      return { closed: true, session_id: sessionId };
    }) as unknown as RuntimeFinishSessionFn,
    forceFinishSession: (async sessionId => {
      state.forceFinishCalls += 1;
      if (state.activeSessionId === sessionId) delete state.activeSessionId;
      return { closed: true, session_id: sessionId };
    }) as unknown as RuntimeForceFinishSessionFn,
    observedHostsForSession: sessionId => {
      const href = state.currentUrls.get(sessionId);
      return href ? [new URL(href).hostname] : [];
    },
    currentProvisionUrl: sessionId => state.currentUrls.get(sessionId) ?? 'https://example.invalid',
    ...(input.onAct ? { act: input.onAct } : {}),
    ...(input.onObserve ? { observe: input.onObserve } : {}),
    runDrive: (async (args, _api, context, deps) => {
      return await input.onDrive(args, context!, deps!, state);
    }) as RuntimeDriveFn
  };

  return { signupRuntime, state };
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
  const paths = await gruntSignupPaths(directory);
  expect(paths.profileDir).toBe(join(canonicalDir, GRUNT_BROWSER_PROFILE_DIR));
  expect(paths.sessionPath).toBe(join(canonicalDir, GRUNT_SIGNUP_SESSION_FILE));
  expect(paths.profileDir).not.toContain('.trusty-squire');
  expect(paths.sessionPath).not.toContain('trusty-squire');

  // Personal Trusty Squire session store directory is rejected.
  const squireConfig = join(homedir(), '.config', 'trusty-squire');
  await expect(gruntSignupPaths(squireConfig)).rejects.toThrow(SignupSessionIsolationError);

  // Symlink aliasing Trusty Squire's personal Chrome profile is rejected.
  const aliasDir = await mkdtemp(join(tmpdir(), 'grunt-alias-profile-'));
  try {
    await symlink(join(homedir(), '.trusty-squire', 'chrome-profile'), join(aliasDir, GRUNT_BROWSER_PROFILE_DIR));
    await expect(gruntSignupPaths(aliasDir)).rejects.toThrow(SignupProfileIsolationError);
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

  const { signupRuntime, state } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      const obs = await deps.startSession({ serviceUrl: args.url! });
      await context.persistCredentials!({
        url: 'https://zro.moonmath.ai/overview',
        credentials: { api_key: secret },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: `Captured key ${secret}`,
        remaining: '',
        reason: `Stored ${secret}`,
        steps: 3,
        seconds: 1.2,
        jev_calls: 2,
        trajectory: [],
        observation: { session_id: obs.session_id, url: 'https://zro.moonmath.ai/overview', safe_table: [] }
      };
    }
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

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
  const notes: string[] = [];
  try {
    await squire.connect();
    await setup(line => notes.push(line), ['zro'], { squire, directory });
  } finally {
    await squire.close();
  }

  expect(ensureSession).toHaveBeenCalledOnce();
  expect(state.profileDirs).toEqual([join(canonicalDir, 'browser-profile')]);
  expect(state.browserStarts).toBe(1);
  expect(state.browserCloses).toBe(1);
  expect(state.finishCalls).toBe(1);

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

  const { signupRuntime } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      const obs = await deps.startSession({ serviceUrl: args.url! });
      await context.persistCredentials!({
        url: 'https://www.runcrate.ai/dashboard/api-keys',
        credentials: { api_key: activeKey },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: 'captured',
        remaining: '',
        steps: 2,
        seconds: 1,
        jev_calls: 1,
        trajectory: [],
        observation: { session_id: obs.session_id, url: 'https://www.runcrate.ai/dashboard/api-keys', safe_table: [] }
      };
    }
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
  const unsafeSquire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
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
  const safeSquire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
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

  const { signupRuntime } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      const obs = await deps.startSession({ serviceUrl: args.url! });
      const service = args.url!.includes('beatapi') ? 'beatapi' : args.url!.includes('pollinations') ? 'pollinations' : 'goedel';
      await context.persistCredentials!({
        url: args.url!,
        credentials: { api_key: keys[service] },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: 'captured',
        remaining: '',
        steps: 2,
        seconds: 1,
        jev_calls: 1,
        trajectory: [],
        observation: { session_id: obs.session_id, url: args.url!, safe_table: [] }
      };
    }
  });

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
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
  const { signupRuntime, state } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      const obs = await deps.startSession({ serviceUrl: args.url! });
      await context.persistCredentials!({
        url: args.url!,
        credentials: { api_key: leaked },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'stuck',
        session_id: obs.session_id,
        done: '',
        remaining: `Check ${leaked}`,
        reason: `Upstream echoed ${leaked} in error`,
        question: `Did you save ${leaked}?`,
        steps: 2,
        seconds: 1,
        jev_calls: 1,
        trajectory: [],
        observation: {
          session_id: obs.session_id,
          url: args.url!,
          safe_table: [['e1', 't', `Revealed ${leaked}`]]
        }
      };
    }
  });

  const { driveResult, signupResult } = await runEmbeddedSignup(
    {
      provider: 'groq',
      url: 'https://console.groq.com/keys',
      goal: 'Create a free Groq API key',
      directory,
      session: embeddedSession
    },
    { signupRuntime }
  );

  expect(state.browserStarts).toBe(1);
  expect(state.browserCloses).toBe(1);
  expect(state.finishCalls).toBe(1);
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
  const { signupRuntime } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      const obs = await deps.startSession({ serviceUrl: args.url! });
      await context.persistCredentials!({
        url: 'https://opencode.ai/auth',
        credentials: { api_key: opencodeSecret },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: 'captured',
        remaining: '',
        steps: 2,
        seconds: 1,
        jev_calls: 1,
        trajectory: [],
        observation: { session_id: obs.session_id, url: 'https://opencode.ai/auth', safe_table: [] }
      };
    }
  });
  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
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

it('answers a key-name needs_value prompt inside the same open dialog and live browser session before writing to vault.json', async () => {
  const secret = 'sk-zro-same-dialog-live-key-991122';
  let dialogSeq = 0;
  let openDialog: { id: string; sessionId: string; submittedKeyName?: string } | undefined;
  let turnCount = 0;
  const seenDriveArgs: Parameters<RuntimeDriveFn>[0][] = [];

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const { signupRuntime, state } = createRealSessionRuntime({
    onStartHarness: (_opts, sessionId) => {
      // Transient modal dialog state that only exists on this live page instance.
      openDialog = { id: `key-dialog-${++dialogSeq}`, sessionId };
    },
    onBrowserClose: () => {
      // Closing Chrome destroys transient open dialog state.
      openDialog = undefined;
    },
    onFinish: () => {
      // Finishing the provision session closes the tab and destroys transient dialog state.
      openDialog = undefined;
    },
    onDrive: async (args, context, deps, runtimeState) => {
      turnCount += 1;
      seenDriveArgs.push({ ...args, ...(args.facts ? { facts: { ...args.facts } } : {}) });

      if (turnCount === 1) {
        expect(args.url).toBe('https://zro.moonmath.ai/overview');
        expect(args.session_id).toBeUndefined();
        const obs = await deps.startSession({ serviceUrl: args.url! });
        expect(openDialog).toEqual({ id: 'key-dialog-1', sessionId: obs.session_id });
        return {
          status: 'needs_value',
          session_id: obs.session_id,
          field: 'Alias',
          question: 'Enter a name for the new API key',
          options: { key_name: 'key_name' },
          done: 'Opened Create API Key dialog',
          remaining: 'Fill Alias field and submit dialog',
          reason: 'Missing value for Alias field',
          steps: 4,
          seconds: 1.5,
          jev_calls: 2,
          trajectory: [],
          observation: {
            session_id: obs.session_id,
            url: 'https://zro.moonmath.ai/api-keys',
            safe_table: [['e1', 't', 'Alias|in=Create API Key dialog']]
          }
        };
      }

      // Turn 2 must arrive on the EXACT SAME live browser, provision session, and open dialog.
      expect(runtimeState.browserStarts).toBe(1);
      expect(runtimeState.browserCloses).toBe(0);
      expect(runtimeState.harnessStarts).toBe(1);
      expect(runtimeState.finishCalls).toBe(0);
      expect(runtimeState.forceFinishCalls).toBe(0);
      expect(args.url).toBeUndefined();
      expect(args.session_id).toBe(runtimeState.activeSessionId);
      expect(openDialog).toBeDefined();
      expect(openDialog!.id).toBe('key-dialog-1');
      expect(openDialog!.sessionId).toBe(args.session_id);
      expect(args.answer).toBe('key_name');
      expect(args.facts?.Alias).toBe(args.facts?.key_name);

      // Submit the answered key name directly into the same open dialog and mint the key.
      openDialog!.submittedKeyName = args.facts!.Alias;
      await context.persistCredentials!({
        url: 'https://zro.moonmath.ai/api-keys',
        credentials: { api_key: secret },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);

      return {
        status: 'complete',
        session_id: args.session_id!,
        done: `Created key ${openDialog!.submittedKeyName} in ${openDialog!.id}`,
        remaining: '',
        steps: 2,
        seconds: 0.8,
        jev_calls: 1,
        trajectory: [],
        observation: {
          session_id: args.session_id!,
          url: 'https://zro.moonmath.ai/api-keys',
          safe_table: []
        }
      };
    }
  });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://zro.moonmath.ai/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secret}`);
    return Response.json({
      id: 'chatcmpl-zro-same-dialog',
      model: ZRO_DEEPSEEK,
      choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1 }
    });
  }));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
  try {
    await squire.connect();
    await setup(() => {}, ['zro'], { squire, directory });
  } finally {
    await squire.close();
  }

  expect(seenDriveArgs).toHaveLength(2);
  expect(seenDriveArgs[0]!.facts?.Alias).toBeUndefined();
  expect(seenDriveArgs[1]!.facts?.Alias).toBe(seenDriveArgs[0]!.facts?.key_name);
  expect(seenDriveArgs[1]!.answer).toBe('key_name');
  expect(seenDriveArgs[1]!.session_id).toBe('prov-session-1');

  // Browser and provision session were started once and torn down once at operate_finish.
  expect(state.browserStarts).toBe(1);
  expect(state.harnessStarts).toBe(1);
  expect(state.finishCalls).toBe(1);
  expect(state.forceFinishCalls).toBe(0);
  expect(state.browserCloses).toBe(1);

  expect(await readVaultEntry('zro', directory)).toMatchObject({
    api_key: secret,
    origin: 'https://zro.moonmath.ai',
    source: 'squire'
  });
  const receiptRaw = await readFile(join(directory, 'zro.json'), 'utf8');
  expect(receiptRaw).not.toContain(secret);
  expect(await readZroGrant(directory, {})).toMatchObject({ base_url: 'https://zro.moonmath.ai', token: secret });
});

it('keeps the same live browser session across OAuth choice, operate_click terms acceptance, and key-name resume turns', async () => {
  const secret = 'sk-zro-embedded-multiturn-live-776655';
  const clickedRefs: { sessionId: string; ref: string }[] = [];
  const driveAnswers: (string | undefined)[] = [];
  let turn = 0;

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const { signupRuntime, state } = createRealSessionRuntime({
    onAct: (async (sessionId, action) => {
      expect(action.kind).toBe('click');
      clickedRefs.push({ sessionId, ref: 'target' in action ? action.target : '' });
      return {
        session_id: sessionId,
        url: 'https://zro.moonmath.ai/api-keys',
        safe_table: [['k1', 't', 'Alias']]
      };
    }) as RuntimeActFn,
    onDrive: async (args, context, deps, runtimeState) => {
      turn += 1;
      driveAnswers.push(args.answer);

      if (turn === 1) {
        const obs = await deps.startSession({ serviceUrl: args.url! });
        return {
          status: 'low_confidence',
          session_id: obs.session_id,
          question: 'Choose a sign-in option',
          options: {
            google_oauth: 'Sign in with Google',
            email_login: 'Continue with Email'
          },
          done: '',
          remaining: 'Choose OAuth provider',
          reason: 'model confidence is below the drive threshold',
          steps: 2,
          seconds: 1.0,
          jev_calls: 1,
          trajectory: [],
          observation: {
            session_id: obs.session_id,
            url: 'https://zro.moonmath.ai/sign-in',
            safe_table: []
          }
        };
      }

      // Every resumed turn must run on the exact same browser and provision session.
      expect(runtimeState.browserStarts).toBe(1);
      expect(runtimeState.browserCloses).toBe(0);
      expect(runtimeState.harnessStarts).toBe(1);
      expect(runtimeState.finishCalls).toBe(0);
      expect(args.session_id).toBe('prov-session-1');

      if (turn === 2) {
        expect(args.answer).toBe('google_oauth');
        return {
          status: 'low_confidence',
          session_id: args.session_id!,
          question: 'Review Terms of Service',
          options: {},
          done: '',
          remaining: 'Accept required Terms of Service',
          reason: 'model confidence is below the drive threshold',
          steps: 2,
          seconds: 0.9,
          jev_calls: 1,
          trajectory: [],
          observation: {
            session_id: args.session_id!,
            url: 'https://zro.moonmath.ai/terms',
            safe_table: [['terms_btn', 'b', 'Accept Terms of Service']]
          }
        };
      }

      expect(clickedRefs).toEqual([{ sessionId: 'prov-session-1', ref: 'terms_btn' }]);
      await context.persistCredentials!({
        url: 'https://zro.moonmath.ai/api-keys',
        credentials: { api_key: secret },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: args.session_id!,
        done: 'Captured API key after OAuth and Terms acceptance',
        remaining: '',
        steps: 2,
        seconds: 0.7,
        jev_calls: 1,
        trajectory: [],
        observation: {
          session_id: args.session_id!,
          url: 'https://zro.moonmath.ai/api-keys',
          safe_table: []
        }
      };
    }
  });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
    id: 'chatcmpl-zro-multiturn',
    model: ZRO_DEEPSEEK,
    choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1 }
  })));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
  squire.useBatchSignup();
  try {
    await squire.connect();
    await setup(() => {}, ['zro'], { squire, directory });
  } finally {
    await squire.close();
  }

  expect(driveAnswers).toEqual([undefined, 'google_oauth', undefined]);
  expect(clickedRefs).toEqual([{ sessionId: 'prov-session-1', ref: 'terms_btn' }]);
  expect(state.browserStarts).toBe(1);
  expect(state.harnessStarts).toBe(1);
  expect(state.finishCalls).toBe(1);
  expect(state.browserCloses).toBe(1);
  expect(await readVaultEntry('zro', directory)).toMatchObject({
    api_key: secret,
    origin: 'https://zro.moonmath.ai',
    source: 'squire'
  });
});

it('tears down an open embedded session and releases the profile lease on cancel so a subsequent signup succeeds', async () => {
  const secret = 'sk-zro-after-cancel-recovery-332211';
  let firstStarted!: () => void;
  const firstInFlight = new Promise<void>(resolve => { firstStarted = resolve; });
  let callIndex = 0;

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const { signupRuntime, state } = createRealSessionRuntime({
    onDrive: async (args, context, deps) => {
      callIndex += 1;
      const obs = await deps.startSession({ serviceUrl: args.url! });
      if (callIndex === 1) {
        firstStarted();
        await new Promise<void>(resolve => {
          if (context.signal?.aborted) { resolve(); return; }
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'stuck',
          session_id: obs.session_id,
          done: '',
          remaining: 'cancelled',
          reason: 'cancelled',
          steps: 1,
          seconds: 0.2,
          jev_calls: 1,
          trajectory: []
        };
      }
      await context.persistCredentials!({
        url: 'https://zro.moonmath.ai/overview',
        credentials: { api_key: secret },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: 'captured',
        remaining: '',
        steps: 2,
        seconds: 0.5,
        jev_calls: 1,
        trajectory: [],
        observation: { session_id: obs.session_id, url: 'https://zro.moonmath.ai/overview', safe_table: [] }
      };
    }
  });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
    id: 'chatcmpl-zro-after-cancel',
    model: ZRO_DEEPSEEK,
    choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1 }
  })));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
  try {
    await squire.connect();
    const cancelledSignup = squire.signup('groq', 'https://console.groq.com/keys', 'Capture Groq key');
    await firstInFlight;
    await squire.cancelSignup('groq');
    await expect(cancelledSignup).rejects.toThrow(/cancelled/i);

    // First browser and provision session tore down cleanly and released the profile lease.
    expect(state.browserStarts).toBe(1);
    expect(state.finishCalls).toBe(1);
    expect(state.browserCloses).toBe(1);

    // Subsequent signup on the same profile directory acquires the lease cleanly and succeeds.
    await setup(() => {}, ['zro'], { squire, directory });
    expect(state.browserStarts).toBe(2);
    expect(state.finishCalls).toBe(2);
    expect(state.browserCloses).toBe(2);
    expect(await readVaultEntry('zro', directory)).toMatchObject({
      api_key: secret,
      origin: 'https://zro.moonmath.ai',
      source: 'squire'
    });
  } finally {
    await squire.close();
  }
});

it('lets a paused profile-lease holder resume its open dialog when queued signups fill all browser slots', async () => {
  const secrets = {
    zro: 'sk-zro-parallel-resume-secret-111111',
    groq: 'gsk_parallel_queued_secret_222222',
    cerebras: 'csk-parallel-queued-secret-333333',
    nvidia: 'nvapi-parallel-queued-secret-444444'
  } as const;
  const urls: Record<keyof typeof secrets, string> = {
    zro: 'https://zro.moonmath.ai/overview',
    groq: 'https://console.groq.com/keys',
    cerebras: 'https://cloud.cerebras.ai/platform/api-keys',
    nvidia: 'https://build.nvidia.com/settings/api-keys'
  };

  let zroTurn1Entered!: () => void;
  const zroPaused = new Promise<void>(resolve => { zroTurn1Entered = resolve; });
  let releaseZroTurn1!: () => void;
  const zroTurn1Gate = new Promise<void>(resolve => { releaseZroTurn1 = resolve; });

  let dialogSeq = 0;
  let openDialog: { id: string; sessionId: string; submittedKeyName?: string } | undefined;
  let zroTurns = 0;
  let activeBrowsers = 0;
  let peakConcurrentBrowsers = 0;
  const startedProviders: string[] = [];
  const queueEvents: { provider: string; state: 'waiting' | 'started' }[] = [];

  const ensureSession = vi.fn(async () => ({
    status: 'already_connected' as const,
    session: embeddedSession,
    providers: ['google' as const],
    browserLocation: { kind: 'none' as const }
  }));

  const providerForUrl = (href: string): keyof typeof secrets => {
    if (href.includes('zro.moonmath.ai')) return 'zro';
    if (href.includes('groq.com')) return 'groq';
    if (href.includes('cerebras.ai')) return 'cerebras';
    return 'nvidia';
  };

  const { signupRuntime, state } = createRealSessionRuntime({
    onStartHarness: (opts, sessionId) => {
      activeBrowsers += 1;
      peakConcurrentBrowsers = Math.max(peakConcurrentBrowsers, activeBrowsers);
      const provider = providerForUrl(opts.serviceUrl);
      startedProviders.push(provider);
      if (provider === 'zro') {
        openDialog = { id: `key-dialog-${++dialogSeq}`, sessionId };
      }
    },
    onBrowserClose: () => {
      activeBrowsers = Math.max(0, activeBrowsers - 1);
      openDialog = undefined;
    },
    onFinish: () => {
      openDialog = undefined;
    },
    onDrive: async (args, context, deps, runtimeState) => {
      if (args.session_id === 'prov-session-1') {
        // Zro turn 2 must resume the exact same live browser, provision session, and open dialog.
        zroTurns += 1;
        expect(zroTurns).toBe(2);
        expect(runtimeState.browserStarts).toBe(1);
        expect(runtimeState.browserCloses).toBe(0);
        expect(runtimeState.harnessStarts).toBe(1);
        expect(runtimeState.finishCalls).toBe(0);
        expect(args.url).toBeUndefined();
        expect(openDialog).toEqual({ id: 'key-dialog-1', sessionId: 'prov-session-1' });
        expect(args.answer).toBe('key_name');
        expect(args.facts?.Alias).toBe(args.facts?.key_name);

        openDialog!.submittedKeyName = args.facts!.Alias;
        await context.persistCredentials!({
          url: 'https://zro.moonmath.ai/api-keys',
          credentials: { api_key: secrets.zro },
          sources: []
        } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);

        return {
          status: 'complete',
          session_id: args.session_id,
          done: `Created key ${openDialog!.submittedKeyName} in ${openDialog!.id}`,
          remaining: '',
          steps: 2,
          seconds: 0.4,
          jev_calls: 1,
          trajectory: [],
          observation: {
            session_id: args.session_id,
            url: 'https://zro.moonmath.ai/api-keys',
            safe_table: []
          }
        };
      }

      const provider = providerForUrl(args.url!);
      const obs = await deps.startSession({ serviceUrl: args.url! });
      if (provider === 'zro') {
        zroTurns += 1;
        zroTurn1Entered();
        await zroTurn1Gate;
        return {
          status: 'needs_value',
          session_id: obs.session_id,
          field: 'Alias',
          question: 'Enter a name for the new API key',
          options: { key_name: 'key_name' },
          done: 'Opened Create API Key dialog',
          remaining: 'Fill Alias field and submit dialog',
          reason: 'Missing value for Alias field',
          steps: 3,
          seconds: 1.0,
          jev_calls: 2,
          trajectory: [],
          observation: {
            session_id: obs.session_id,
            url: 'https://zro.moonmath.ai/api-keys',
            safe_table: [['e1', 't', 'Alias|in=Create API Key dialog']]
          }
        };
      }

      await context.persistCredentials!({
        url: args.url!,
        credentials: { api_key: secrets[provider] },
        sources: []
      } as Parameters<NonNullable<typeof context.persistCredentials>>[0]);
      return {
        status: 'complete',
        session_id: obs.session_id,
        done: `Captured ${provider} key`,
        remaining: '',
        steps: 2,
        seconds: 0.3,
        jev_calls: 1,
        trajectory: [],
        observation: {
          session_id: obs.session_id,
          url: args.url!,
          safe_table: []
        }
      };
    }
  });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://zro.moonmath.ai/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secrets.zro}`);
    return Response.json({
      id: 'chatcmpl-zro-parallel-resume',
      model: ZRO_DEEPSEEK,
      choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1 }
    });
  }));

  const squire = new BrowserSquire({ directory, embeddedRuntime: { ensureSession, signupRuntime } });
  squire.onBrowserQueue((provider, queueState) => {
    queueEvents.push({ provider, state: queueState });
  });

  try {
    await squire.connect();

    const zroRun = setup(() => {}, ['zro'], { squire, directory });
    await zroPaused;

    // Launch 3 additional concurrent signups so all BROWSER_CONCURRENCY (3) slots
    // are occupied and the queue has waiting work while Zro holds the profile lease.
    const queuedRuns = [
      squire.signup('groq', urls.groq, 'Capture Groq API key'),
      squire.signup('cerebras', urls.cerebras, 'Capture Cerebras API key'),
      squire.signup('nvidia', urls.nvidia, 'Capture NVIDIA API key')
    ];

    await vi.waitFor(() => {
      expect(queueEvents.some(event => event.provider === 'nvidia' && event.state === 'waiting')).toBe(true);
    });

    // Release Zro turn 1 to pause on needs_value; Zro must resume its original
    // dialog instead of deadlocking behind the queued signups.
    releaseZroTurn1();

    await Promise.all([zroRun, ...queuedRuns]);
  } finally {
    await squire.close();
  }

  expect(zroTurns).toBe(2);
  expect(peakConcurrentBrowsers).toBe(1);
  expect(startedProviders).toEqual(['zro', 'groq', 'cerebras', 'nvidia']);
  expect(queueEvents).toContainEqual({ provider: 'nvidia', state: 'waiting' });
  expect(queueEvents).toContainEqual({ provider: 'nvidia', state: 'started' });
  expect(state.browserStarts).toBe(4);
  expect(state.harnessStarts).toBe(4);
  expect(state.finishCalls).toBe(4);
  expect(state.browserCloses).toBe(4);

  expect(await readVaultEntry('zro', directory)).toMatchObject({
    api_key: secrets.zro,
    origin: 'https://zro.moonmath.ai',
    source: 'squire'
  });
  expect(await readVaultEntry('groq', directory)).toMatchObject({
    api_key: secrets.groq,
    origin: 'https://api.groq.com',
    source: 'squire'
  });
  expect(await readVaultEntry('cerebras', directory)).toMatchObject({
    api_key: secrets.cerebras,
    origin: 'https://api.cerebras.ai',
    source: 'squire'
  });
  expect(await readVaultEntry('nvidia', directory)).toMatchObject({
    api_key: secrets.nvidia,
    origin: 'https://integrate.api.nvidia.com',
    source: 'squire'
  });
  const receiptRaw = await readFile(join(directory, 'zro.json'), 'utf8');
  expect(receiptRaw).not.toContain(secrets.zro);
  expect(await readZroGrant(directory, {})).toMatchObject({ base_url: 'https://zro.moonmath.ai', token: secrets.zro });
}, 10000);
