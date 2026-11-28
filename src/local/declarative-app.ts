import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configRoot } from '../brand.js';
import {
  DAY_PATTERN,
  ID_PATTERN,
  disabledAdapters,
  isDeclarativeAppAdapter,
  knownAdapters,
  safePublicHttpsOrigin,
  safePublicHttpsUrl
} from '../registry.js';
import type { Adapter, DeclarativeAppAdapter, DeclarativeAppAuth, DeclarativeAppErrorPatterns, DeclarativeAppOneshotOutput, Registry } from '../registry.js';
import { openAcpClient } from './acp-client.js';
import {
  appSandboxPaths,
  collectHostRuntimeMounts,
  createOpenerPipe,
  installDeclarativeApp,
  installerFingerprint,
  prepareAppDirectories,
  readAppState,
  requireSandboxBackend,
  resolveInstalledBinary,
  runSandboxedCommand,
  sandboxPathsFor,
  spawnSandboxed,
  withAppLock,
  writeAppState
} from './app-sandbox.js';
import type { DeclarativeAppState, SandboxBackend, SandboxMountSpec } from './app-sandbox.js';
import { declarativeAppDataSharingPolicy, readDataSharingConsent } from './data-sharing.js';
import { observeAttemptDispatch } from './diagnostics.js';
import { userTurns } from './harness.js';
import { JsonToolBridge } from './json-tool-bridge.js';
import { SetupRefusal } from './setup-failure.js';
import { SourceError, completionEnding, messageText, preventReplay, replayTimeout, requestRefusal, withEnding } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { compileToolSchemas } from './tool-schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_BACKOFF_MS = 12 * 60 * 60 * 1000;
const SAFE_SESSION_ID = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stripAnsi = (value: string) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');

export function declarativeAppRetired(adapter: Pick<Adapter, 'status' | 'expires'>, now = Date.now()): boolean {
  if (adapter.status === 'inactive' || adapter.status === 'expiring') return true;
  if (adapter.expires !== undefined) {
    if (!DAY_PATTERN.test(adapter.expires) || !Number.isFinite(Date.parse(adapter.expires))) return true;
    if (now >= Date.parse(adapter.expires) + DAY_MS) return true;
  }
  return false;
}

export async function isDeclarativeAppBackedOff(id: string, directory = configRoot(), now = Date.now()): Promise<boolean> {
  const state = await readAppState(id, directory);
  return state?.signupBackoffUntil !== undefined && state.signupBackoffUntil > now;
}

function getByDotPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const segment of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function extractOneshotReply(stdout: string, output: DeclarativeAppOneshotOutput): { text: string; sessionId?: string } {
  if (output.format === 'plain') {
    const text = stripAnsi(stdout).trim();
    if (!text) throw new SourceError('upstream', 'Declarative app returned empty output');
    return { text };
  }
  if (output.format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout.trim()); }
    catch { throw new SourceError('upstream', 'Declarative app returned invalid JSON'); }
    const rawText = output.textPath
      ? getByDotPath(parsed, output.textPath)
      : (object(parsed).text ?? object(parsed).response ?? object(parsed).content ?? object(parsed).result);
    if (typeof rawText !== 'string' || !rawText.trim()) throw new SourceError('upstream', 'Declarative app JSON contained no assistant text');
    const rawSession = output.sessionIdPath ? getByDotPath(parsed, output.sessionIdPath) : undefined;
    const sessionId = typeof rawSession === 'string' && SAFE_SESSION_ID.test(rawSession) ? rawSession : undefined;
    return { text: rawText, ...(sessionId ? { sessionId } : {}) };
  }
  // jsonl
  let text = '';
  let sessionId: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (output.sessionIdPath) {
      const candidateSession = getByDotPath(event, output.sessionIdPath);
      if (typeof candidateSession === 'string' && SAFE_SESSION_ID.test(candidateSession)) sessionId = candidateSession;
    }
    if (output.eventTypeField && output.eventTypeValue !== undefined) {
      if (getByDotPath(event, output.eventTypeField) !== output.eventTypeValue) continue;
    }
    const candidateText = output.textPath ? getByDotPath(event, output.textPath) : object(event).text;
    if (typeof candidateText === 'string' && candidateText) text = candidateText;
  }
  if (!text.trim()) throw new SourceError('upstream', 'Declarative app JSONL contained no assistant text');
  return { text, ...(sessionId ? { sessionId } : {}) };
}

function classifyCliError(id: string, combined: string, patterns?: DeclarativeAppErrorPatterns): SourceError {
  const sample = stripAnsi(combined).slice(0, 16384);
  if (patterns?.quota && new RegExp(patterns.quota, 'i').test(sample)) return new SourceError('quota', `${id} reported quota exhaustion`);
  if (patterns?.loggedOut && new RegExp(patterns.loggedOut, 'i').test(sample)) return new SourceError('logged_out', `${id} requires sign-in`);
  if (patterns?.refused && new RegExp(patterns.refused, 'i').test(sample)) return new SourceError('refused', `${id} refused the request`);
  if (/quota|rate.?limit|usage.?limit|too many requests|credits?.*exhaust/i.test(sample)) return new SourceError('quota', `${id} reported quota exhaustion`);
  if (/not logged in|logged out|sign.?in|unauthorized|authentication required|login required|401/i.test(sample)) return new SourceError('logged_out', `${id} requires sign-in`);
  return new SourceError('upstream', `${id} CLI request failed`);
}

function substituteArgTemplate(args: readonly string[], vars: Record<string, string>): string[] {
  return args.map(arg => arg.replace(/\{\{(prompt|promptFile|sessionId|model)\}\}/g, (_m, key: string) => vars[key] ?? ''));
}

async function checkAppAuth(
  adapter: DeclarativeAppAdapter,
  directory: string,
  binaryRelPath: string,
  signal: AbortSignal,
  backend?: SandboxBackend
): Promise<boolean> {
  const paths = appSandboxPaths(adapter.id, directory);
  const auth = adapter.declarativeApp.auth;
  if (auth.authFile) {
    try {
      const target = join(paths.home, auth.authFile);
      const st = await lstat(target);
      if (!st.isFile() || st.isSymbolicLink() || st.size === 0) return false;
      if (!auth.statusArgs) return true;
    } catch { return false; }
  }
  if (auth.statusArgs) {
    const reqDir = await mkdtemp(join(paths.tmp, 'status-'));
    try {
      const resolvedBackend = backend ?? await requireSandboxBackend();
      const visible = sandboxPathsFor(resolvedBackend, paths.pkg, reqDir);
      const { mounts } = await collectHostRuntimeMounts({ needsUv: adapter.declarativeApp.installer.type === 'uv' });
      const binInSandbox = join(visible.pkg, binaryRelPath);
      const res = await runSandboxedCommand(binInSandbox, auth.statusArgs, {
        mode: 'run',
        pkgDir: paths.pkg,
        homeDir: paths.home,
        workDir: reqDir,
        extraRuntimeMounts: mounts,
        ...(adapter.declarativeApp.env ? { env: adapter.declarativeApp.env } : {})
      }, { signal, timeoutMs: 15000, maxOutputBytes: 256 * 1024, backend: resolvedBackend });
      if (res.code !== 0) return false;
      if (auth.statusMatch && !new RegExp(auth.statusMatch, 'i').test(stripAnsi(res.stdout + '\n' + res.stderr))) return false;
      return true;
    } catch { return false; }
    finally { await rm(reqDir, { recursive: true, force: true }).catch(() => {}); }
  }
  return auth.type === 'none';
}

export interface DeclarativeAppOptions {
  directory?: string;
  registry?: () => Registry;
  adapter?: () => DeclarativeAppAdapter | undefined;
  now?: () => number;
  backend?: SandboxBackend;
}

/**
 * Generalized sandboxed CLI app source driven by declarative:app registry entries.
 * Always executes in an empty per-request temp directory inside the OS sandbox
 * (never mounts host $HOME or any host project directory).
 */
export class DeclarativeApp implements Source {
  readonly metadataOnlyMaintenance = true;
  private readonly shutdown = new AbortController();
  private readonly sessions = new Map<string, string>();
  private readonly busySessions = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(readonly id: string, private options: DeclarativeAppOptions = {}) {
    if (!ID_PATTERN.test(id) || knownAdapters.has(id) || disabledAdapters.has(id)) {
      throw new Error(`Invalid declarative app id: ${id}`);
    }
  }

  private get directory(): string { return this.options.directory ?? configRoot(); }
  private get now(): number { return (this.options.now ?? Date.now)(); }

  private entry(): DeclarativeAppAdapter | undefined {
    const candidate = this.options.adapter?.() ?? this.options.registry?.().adapters.find(a => a.id === this.id);
    if (!isDeclarativeAppAdapter(candidate) || candidate.id !== this.id) return undefined;
    return structuredClone(candidate);
  }

  get supportsFunctionTools(): boolean {
    return this.entry()?.declarativeApp.execution === 'inference';
  }

  get jsonToolBridge(): boolean {
    return this.entry()?.declarativeApp.execution === 'inference';
  }

  get inferenceOnly(): boolean {
    return this.entry()?.declarativeApp.execution === 'inference';
  }

  private async ready(signal: AbortSignal): Promise<{ adapter: DeclarativeAppAdapter; binaryRelPath: string }> {
    signal.throwIfAborted();
    const adapter = this.entry();
    if (!adapter || declarativeAppRetired(adapter, this.now)) {
      throw new SourceError('refused', `${this.id} declarative app is retired or unlisted`);
    }
    const policy = declarativeAppDataSharingPolicy(adapter);
    if (!(await readDataSharingConsent(this.directory, [this.id], [policy])).includes(this.id)) {
      throw new SourceError('refused', `${this.id} data sharing is not approved; rerun usegrunt setup`);
    }
    const state = await readAppState(this.id, this.directory);
    const paths = appSandboxPaths(this.id, this.directory);
    if (!state || state.installerFingerprint !== installerFingerprint(adapter.declarativeApp.installer)
      || !(await resolveInstalledBinary(paths.pkg, state.binaryRelPath))) {
      throw new SourceError('not_installed', `${this.id} sandboxed app is not installed; run usegrunt add ${this.id}`);
    }
    const authed = await checkAppAuth(adapter, this.directory, state.binaryRelPath, signal, this.options.backend);
    if (!authed) throw new SourceError('logged_out', `${this.id} app login is missing or expired; run usegrunt add ${this.id}`);
    return { adapter, binaryRelPath: state.binaryRelPath };
  }

  async available(caller?: AbortSignal): Promise<boolean> {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000), ...(caller ? [caller] : [])]);
    try { await this.ready(signal); return true; }
    catch { return false; }
  }

  async healthCheck(caller?: AbortSignal): Promise<boolean> {
    return this.available(caller);
  }

  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    caller.throwIfAborted();
    const task = this.completeOnce(request, caller);
    this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); }
  }

  private async completeOnce(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const initial = this.entry();
    if (!initial || declarativeAppRetired(initial, this.now)) {
      throw new SourceError('refused', `${this.id} declarative app is retired or unlisted`);
    }
    if (request.imageInput) throw new SourceError('refused', `${this.id} supports text input only`);
    const execution = initial.declarativeApp.execution;
    if (execution === 'inference' && request.tools.some(tool => tool.type !== 'function')) {
      throw requestRefusal(`${this.id} supports function tools only`, 'request_tools');
    }

    const timeoutMs = initial.declarativeApp.timeoutMs ?? 180000;
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(timeoutMs)]);
    const { adapter, binaryRelPath } = await this.ready(signal);

    // Prepare prompt (with JsonToolBridge in inference mode when tools/tool-history exist)
    let bridge: JsonToolBridge | undefined;
    let prompt: string;
    let sessionKey: string | undefined;
    let priorSession: string | undefined;
    if (execution === 'inference') {
      const needsBridge = request.tools.length > 0 || request.messages.some(m => m.role === 'tool' || Boolean(m.tool_calls?.length));
      if (needsBridge) {
        try {
          bridge = new JsonToolBridge(request);
          compileToolSchemas(request.tools, `${this.id} rejected a function tool schema`);
        } catch (err) {
          throw err instanceof SourceError ? err : requestRefusal(`${this.id} rejected unsupported tool definitions`);
        }
        prompt = bridge.prompt(false, `native ${this.id} tools`);
      } else {
        prompt = request.handoffPrompt ?? (request.messages.length === 1 && request.messages[0]?.role === 'user'
          ? messageText(request.messages[0].content)
          : `Continue this conversation and answer the latest user request:\n${JSON.stringify(request.messages)}`);
      }
    } else {
      const turns = userTurns(request);
      const latest = request.handoffPrompt ?? turns.at(-1);
      if (!latest?.trim()) throw new SourceError('upstream', `No user text in request for ${this.id}`);
      prompt = latest;
      const hash = (history: string[]) => createHash('sha256').update(JSON.stringify([this.id, request.cwd, history])).digest('hex');
      sessionKey = hash(turns);
      const candidate = turns.length > 1 ? this.sessions.get(hash(turns.slice(0, -1))) : undefined;
      if (candidate && !this.busySessions.has(candidate)) {
        priorSession = candidate;
        this.busySessions.add(candidate);
      }
    }
    if (!prompt.trim()) throw new SourceError('upstream', `Empty prompt for ${this.id}`);

    const paths = await prepareAppDirectories(this.id, this.directory);
    const reqDir = await mkdtemp(join(paths.tmp, 'req-'));
    let dispatched = false;
    try {
      const backend = this.options.backend ?? await requireSandboxBackend();
      const visible = sandboxPathsFor(backend, paths.pkg, reqDir);
      const { mounts } = await collectHostRuntimeMounts({ needsUv: adapter.declarativeApp.installer.type === 'uv' });
      const spec: SandboxMountSpec = {
        mode: 'run',
        pkgDir: paths.pkg,
        homeDir: paths.home,
        workDir: reqDir,
        extraRuntimeMounts: mounts,
        ...(adapter.declarativeApp.env ? { env: adapter.declarativeApp.env } : {})
      };
      const binInSandbox = join(visible.pkg, binaryRelPath);

      let rawText: string;
      let newSessionId: string | undefined;
      observeAttemptDispatch({ account: 'local_session', ...(adapter.model ? { model: adapter.model } : {}) });

      if (adapter.declarativeApp.transport.type === 'oneshot-exec') {
        const transport = adapter.declarativeApp.transport;
        const promptFileHost = join(reqDir, 'prompt.txt');
        const promptFileSandbox = join(visible.work, 'prompt.txt');
        if (transport.promptInput === 'file') {
          await writeFile(promptFileHost, prompt, { mode: 0o600, flag: 'wx' });
        }
        const vars: Record<string, string> = {
          prompt,
          promptFile: promptFileSandbox,
          ...(priorSession ? { sessionId: priorSession } : {}),
          ...(adapter.model ? { model: adapter.model } : {})
        };
        const baseArgs = substituteArgTemplate(transport.args, vars);
        const resume = priorSession && transport.resumeArgs ? substituteArgTemplate(transport.resumeArgs, vars) : [];
        const finalArgs = [...baseArgs, ...resume];
        dispatched = true;
        const res = await runSandboxedCommand(binInSandbox, finalArgs, spec, {
          signal,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(transport.promptInput === 'stdin' ? { stdin: prompt } : {}),
          backend
        });
        if (res.code !== 0) throw classifyCliError(this.id, res.stdout + '\n' + res.stderr, transport.errors);
        const extracted = extractOneshotReply(res.stdout, transport.output);
        rawText = extracted.text;
        newSessionId = extracted.sessionId;
      } else {
        // ACP over stdio inside sandbox
        const transport = adapter.declarativeApp.transport;
        const child = await spawnSandboxed(binInSandbox, transport.args, spec, {
          stdio: ['pipe', 'pipe', 'pipe'],
          backend
        });
        const client = await openAcpClient(binInSandbox, transport.args, {
          source: this.id,
          label: adapter.declarativeApp.name ?? this.id,
          cwd: reqDir,
          env: {},
          signal,
          timeoutMs,
          forbidToolCalls: execution === 'inference',
          spawnChild: () => child
        });
        try {
          await client.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'grunt', version: 'declarative-app-v1' }
          });
          const session = object(await client.request('session/new', {
            cwd: visible.work,
            mcpServers: [],
            ...(transport.mode ? { mode: transport.mode } : {}),
            ...(transport.modelOption ? { modelOptionId: transport.modelOption } : {})
          }));
          if (typeof session.sessionId !== 'string' || !SAFE_SESSION_ID.test(session.sessionId)) {
            throw new SourceError('upstream', `${this.id} returned an invalid ACP session`);
          }
          dispatched = true;
          const result = object(await client.request('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: prompt }]
          }));
          if (result.stopReason !== 'end_turn' && result.stopReason !== 'max_tokens') {
            throw new SourceError('upstream', `${this.id} did not return a complete ACP response`);
          }
          let collected = '';
          for (const notification of client.notifications) {
            const params = object(notification.params), update = object(params.update), content = object(update.content);
            if (params.sessionId !== session.sessionId) continue;
            if (update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string') {
              collected += content.text;
            }
          }
          if (!collected.trim() && result.stopReason !== 'max_tokens') {
            throw new SourceError('upstream', `${this.id} returned no ACP assistant text`);
          }
          if (result.stopReason === 'max_tokens' && bridge) {
            return withEnding({ text: '', finishReason: 'length' }, completionEnding(result.stopReason, undefined, false));
          }
          rawText = collected;
          newSessionId = session.sessionId;
        } finally {
          await client.close().catch(() => {});
        }
      }

      if (sessionKey && (newSessionId || priorSession)) {
        this.sessions.set(sessionKey, newSessionId ?? priorSession!);
      }
      if (bridge) {
        try {
          const completion = bridge.parse(rawText);
          if (!completion.text.trim() && !completion.calls?.length) throw new Error('Empty answer');
          return withEnding(completion, completionEnding('stop', undefined, Boolean(completion.calls?.length)));
        } catch {
          throw new SourceError('upstream', `${this.id} returned an invalid caller tool envelope`);
        }
      }
      return { text: rawText, ...(adapter.model ? { servedModel: adapter.model } : {}), free: true };
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', `${this.id} stopped during shutdown`);
      if (signal.aborted) throw replayTimeout(`${this.id} request timed out`, !dispatched);
      if (execution === 'delegated' && dispatched) throw preventReplay(error, `${this.id} failed after dispatch`);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `${this.id} request failed`);
    } finally {
      if (priorSession) this.busySessions.delete(priorSession);
      await rm(reqDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}

export interface DeclarativeAppSignupSquire {
  signup?(service: string, url: string, goal: string, facts?: Record<string, string>): Promise<void>;
}

function validateAuthUrl(raw: string, auth: Extract<DeclarativeAppAuth, { type: 'browser-url' | 'device-code' }>): URL | undefined {
  const cleaned = stripAnsi(raw).trim().replace(/[),.;]+$/, '');
  if (!safePublicHttpsUrl(cleaned)) return undefined;
  let parsed: URL;
  try { parsed = new URL(cleaned); } catch { return undefined; }
  const allowed = new Set(auth.allowedOrigins.map(o => safePublicHttpsOrigin(o)).filter((v): v is string => Boolean(v)));
  if (!allowed.has(parsed.origin)) return undefined;
  if (auth.urlPattern && !new RegExp(auth.urlPattern).test(parsed.href)) return undefined;
  return parsed;
}

export async function setupDeclarativeApp(
  adapter: DeclarativeAppAdapter,
  options: {
    directory: string;
    squire: DeclarativeAppSignupSquire;
    notify(line: string): void;
    connect?: () => Promise<void>;
    signal?: AbortSignal;
    background: boolean;
    fetcher?: typeof fetch;
    now?: () => number;
    backend?: SandboxBackend;
  }
): Promise<void> {
  const { directory, squire, notify, signal: caller } = options;
  const now = (options.now ?? Date.now)();
  if (declarativeAppRetired(adapter, now)) {
    throw new SetupRefusal('free promotion expired', `${adapter.id} declarative app is expired or retired`);
  }
  const policy = declarativeAppDataSharingPolicy(adapter);
  if (!(await readDataSharingConsent(directory, [adapter.id], [policy])).includes(adapter.id)) {
    throw new Error(`${adapter.id} requires current data-sharing approval`);
  }
  const signal = AbortSignal.any([AbortSignal.timeout(600000), ...(caller ? [caller] : [])]);

  const { paths, state: installedState } = await installDeclarativeApp(adapter.id, adapter.declarativeApp.installer, {
    directory,
    signal,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.backend ? { backend: options.backend } : {})
  });

  const currentNow = () => (options.now ?? Date.now)();

  // Hold the per-app lock across auth recheck, backoff check, pre-login attempt
  // persistence, browser login, post-login verification, and final state update.
  await withAppLock(`${resolve(directory)}:${adapter.id}`, async () => {
    const state = (await readAppState(adapter.id, directory)) ?? installedState;

    // Strict single-login reuse: recheck under the lock so concurrent setup calls
    // never launch a second login.
    if (await checkAppAuth(adapter, directory, state.binaryRelPath, signal, options.backend)) {
      notify(`${adapter.id}: sandboxed app reused existing login`);
      return;
    }

    const auth = adapter.declarativeApp.auth;
    if (auth.type === 'none') {
      notify(`${adapter.id}: sandboxed app ready (no login required)`);
      return;
    }
    if (state.signupBackoffUntil !== undefined && state.signupBackoffUntil > currentNow()) {
      throw new Error(`${adapter.id} sign-in is backed off until ${new Date(state.signupBackoffUntil).toISOString()}`);
    }
    if (options.background) {
      throw new Error(`${adapter.id} requires foreground browser sign-in`);
    }
    if (!squire.signup) {
      throw new Error(`${adapter.id} requires browser-capable Trusty Squire`);
    }

    await options.connect?.();
    const backend = options.backend ?? await requireSandboxBackend();

    // Persist the attempt and backoff window BEFORE starting the login CLI so even
    // a hard interruption (SIGKILL/abort) cannot bypass backoff.
    const attemptAt = currentNow();
    const attemptState: DeclarativeAppState = {
      version: 1,
      installerFingerprint: state.installerFingerprint,
      installedAt: state.installedAt,
      binaryRelPath: state.binaryRelPath,
      lastSignupAttemptAt: attemptAt,
      signupBackoffUntil: attemptAt + SIGNUP_BACKOFF_MS,
      lastSignupFailure: 'in_progress'
    };
    await writeAppState(adapter.id, attemptState, directory);

    const loginWork = await mkdtemp(join(paths.tmp, 'login-'));
    const lifetime = new AbortController();
    const loginSignal = AbortSignal.any([signal, lifetime.signal]);
    const { mounts } = await collectHostRuntimeMounts({ needsUv: adapter.declarativeApp.installer.type === 'uv' });

    let pairing: Promise<void> | undefined;
    let capturedUrl: string | undefined;
    let capturedCode: string | undefined;
    let failure: Error | undefined;

    const maybeStartBrowser = () => {
      if (pairing || !capturedUrl) return;
      if (auth.type === 'device-code' && !capturedCode) return;
      const url = capturedUrl;
      const code = capturedCode;
      const label = adapter.declarativeApp.name ?? adapter.id;
      const goal = [
        `Complete the ${/\bcli\b/i.test(label) ? label : `${label} CLI`} sign-in started by Grunt using this user's existing account or a free account.`,
        ...(code ? [`Enter the verification code ${code}.`] : []),
        ...(adapter.hints ? [adapter.hints] : []),
        'Do not add a payment method, pay, top up, or switch to a paid plan. Authorize only this CLI sign-in and finish.'
      ].join(' ');
      pairing = squire.signup!(adapter.id, url, goal, code ? { user_code: code } : undefined);
      void pairing.catch(err => {
        failure = err instanceof Error ? err : new Error(`${adapter.id} browser sign-in failed`);
        lifetime.abort(failure);
      });
    };

    const handleCandidateUrl = (raw: string) => {
      const valid = validateAuthUrl(raw, auth);
      if (!valid || capturedUrl) return;
      capturedUrl = valid.href;
      maybeStartBrowser();
    };

    const opener = await createOpenerPipe(paths.tmp, handleCandidateUrl);
    try {
      const visible = sandboxPathsFor(backend, paths.pkg, loginWork);
      const binInSandbox = join(visible.pkg, state.binaryRelPath);
      const spec: SandboxMountSpec = {
        mode: 'auth',
        pkgDir: paths.pkg,
        homeDir: paths.home,
        workDir: loginWork,
        openerDir: opener.openerDir,
        openerPipePath: opener.pipePath,
        extraRuntimeMounts: mounts,
        ...(adapter.declarativeApp.env ? { env: adapter.declarativeApp.env } : {})
      };
      const result = await runSandboxedCommand(binInSandbox, auth.command, spec, {
        signal: loginSignal,
        timeoutMs: 600000,
        maxOutputBytes: 256 * 1024,
        backend,
        onOpenerData: opener.onFd3Data,
        onLine(line) {
          const clean = stripAnsi(line);
          const urls = clean.match(/https:\/\/[^\s"'<>`]+/g) ?? [];
          for (const u of urls) handleCandidateUrl(u);
          if (auth.type === 'device-code' && !capturedCode) {
            const codeMatch = clean.match(new RegExp(auth.codePattern));
            if (codeMatch) {
              capturedCode = (codeMatch[1] ?? codeMatch[0]).trim();
              maybeStartBrowser();
            }
          }
        }
      });
      if (failure) throw failure;
      if (result.code !== 0 || !pairing) throw new Error(`${adapter.id} CLI login did not complete`);
      await pairing;

      if (!(await checkAppAuth(adapter, directory, state.binaryRelPath, signal, backend))) {
        throw new Error(`${adapter.id} login completed but status check still reports signed out`);
      }
      await writeAppState(adapter.id, {
        version: 1,
        installerFingerprint: state.installerFingerprint,
        installedAt: state.installedAt,
        binaryRelPath: state.binaryRelPath
      }, directory);
      notify(`${adapter.id}: sandboxed app connected`);
    } catch (err) {
      const failedAt = currentNow();
      await writeAppState(adapter.id, {
        ...attemptState,
        lastSignupAttemptAt: attemptAt,
        signupBackoffUntil: Math.max(attemptState.signupBackoffUntil ?? 0, failedAt + SIGNUP_BACKOFF_MS),
        lastSignupFailure: 'signup_failed'
      }, directory).catch(() => {});
      throw failure ?? err;
    } finally {
      lifetime.abort();
      await opener.close();
      await rm(loginWork, { recursive: true, force: true }).catch(() => {});
    }
  });
}
