import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ProvisionInput } from '@trusty-squire/sdk';
import { freeConfig, loopback } from './freellmapi.js';
import { bundledRegistry } from '../registry.js';
import { proxyApproval } from './approval-proxy.js';
import { VerificationQueue } from './verification-queue.js';
import { BROWSER_CONCURRENCY } from './parallel.js';
import { Nvidia, writeNvidiaGrant } from './nvidia.js';
import { Zro, writeZroGrant } from './zro.js';
import { TokenHarbor, writeTokenHarborGrant } from './tokenharbor.js';
import { Runcrate, writeRuncrateGrant } from './runcrate.js';
import { Apinex, writeApinexGrant } from './apinex.js';
import { setupMistralVibe } from './mistral-vibe-setup.js';
import { setupLiveKit } from './livekit-setup.js';
import { setupPollinations } from './pollinations-setup.js';
import { setupBeatAPI } from './beatapi-setup.js';
import { setupClixad } from './clixad-setup.js';
import { setupPerch } from './perch-setup.js';
import { setupNous } from './nous-setup.js';
import { setupKenari } from './kenari-setup.js';
import { setupPromotionalApi } from './promotional-setup.js';
import { setupCrowLLM } from './crowllm-setup.js';
import { setupAperture } from './aperture-setup.js';
import { setupAntseedVikey } from './antseed-vikey-setup.js';
import { setupDarus } from './darus-setup.js';
import { setupMillionSeek } from './millionseek-setup.js';
import { setupFreePi } from './freepi-setup.js';
import { setupGoedel } from './goedel-setup.js';
import { setupNumes } from './numes-setup.js';
import { disabledAdapters } from '../registry.js';
import { configRoot, gruntEnv } from '../brand.js';
import { KILO_PARTICLE, verifyKiloAccess } from './kilo.js';
import { DATA_SHARING_POLICIES, dataSharingPolicies, readDataSharingConsent, requiresExplicitDataSharing } from './data-sharing.js';
import { writePrivateProviderGrant } from './provider-grant.js';
import { readSetupSession } from './setup-session.js';
import { signupAgentTools, signupAgentResult, guardedSignupChoice, writeId } from './signup-mcp.js';
import type { SignupAgent } from './signup-mcp.js';
import { setupFailureReason, signupOperatorUnavailable } from './setup-failure.js';
import { withTerminal } from './terminal.js';
import { confirm, isCancel } from '@clack/prompts';

const exec = promisify(execFile);
export const FREELLMAPI_IMAGE = 'ghcr.io/tashfeenahmed/freellmapi@sha256:845a4b568a20fffd5112e1b9c0258e7782d9eabbba2430612d2f7c811eee267e';
export const PROVIDERS: Record<string, string> = { groq: 'https://console.groq.com/keys', cerebras: 'https://cloud.cerebras.ai/platform/api-keys', kilo: 'https://app.kilo.ai/profile', nvidia: 'https://build.nvidia.com/settings/api-keys', zro: 'https://zro.moonmath.ai/overview', tokenharbor: 'https://tokenharbor.ai/dashboard', runcrate: 'https://www.runcrate.ai/auth/signup', apinex: 'https://apinex.bond/register', 'mistral-vibe': 'https://console.mistral.ai', livekit: 'https://cloud.livekit.io', pollinations: 'https://enter.pollinations.ai', beatapi: 'https://beatapi.io', clixad: 'https://app.clixad.io', perch: 'https://www.perchai.app', nous: 'https://portal.nousresearch.com/login', kenari: 'https://kenari.id/login', numes: 'https://numes.ai/dashboard', goedel: 'https://inference.goedelmachines.com/keys', crowllm: 'https://crowllm.com/keys', fikra: 'https://fikraapi.co.ke/account/signup', openference: 'https://openference.com/register', darus: 'https://gateway.darusalfatah.id/', 'aperture-ai': 'https://www.aperture-ai.run/login.html', 'reflection-beam': 'https://kilo.ai/docs/getting-started/using-kilo-for-free', 'antseed-vikey': 'https://antseed.com/docs/', millionseek: 'https://100milionseek.top/signup', freepi: 'https://freepi.ai' };
const freeProviderInstructions: Record<string, string> = {
  runcrate: ' Go straight to the API keys page at https://www.runcrate.ai/dashboard/api-keys. Leave optional marketing unchecked. Do not open or change billing settings or create another account. Capture the API key with api_hosts ["api.runcrate.ai"] and auth_shape "bearer", service runcrate, label grunt. Reuse an existing vaulted key where possible; never reset or rotate it.',
  apinex: ' Go straight to the API keys page. Use the personal @gmail.com Google identity already connected to Squire; do not choose a workspace identity or switch accounts. Do not use or change any existing paid wallet balance. Dismiss any paid upsell. Do not add billing, top up a wallet, buy credits, or use any paid balance. Capture the API key with api_hosts ["api.apinex.bond"] and auth_shape "bearer", service apinex, label grunt. Reuse an existing vaulted key; never reset or rotate it.'
};
export type Provider = keyof typeof PROVIDERS;
export function providerURL(value: string): URL | undefined {
  if (!/^https?:\/\//i.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid provider base URL'); }
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash)
    throw new Error('Use HTTPS (HTTP is allowed only for loopback), without user info, query or fragment');
  return url;
}
export function providerLabel(base: string): string {
  const url = providerURL(base);
  if (!url) return base;
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 40);
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 12);
  return `custom-${host}-${hash}`;
}
async function chooseModel(models: string[]) {
  const model = models[0];
  if (!model) throw new Error('Provider returned no models');
  return model;
}
export async function setupURL(squire: BrowserSquire, router: FreeLLMAdmin, base: string, notify: (line: string) => void) {
  const url = providerURL(base)!;
  const credential = (await squire.credentials.list()).find(item => sameService(item, url.host)
    && item.auth_strategy !== 'username_password'
    && item.field_names.some(field => /^(?:api_?key|key|token|value)$/i.test(field)));
  if (!credential) throw new Error(`No saved API access for ${url.host}`);
  const grant = await squire.credentials.grant(credential.reference);
  // The grant replaces the origin only; retain the supplied API path verbatim.
  await router.addGrant(base, { base_url: grant.base_url.replace(/\/$/, '') + url.pathname, token: grant.token }, chooseModel);
  notify(`${url.host}: connected through Squire grant`);
}

export const KILO_NEMOTRON = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export { NVIDIA_DEEPSEEK } from './nvidia.js';
const savedProviders = ['kilo'] as const;
const providerModels: Record<string, string[]> = { kilo: [KILO_PARTICLE] };
type Credential = { service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null };
const sameService = (credential: Credential, service: string) => credential.service?.trim().toLowerCase() === service.trim().toLowerCase();
function apiKeyField(credential: Credential, provider: Provider): string | undefined {
  return credential.field_names.find(field => {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    const name = normalized.startsWith(provider) ? normalized.slice(provider.length) : normalized;
    return ['apikey', 'key', 'token', 'value', 'secret', 'apitoken', 'accesstoken'].includes(name);
  });
}
type Run = { run: { id: string; state: string }; decision: 'silent' | 'needs_approval' | 'reject' | 'drop'; approval_url?: string; reason?: string };
// Select only diagnostic text, never serialize the browser result or vault data.
function setupReason(...values: unknown[]): string {
  return [...new Set(values.filter((value): value is string => typeof value === 'string')
    // Free-form secret descriptions cannot be redacted reliably. Drop the whole
    // field, including ambiguous prose, while retaining separate safe details.
    .filter(value => !/(?:password|passcode|token|secret|key|credential|authorization)/i.test(value.normalize('NFKC'))).map(value => value
    .replace(/\p{Cc}|\p{Cf}/gu, ' ')
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted authorization]')
    .replace(/\b(?:gsk_|nvapi-|sk-|sk_|freellmapi-|ghp_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ').slice(0, 512);
}
function setupStopped(message: string, ...values: unknown[]): Error {
  const reason = setupReason(...values);
  return new Error(reason ? `${message}: ${reason}` : message);
}
// Connection diagnostics are untrusted child output. Redact before truncating.
function connectionReason(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/(?:sk-|gsk_|ghp_|eyJ)[A-Za-z0-9_+/.=-]*/g, '[redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, '[redacted]')
    .replace(/\p{Cc}|\p{Cf}/gu, ' ').replace(/\s+/g, ' ').trim();
}
// The browser adapter implements this narrow setup contract. It does not use
// the SDK's legacy runs API: signup is driven by local operate_drive calls.
export interface SetupSquire {
  credentials: {
    list(): Promise<Credential[]>;
    grant(reference: string): Promise<{ base_url: string; token: string }>;
  };
  runs: { start(input: ProvisionInput): Promise<Run>; get(id: string): Promise<{ state: string; approval_url?: string; reason?: string }> };
}
export class SetupPending extends Error {}
export class SetupFailure extends Error {}

export async function setupProviders(squire: SetupSquire, router: { addGrant(platform: string, grant: { base_url: string; token: string }): Promise<void>; hasKey?(platform: string): Promise<boolean> }, options: { providers?: Provider[]; notify: (line: string) => void; reuseSaved?: boolean; verifySaved?: readonly Provider[]; dataSharingApproved?: readonly string[] } ) {
  const pending: string[] = [];
  const dropped: string[] = [];
  const drop = (provider: string, reason?: string) => {
    const safe = setupReason(reason);
    options.notify(`${provider}: dropped; Squire cannot complete signup automatically${safe ? `: ${safe}` : ''}`);
    dropped.push(provider);
  };
  for (const provider of options.providers ?? ['groq']) {
    if (await router.hasKey?.(provider)) { options.notify(`${provider}: connected`); continue; }
    const find = async () => (await squire.credentials.list()).find(c => sameService(c, provider) && c.auth_strategy !== 'username_password' && apiKeyField(c, provider));
    let credential = await find();
    if (!credential || options.verifySaved?.includes(provider)) {
      // Preserve the provisioning identity so upgrades do not repeat an existing signup.
      const result = await squire.runs.start({ service: provider, plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none', idempotency_key: `milo-free-${provider}` });
      if (result.decision === 'reject') throw setupStopped(`Squire refused ${provider} signup; setup stopped`, result.reason);
      if (result.decision === 'needs_approval' || result.decision === 'drop') { drop(provider, result.reason); continue; }
      let state = result.run.state;
      let reason = result.reason;
      const deadline = Date.now() + 120000;
      while (!['completed', 'failed', 'rejected', 'dropped'].includes(state) && Date.now() < deadline) {
        const run = await squire.runs.get(result.run.id); state = run.state; reason = run.reason ?? reason;
        if (run.approval_url || state === 'awaiting_approval') { state = 'dropped'; break; }
        if (!['completed', 'dropped', 'failed', 'rejected'].includes(state)) await delay(1000);
      }
      if (state === 'failed' || state === 'rejected') throw setupStopped(`Squire could not provision ${provider}; setup stopped`, reason);
      if (state !== 'completed') { drop(provider, reason); continue; }
      credential = await find();
      if (!credential) { drop(provider, 'No provider access was created'); continue; }
    }
    const grant = await squire.credentials.grant(credential.reference);
    await router.addGrant(provider, grant);
    options.notify(`${provider}: connected through Squire grant`);
  }
  // These sources reuse existing vault access only; missing keys never start signup.
  const approved = options.dataSharingApproved ?? await readDataSharingConsent(dirname(localAdminPath()), savedProviders);
  for (const provider of options.reuseSaved === false ? [] : savedProviders) {
    if (dataSharingPolicies([provider]).length && !approved.includes(provider)) continue;
    if (options.providers?.includes(provider)) continue;
    if (await router.hasKey?.(provider)) { options.notify(`${provider}: connected`); continue; }
    const credential = (await squire.credentials.list()).find(c => sameService(c, provider) && c.auth_strategy !== 'username_password' && apiKeyField(c, provider));
    if (!credential) { options.notify(`${provider}: skipped; no saved API access`); continue; }
    await router.addGrant(provider, await squire.credentials.grant(credential.reference));
    options.notify(`${provider}: connected through Squire grant`);
  }
  return { pending, dropped };
}

function oauthRetry(result: Record<string, unknown>) {
  return /retry oauth[ _-]login/i.test(String(result.reason))
    || result.outcome === 'not_attempted' || object(result.oauth).outcome === 'not_attempted';
}
type ObjectValue = Record<string, unknown>;
// The registry entry for a drive: by id, else by its signup host (a setup may
// drive under a vault service name that differs from the registry id).
function registryEntry(provider: string, url: string | undefined) {
  const host = (value: string | undefined) => { try { return value ? new URL(value).hostname.replace(/^www\./, '') : undefined; } catch { return undefined; } };
  return bundledRegistry.adapters.find(a => a.id === provider) ?? bundledRegistry.adapters.find(a => host(a.signup) !== undefined && host(a.signup) === host(url));
}
// Squire's explicit capture stores one revealed textbox/code value, or retries
// an unresolved write by write_id. Only this provider's vault entry is allowed.
// Returns undefined when absent and null when it is not acceptable.
function signupCapture(value: unknown, provider: string): ObjectValue | undefined | null {
  if (value === undefined) return undefined;
  const capture = object(value), store = object(capture.store), source = object(capture.source);
  if (Object.keys(capture).some(key => !['store', 'source', 'write_id'].includes(key)) || store.service !== provider) return null;
  if (capture.write_id !== undefined && (typeof capture.write_id !== 'string' || !writeId.test(capture.write_id))) return null;
  const container = source.container === undefined ? undefined : object(source.container);
  if (container && (!['dialog', 'region'].includes(String(container.role)) || Object.keys(container).some(key => !['role', 'name'].includes(key)))) return null;
  const named = (keys: string[]) => Object.keys(source).every(key => keys.includes(key));
  const role = ['textbox', 'code'].includes(String(source.role)) && named(['role', 'name', 'container']) && (source.name === undefined || typeof source.name === 'string');
  const selector = typeof source.selector === 'string' && source.selector.length > 0 && named(['selector', 'container']);
  if (!role && !selector) return null;
  return { store, source, ...(typeof capture.write_id === 'string' ? { write_id: capture.write_id } : {}) };
}
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export function squireEnvironment() {
  const home = gruntEnv('SQUIRE_HOME'), xdg = gruntEnv('SQUIRE_XDG_CONFIG_HOME');
  return {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(home ? { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } : {}),
      ...(xdg ? { XDG_CONFIG_HOME: xdg } : {}),
      TRUSTY_SQUIRE_AGENT_IDENTITY: 'grunt setup'
  };
}
export class BrowserSquire implements SetupSquire {
  constructor(private options: { background?: boolean | undefined; signal?: AbortSignal; dataSharingApproved?: readonly string[]; agent?: SignupAgent } = {}) {}
  useSignupAgent(agent: SignupAgent | undefined) { if (agent) this.options.agent = agent; else delete this.options.agent; }
  useBatchSignup() { this.batchSignup = true; }
  // Bootstrap tries other providers before handing a browser to the person.
  deferHandoff(deferred: boolean) { this.handoffDeferred = deferred; }
  // Reports when a provider's browser work queues behind the browser limit
  // and when it gets a slot, so setup can show waiting until it starts.
  onBrowserQueue(observer: ((provider: string, state: 'waiting' | 'started') => void) | undefined) { this.browserObserver = observer; }
  private browserObserver: ((provider: string, state: 'waiting' | 'started') => void) | undefined;
  private batchSignup = false;
  private handoffDeferred = false;
  private canHandOff() {
    return !this.options.background && process.stdin.isTTY === true && gruntEnv('SETUP_NO_HUMAN') !== '1'
      && !(this.handoffDeferred && !this.options.agent);
  }
  signupFailure(provider: string) { return this.failures.get(provider); }
  /** Squire's own stop detail for the last dropped signup, for GRUNT_SETUP_DEBUG. */
  signupFailureDetail(provider: string) { return this.failureDetails.get(provider); }
  approveDataSharing(providers: readonly string[]) { this.options.dataSharingApproved = [...new Set(providers)]; }
  pendingVerificationServices(): readonly string[] { return this.verification.services(); }
  onVerificationChange(observer: (services: readonly string[]) => void) { return this.verification.subscribe(observer); }
  private client = new Client({ name: 'grunt setup', version: '0.1.0' });
  private sessions = new Map<string, string>();
  private services = new Map<string, AbortController>();
  private callSignals = new WeakMap<ObjectValue, AbortSignal>();
  private queueSignals = new WeakMap<ObjectValue, AbortSignal>();
  private browserActive = 0;
  private browserQueue: { grant(): void }[] = [];
  private initialDriveSignal = new AbortController().signal;
  private finishing = new Map<string, Promise<void>>();
  private failures = new Map<string, string>();
  private failureDetails = new Map<string, string>();
  private recoveryChoices = new Map<string, Set<string>>();
  private retries = new Map<string, number>();
  private pending = new Set<Promise<Run>>();
  private closed = false;
  private shutdown = new AbortController();
  private get signal() { return this.options.signal ? AbortSignal.any([this.options.signal, this.shutdown.signal]) : this.shutdown.signal; }
  private handoffs: { url: string; close(): void; provider?: string }[] = [];
  private connection: Promise<void> | undefined;
  private metadata: Promise<Credential[]> | undefined;
  private grants = new Map<string, Promise<{ base_url: string; token: string }>>();
  private verification = new VerificationQueue(items => withTerminal(async () => {
    for (const item of items) {
      console.log(`Verify ${item.service} in your browser: ${item.url}`);
      const answer = await confirm({ message: `Finished verifying ${item.service}?`, initialValue: true, signal: this.signal });
      if (isCancel(answer) || !answer) throw new SetupFailure('needs human verification');
    }
  }));
  private serviceSignal(provider: string) {
    let controller = this.services.get(provider);
    if (!controller) { controller = new AbortController(); this.services.set(provider, controller); }
    return AbortSignal.any([this.signal, controller.signal]);
  }
  private async scoped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Provider signup cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  private async serviceCall(provider: string, name: string, args: ObjectValue) {
    this.serviceSignal(provider).throwIfAborted();
    // Cancelling MCP before a first response discards its new session ID.
    // Let that one bounded create/drive finish, then close any late session.
    // Known-session calls can be aborted immediately and cleaned up by ID.
    const initial = name === 'operate_drive' && !args.session_id;
    this.callSignals.set(args, initial ? this.initialDriveSignal : this.serviceSignal(provider));
    // Waiting work must remain cancellable even when its eventual first RPC
    // needs to retain a late response containing the owned browser session ID.
    this.queueSignals.set(args, this.serviceSignal(provider));
    try { return await this.call(name, args); }
    finally { this.callSignals.delete(args); this.queueSignals.delete(args); }
  }
  private async browserSlot(signal: AbortSignal, provider?: string): Promise<() => void> {
    signal.throwIfAborted();
    const release = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.browserActive--;
        this.browserQueue.shift()?.grant();
      };
    };
    if (this.browserActive < BROWSER_CONCURRENCY) {
      this.browserActive++;
      return release();
    }
    if (provider) this.browserObserver?.(provider, 'waiting');
    return new Promise((resolve, reject) => {
      const entry = { grant: () => {
        signal.removeEventListener('abort', cancelled);
        this.browserActive++;
        if (provider) this.browserObserver?.(provider, 'started');
        resolve(release());
      } };
      const cancelled = () => {
        const index = this.browserQueue.indexOf(entry);
        if (index !== -1) this.browserQueue.splice(index, 1);
        signal.removeEventListener('abort', cancelled);
        reject(new Error('Provider signup cancelled'));
      };
      this.browserQueue.push(entry);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
  }
  async cancelSignup(provider: string): Promise<void> {
    let controller = this.services.get(provider);
    if (!controller) { controller = new AbortController(); this.services.set(provider, controller); }
    controller.abort(new Error('Provider signup cancelled'));
    for (const handoff of this.handoffs.filter(item => item.provider === provider)) handoff.close();
    await this.finishSession(provider);
  }
  connect(): Promise<void> {
    return this.connection ??= this.connectOnce().catch(error => { this.connection = undefined; throw error; });
  }
  private async connectOnce() {
    const bin = join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
    const env = squireEnvironment();
    // Squire owns its account binding and vault. grunt never reads its files.
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'server'], stderr: 'pipe', env });
    let lastLine = '', partialLine = '';
    const stderr = transport.stderr instanceof Readable ? transport.stderr : null;
    stderr?.setEncoding('utf8');
    const capture = (chunk: string) => {
      const lines = (partialLine + chunk).split(/\r\n|[\r\n]/);
      partialLine = lines.pop()!.slice(0, 8192);
      for (const line of lines) if (line.trim()) lastLine = line.slice(0, 8192);
    };
    stderr?.on('data', capture);
    try {
      await this.client.connect(transport);
      const result = await this.call('list_credentials', { fields: 'summary' }, true);
      if (!Array.isArray(result.credentials)) throw new Error('Squire did not return vault metadata');
      this.metadata = Promise.resolve(result.credentials as Credential[]);
    } catch (error) {
      await this.client.close().catch(() => {});
      const stderrReason = partialLine.trim() || lastLine;
      const mcpReason = error instanceof Error ? error.message : '';
      // Prefer a broker error over a startup banner; use stderr for a bare exit.
      const closed = error instanceof McpError && error.code === ErrorCode.ConnectionClosed
        && mcpReason === `MCP error ${ErrorCode.ConnectionClosed}: Connection closed`;
      const reason = connectionReason(closed ? stderrReason || mcpReason : mcpReason || stderrReason);
      const instruction = 'Connect Trusty Squire separately, then rerun usegrunt setup';
      throw new Error((reason ? `${instruction}: ${reason}` : instruction).slice(0, 300));
    } finally {
      stderr?.off('data', capture);
      // Keep consuming stderr without retaining diagnostics after connecting.
      stderr?.resume();
    }
  }
  async call(name: string, args: ObjectValue, connectionCheck = false): Promise<ObjectValue> {
    const provider = typeof args.service === 'string' ? args.service
      : [...this.sessions].find(([, id]) => id === args.session_id)?.[0];
    const queueSignal = this.queueSignals.get(args) ?? (provider ? this.serviceSignal(provider) : this.signal);
    const release = name === 'operate_drive' || name === 'operate_start' ? await this.browserSlot(queueSignal, provider) : undefined;
    try {
      // A slot can be granted just before cancellation. Recheck before dispatch.
      if (release) queueSignal.throwIfAborted();
      const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: name === 'operate_finish' ? 10000 : 60000, ...(name === 'operate_finish' ? {} : { signal: this.callSignals.get(args) ?? queueSignal }) }).catch(error => {
        if (connectionCheck) throw error;
        throw new Error(`Squire ${name} is unavailable; resume setup after reconnecting Squire`);
      });
      if (result.isError) {
        const reason = connectionCheck ? (result.content as { type: string; text?: string }[])
          .filter(part => part.type === 'text').map(part => part.text ?? '').join(' ') : '';
        throw new Error(reason || `Squire ${name} failed; inspect Squire for the required action`);
      }
      if (result.structuredContent) return object(result.structuredContent);
      for (const part of result.content as { type: string; text?: string }[]) {
        if (part.type === 'text' && part.text) { try { return object(JSON.parse(part.text)); } catch { /* Do not echo upstream output. */ } }
      }
      throw new Error(`Squire ${name} returned an unsupported result`);
    } finally { release?.(); }
  }
  credentials = {
    list: async (): Promise<Credential[]> => {
      return structuredClone(await (this.metadata ??= this.call('list_credentials', { fields: 'summary' }).then(result => {
        if (!Array.isArray(result.credentials)) throw new Error('Squire did not return vault metadata');
        return result.credentials as Credential[];
      }).catch(error => { this.metadata = undefined; throw error; })));
    },
    grant: async (reference: string) => {
      let grant = this.grants.get(reference);
      if (!grant) { grant = this.grant(reference).catch(error => { this.grants.delete(reference); throw error; }); this.grants.set(reference, grant); }
      return grant;
    }
  };
  private async grant(reference: string) {
    const result = await this.call('grant_app_access', { reference });
    if (typeof result.base_url !== 'string' || typeof result.token !== 'string' || !result.token) throw new Error('Squire returned no app grant');
    const url = new URL(result.base_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Squire returned an invalid grant endpoint');
    return { base_url: result.base_url, token: result.token };
  }

  private async finishSession(provider: string, completed = false) {
    const id = this.sessions.get(provider);
    if (!id) return;
    const existing = this.finishing.get(id);
    if (existing) return existing;
    const pending = (async () => {
      try {
        await this.call('operate_finish', { session_id: id, outcome: completed ? 'result' : 'none',
          ...(completed ? { summary: 'grunt provider key stored in user vault' } : {}) });
        if (this.sessions.get(provider) === id) this.sessions.delete(provider);
        this.recoveryChoices.delete(provider);
        this.retries.delete(provider);
        for (const handoff of this.handoffs.filter(item => item.provider === provider)) handoff.close();
      } catch { /* Preserve the original error; close retries a failed cleanup. */ }
    })();
    this.finishing.set(id, pending);
    try { await pending; }
    finally { this.finishing.delete(id); }
  }
  async signup(service: string, url: string, goal: string): Promise<void> {
    const deadline = Date.now() + 600000;
    try {
      while (Date.now() < deadline) {
        this.serviceSignal(service).throwIfAborted();
        const result = await this.drive(service, url, goal);
        if (result.run.state === 'completed') return;
        if (result.run.state !== 'running') throw new SetupFailure(result.reason ?? 'browser could not continue');
      }
      throw new Error(`${service}: signup timed out; rerun setup to resume`);
    } finally { await this.finishSession(service); }
  }
  private async drive(provider: string, url = PROVIDERS[provider], goal?: string): Promise<Run> {
    if (this.closed) throw new Error('Squire setup is closed');
    this.failures.delete(provider);
    this.failureDetails.delete(provider);
    const pending = this.driveOnce(provider, url, goal).catch(async error => {
      await this.finishSession(provider); throw error;
    });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    try { return await this.scoped(pending, this.serviceSignal(provider)); }
    catch (error) { await this.finishSession(provider); throw error; }
  }
  private async driveOnce(provider: string, url: string | undefined, goal?: string): Promise<Run> {
    const entry = registryEntry(provider, url);
    const termsInstruction = ' Accept required provider Terms of Service for this free signup. Never accept a terms control that also selects a paid plan, payment, upgrade, billing change, or another account. Leave optional consent unchecked.';
    const customGoal = goal === undefined ? undefined : `${goal}${this.options.dataSharingApproved?.includes(provider) ? ' Grunt setup enables this free source by default. You may accept its required data-sharing disclosure.' : ' Do not opt in to optional prompt/response retention, staff review or model training; report any required consent for grouped setup approval.'}`;
    const instruction = (customGoal ?? `Use the user's existing ${provider} account or sign up for one. ${provider === 'runcrate' ? 'Use GitHub OAuth for the free path; do not use Google OAuth because that path requires billing.' : provider === 'apinex' ? 'Use Google OAuth with the personal @gmail.com identity already connected to Squire.' : "Prefer Google OAuth using the user's Squire-connected identity."} Reuse an existing key in this user's vault, or create one API key for grunt and store it in this user's Squire vault with service ${provider}. Use operate_extract to capture the key directly into the vault; never put its value in your answer.${provider === 'kilo' ? ' Reuse the existing profile API key without resetting it. Capture with api_hosts ["api.kilo.ai", "ai-gateway.kilo.ai"] in that order and auth_shape "bearer"; grunt uses /api/gateway beneath the grant.' : ''}${provider === 'nvidia' ? ' Capture the API key with api_hosts ["integrate.api.nvidia.com"] and auth_shape "bearer". Never reset or rotate an existing key.' : ''}${provider === 'zro' ? ' Go straight to the API keys page; do not open billing or plan pages, and do not cancel, downgrade, remove a payment method or create another account. Capture the API key with api_hosts ["zro.moonmath.ai"] and auth_shape "bearer". Store service zro, label grunt. Never reset or rotate an existing key.' : ''}${provider === 'tokenharbor' ? ' Go straight to the API keys page. Capture with api_hosts ["tokenharbor.ai"] and auth_shape "bearer", service tokenharbor, label grunt. Do not create a second key if an existing vaulted key is usable, and never reset or rotate an existing key.' : ''}${freeProviderInstructions[provider] ?? ''}${this.options.dataSharingApproved?.includes(provider) ? ' Grunt setup enables this free source by default. You may accept its required prompt/response retention, staff review and provider training disclosure.' : ' Do not opt in to optional prompt/response retention, staff review or model training; if the API key requires that consent, report it for the grouped setup approval.'} No paid plan, payment method, extra account or account switching. Use ordinary email verification only when supported by Squire. Stop for human CAPTCHA, passkey or other human verification. Do not bypass verification. Stop on provider refusal.`) + termsInstruction
      + (entry?.hints ? ` Provider hints (page, control, value, in order): ${entry.hints}` : '');
    const signal = this.serviceSignal(provider);
    // The last Squire result, so a drop can report Squire's own stop reason.
    let last: ObjectValue | undefined;
    const dropped = async (reason: string): Promise<Run> => {
      this.failures.set(provider, reason);
      if (last) {
        const needs = object(last.needs_user);
        const detail = setupReason(...[['status', last.status], ['reason', last.reason], ['remaining', last.remaining], ['field', last.field],
          ['needs', needs.wall], ['message', needs.message], ['error', last.error]]
          .filter(([, value]) => typeof value === 'string' && value.trim()).map(([name, value]) => `${name}: ${value};`));
        if (detail) this.failureDetails.set(provider, detail);
      }
      await this.finishSession(provider);
      return { run: { id: provider, state: 'dropped' }, decision: 'drop', reason };
    };
    const checkCaptured = !goal && !['zro', 'tokenharbor', 'runcrate', 'apinex'].includes(provider);
    let answer: string | undefined;
    let waits = 0;
    const facts = { plan: 'free', project_name: 'grunt' };
    while (true) {
      this.serviceSignal(provider).throwIfAborted();
      const session = this.sessions.get(provider);
      const result = await this.serviceCall(provider, 'operate_drive', {
        ...(session ? { session_id: session } : { url }), goal: instruction,
        facts, max_seconds: 45, max_steps: 60,
        ...(entry?.capture ? { store: entry.capture } : {}),
        ...(answer ? { answer } : {})
      });
      if (typeof result.session_id === 'string') this.sessions.set(provider, result.session_id);
      last = result;
      signal.throwIfAborted();
      answer = undefined;
      // The driver's remaining field can repeat our own goal, including refusal
      // and human-verification instructions. That is not evidence from the site.
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
      const remaining = typeof result.remaining === 'string' && result.remaining.trim()
        && !normalize(instruction).includes(normalize(result.remaining))
        && !normalize(result.remaining).includes(normalize(instruction)) ? result.remaining : undefined;
      const reason = setupReason(result.reason, remaining);
      const classification = [result.reason, remaining].filter(value => typeof value === 'string').join(' ').replace(/[_-]/g, ' ');
      const observedField = typeof result.field === 'string' && result.field.trim()
        && !normalize(instruction).includes(normalize(result.field))
        && !normalize(result.field).includes(normalize(instruction)) ? result.field : undefined;
      const refusal = ['refused', 'rejected', 'denied', 'forbidden'].includes(String(result.status)) || /\b(?:refus(?:al|ed|es|ing)?|denied|prohibit(?:ed|s)?|not allowed|not permitted|forbidden|disallowed)\b/i.test(`${classification} ${observedField ?? ''}`);
      if (refusal) {
        this.failures.set(provider, 'provider refused');
        throw setupStopped(`Provider refused ${provider} signup; setup stopped`, reason);
      }
      if (['pending_approval', 'approval_expired', 'card_incomplete'].includes(String(result.status))) return dropped('browser requested an approval');
      if (result.status === 'complete') {
        this.metadata = undefined; // A browser capture may have added a credential.
        await this.finishSession(provider, true);
        this.serviceSignal(provider).throwIfAborted();
        return { run: { id: provider, state: 'completed' }, decision: 'silent' };
      }
      const active = this.sessions.get(provider);
      const needsUser = object(result.needs_user);
      const handoff = `${classification} ${observedField ?? ''} ${String(needsUser.wall ?? '')} ${String(needsUser.message ?? '')}`.replace(/[_-]/g, ' ');
      const needsTerms = provider === 'zro' && /please read and accept the terms to continue/i.test(String(object(result.observation).dom ?? ''));
      const offeredTerms = Object.entries(object(result.options)).find(([key, label]) => typeof label === 'string' && /\b(?:accept|agree)\b/i.test(label) && /\b(?:terms of service|terms and conditions|terms of use)\b/i.test(label) && guardedSignupChoice(key, label));
      const usedTerms = this.recoveryChoices.get(provider) ?? new Set<string>();
      this.recoveryChoices.set(provider, usedTerms);
      const termsButton = !this.options.agent && !this.options.background && active && (Array.isArray(object(result.observation).safe_table) ? object(result.observation).safe_table as unknown[] : []).find(row =>
        Array.isArray(row) && typeof row[0] === 'string' && ['b', 'c'].includes(String(row[1]))
        && /\b(?:accept|agree)\b/i.test(String(row[2]))
        && /\b(?:terms of service|terms and conditions|terms of use)\b/i.test(String(row[2]).replace(/[_|-]/g, ' '))
        && guardedSignupChoice(row[0], String(row[2]).replace(/[_|-]/g, ' ')) && !usedTerms.has(row[0]));
      if (Array.isArray(termsButton)) {
        usedTerms.add(termsButton[0]);
        await this.serviceCall(provider, 'operate_click', { session_id: active, ref: termsButton[0] });
        continue;
      }
      const humanStep = (needsTerms && !offeredTerms && !this.options.agent) || /\b(?:sms|phone|captcha|passkey|2fa|two factor|email verification|verification (?:code|link)|human (?:verification|assistance))\b/i.test(handoff);
      if (/\b(?:sms|phone)\b/i.test(handoff)) return dropped('needs SMS verification');
      if (humanStep && active && this.canHandOff()) {
        await this.scoped(this.verification.wait({ service: provider, url: await this.humanHandoff(active) }), signal);
        continue;
      }
      if (humanStep && !this.options.background) return dropped(needsTerms ? 'needs Terms of Service acceptance' : 'needs human verification');
      if (['budget', 'evaluate_timeout'].includes(String(result.status))) return { run: { id: provider, state: 'running' }, decision: 'silent' };
      if (checkCaptured) {
        // A new vault entry can be tested directly unless the goal also
        // requires independent proof of the account's free-plan settings.
        this.metadata = undefined;
        const captured = (await this.credentials.list().catch(() => [])).some(credential => sameService(credential, provider)
          && credential.auth_strategy !== 'username_password' && apiKeyField(credential, provider));
        if (captured) {
          await this.finishSession(provider, true);
          return { run: { id: provider, state: 'completed' }, decision: 'silent' };
        }
      }
      const uncertain = ['low_confidence', 'needs_value', 'no_progress', 'stuck', 'invalid_answer'].includes(String(result.status));
      const retry = oauthRetry(result);
      if (!active || (!retry && !uncertain)) return dropped('browser could not continue');
      const turns = this.retries.get(provider) ?? 0;
      if (turns >= 8) return dropped('browser recovery limit reached');
      this.retries.set(provider, turns + 1);
      if (retry) { await delay(3000, undefined, { signal }); answer = 'WAIT'; continue; }
      // Background signups use the router's driver too; it cannot hand off to a person.
      if (this.options.agent && url) {
        let agentResult = result;
        try {
          agentResult = await this.harnessSignup(provider, url, instruction, result, active, signal);
        } catch (error) {
          signal.throwIfAborted();
          const failure = setupFailureReason(error);
          // A driver that hangs until its timeout fails this signup; it never switches drivers.
          if (signupOperatorUnavailable(failure) || failure === 'timed out') return dropped(failure);
        }
        if (['refused', 'rejected', 'denied', 'forbidden'].includes(String(agentResult.status))) return dropped('provider refused');
        if (agentResult.status === 'complete') {
          this.metadata = undefined;
          await this.finishSession(provider, true);
          return { run: { id: provider, state: 'completed' }, decision: 'silent' };
        }
        if (agentResult.status === 'needs_human') return dropped('needs human verification');
        if (agentResult.status === 'needs_sms') return dropped('needs SMS verification');
      }
      if (this.options.background) return dropped('needs foreground signup');
      const used = this.recoveryChoices.get(provider) ?? new Set<string>();
      this.recoveryChoices.set(provider, used);
      const cookie = !this.options.agent && Object.entries(object(result.options)).find(([, label]) => typeof label === 'string'
        && /^(?:reject optional|reject all(?: cookies)?|only necessary(?: cookies)?|continue without accepting)$/i.test(label.trim())
        && !used.has(label.trim().toLowerCase()));
      if (!this.options.agent && offeredTerms && !used.has(String(offeredTerms[1]))) {
        used.add(String(offeredTerms[1]));
        answer = offeredTerms[0];
        continue;
      }
      const oauthProvider = ['runcrate', 'clixad'].includes(provider) || /use GitHub OAuth/i.test(instruction) ? 'GitHub' : 'Google';
      const oauth = this.batchSignup && !this.options.agent && Object.entries(object(result.options)).find(([, label]) => typeof label === 'string'
        && new RegExp(`^(?:sign in|sign up|continue|log in|login) with ${oauthProvider}$`, 'i').test(label.trim())
        && !used.has(label.trim().toLowerCase()));
      if (oauth) {
        used.add(String(oauth[1]).trim().toLowerCase());
        used.add(oauthProvider);
        answer = oauth[0];
        continue;
      }
      if (this.batchSignup && !this.options.agent && url && !used.has(oauthProvider)) {
        const observation = object(result.observation);
        const current = typeof observation.url === 'string' && URL.canParse(observation.url) ? new URL(observation.url) : undefined;
        const controls = Array.isArray(observation.safe_table) ? observation.safe_table : [];
        const alias = new RegExp(`^@(?:sign-in|sign-up|log-in|login|continue)-with-${oauthProvider}(?:-${oauthProvider})?$`, 'i');
        const login = current && new URL(current).origin === new URL(url).origin && controls.find(row =>
          Array.isArray(row) && typeof row[0] === 'string' && ['b', 'l'].includes(row[1])
          && (alias.test(String(row[2]).split('|')[0]!)
            || String(row[2]).toLowerCase().startsWith(`@${oauthProvider.toLowerCase()}|`)
              && String(row[2]).split('|').includes('a=login')));
        if (login) {
          const clicked = await this.serviceCall(provider, 'operate_click', { session_id: active, ref: login[0] });
          if (oauthRetry(clicked)) { await delay(3000, undefined, { signal }); answer = 'WAIT'; }
          else used.add(oauthProvider);
          continue;
        }
      }
      if (this.batchSignup && !this.options.agent && waits < 2 && !cookie && /(?:confidence|loading|no progress)/i.test(`${classification} ${result.status}`.replace(/_/g, ' '))) {
        waits++;
        answer = 'WAIT';
        continue;
      }
      if (cookie && used.size < 4) {
        used.add(String(cookie[1]).trim().toLowerCase());
        answer = cookie[0];
        continue;
      }
      if (this.canHandOff()) {
        await this.scoped(this.verification.wait({ service: provider, url: await this.humanHandoff(active) }), signal);
        continue;
      }
      return dropped(this.failures.get(provider) ?? 'browser could not continue');
    }
  }
  private async harnessSignup(provider: string, url: string, goal: string, initial: ObjectValue, session: string, signal: AbortSignal) {
    const tools = await this.client.listTools();
    let latest = initial;
    let turns = 0;
    let started = false;
    let busy = false;
    let email: string | undefined;
    let observation = object(initial.observation);
    // Values Grunt itself supplies for this signup; the operator may type or pass only these.
    const supplied = () => ['grunt', 'free', ...(email ? [email] : [])];
    const terminal = () => ['complete', 'needs_sms', 'refused', 'rejected', 'denied', 'forbidden'].includes(String(latest.status));
    // After a terminal result, answer every further call with a final stop instead
    // of replaying the stale page, which reads as unfinished work.
    const finished = () => latest.status === 'complete'
      ? { status: 'complete', reason: 'Squire finished this signup and stored any requested key in the vault. No further browser steps are needed; stop calling tools and report that Squire completed.' }
      : { status: String(latest.status), reason: 'This signup has stopped. No further browser steps are available; stop calling tools and report the status.' };
    try { await this.options.agent!({
      service: provider, url, goal, signal,
      tools: tools.tools.filter(tool => signupAgentTools.has(tool.name)),
      call: async (name, args) => {
        if (terminal()) return finished();
        if (busy || ++turns > 24 || !signupAgentTools.has(name)) return { status: 'stopped', reason: 'Tool unavailable for this signup' };
        busy = true;
        try {
          signal.throwIfAborted();
          if (!started) {
            if (name !== 'operate_drive') return { status: 'stopped', reason: 'Call operate_drive first' };
            started = true;
            return signupAgentResult(latest);
          }
          if (name === 'operate_drive') {
            const answer = typeof args.answer === 'string' && (args.answer === 'WAIT' || Object.hasOwn(object(latest.options), args.answer)) ? args.answer : undefined;
            if (args.answer !== undefined && (!answer || (answer !== 'WAIT' && !guardedSignupChoice(answer, object(latest.options)[answer]))))
              return { status: 'invalid_answer', reason: 'Choose a safe, currently offered option or WAIT',
                allowed_answers: [...Object.entries(object(latest.options)).filter(([key, label]) => guardedSignupChoice(key, label)).map(([key]) => key), 'WAIT'] };
            if (oauthRetry(latest)) await delay(3000, undefined, { signal });
            // Forward any fact the operator names whose value Grunt supplies (e.g. "Key Name": "grunt").
            const facts = Object.fromEntries(Object.entries(object(args.facts)).filter(([, value]) => typeof value === 'string' && supplied().includes(value)));
            latest = await this.serviceCall(provider, name, { session_id: session, goal, facts: { ...facts, plan: 'free', project_name: 'grunt' }, max_seconds: 45, max_steps: 30,
              ...(answer ? { answer } : {}) });
            observation = object(latest.observation);
            const browserWall = object(latest.needs_user);
            if (/\b(?:sms|phone)\b/i.test(`${latest.field ?? ''} ${browserWall.wall ?? ''} ${browserWall.message ?? ''}`))
              latest = { status: 'needs_sms' };
            return signupAgentResult(latest);
          }
          if (name === 'operate_share') {
            latest = { status: 'needs_human' };
            if (!this.canHandOff()) return latest;
            await this.scoped(this.verification.wait({ service: provider, url: await this.humanHandoff(session) }), signal);
            return { status: 'human_finished', reason: 'Resume the same browser with operate_drive' };
          }
          if (name === 'operate_extract') {
            const capture = signupCapture(args.capture, provider);
            const store = args.store === undefined ? undefined : object(args.store);
            if (args.into_slot !== undefined || capture === null || (store && store.service !== provider) || (!store && !capture))
              return { status: 'stopped', reason: 'Capture directly into this provider’s vault entry' };
            args = { ...(typeof args.selector === 'string' ? { selector: args.selector } : {}), ...(store ? { store } : {}), ...(capture ? { capture } : {}) };
          }
          const text = typeof args.text === 'string' ? args.text : '';
          if (name === 'operate_type' && !supplied().includes(text)) return { status: 'stopped', reason: 'Only values Grunt supplies (key or project name, plan, Squire-connected email) can be typed', allowed_text: supplied() };
          if (['operate_click', 'operate_type', 'operate_select'].includes(name)) {
            const ref = typeof args.ref === 'string' ? args.ref : args.target;
            const control = (Array.isArray(observation.safe_table) ? observation.safe_table : [])
              .find(row => Array.isArray(row) && row[0] === ref);
            const label = Array.isArray(control) ? String(control[2] ?? '') : '';
            const safe = name === 'operate_type' ? Array.isArray(control) && (text !== email || /(?:email|e-mail)/i.test(label)) : guardedSignupChoice(String(ref), label);
            if (!safe) return { status: 'stopped', reason: 'Observe and choose a safe browser control: use a ref from the latest operate_observe result' };
            if (name === 'operate_click') args = { ref };
            if (name === 'operate_type') args = { ref, text };
            if (name === 'operate_select') {
              const values = Array.isArray(args.values) ? args.values : [];
              if (values.length !== 1 || !guardedSignupChoice(String(ref), values[0])) return { status: 'stopped', reason: 'Select a safe option' };
              args = { ref, values };
            }
          }
          const result = await this.serviceCall(provider, name, { ...args, session_id: session });
          if (name === 'operate_observe') {
            observation = result;
            if (typeof result.user_email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result.user_email)) email = result.user_email;
          }
          return signupAgentResult(result);
        } finally { busy = false; }
      }
    }); } catch (error) {
      signal.throwIfAborted();
      if (!terminal() && latest.status !== 'needs_human') throw error;
    }
    return latest;
  }
  async humanHandoff(session: string) {
    const provider = [...this.sessions].find(([, id]) => id === session)?.[0];
    const share = await (provider ? this.serviceCall(provider, 'operate_share', { session_id: session }) : this.call('operate_share', { session_id: session }));
    if (provider) this.serviceSignal(provider).throwIfAborted();
    if (typeof share.url !== 'string') throw new Error('Squire returned no browser handoff link');
    const proxy = await proxyApproval(share.url);
    if (provider && this.serviceSignal(provider).aborted) { proxy.close(); throw new Error('Provider signup cancelled'); }
    this.handoffs.push({ ...proxy, ...(provider ? { provider } : {}) });
    return proxy.url;
  }
  runs = {
    start: async (input: ProvisionInput) => this.drive(input.service as Provider),
    get: async (id: string) => { const result = await this.drive(id as Provider); return { state: result.run.state, ...(result.approval_url ? { approval_url: result.approval_url } : {}), ...(result.reason ? { reason: result.reason } : {}) }; }
  };
  async close() {
    this.closed = true;
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.sessions.keys()].map(provider => this.finishSession(provider)));
    for (const handoff of this.handoffs) handoff.close();
    await this.client.close();
  }
}

// This internal account already owns existing router databases; retain its identity.
export const ROUTER_ADMIN_EMAIL = 'milo@localhost.local';
const managedLabels = (provider: string) => [`Grunt ${providerLabel(provider)} (Squire)`, `Milo ${providerLabel(provider)} (Squire)`];
const providerPath = (provider: string) => ({ groq: '/openai/v1', kilo: '/api/gateway' })[provider] ?? '/v1';

export class FreeLLMAdmin {
  private token = '';
  readonly url: string;
  constructor(url = gruntEnv('FREELLMAPI_URL') || 'http://127.0.0.1:3001') { this.url = loopback(url).origin; }
  async call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(`${this.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Local FreeLLMAPI setup returned HTTP ${response.status}`);
    return await response.json();
  }
  async login(password: string) { this.token = (await this.call('/auth/login', { email: ROUTER_ADMIN_EMAIL, password })).token; }
  async hasKey(platform: string) {
    const keys = await this.call('/keys', undefined, 'GET') as { id: number; platform: string; label: string; baseUrl?: string; models?: { modelId: string }[] }[];
    const key = keys.find(key => key.platform === 'custom' && managedLabels(platform).includes(key.label) && (providerURL(platform) ? !!key.baseUrl : key.baseUrl?.endsWith(providerPath(platform))));
    if (!key || !key.models?.length) return false;
    const discovery = await this.call('/keys/custom/discover-models', { keyId: key.id }) as { models: { id: string }[] };
    const available = new Set(discovery.models.map(model => model.id));
    const wanted = providerModels[platform]?.filter(id => available.has(id));
    if (wanted) {
      const required = platform === 'kilo' ? wanted : wanted.slice(0, 1);
      return required.length > 0 && required.every(id => key.models!.some(model => model.modelId === id));
    }
    return key.models.some(model => available.has(model.modelId));
  }
  async addGrant(platform: string, grant: { base_url: string; token: string }, choose: (models: string[]) => Promise<string> = chooseModel) {
    // Custom endpoints bind the grant URL and token to their own model rows.
    const custom = !!providerURL(platform);
    const baseUrl = custom ? grant.base_url : grant.base_url.replace(/\/$/, '') + providerPath(platform);
    const label = `Grunt ${providerLabel(platform)} (Squire)`;
    let discovery: { models: { id: string }[] };
    try { discovery = await this.call('/keys/custom/discover-models', { baseUrl, apiKey: grant.token }); }
    catch { throw new Error('Model discovery failed; check the base URL and API key (the provider may have rejected it)'); }
    if (!discovery.models?.length) throw new Error('The provider returned no models; check the base URL and API key');
    const available = new Set(discovery.models.map(model => model.id));
    const candidates = providerModels[platform] ?? ['openai/gpt-oss-120b', 'gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
    const models = custom ? [await choose([...available])] : platform === 'kilo' ? candidates.filter(id => available.has(id)) : candidates.filter(id => available.has(id)).slice(0, 1);
    if (!models.length || models.some(model => !available.has(model))) throw new Error(`No supported chat model is currently available from ${platform}`);

    const previous = await this.call('/keys', undefined, 'GET') as { id: number; platform: string; label: string; baseUrl?: string }[];
    const registered = await this.call('/keys/custom', { baseUrl, apiKey: grant.token,
      label, models: models.map(model => ({ model, supportsTools: true })) });
    if (custom && !Number.isInteger(registered?.keyId)) throw new Error('The router did not confirm the provider registration');
    for (const key of previous) {
      if (Number.isInteger(key.id) && key.platform === 'custom' && managedLabels(platform).includes(key.label) && (custom ? key.id !== registered.keyId : key.baseUrl !== baseUrl)) await this.call(`/keys/${key.id}`, undefined, 'DELETE');
    }
  }
  async migrateKiloModels(approved: readonly string[], savedChain?: FallbackRow[]) {
    const chain = savedChain ?? await this.call('/fallback', undefined, 'GET') as FallbackRow[];
    const updates = chain.filter(row => managedSharingProvider(row) === 'kilo' && row.enabled !== false
      && (obsoleteManagedKilo(row) || !approved.includes('kilo') || row.priority !== 999999))
      .map(row => ({ modelDbId: row.modelDbId, enabled: approved.includes('kilo') && !obsoleteManagedKilo(row),
        priority: obsoleteManagedKilo(row) || !approved.includes('kilo') ? row.priority : 999999 }));
    // Quarantine before any catalog lookup/registration, so partial failures
    // cannot leave a retired managed route enabled for the next request.
    if (updates.length) await this.call('/fallback', updates, 'PUT');
    if (!approved.includes('kilo')) return;
    const keys = await this.call('/keys', undefined, 'GET') as { id?: number; platform: string; label: string; baseUrl?: string; models?: { modelId: string }[] }[];
    const complete = new Set(keys.filter(key => key.platform === 'custom' && key.models?.some(model => model.modelId === KILO_PARTICLE)).map(key => key.baseUrl));
    for (const key of keys) {
      if (key.platform !== 'custom' || !['Kilo Free', ...managedLabels('kilo')].includes(key.label) || !Number.isInteger(key.id) || !key.id || key.id < 1
        || !key.baseUrl || complete.has(key.baseUrl) || !Array.isArray(key.models)) continue;
      const catalog = await this.call('/keys/custom/discover-models', { keyId: key.id }) as { models: { id: string }[] };
      if (!catalog.models.some(model => model.id === KILO_PARTICLE)) continue;
      // The backend reuses this exact credential. Never read or replace it.
      // Omitted capability flags preserve an existing custom row's settings;
      // the backend already defaults newly inserted chat models to tools-on.
      const registered = await this.call('/keys/custom', { keyId: key.id, models: [{ model: KILO_PARTICLE }] }) as {
        modelDbId?: number; model?: string; created?: number;
        models?: { modelDbId: number; model: string; created: boolean }[];
      };
      if (!Number.isInteger(registered.modelDbId) || !registered.modelDbId || registered.modelDbId < 1 || registered.model !== KILO_PARTICLE) throw new Error('Legacy Kilo Particle registration could not be verified');
      const created = registered.models?.find(model => model.modelDbId === registered.modelDbId && model.model === KILO_PARTICLE)?.created;
      // A user may register/disable this model while catalog discovery runs.
      // Upsert preserves existing fallback flags; only default a new row.
      if (created === true || (created === undefined && registered.created === 1)) {
        await this.call('/fallback', [{ modelDbId: registered.modelDbId, enabled: true, priority: 999999 }], 'PUT');
      }
      complete.add(key.baseUrl);
    }
  }
  async ensureFreeFallbacks(dataSharingApproved?: readonly string[]) {
    const approved = dataSharingApproved ?? await readDataSharingConsent(dirname(localAdminPath()), ['kilo']);
    // Retired Grunt-owned rows stay quarantined even if a saved sharing receipt
    // approved them. Disable before unrelated discovery can fail.
    const chain = await this.call('/fallback', undefined, 'GET') as FallbackRow[];
    const retired = chain.filter(row => retiredManagedAdapter(row) && row.enabled !== false)
      .map(row => ({ modelDbId: row.modelDbId, enabled: false, priority: row.priority }));
    if (retired.length) await this.call('/fallback', retired, 'PUT');
    await this.migrateKiloModels(approved);
    const keys = await this.call('/keys', undefined, 'GET') as { platform: string; label: string; baseUrl?: string }[];
    for (const provider of freeConfig().customProviders) {
      if (provider.label === 'Kilo Free' && !approved.includes('kilo')) continue;
      if (!keys.some(key => key.platform === 'custom' && key.baseUrl === provider.baseUrl)) await this.call('/keys/custom', provider);
    }
  }
  async configureChain(excluded: string[] = [], dataSharingApproved?: readonly string[]) {
    const approved = dataSharingApproved ?? await readDataSharingConsent(dirname(localAdminPath()), DATA_SHARING_POLICIES.map(policy => policy.provider));
    const chain = await this.call('/fallback', undefined, 'GET') as { modelDbId: number; platform: string; modelId: string; priority: number; keyLabel: string | null; enabled?: boolean }[];
    const rows = chain.map(row => {
      const provider = row.keyLabel?.match(/^(?:Grunt|Milo) (.+) \(Squire\)$/)?.[1];
      const owned = managedSharingProvider(row);
      const fallback = !provider && owned !== undefined;
      const retired = retiredManagedAdapter(row);
      const sharingAllowed = !retired && (!owned || approved.includes(owned));
      const vetted = !provider || !providerModels[provider] || providerModels[provider].includes(row.modelId);
      const disabledParticle = owned === 'kilo' && row.modelId === KILO_PARTICLE && row.enabled === false;
      return { modelDbId: row.modelDbId,
        enabled: sharingAllowed && !obsoleteManagedKilo(row) && !disabledParticle
          && (fallback || (provider ? row.platform === 'custom' && vetted && !excluded.map(providerLabel).includes(provider) : row.enabled === true)),
        priority: disabledParticle || retired ? row.priority : owned === 'kilo' ? 999999 : row.priority };
    });
    await this.call('/fallback', rows, 'PUT');
    await this.call('/fallback/routing', { strategy: 'priority' }, 'PUT');
  }
  async key(): Promise<string> { return (await this.call('/settings/api-key', undefined, 'GET')).apiKey; }
}

type DockerRun = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
// Read only key metadata from the legacy volume. Never load or print key values.
const inspectRouterKeys = `
const fs = require('node:fs');
const path = '/data/freeapi.db';
if (!fs.existsSync(path)) {
  if (fs.readdirSync('/data').length) throw new Error('Unrecognized router data');
  console.log('empty');
} else {
  const Database = require('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const keys = db.prepare("SELECT EXISTS(SELECT 1 FROM api_keys WHERE platform != 'custom' OR label NOT IN ('Kilo Free', 'Freebuff')) AS present").get();
  console.log(keys.present ? 'keys' : 'empty');
  db.close();
}`;
// Resource discovery preserves existing containers and volumes; only fresh installs
// use Grunt names. Never rename a volume containing encrypted provider credentials.
const routerResources = [
  { name: 'grunt-freellmapi', label: 'io.grunt.router' },
  { name: 'milo-freellmapi', label: 'io.milo.router' }
];
export async function ensureRouter(password: string, encryption: string, run: DockerRun = argsWithEnv, recreate = false) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('grunt FreeLLMAPI requires Docker on Linux or macOS');
  let resource = routerResources[0]!;
  let owner: string | undefined;
  for (const candidate of routerResources) {
    try {
      owner = (await run(['inspect', '--format', `{{ index .Config.Labels "${candidate.label}" }}`, candidate.name])).stdout.trim();
      resource = candidate;
      break;
    } catch (error) {
      if (!/No such (object|container)/i.test(String((error as { stderr?: string }).stderr))) throw new Error('Docker is unavailable. Install and start Docker Desktop, then run npx usegrunt setup again');
    }
  }
  if (owner !== undefined) {
    if (owner !== '1') throw new Error(`The ${resource.name} container belongs to another installation; setup stopped`);
    if (!recreate) { await run(['start', resource.name]); return; }
  }
  await run(['pull', FREELLMAPI_IMAGE]);
  if (recreate) {
    let volume = false;
    for (const candidate of owner === undefined ? routerResources : [resource]) {
      try { await run(['volume', 'inspect', candidate.name + '-data']); resource = candidate; volume = true; break; }
      catch (error) {
        if (!/No such volume/i.test(String((error as { stderr?: string }).stderr))) throw new Error('Cannot inspect the old router volume; its data was preserved');
      }
    }
    if (volume) {
      let state: string;
      try {
        state = (await run(['run', '--rm', '--network', 'none', '--mount', `type=volume,src=${resource.name}-data,dst=/data,readonly`, '--entrypoint', 'node', FREELLMAPI_IMAGE, '-e', inspectRouterKeys])).stdout.trim();
      } catch { throw new Error('Cannot check the old router for provider keys; its data was preserved'); }
      if (state !== 'empty') throw new Error('Local router admin credentials are missing and the old router may contain provider keys; its data was preserved. Restore the local admin file before rerunning setup');
    }
    if (owner !== undefined) await run(['rm', '-f', resource.name]);
    if (volume) await run(['volume', 'rm', resource.name + '-data']);
  }
  // Docker copies named variables from env, keeping secrets out of argv.
  await run(['run', '-d', '--name', resource.name, '--label', resource.label + '=1', ...(process.platform === 'linux' ? ['--network', 'host'] : ['-p', '127.0.0.1:3001:3001']), '--restart', 'unless-stopped', '-v', resource.name + '-data:/app/server/data', '-e', process.platform === 'linux' ? 'HOST=127.0.0.1' : 'HOST=0.0.0.0', '-e', 'PORT=3001', '-e', 'PROVIDER_TIMEOUT_CUSTOM=600000', '-e', 'ENCRYPTION_KEY', '-e', 'FREEAPI_CONFIG_JSON', FREELLMAPI_IMAGE], {
    ...process.env, ENCRYPTION_KEY: encryption, FREEAPI_CONFIG_JSON: JSON.stringify({ admin: { email: ROUTER_ADMIN_EMAIL, password }, ...freeConfig() })
  });
}
async function argsWithEnv(args: string[], env?: NodeJS.ProcessEnv) {
  return await exec('docker', args, { timeout: 300000, maxBuffer: 1048576, ...(env ? { env } : {}) });
}
type LocalAdmin = { password: string; encryption: string };
function localAdminPath() {
  return join(configRoot(), 'router-admin.json');
}
async function readLocalAdmin(path = localAdminPath()): Promise<LocalAdmin | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot read the local router admin file; setup stopped');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('permissions');
    const saved = object(JSON.parse(await handle.readFile('utf8')));
    if (typeof saved.password !== 'string' || !/^[a-f0-9]{64}$/.test(saved.password)
      || typeof saved.encryption !== 'string' || !/^[a-f0-9]{64}$/.test(saved.encryption)) throw new Error('format');
    return { password: saved.password, encryption: saved.encryption };
  } catch { throw new Error('Invalid local router admin file; it must belong to this user and have mode 0600. Restore it before rerunning setup'); }
  finally { await handle.close(); }
}
async function saveLocalAdmin(admin: LocalAdmin) {
  const path = localAdminPath(), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(admin), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch { throw new Error('Cannot save the local router admin file; setup stopped'); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
type FallbackRow = { modelDbId: number; platform: string; modelId: string; priority: number; keyLabel: string | null; enabled?: boolean };
function managedSharingProvider(row: Pick<FallbackRow, 'platform' | 'modelId' | 'keyLabel'>): string | undefined {
  if (row.platform !== 'custom') return;
  if (managedLabels('kilo').includes(row.keyLabel ?? '') || row.keyLabel === 'Kilo Free') return 'kilo';
  if (row.keyLabel === 'Freebuff' && row.modelId === 'freebuff') return 'freebuff';
  for (const provider of disabledAdapters) if (managedLabels(provider).includes(row.keyLabel ?? '')) return provider;
  return;
}
const obsoleteManagedKilo = (row: Pick<FallbackRow, 'platform' | 'modelId' | 'keyLabel'>) => managedSharingProvider(row) === 'kilo' && row.modelId !== KILO_PARTICLE;
// Keep legacy label recognition for retirement; never recreate these rows.
const retiredManagedAdapter = (row: Pick<FallbackRow, 'platform' | 'modelId' | 'keyLabel'>) => {
  const provider = managedSharingProvider(row);
  return provider !== undefined && disabledAdapters.has(provider);
};
// Reconcile only Grunt-owned sharing rows before a legacy backend request. This
// never provisions a router, changes custom rows, or enables a disabled row.
export class RouterSetupPending extends Error {}
export async function guardRouterSharing(url: string, directory: string): Promise<void> {
  const approved = await readDataSharingConsent(directory, ['kilo']);
  const admin = await readLocalAdmin(join(directory, 'router-admin.json'));
  if (!admin) throw new Error('Local router admin state is required to enforce data-sharing choices; rerun usegrunt setup');
  const router = new FreeLLMAdmin(url);
  await router.login(admin.password);
  const chain = await router.call('/fallback', undefined, 'GET') as FallbackRow[];
  const updates = chain.filter(row => { const provider = managedSharingProvider(row); return provider && (retiredManagedAdapter(row) || !approved.includes(provider) || obsoleteManagedKilo(row)) && row.enabled !== false; })
    .map(row => ({ modelDbId: row.modelDbId, enabled: false, priority: row.priority }));
  if (updates.length) await router.call('/fallback', updates, 'PUT');
  const patched = chain.map(row => ({ ...row, ...updates.find(update => update.modelDbId === row.modelDbId) }));
  const pending = (await readSetupSession(directory))?.pending;
  if (patched.some(row => {
    const provider = managedSharingProvider(row);
    return provider && row.enabled !== false && pending?.has(provider);
  })) throw new RouterSetupPending('A managed provider is still being verified');
  // An old aggregate backend must not create a new owned route before the
  // corresponding direct source has passed its foreground verification.
  await router.migrateKiloModels(approved.filter(provider => !pending?.has(provider)), patched);
}
// Read the login already created by setup; never provision or change router state.
export async function loadRouterKey(url: string): Promise<string> {
  const admin = await readLocalAdmin();
  if (!admin) throw new Error('Local router login is missing');
  const router = new FreeLLMAdmin(url);
  await router.login(admin.password);
  const key = await router.key();
  if (typeof key !== 'string' || !key.trim()) throw new Error('Local router returned an invalid API key');
  return key;
}
const routerStarts = new Map<string, Promise<FreeLLMAdmin>>();
// Provider signups overlap, but they must share one local router initialization.
// Otherwise two fresh jobs can generate different encryption keys for one DB.
function readyRouter(signal?: AbortSignal): Promise<FreeLLMAdmin> {
  const key = JSON.stringify([localAdminPath(), gruntEnv('FREELLMAPI_URL'), gruntEnv('ROUTER_RUNTIME')]);
  const existing = routerStarts.get(key);
  if (existing) return existing;
  const starting = (async () => {
    const router = new FreeLLMAdmin();
    signal?.throwIfAborted();
    const saved = await readLocalAdmin();
    if (!saved && gruntEnv('ROUTER_RUNTIME') !== 'docker') {
      const database = join(dirname(localAdminPath()), 'freellmapi', 'router.db');
      let exists = false;
      try { await lstat(database); exists = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot inspect the existing router database; setup stopped');
      }
      if (exists) throw new Error('Existing router database has no local encryption key. Restore its original private router login before rerunning setup');
    }
    const admin = saved ?? { password: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('hex') };
    if (gruntEnv('ROUTER_RUNTIME') === 'docker') {
      await ensureRouter(admin.password, admin.encryption, argsWithEnv, !saved);
      if (!saved) await saveLocalAdmin(admin);
    } else {
      if (!saved) await saveLocalAdmin(admin);
      const { ensureNativeRouter } = await import('./native-router.js');
      let running = false;
      if (saved) { try { await router.login(admin.password); running = true; } catch { /* Repair an unavailable backend. */ } }
      if (!running) await ensureNativeRouter(signal);
    }
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal?.throwIfAborted();
      try { await router.login(admin.password); ready = true; break; } catch { await delay(1000, undefined, signal ? { signal } : {}); }
    }
    if (!ready) throw new Error('Local FreeLLMAPI did not start; inspect its health before resuming setup');
    await router.ensureFreeFallbacks();
    await router.configureChain();
    return router;
  })();
  routerStarts.set(key, starting);
  void starting.finally(() => { if (routerStarts.get(key) === starting) routerStarts.delete(key); }).catch(() => {});
  return starting;
}
export async function bootstrapKilo(squire: SetupSquire, directory: string, notify: (line: string) => void) {
  const result = await setupProviders(squire, {
    addGrant: async (_provider, grant) => writePrivateProviderGrant('kilo', grant, directory)
  }, { providers: ['kilo'], reuseSaved: false, notify });
  if (result.dropped.length) throw new SetupFailure('no verified Kilo credential');
}

export async function setup(notify = console.log, providers: string[] = ['groq'], options: { squire?: SetupSquire; signal?: AbortSignal; directory?: string; background?: boolean; dataSharingApproved?: readonly string[]; connect?: () => Promise<void>; upgradeBeatAPI?: boolean } = {}) {
  const retired = providers.find(provider => disabledAdapters.has(provider));
  if (retired) throw new Error(`${retired} routing is disabled`);
  const location = options.directory ?? configRoot();
  const approved = [...new Set([...(options.dataSharingApproved ?? []).filter(id => !requiresExplicitDataSharing(id)),
    ...await readDataSharingConsent(location, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
  const unapproved = dataSharingPolicies(providers).filter(policy => !approved.includes(policy.provider));
  if (unapproved.length) throw new Error(`${unapproved.map(policy => policy.name).join(', ')} data sharing requires the grouped setup approval`);
  const owned = options.squire ? undefined : new BrowserSquire({ ...(options.signal ? { signal: options.signal } : {}), background: options.background, dataSharingApproved: approved });
  if (options.squire instanceof BrowserSquire) options.squire.approveDataSharing(approved);
  const squire = options.squire ?? owned!;
  try {
    if (providers.includes('antseed-vikey')) {
      await setupAntseedVikey({ directory: location, dataSharingApproved: approved, notify, ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'antseed-vikey');
    }
    if (providers.includes('reflection-beam')) {
      await verifyKiloAccess({ reflectionBeam: true, ...(options.signal ? { signal: options.signal } : {}) });
      notify('Reflection Beam: exact free access verified; no account or API key required');
      providers = providers.filter(provider => provider !== 'reflection-beam');
    }
    if (providers.includes('kilo')) {
      await verifyKiloAccess({ ...(options.signal ? { signal: options.signal } : {}) });
      notify('Kilo: free Particle-1 access verified; no account or API key required');
      providers = providers.filter(provider => provider !== 'kilo');
    }
    if (providers.includes('millionseek')) {
      await setupMillionSeek({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'millionseek');
    }
    if (providers.includes('freepi')) {
      await setupFreePi({ directory: location, squire: { signup: async (service, url, instructions) => {
        const signup = (squire as SetupSquire & Partial<Pick<BrowserSquire, 'signup'>>).signup;
        if (!signup) throw new Error('Free-Pi requires browser-capable Trusty Squire');
        if (options.connect) await options.connect(); else await owned?.connect();
        await signup.call(squire, service, url, instructions);
      } }, notify, background: options.background ?? false, ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'freepi');
    }
    if (providers.includes('nous')) {
      await setupNous({ directory: location, notify, background: options.background ?? false, squire: squire as SetupSquire & Pick<BrowserSquire, 'signup'>,
        connect: async () => { if (options.connect) await options.connect(); else if (owned) await owned.connect(); else if (squire instanceof BrowserSquire) await squire.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'nous');
    }
    if (providers.includes('kenari')) {
      await setupKenari({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'kenari');
    }
    if (providers.includes('numes')) {
      await setupNumes({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'numes');
    }
    for (const id of ['fikra', 'openference'] as const) {
      if (!providers.includes(id)) continue;
      await setupPromotionalApi(id, { directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== id);
    }
    if (providers.includes('aperture-ai')) {
      await setupAperture({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'aperture-ai');
    }
    if (providers.includes('darus')) {
      await setupDarus({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'darus');
    }
    if (providers.includes('crowllm')) {
      await setupCrowLLM({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'crowllm');
    }
    if (providers.includes('goedel')) {
      await setupGoedel({ directory: location, squire, notify, background: options.background ?? false,
        connect: async () => { if (options.connect) await options.connect(); else await owned?.connect(); },
        ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'goedel');
    }
    // Idle sync only reuses verified state for these guarded sources. It never
    // deletes their receipts, provisions a browser or changes account settings.
    if (options.background) {
      const browser = squire as SetupSquire & Pick<BrowserSquire, 'signup' | 'call' | 'cancelSignup'>;
      for (const provider of ['pollinations', 'beatapi', 'clixad', 'perch'] as const) {
        if (!providers.includes(provider)) continue;
        await (provider === 'pollinations' ? setupPollinations : provider === 'beatapi' ? setupBeatAPI : provider === 'clixad' ? setupClixad : setupPerch)({ directory: location, squire: browser, background: true,
          dataSharingApproved: approved, notify, ...(options.signal ? { signal: options.signal } : {}) });
        providers = providers.filter(id => id !== provider);
      }
    }
    if (!providers.length) return {};
    await owned?.connect();
    options.signal?.throwIfAborted();
    for (const provider of ['pollinations', 'beatapi', 'clixad', 'perch'] as const) {
      if (!providers.includes(provider)) continue;
      const browser = squire as SetupSquire & Pick<BrowserSquire, 'signup' | 'call' | 'cancelSignup'>;
      if (typeof browser.signup !== 'function') throw new Error(`${provider} signup requires a browser-capable Squire client`);
      await (provider === 'pollinations' ? setupPollinations : provider === 'beatapi' ? setupBeatAPI : provider === 'clixad' ? setupClixad : setupPerch)({ directory: location, squire: browser,
        dataSharingApproved: approved, notify, ...(options.signal ? { signal: options.signal } : {}),
        ...(provider === 'beatapi' && options.upgradeBeatAPI ? { upgradeExisting: true } : {}) });
      providers = providers.filter(id => id !== provider);
    }
    if (providers.includes('livekit')) {
      const browser = squire as SetupSquire & Pick<BrowserSquire, 'signup'>;
      if (typeof browser.signup !== 'function') throw new Error('LiveKit native signup requires a browser-capable Squire client');
      await setupLiveKit({ directory: location, squire: browser, notify, ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'livekit');
    }
    if (providers.includes('mistral-vibe')) {
      const browser = squire as SetupSquire & Pick<BrowserSquire, 'signup'>;
      if (typeof browser.signup !== 'function') throw new Error('Mistral Vibe native signup requires a browser-capable Squire client');
      await setupMistralVibe({ directory: location, squire: browser, notify, ...(options.signal ? { signal: options.signal } : {}) });
      providers = providers.filter(provider => provider !== 'mistral-vibe');
    }
    for (const provider of ['runcrate', 'apinex'] as const) {
      if (!providers.includes(provider)) continue;
      const source = provider === 'runcrate' ? new Runcrate({ directory: location }) : new Apinex({ directory: location });
      const writeGrant = provider === 'runcrate' ? writeRuncrateGrant : writeApinexGrant;
      try {
        const result = await setupProviders(squire, {
          hasKey: async id => id === provider && await source.available(),
          addGrant: async (id, grant) => {
            if (id !== provider) throw new Error(`Unexpected ${provider} credential`);
            await writeGrant(grant, location);
            if (!await source.available()) throw new Error(`${provider}: verified free access is unavailable`);
          }
        }, { providers: [provider], notify, reuseSaved: false, verifySaved: [provider] });
        if (result.dropped.length) throw new Error(`${provider} setup incomplete; rerun usegrunt setup`);
      } finally { await source.close(); }
      providers = providers.filter(id => id !== provider);
    }
    if (!providers.length) return {};
    if (providers.includes('zro')) {
      const source = new Zro({ directory: location });
      try {
        const result = await setupProviders(squire, {
          hasKey: async provider => provider === 'zro' && await source.available(),
          addGrant: async (provider, grant) => {
            if (provider !== 'zro') throw new Error('Unexpected Zro credential');
            await writeZroGrant(grant, location);
          }
        }, { providers: ['zro'], notify, reuseSaved: false, verifySaved: ['zro'] });
        if (result.dropped.length) throw new Error('Zro setup incomplete; rerun usegrunt setup');
      } finally { await source.close(); }
      providers = providers.filter(provider => provider !== 'zro');
      if (!providers.length) return {};
    }
    if (providers.includes('tokenharbor')) {
      const source = new TokenHarbor({ directory: location });
      try {
        const result = await setupProviders(squire, {
          hasKey: async provider => provider === 'tokenharbor' && await source.available(),
          addGrant: async (provider, grant) => {
            if (provider !== 'tokenharbor') throw new Error('Unexpected Token Harbor credential');
            await writeTokenHarborGrant(grant, location);
          }
        }, { providers: ['tokenharbor'], notify, reuseSaved: false, verifySaved: ['tokenharbor'] });
        if (result.dropped.length) throw new Error('Token Harbor setup incomplete; rerun usegrunt setup');
      } finally { await source.close(); }
      providers = providers.filter(provider => provider !== 'tokenharbor');
      if (!providers.length) return {};
    }
    if (providers.includes('nvidia')) {
      const source = new Nvidia();
      try {
        const result = await setupProviders(squire, {
          hasKey: async provider => provider === 'nvidia' && await source.available(),
          addGrant: async (provider, grant) => {
            if (provider !== 'nvidia') throw new Error('Unexpected NVIDIA credential');
            await writeNvidiaGrant(grant);
          }
        }, { providers: ['nvidia'], notify, reuseSaved: false });
        if (result.dropped.length) throw new Error('NVIDIA setup incomplete; rerun usegrunt setup');
      } finally { await source.close(); }
      providers = providers.filter(provider => provider !== 'nvidia');
      if (!providers.length) return {};
    }
    const router = await readyRouter(options.signal);
    options.signal?.throwIfAborted();
    for (const provider of providers) if (providerURL(provider)) await setupURL(squire as BrowserSquire, router, provider, notify);
    const result = await setupProviders(squire, router, { providers: providers.filter(provider => !providerURL(provider)) as Provider[], notify, dataSharingApproved: approved });
    const dropped = new Set(result.dropped);
    if (dropped.size) throw new Error(`Provider setup incomplete: ${[...dropped].join(', ')}`);
    await router.configureChain([...dropped], approved);
    return { key: await router.key() };
  } catch (error) {
    // Child-process and SDK errors may contain request data. Keep those local.
    if (error instanceof SetupPending) throw new Error('Squire approval remains pending; resume usegrunt setup after approval');
    if (error instanceof Error && !('cmd' in error)) throw error;
    throw new Error('FreeLLMAPI installation failed; check Node and npm availability and run npx usegrunt setup again');
  } finally { await owned?.close(); }
}
