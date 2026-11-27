import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as SignupSdkModule from '@trusty-squire/mcp/signup';
import type {
  CapturedCredential,
  CreateSignupSessionOptions,
  EmbeddedSignupSession,
  SignupCeremonyOpenInfo,
  SignupConnectRuntime,
  SignupDriveOptions,
  SignupObservationSummary,
  SignupResult,
  SignupRunRuntime,
  SignupSession,
  createSignupSession as createSignupSessionFn,
  ensureSignupSession as ensureSignupSessionFn,
  readSignupSession as readSignupSessionFn,
  runSignup as runSignupFn
} from '@trusty-squire/mcp/signup';
import { configRoot } from '../brand.js';
import { isDeclarativeAdapter, safePublicHttpsOrigin } from '../registry.js';
import type { Registry } from '../registry.js';
import { squireClientPath } from './squire-client-path.js';
import {
  defaultProviderOrigin,
  extractCredentialSecret,
  isVaultProvider,
  redactVaultSecrets,
  validateDirectOrigin,
  validateVaultToken,
  writeVaultEntry
} from './vault.js';
import type { VaultProvider } from './vault.js';

export type {
  CapturedCredential,
  CreateSignupSessionOptions,
  EmbeddedSignupSession,
  SignupCeremonyOpenInfo,
  SignupConnectRuntime,
  SignupDriveOptions,
  SignupObservationSummary,
  SignupResult,
  SignupRunRuntime,
  SignupSession
};

export const GRUNT_BROWSER_PROFILE_DIR = 'browser-profile';
export const GRUNT_SIGNUP_SESSION_FILE = 'signup-session.json';
export const EMBEDDED_DRIVE_GOAL_LIMIT = 4000;

type SignupSdk = typeof SignupSdkModule;

let cachedSignupSdk: Promise<SignupSdk> | undefined;

/**
 * Lazily loads `@trusty-squire/mcp/signup` so the standalone bundled background
 * daemon (`dist/local/daemon.mjs`) starts with zero `node_modules` dependencies
 * and resolves the CLI-owned package path only if embedded signup is invoked.
 */
export function loadEmbeddedSignupSdk(directory = configRoot()): Promise<SignupSdk> {
  if (typeof GRUNT_DAEMON_BUNDLE === 'undefined') {
    return cachedSignupSdk ??= import('@trusty-squire/mcp/signup');
  }
  return import('@trusty-squire/mcp/signup').catch(async () => {
    const binPath = await squireClientPath(directory);
    const signupEntry = join(dirname(binPath), 'signup.js');
    return await import(pathToFileURL(signupEntry).href) as SignupSdk;
  });
}

const SIGNUP_CONFIG_ERROR_NAMES = new Set([
  'SignupConfigError',
  'SignupProfileIsolationError',
  'SignupSessionIsolationError'
]);

export function isSignupConfigError(error: unknown): boolean {
  return error instanceof Error && SIGNUP_CONFIG_ERROR_NAMES.has(error.name);
}

export interface EmbeddedSignupRuntime {
  ensureSession?: typeof ensureSignupSessionFn;
  createSignupSession?: typeof createSignupSessionFn;
  runSignup?: typeof runSignupFn;
  readSession?: typeof readSignupSessionFn;
  connectRuntime?: SignupConnectRuntime;
  signupRuntime?: SignupRunRuntime;
}

export interface InMemoryCapturedGrant {
  provider: string;
  base_url: string;
  token: string;
  label: string;
  allowed_hosts: string[];
}

export interface PersistedCaptureSummary {
  provider: string;
  origin: string;
  storedInVault: boolean;
}

export interface EmbeddedDriveOutcome {
  driveResult: Record<string, unknown>;
  signupResult: SignupResult;
}

export interface ManagedEmbeddedSignupSession {
  readonly provider: string;
  readonly profileDir: string;
  readonly sessionId: string | null;
  readonly currentUrl: string | null;
  readonly closed: boolean;
  drive(options: {
    url?: string;
    goal: string;
    facts?: Record<string, string>;
    answer?: string;
    maxSteps?: number;
    maxSeconds?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<EmbeddedDriveOutcome>;
  click(ref: string): Promise<SignupObservationSummary>;
  observe(format?: 'compact' | 'full'): Promise<SignupObservationSummary>;
  close(): Promise<void>;
}

const SERVICE_TO_VAULT_PROVIDER: Record<string, VaultProvider> = {
  '100milionseek': 'millionseek',
  'goedel machines': 'goedel'
};

/**
 * Maps a signup service name (which may differ from the adapter id, e.g.
 * `100milionseek`) to its canonical local Grunt vault provider id.
 */
export function vaultProviderForService(service: string): VaultProvider | undefined {
  const normalized = service.trim().toLowerCase();
  if (Object.hasOwn(SERVICE_TO_VAULT_PROVIDER, normalized)) {
    return SERVICE_TO_VAULT_PROVIDER[normalized];
  }
  return isVaultProvider(normalized) ? normalized : undefined;
}

/**
 * Resolves Grunt-owned isolated paths under `configDir()` for the Chrome
 * profile and embedded signup session file. Refuses any path that aliases
 * Trusty Squire's personal profile or personal session store.
 */
export async function gruntSignupPaths(directory = configRoot()): Promise<{ profileDir: string; sessionPath: string }> {
  const sdk = await loadEmbeddedSignupSdk(directory);
  return {
    profileDir: sdk.assertIsolatedProfileDir(join(directory, GRUNT_BROWSER_PROFILE_DIR)),
    sessionPath: sdk.assertIsolatedSessionPath(join(directory, GRUNT_SIGNUP_SESSION_FILE))
  };
}

/**
 * Ensures Grunt's isolated embedded signup session and Google profile exist
 * directly in-process via `@trusty-squire/mcp/signup`, never starting or
 * touching Trusty Squire's personal Chrome profile, session store, or broker.
 */
export async function ensureEmbeddedSignupSession(
  options: {
    directory?: string;
    signal?: AbortSignal;
    noHuman?: boolean;
    background?: boolean;
    onSignInOpen?: (info: SignupCeremonyOpenInfo) => Promise<void> | void;
  } = {},
  runtime: EmbeddedSignupRuntime = {}
): Promise<{ state: 'existing' | 'installed'; session: SignupSession; profileDir: string; sessionPath: string }> {
  options.signal?.throwIfAborted();
  const directory = options.directory ?? configRoot();
  const sdk = await loadEmbeddedSignupSdk(directory);
  const { profileDir, sessionPath } = await gruntSignupPaths(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();

  const nonInteractive = options.noHuman === true || options.background === true;
  if (nonInteractive) {
    const existing = await (runtime.readSession ?? sdk.readSignupSession)(sessionPath);
    if (!sdk.isCompleteSignupSession(existing)) {
      throw new Error('Squire login needs human verification; stopped before onboarding');
    }
  }

  const blockInteractiveLogin = async (): Promise<never> => {
    throw new Error('Squire login needs human verification; stopped before onboarding');
  };
  const connectRuntime: SignupConnectRuntime | undefined = nonInteractive
    ? {
        ...runtime.connectRuntime,
        detectAsn: async () => null,
        issueMachineToken: blockInteractiveLogin,
        installInitiate: blockInteractiveLogin
      }
    : runtime.connectRuntime;

  const ensure = runtime.ensureSession ?? sdk.ensureSignupSession;
  const result = await ensure(
    {
      profileDir,
      sessionPath,
      agentIdentity: 'grunt',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onSignInOpen ? { onSignInOpen: options.onSignInOpen } : {})
    },
    connectRuntime
  );
  options.signal?.throwIfAborted();

  if (result.status === 'already_connected' || result.status === 'connected') {
    return {
      state: result.status === 'already_connected' ? 'existing' : 'installed',
      session: result.session,
      profileDir,
      sessionPath
    };
  }
  const safeReason = redactVaultSecrets(('reason' in result && result.reason) || `Embedded sign-in ended with status ${result.status}`);
  throw new Error(safeReason);
}

/**
 * Persists a captured provider API key from `@trusty-squire/mcp/signup`'s
 * `onCredentialCaptured` callback straight into Grunt's private mode-0600
 * local vault with its exact pinned HTTPS origin (or in-memory for non-vault
 * providers such as OpenCode or declarative adapters). Never logs secrets.
 */
export async function persistCapturedCredential(input: {
  provider: string;
  credential: CapturedCredential;
  directory?: string;
  registry?: Registry;
  fallbackUrl?: string;
  storeInMemory?: (grant: InMemoryCapturedGrant) => void;
}): Promise<PersistedCaptureSummary | undefined> {
  if (input.credential.kind !== 'api_key') return undefined;
  const directory = input.directory ?? configRoot();
  const vaultProvider = vaultProviderForService(input.provider) ?? vaultProviderForService(input.credential.service);
  const keyLookupName = vaultProvider ?? input.provider;
  const rawSecret = extractCredentialSecret(input.credential.fields, keyLookupName);
  if (!rawSecret) {
    throw new Error(`Captured ${input.provider} credential did not contain a usable API key`);
  }
  const secret = validateVaultToken(rawSecret);

  if (vaultProvider) {
    const origin = validateDirectOrigin(vaultProvider, defaultProviderOrigin(vaultProvider));
    await writeVaultEntry(vaultProvider, { api_key: secret, origin, source: 'squire' }, directory);
    return { provider: vaultProvider, origin, storedInVault: true };
  }

  const declarative = input.registry?.adapters.find(adapter => adapter.id === input.provider);
  if (isDeclarativeAdapter(declarative)) {
    const origin = safePublicHttpsOrigin(declarative.declarative.baseUrl);
    if (!origin) throw new Error(`Invalid declarative API origin for ${input.provider}`);
    input.storeInMemory?.({
      provider: input.provider,
      base_url: origin,
      token: secret,
      label: 'Grunt Free',
      allowed_hosts: [new URL(origin).hostname]
    });
    return { provider: input.provider, origin, storedInVault: false };
  }

  if (input.provider.trim().toLowerCase() === 'opencode') {
    const origin = 'https://opencode.ai';
    input.storeInMemory?.({
      provider: 'opencode',
      base_url: origin,
      token: secret,
      label: 'grunt',
      allowed_hosts: ['opencode.ai']
    });
    return { provider: 'opencode', origin, storedInVault: false };
  }

  const candidateUrl = input.fallbackUrl || input.credential.url;
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    throw new Error(`Could not determine pinned HTTPS origin for ${input.provider}`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`Untrusted origin scheme for ${input.provider}`);
  }
  input.storeInMemory?.({
    provider: input.provider,
    base_url: parsed.origin,
    token: secret,
    label: 'grunt',
    allowed_hosts: [parsed.hostname]
  });
  return { provider: input.provider, origin: parsed.origin, storedInVault: false };
}

// Chrome enforces exclusive custody per user-data-dir. Hold an exclusive lease
// per Grunt profile directory for the full lifetime of each live embedded
// signup session so concurrent provider setups never collide on ProfileBusyError
// while multi-turn resumes keep the same browser tab and open dialog alive.
interface ProfileLeaseState {
  held: boolean;
  waiters: { grant(): void }[];
}

const profileLeases = new Map<string, ProfileLeaseState>();

function acquireProfileLease(profileDir: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  let state = profileLeases.get(profileDir);
  if (!state) {
    state = { held: false, waiters: [] };
    profileLeases.set(profileDir, state);
  }

  const createRelease = (leaseState: ProfileLeaseState) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = leaseState.waiters.shift();
      if (next) {
        next.grant();
      } else {
        leaseState.held = false;
        if (profileLeases.get(profileDir) === leaseState) {
          profileLeases.delete(profileDir);
        }
      }
    };
  };

  if (!state.held) {
    state.held = true;
    return Promise.resolve(createRelease(state));
  }

  const leaseState = state;
  return new Promise<() => void>((resolve, reject) => {
    const waiter = {
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(createRelease(leaseState));
      }
    };
    const onAbort = () => {
      const index = leaseState.waiters.indexOf(waiter);
      if (index !== -1) leaseState.waiters.splice(index, 1);
      if (!leaseState.held && leaseState.waiters.length === 0 && profileLeases.get(profileDir) === leaseState) {
        profileLeases.delete(profileDir);
      }
      reject(signal?.reason ?? new Error('Provider signup cancelled'));
    };
    leaseState.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function mapEmbeddedDriveStatus(result: SignupResult): string {
  if (result.status === 'completed') return 'complete';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.driveStatus) return result.driveStatus;
  switch (result.status) {
    case 'budget_exceeded': return 'budget';
    case 'needs_input': return 'needs_value';
    case 'needs_human': return 'needs_human';
    case 'low_confidence': return 'low_confidence';
    case 'stuck': return 'stuck';
    case 'failed': return 'failed';
  }
}

function formatEmbeddedDriveResult(
  sdk: SignupSdk,
  signupResult: SignupResult,
  capturedSecrets: ReadonlySet<string>
): EmbeddedDriveOutcome {
  const scrubbed = sdk.redactUnknownSecrets(signupResult, capturedSecrets);
  const scrubText = (value: string | undefined) =>
    value === undefined ? undefined : redactVaultSecrets(sdk.redactSecrets(value, capturedSecrets), [...capturedSecrets]);

  const driveResult: Record<string, unknown> = {
    status: mapEmbeddedDriveStatus(scrubbed),
    ...(scrubbed.url ? { url: scrubbed.url } : {}),
    captured: scrubbed.captured,
    credentials: scrubbed.credentials,
    ...(scrubbed.reason !== undefined ? { reason: scrubText(scrubbed.reason) } : {}),
    ...(scrubbed.remaining !== undefined ? { remaining: scrubText(scrubbed.remaining) } : {}),
    ...(scrubbed.field !== undefined ? { field: scrubText(scrubbed.field) } : {}),
    ...(scrubbed.question !== undefined ? { question: scrubText(scrubbed.question) } : {}),
    ...(scrubbed.options !== undefined ? { options: scrubbed.options } : {}),
    ...(scrubbed.probabilities !== undefined ? { probabilities: scrubbed.probabilities } : {}),
    ...(scrubbed.needsUser !== undefined ? { needs_user: scrubbed.needsUser } : {}),
    ...(scrubbed.oauth !== undefined ? { oauth: scrubbed.oauth } : {}),
    ...(scrubbed.observation !== undefined ? { observation: scrubbed.observation } : {})
  };
  return { driveResult, signupResult: scrubbed };
}

/**
 * Opens a live stateful embedded signup session via `@trusty-squire/mcp/signup`'s
 * `createSignupSession`, preserving the browser tab, open dialogs, and
 * provision session across `needs_value` / `low_confidence` resume turns until
 * `close()` or `AbortSignal` teardown.
 */
export async function openEmbeddedSignupSession(
  options: {
    provider: string;
    url?: string;
    facts?: Record<string, string>;
    directory?: string;
    session?: SignupSession;
    registry?: Registry;
    signal?: AbortSignal;
    storeInMemory?: (grant: InMemoryCapturedGrant) => void;
    onCaptured?: (summary: PersistedCaptureSummary) => void;
    onProgress?: (message: string, data?: Record<string, unknown>) => Promise<void> | void;
  },
  runtime: EmbeddedSignupRuntime = {}
): Promise<ManagedEmbeddedSignupSession> {
  options.signal?.throwIfAborted();
  const directory = options.directory ?? configRoot();
  const sdk = await loadEmbeddedSignupSdk(directory);
  const { profileDir, sessionPath } = await gruntSignupPaths(directory);
  const releaseLease = await acquireProfileLease(profileDir, options.signal);
  const capturedSecrets = new Set<string>();

  let signupSession: EmbeddedSignupSession;
  try {
    options.signal?.throwIfAborted();
    const createSession = runtime.createSignupSession ?? sdk.createSignupSession;
    signupSession = await createSession(
      {
        ...(options.url ? { url: options.url } : {}),
        service: options.provider,
        ...(options.facts && Object.keys(options.facts).length ? { facts: options.facts } : {}),
        profileDir,
        ...(options.session ? { session: options.session } : { sessionPath }),
        agentIdentity: 'grunt',
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        onCredentialCaptured: async credential => {
          for (const value of Object.values(credential.fields)) {
            if (typeof value === 'string' && value.trim().length > 0) {
              capturedSecrets.add(value);
            }
          }
          const summary = await persistCapturedCredential({
            provider: options.provider,
            credential,
            directory,
            ...(options.registry ? { registry: options.registry } : {}),
            ...(options.url ? { fallbackUrl: options.url } : {}),
            ...(options.storeInMemory ? { storeInMemory: options.storeInMemory } : {})
          });
          if (summary) options.onCaptured?.(summary);
        },
        onLoginCreated: async credential => {
          for (const value of Object.values(credential.fields)) {
            if (typeof value === 'string' && value.trim().length > 0) {
              capturedSecrets.add(value);
            }
          }
        }
      },
      runtime.signupRuntime
    );
  } catch (error) {
    releaseLease();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  let closed = false;

  const onSessionAbort = () => {
    void close();
  };

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    options.signal?.removeEventListener('abort', onSessionAbort);
    closePromise = (async () => {
      try {
        await signupSession.close();
      } finally {
        releaseLease();
      }
    })();
    return closePromise;
  };

  if (options.signal?.aborted) {
    await close();
  } else {
    options.signal?.addEventListener('abort', onSessionAbort, { once: true });
  }

  return {
    provider: options.provider,
    profileDir,
    get sessionId() { return signupSession.sessionId; },
    get currentUrl() { return signupSession.currentUrl; },
    get closed() { return closed || signupSession.closed; },
    async drive(turnOptions) {
      const result = await signupSession.drive({
        ...(turnOptions.url ? { url: turnOptions.url } : {}),
        goal: turnOptions.goal,
        ...(turnOptions.facts && Object.keys(turnOptions.facts).length ? { facts: turnOptions.facts } : {}),
        ...(turnOptions.answer !== undefined && turnOptions.answer.trim() ? { answer: turnOptions.answer.trim() } : {}),
        ...(turnOptions.maxSteps !== undefined ? { maxSteps: turnOptions.maxSteps } : {}),
        ...(turnOptions.maxSeconds !== undefined ? { maxSeconds: turnOptions.maxSeconds } : {}),
        ...(turnOptions.timeoutMs !== undefined ? { timeoutMs: turnOptions.timeoutMs } : {}),
        ...(turnOptions.signal ? { signal: turnOptions.signal } : {})
      });
      if (signupSession.closed) {
        await close();
      }
      return formatEmbeddedDriveResult(sdk, result, capturedSecrets);
    },
    async click(ref) {
      const summary = await signupSession.click(ref);
      return sdk.redactUnknownSecrets(summary, capturedSecrets);
    },
    async observe(format) {
      const summary = await signupSession.observe(format);
      return sdk.redactUnknownSecrets(summary, capturedSecrets);
    },
    close
  };
}

/**
 * Runs one single-shot embedded provider signup directly in-process via
 * `@trusty-squire/mcp/signup`, delivering captured API keys straight into
 * Grunt's local vault and redacting all secrets from transcripts.
 */
export async function runEmbeddedSignup(
  options: {
    provider: string;
    url: string;
    goal: string;
    facts?: Record<string, string>;
    directory?: string;
    session?: SignupSession;
    registry?: Registry;
    maxSteps?: number;
    maxSeconds?: number;
    signal?: AbortSignal;
    storeInMemory?: (grant: InMemoryCapturedGrant) => void;
    onCaptured?: (summary: PersistedCaptureSummary) => void;
    onProgress?: (message: string, data?: Record<string, unknown>) => Promise<void> | void;
  },
  runtime: EmbeddedSignupRuntime = {}
): Promise<EmbeddedDriveOutcome> {
  if (runtime.runSignup) {
    options.signal?.throwIfAborted();
    const directory = options.directory ?? configRoot();
    const sdk = await loadEmbeddedSignupSdk(directory);
    const { profileDir, sessionPath } = await gruntSignupPaths(directory);
    const releaseLease = await acquireProfileLease(profileDir, options.signal);
    const capturedSecrets = new Set<string>();
    try {
      options.signal?.throwIfAborted();
      const signupResult = await runtime.runSignup(
        {
          url: options.url,
          goal: options.goal,
          service: options.provider,
          ...(options.facts && Object.keys(options.facts).length ? { facts: options.facts } : {}),
          profileDir,
          ...(options.session ? { session: options.session } : { sessionPath }),
          agentIdentity: 'grunt',
          ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
          ...(options.maxSeconds !== undefined ? { maxSeconds: options.maxSeconds } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          onCredentialCaptured: async credential => {
            for (const value of Object.values(credential.fields)) {
              if (typeof value === 'string' && value.trim().length > 0) {
                capturedSecrets.add(value);
              }
            }
            const summary = await persistCapturedCredential({
              provider: options.provider,
              credential,
              directory,
              ...(options.registry ? { registry: options.registry } : {}),
              fallbackUrl: options.url,
              ...(options.storeInMemory ? { storeInMemory: options.storeInMemory } : {})
            });
            if (summary) options.onCaptured?.(summary);
          },
          onLoginCreated: async credential => {
            for (const value of Object.values(credential.fields)) {
              if (typeof value === 'string' && value.trim().length > 0) {
                capturedSecrets.add(value);
              }
            }
          }
        },
        runtime.signupRuntime
      );
      return formatEmbeddedDriveResult(sdk, signupResult, capturedSecrets);
    } finally {
      releaseLease();
    }
  }

  const managed = await openEmbeddedSignupSession(
    {
      provider: options.provider,
      url: options.url,
      ...(options.facts ? { facts: options.facts } : {}),
      ...(options.directory ? { directory: options.directory } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.storeInMemory ? { storeInMemory: options.storeInMemory } : {}),
      ...(options.onCaptured ? { onCaptured: options.onCaptured } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    },
    runtime
  );
  try {
    return await managed.drive({
      url: options.url,
      goal: options.goal,
      ...(options.facts ? { facts: options.facts } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.maxSeconds !== undefined ? { maxSeconds: options.maxSeconds } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
  } finally {
    await managed.close();
  }
}

type Result = Record<string, unknown>;
export type SignupAgent = (input: {
  service: string;
  url: string;
  goal: string;
  signal: AbortSignal;
  tools: Tool[];
  call(name: string, args: Result): Promise<Result>;
}) => Promise<void>;

// Vault, payment, upload, dialog and inbox tools stay out: they reveal secrets or local
// files to the free model, spend money, or confirm a key change no label check sees.
export const signupAgentTools = new Set(['operate_drive', 'operate_observe', 'operate_click', 'operate_type', 'operate_select', 'operate_wait', 'operate_scroll', 'operate_extract',
  'operate_solve_captcha', 'operate_navigate', 'operate_press', 'operate_login']);

const browserArguments: Record<string, readonly string[]> = {
  operate_observe: ['query', 'cursor', 'role'],
  operate_click: ['ref'],
  operate_type: ['ref', 'text'],
  operate_select: ['ref', 'values'],
  operate_wait: ['milliseconds'],
  operate_scroll: ['direction'],
  operate_extract: ['store', 'capture'],
  operate_solve_captcha: [],
  operate_navigate: ['url'],
  operate_press: ['key']
};

function signupTool(tool: Tool): Tool {
  if (tool.name === 'operate_drive') return {
    name: tool.name,
    description: 'Start with Jev’s current result. Call again with an offered answer or WAIT, or resume with known signup facts.',
    inputSchema: { type: 'object', properties: { answer: { type: 'string' }, facts: { type: 'object' } }, additionalProperties: false }
  };
  if (tool.name === 'operate_login') return {
    name: tool.name,
    description: 'Sign in with Google or GitHub OAuth by pressing the observed OAuth control ref. Wait and observe after a timeout; never repeat a dispatched OAuth click.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['google', 'github'] }, ref: { type: 'string' } }, required: ['provider', 'ref'], additionalProperties: false }
  };
  const allowed = browserArguments[tool.name] ?? [];
  return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => allowed.includes(key))),
    required: (tool.inputSchema.required ?? []).filter(key => allowed.includes(key)),
    additionalProperties: false
  } };
}

function safeBrowserText(value: string) {
  return value.replace(/https?:\/\/[^\s"']+/gi, match => {
    try { return new URL(match).origin; } catch { return '[link omitted]'; }
  }).replace(/\b(?:sk[-_]|gh[pousr]_|gsk_|nvapi-|eyJ)[\w.-]{6,}|\b[A-Za-z0-9_+/=-]{32,}\b/g, '[omitted]');
}

export const writeId = /^[a-zA-Z0-9:_-]{1,128}$/;

export function signupAgentResult(value: Result): Result {
  // write_id stays visible: the operator retries an unresolved capture with it.
  const omit = new Set(['session_id', 'operation_id', 'dom', 'delta', 'raw_attributes', 'fields', 'value', 'token',
    'approval_url', 'password', 'secret', 'credentials', 'stored_credential', 'reference', 'capture_omissions', 'trajectory']);
  const clean = (value: unknown, depth: number, key?: string): unknown => {
    if (depth > 7) return;
    // Squire's capture write_id is a nonsecret retry handle, often a UUID, which
    // the long-token redaction below would hide. Keep only its documented shape.
    if (key === 'write_id') return typeof value === 'string' && writeId.test(value) && !/^(?:sk[-_]|gh[pousr]_|gsk_|nvapi-|eyJ)/.test(value) ? value : undefined;
    if (typeof value === 'string') return safeBrowserText(value.slice(0, 1800));
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 100)
        .filter(([key]) => !omit.has(key)).map(([key, item]) => [key, clean(item, depth + 1, key)]));
    }
    return value;
  };
  return clean(value, 0) as Result;
}

export async function signupMcp(input: Parameters<SignupAgent>[0]) {
  const authorization = randomBytes(32).toString('hex');
  const listener = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${authorization}`) {
      res.writeHead(404).end(); return;
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = new Server({ name: 'grunt-squire', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: input.tools.map(signupTool)
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const result = await input.call(request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Squire could not complete this browser step.' }] };
      }
    });
    try {
      await server.connect(transport);
      res.once('close', () => { void server.close(); });
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') { listener.close(); throw new Error('Signup MCP unavailable'); }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, authorization,
    close: () => { listener.close(); listener.closeAllConnections(); }
  };
}

export function guardedSignupChoice(key: string, label: unknown) {
  if (typeof label !== 'string' || !label.trim()) return false;
  const text = label.replace(/[_|-]/g, ' ');
  const choice = `${key} ${text}`.replace(/[_-]/g, ' ');
  // Only spending money or changing an existing key is refused.
  return !/\b(?:billing|payment|credit card|upgrade|premium|subscription|paid|purchase|buy|top up|revoke|rotate|regenerate|roll|reset|delete)\b/i.test(choice);
}
