import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ProvisionInput } from '@trusty-squire/sdk';
import { freeConfig, loopback } from './freellmapi.js';
import { proxyApproval } from './approval-proxy.js';
import { VerificationQueue } from './verification-queue.js';
import { withTerminal } from './terminal.js';
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
import { disabledAdapters } from '../registry.js';
import { KILO_PARTICLE, verifyKiloAccess } from './kilo.js';
import { DATA_SHARING_POLICIES, dataSharingPolicies, readDataSharingConsent } from './data-sharing.js';

const exec = promisify(execFile);
export const FREELLMAPI_IMAGE = 'ghcr.io/tashfeenahmed/freellmapi@sha256:845a4b568a20fffd5112e1b9c0258e7782d9eabbba2430612d2f7c811eee267e';
export const PROVIDERS: Record<string, string> = { groq: 'https://console.groq.com/keys', cerebras: 'https://cloud.cerebras.ai/platform/api-keys', kilo: 'https://app.kilo.ai/profile', nvidia: 'https://build.nvidia.com/settings/api-keys', zro: 'https://zro.moonmath.ai/overview', tokenharbor: 'https://tokenharbor.ai/dashboard', runcrate: 'https://www.runcrate.ai/auth/signup', apinex: 'https://apinex.bond/register', 'mistral-vibe': 'https://console.mistral.ai', livekit: 'https://cloud.livekit.io', pollinations: 'https://enter.pollinations.ai', beatapi: 'https://beatapi.io', clixad: 'https://app.clixad.io', perch: 'https://www.perchai.app' };
const freeProviderInstructions: Record<string, string> = {
  runcrate: ' Verify that the GitHub account is at least 30 days old. Use the normal Get your free tokens link at https://www.runcrate.ai/dashboard/api-keys#free-card to activate its recurring weekly allowance; verify the free tier is active via GitHub and not paused. Leave optional marketing unchecked. Verify no paid subscription, no purchased balance, no payment method and automatic top-ups disabled. If any of these checks fails, stop and report it; do not change billing settings or create another account. Use only deepseek-ai/DeepSeek-V4.1-Flash at api.runcrate.ai. Capture the API key with api_hosts ["api.runcrate.ai"] and auth_shape "bearer", service runcrate, label grunt. Reuse an existing vaulted key where possible; never reset or rotate it.',
  apinex: ' Verify the Free plan and complete today\'s ordinary DAILY CHECK-IN to activate recurring free quota. Use the personal @gmail.com Google identity already connected to Squire; do not choose a workspace identity or switch accounts. Use only free/deepseek-v4.1-flash at api.apinex.bond, never a wallet-funded model or paid sibling. Verify the check-in for the current UTC date is actually claimed and free quota is active; absence of a check-in modal alone is insufficient. Do not use or change any existing paid wallet balance. Dismiss any paid upsell after check-in. Do not add billing, top up a wallet, buy credits, or use any paid balance. If check-in or free access cannot be confirmed, stop and report it. Capture the API key with api_hosts ["api.apinex.bond"] and auth_shape "bearer", service apinex, label grunt. Reuse an existing vaulted key; never reset or rotate it.'
};
export type Provider = keyof typeof PROVIDERS;
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

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export function squireEnvironment() {
  return {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(process.env.MILO_SQUIRE_HOME ? { HOME: process.env.MILO_SQUIRE_HOME, XDG_CONFIG_HOME: join(process.env.MILO_SQUIRE_HOME, '.config') } : {}),
      ...(process.env.MILO_SQUIRE_XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.MILO_SQUIRE_XDG_CONFIG_HOME } : {}),
      TRUSTY_SQUIRE_AGENT_IDENTITY: 'grunt setup'
  };
}
export class BrowserSquire implements SetupSquire {
  constructor(private options: { background?: boolean; signal?: AbortSignal; dataSharingApproved?: readonly string[] } = {}) {}
  approveDataSharing(providers: readonly string[]) { this.options.dataSharingApproved = [...new Set(providers)]; }
  private client = new Client({ name: 'grunt setup', version: '0.1.0' });
  private sessions = new Map<string, string>();
  private services = new Map<string, AbortController>();
  private callSignals = new WeakMap<ObjectValue, AbortSignal>();
  private queueSignals = new WeakMap<ObjectValue, AbortSignal>();
  private browserActive = 0;
  private browserQueue: { grant(): void }[] = [];
  private initialDriveSignal = new AbortController().signal;
  private finishing = new Map<string, Promise<void>>();
  private recoveryChoices = new Map<string, Set<string>>();
  private pending = new Set<Promise<Run>>();
  private closed = false;
  private shutdown = new AbortController();
  private get signal() { return this.options.signal ? AbortSignal.any([this.options.signal, this.shutdown.signal]) : this.shutdown.signal; }
  private handoffs: { url: string; close(): void; provider?: string }[] = [];
  private connection: Promise<void> | undefined;
  private metadata: Promise<Credential[]> | undefined;
  private grants = new Map<string, Promise<{ base_url: string; token: string }>>();
  private verification = new VerificationQueue(items => withTerminal(async () => {
    const { confirm, isCancel } = await import('@clack/prompts');
    for (;;) {
      this.signal.throwIfAborted();
      const active = items.filter(item => !this.serviceSignal(item.service).aborted);
      if (!active.length) return;
      const prompt = new AbortController();
      const signals = active.map(item => this.serviceSignal(item.service));
      const changed = () => prompt.abort();
      for (const signal of signals) signal.addEventListener('abort', changed, { once: true });
      try {
        for (const item of active) {
          console.log(`Complete ${item.service} verification in this browser: ${item.url}`);
          if (item.goal) console.log(`${item.service} requested goal; verify every condition before confirming:\n${item.goal}`);
        }
        const attest = active.some(item => item.goal !== undefined);
        const message = attest
          ? `I personally verified ALL conditions in each full requested goal displayed above (${active.filter(item => item.goal !== undefined).map(item => item.service).join(', ')}), and completed any other listed verification. Confirm these goals are complete?`
          : `Finished verification for ${active.map(item => item.service).join(', ')}? Resume setup.`;
        const done = await this.scoped(confirm({ message, initialValue: !attest, signal: prompt.signal }), prompt.signal);
        this.signal.throwIfAborted();
        if (signals.some(signal => signal.aborted)) continue;
        if (isCancel(done) || !done) throw new Error('Provider verification cancelled');
        return;
      } catch (error) {
        this.signal.throwIfAborted();
        if (!signals.some(signal => signal.aborted)) throw error;
      } finally { for (const signal of signals) signal.removeEventListener('abort', changed); }
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
  private async browserSlot(signal: AbortSignal): Promise<() => void> {
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
    return new Promise((resolve, reject) => {
      const entry = { grant: () => {
        signal.removeEventListener('abort', cancelled);
        this.browserActive++;
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
    const release = name === 'operate_drive' || name === 'operate_start' ? await this.browserSlot(queueSignal) : undefined;
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
        if (result.run.state !== 'running') throw new Error(`${service}: signup could not be completed`);
      }
      throw new Error(`${service}: signup timed out; rerun setup to resume`);
    } finally { await this.finishSession(service); }
  }
  private async drive(provider: string, url = PROVIDERS[provider], goal?: string): Promise<Run> {
    if (this.closed) throw new Error('Squire setup is closed');
    const pending = this.driveOnce(provider, url, goal).catch(async error => { await this.finishSession(provider); throw error; });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    try { return await this.scoped(pending, this.serviceSignal(provider)); }
    catch (error) { await this.finishSession(provider); throw error; }
  }
  private async driveOnce(provider: string, url: string | undefined, goal?: string): Promise<Run> {
    const customGoal = goal === undefined ? undefined : `${goal}${this.options.dataSharingApproved?.includes(provider) ? ' The user approved data sharing for this provider during grouped setup consent. You may accept its required free-route data-sharing disclosure to enable free access.' : ' Do not opt in to optional prompt/response retention, staff review or model training; report any required consent for grouped setup approval.'}`;
    const instruction = customGoal ?? `Use the user's existing ${provider} account or sign up for the free plan. ${provider === 'runcrate' ? 'Use GitHub OAuth for the free path; do not use Google OAuth because that path requires billing.' : provider === 'apinex' ? 'Use Google OAuth with the personal @gmail.com identity already connected to Squire.' : "Prefer Google OAuth using the user's Squire-connected identity."} Reuse an existing key in this user's vault, or create one API key for grunt and store it in this user's Squire vault with service ${provider}. Use operate_extract to capture the key directly into the vault; never put its value in your answer.${provider === 'kilo' ? ' Reuse the existing profile API key without resetting it. Capture with api_hosts ["api.kilo.ai", "ai-gateway.kilo.ai"] in that order and auth_shape "bearer"; grunt uses /api/gateway beneath the grant.' : ''}${provider === 'nvidia' ? ' Complete free NVIDIA Build developer onboarding and enable its free inference endpoint. Capture the API key with api_hosts ["integrate.api.nvidia.com"] and auth_shape "bearer". Never reset or rotate an existing key. The requested free model is deepseek-ai/deepseek-v4.1-flash.' : ''}${provider === 'zro' ? ' Verify that this account is on the Free plan, has no paid subscription, no purchased usage-pack balance and no saved payment method before creating or reusing its key. If any paid balance, plan or payment method exists, stop and report it; do not cancel, downgrade, remove a payment method or create another account. Enable only its daily free DeepSeek V4.1 Flash access. Capture the API key with api_hosts ["zro.moonmath.ai"] and auth_shape "bearer". Store service zro, label grunt. Never reset or rotate an existing key. The requested model is deepseek-v4.1-flash.' : ''}${provider === 'tokenharbor' ? ' Enable the free model deepseek-v4.1-flash:free under the approved data-sharing policy; never select its paid sibling. Capture with api_hosts ["tokenharbor.ai"] and auth_shape "bearer", service tokenharbor, label grunt. Do not create a second key if an existing vaulted key is usable, and never reset or rotate an existing key.' : ''}${freeProviderInstructions[provider] ?? ''}${this.options.dataSharingApproved?.includes(provider) ? ' The user approved data sharing for this provider during grouped setup consent. You may accept its required free-route prompt/response retention, staff review and provider training disclosure to enable free access.' : ' Do not opt in to optional prompt/response retention, staff review or model training; if free access requires that consent, report it for the grouped setup approval.'} No paid plan, payment method, extra account or account switching. If captcha, passkey or email confirmation needs a human, stop and report the required step so grunt can share this browser. Do not bypass verification. Stop on provider refusal.`;
    let answer: string | undefined;
    while (true) {
      this.serviceSignal(provider).throwIfAborted();
      const session = this.sessions.get(provider);
      const result = await this.serviceCall(provider, 'operate_drive', {
        ...(session ? { session_id: session } : { url }), goal: instruction,
        facts: { plan: 'free', project_name: 'grunt' }, max_seconds: 45, max_steps: 60,
        ...(answer ? { answer } : {})
      });
      if (typeof result.session_id === 'string') this.sessions.set(provider, result.session_id);
      this.serviceSignal(provider).throwIfAborted();
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
      if (refusal) throw setupStopped(`Provider refused ${provider} signup; setup stopped`, reason);
      if (result.status === 'complete') {
        this.metadata = undefined; // A browser capture may have added a credential.
        await this.finishSession(provider, true);
        this.serviceSignal(provider).throwIfAborted();
        return { run: { id: provider, state: 'completed' }, decision: 'silent' };
      }
      const uncertain = result.status === 'low_confidence' || result.status === 'no_progress';
      const humanStep = /\b(?:sms|phone|captcha|passkey|email|e mail|verification|confirm(?:ation)?|human(?: only| input| assistance)?)\b/i.test(`${String(result.field)} ${classification}`);
      if (this.options.background && (humanStep || uncertain || result.status === 'stuck')) throw new Error('Provider signup needs verification; run usegrunt setup in the foreground to resume');
      if (uncertain && this.sessions.has(provider)) {
        const used = this.recoveryChoices.get(provider) ?? new Set<string>();
        this.recoveryChoices.set(provider, used);
        // Only resume choices the browser actually offered. Never guess consent,
        // payment, arbitrary Continue controls, or repeat a dispatched OAuth click.
        const choice = Object.entries(object(result.options)).find(([, label]) => typeof label === 'string'
          && /^(?:reject optional|reject all(?: cookies)?|only necessary(?: cookies)?|continue without accepting|more signup options)$/i.test(label.trim())
          && !used.has(label.trim().toLowerCase()));
        if (choice && used.size < 4) {
          used.add((choice[1] as string).trim().toLowerCase()); answer = choice[0]; continue;
        }
      }
      // DONE is a driver choice, not evidence that the account meets the goal.
      // Only the human can attest to every condition, and a generic captcha
      // confirmation must never become an attestation of account/plan state.
      const manualCompletion = uncertain && !humanStep
        && !/\b(?:block(?:ed|ing)?|policy|restrict(?:ed|ion|ions)?)\b/i.test(`${classification} ${String(result.field)}`)
        && object(result.options).DONE === 'The goal is complete';
      if (!humanStep && (result.status === 'budget' || result.status === 'evaluate_timeout')) return { run: { id: provider, state: 'running' }, decision: 'silent' };
      // A driver that cannot choose the next action still owns a resumable tab.
      // Share that exact browser instead of silently dropping the signup.
      const handoff = humanStep || uncertain || result.status === 'stuck';
      if (handoff && process.env.MILO_SETUP_NO_HUMAN === '1') throw new Error('Provider signup needs human verification; stopped before handoff');
      if (handoff && this.sessions.has(provider)) {
        const handoffSession = this.sessions.get(provider)!;
        const url = await this.humanHandoff(handoffSession);
        this.serviceSignal(provider).throwIfAborted();
        await this.scoped(this.verification.wait({ service: provider, url, ...(manualCompletion ? { goal: instruction } : {}) }), this.serviceSignal(provider));
        this.serviceSignal(provider).throwIfAborted();
        if (manualCompletion) {
          if (this.sessions.get(provider) !== handoffSession) throw new Error('Provider verification session changed; rerun setup');
          answer = 'DONE';
          continue;
        }
        return { run: { id: provider, state: 'running' }, decision: 'silent' };
      }
      await this.finishSession(provider);
      return { run: { id: provider, state: 'dropped' }, decision: 'drop', reason: reason || 'Signup could not be completed' };
    }
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

const providerPath = (provider: string) => ({ groq: '/openai/v1', kilo: '/api/gateway' })[provider] ?? '/v1';

export class FreeLLMAdmin {
  private token = '';
  readonly url: string;
  constructor(url = process.env.MILO_FREELLMAPI_URL || 'http://127.0.0.1:3001') { this.url = loopback(url).origin; }
  async call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(`${this.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Local FreeLLMAPI setup returned HTTP ${response.status}`);
    return await response.json();
  }
  async login(password: string) { this.token = (await this.call('/auth/login', { email: 'milo@localhost.local', password })).token; }
  async hasKey(platform: string) {
    const keys = await this.call('/keys', undefined, 'GET') as { id: number; platform: string; label: string; baseUrl?: string; models?: { modelId: string }[] }[];
    const key = keys.find(key => key.platform === 'custom' && key.label === `Milo ${platform} (Squire)` && key.baseUrl?.endsWith(providerPath(platform)));
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
  async addGrant(platform: string, grant: { base_url: string; token: string }) {
    // Custom endpoints bind the grant URL and token to their own model rows.
    const baseUrl = grant.base_url.replace(/\/$/, '') + providerPath(platform);
    const label = `Milo ${platform} (Squire)`;
    const discovery = await this.call('/keys/custom/discover-models', { baseUrl, apiKey: grant.token }) as { models: { id: string }[] };
    const available = new Set(discovery.models.map(model => model.id));
    const candidates = providerModels[platform] ?? ['openai/gpt-oss-120b', 'gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
    const models = platform === 'kilo' ? candidates.filter(id => available.has(id)) : candidates.filter(id => available.has(id)).slice(0, 1);
    if (!models.length) throw new Error(`No supported chat model is currently available from ${platform}`);

    const previous = await this.call('/keys', undefined, 'GET') as { id: number; platform: string; label: string; baseUrl?: string }[];
    await this.call('/keys/custom', { baseUrl, apiKey: grant.token,
      label, models: models.map(model => ({ model, supportsTools: true })) });
    for (const key of previous) {
      if (Number.isInteger(key.id) && key.platform === 'custom' && key.label === label && key.baseUrl !== baseUrl) await this.call(`/keys/${key.id}`, undefined, 'DELETE');
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
      if (key.platform !== 'custom' || !['Kilo Free', 'Milo kilo (Squire)'].includes(key.label) || !Number.isInteger(key.id) || !key.id || key.id < 1
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
      const provider = [...Object.keys(PROVIDERS), ...savedProviders].find(provider => row.keyLabel === `Milo ${provider} (Squire)`);
      const owned = managedSharingProvider(row);
      const fallback = !provider && owned !== undefined;
      const retired = retiredManagedAdapter(row);
      const sharingAllowed = !retired && (!owned || approved.includes(owned));
      const vetted = !provider || !providerModels[provider] || providerModels[provider].includes(row.modelId);
      const disabledParticle = owned === 'kilo' && row.modelId === KILO_PARTICLE && row.enabled === false;
      return { modelDbId: row.modelDbId,
        enabled: sharingAllowed && !obsoleteManagedKilo(row) && !disabledParticle
          && (fallback || (provider ? row.platform === 'custom' && vetted && !excluded.includes(provider) : row.enabled === true)),
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
  const keys = db.prepare("SELECT EXISTS(SELECT 1 FROM api_keys WHERE label = 'Milo' OR platform != 'custom' OR label NOT IN ('Kilo Free', 'Freebuff')) AS present").get();
  console.log(keys.present ? 'keys' : 'empty');
  db.close();
}`;
export async function ensureRouter(password: string, encryption: string, run: DockerRun = argsWithEnv, recreate = false) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('grunt FreeLLMAPI requires Docker on Linux or macOS');
  let owner: string | undefined;
  try { owner = (await run(['inspect', '--format', '{{ index .Config.Labels "io.milo.router" }}', 'milo-freellmapi'])).stdout.trim(); }
  catch (error) {
    if (!/No such (object|container)/i.test(String((error as { stderr?: string }).stderr))) throw new Error('Docker is unavailable. Install and start Docker Desktop, then run npx usegrunt setup again');
  }
  if (owner !== undefined) {
    if (owner !== '1') throw new Error('The milo-freellmapi container belongs to another installation; setup stopped');
    if (!recreate) { await run(['start', 'milo-freellmapi']); return; }
  }
  await run(['pull', FREELLMAPI_IMAGE]);
  if (recreate) {
    let volume = false;
    try { await run(['volume', 'inspect', 'milo-freellmapi-data']); volume = true; }
    catch (error) {
      if (!/No such volume/i.test(String((error as { stderr?: string }).stderr))) throw new Error('Cannot inspect the old router volume; its data was preserved');
    }
    if (volume) {
      let state: string;
      try {
        state = (await run(['run', '--rm', '--network', 'none', '--mount', 'type=volume,src=milo-freellmapi-data,dst=/data,readonly', '--entrypoint', 'node', FREELLMAPI_IMAGE, '-e', inspectRouterKeys])).stdout.trim();
      } catch { throw new Error('Cannot check the old router for provider keys; its data was preserved'); }
      if (state !== 'empty') throw new Error('Local router admin credentials are missing and the old router may contain provider keys; its data was preserved. Restore the local admin file before rerunning setup');
    }
    if (owner !== undefined) await run(['rm', '-f', 'milo-freellmapi']);
    if (volume) await run(['volume', 'rm', 'milo-freellmapi-data']);
  }
  // Docker copies named variables from env, keeping secrets out of argv.
  await run(['run', '-d', '--name', 'milo-freellmapi', '--label', 'io.milo.router=1', ...(process.platform === 'linux' ? ['--network', 'host'] : ['-p', '127.0.0.1:3001:3001']), '--restart', 'unless-stopped', '-v', 'milo-freellmapi-data:/app/server/data', '-e', process.platform === 'linux' ? 'HOST=127.0.0.1' : 'HOST=0.0.0.0', '-e', 'PORT=3001', '-e', 'PROVIDER_TIMEOUT_CUSTOM=600000', '-e', 'ENCRYPTION_KEY', '-e', 'FREEAPI_CONFIG_JSON', FREELLMAPI_IMAGE], {
    ...process.env, ENCRYPTION_KEY: encryption, FREEAPI_CONFIG_JSON: JSON.stringify({ admin: { email: 'milo@localhost.local', password }, ...freeConfig() })
  });
}
async function argsWithEnv(args: string[], env?: NodeJS.ProcessEnv) {
  return await exec('docker', args, { timeout: 300000, maxBuffer: 1048576, ...(env ? { env } : {}) });
}
type LocalAdmin = { password: string; encryption: string };
function localAdminPath() {
  return join(process.env.MILO_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo'), 'router-admin.json');
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
  if (row.keyLabel === 'Milo kilo (Squire)' || row.keyLabel === 'Kilo Free') return 'kilo';
  if (row.keyLabel === 'Freebuff' && row.modelId === 'freebuff') return 'freebuff';
  for (const provider of disabledAdapters) if (row.keyLabel === `Milo ${provider} (Squire)`) return provider;
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
  await router.migrateKiloModels(approved, patched);
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
  const key = JSON.stringify([localAdminPath(), process.env.MILO_FREELLMAPI_URL, process.env.MILO_ROUTER_RUNTIME]);
  const existing = routerStarts.get(key);
  if (existing) return existing;
  const starting = (async () => {
    const router = new FreeLLMAdmin();
    signal?.throwIfAborted();
    const saved = await readLocalAdmin();
    if (!saved && process.env.MILO_ROUTER_RUNTIME !== 'docker') {
      const database = join(dirname(localAdminPath()), 'freellmapi', 'router.db');
      let exists = false;
      try { await lstat(database); exists = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot inspect the existing router database; setup stopped');
      }
      if (exists) throw new Error('Existing router database has no local encryption key. Restore its original private router login before rerunning setup');
    }
    const admin = saved ?? { password: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('hex') };
    if (process.env.MILO_ROUTER_RUNTIME === 'docker') {
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
export async function setup(notify = console.log, providers: Provider[] = ['groq'], options: { squire?: SetupSquire; signal?: AbortSignal; directory?: string; background?: boolean; dataSharingApproved?: readonly string[] } = {}) {
  const retired = providers.find(provider => disabledAdapters.has(provider));
  if (retired) throw new Error(`${retired} routing is disabled`);
  const location = options.directory ?? process.env.MILO_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo');
  const approved = [...new Set([...(options.dataSharingApproved ?? []), ...await readDataSharingConsent(location, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
  const unapproved = dataSharingPolicies(providers).filter(policy => !approved.includes(policy.provider));
  if (unapproved.length) throw new Error(`${unapproved.map(policy => policy.name).join(', ')} data sharing requires the grouped setup approval`);
  const owned = options.squire ? undefined : new BrowserSquire({ ...(options.signal ? { signal: options.signal } : {}), dataSharingApproved: approved });
  if (options.squire instanceof BrowserSquire) options.squire.approveDataSharing(approved);
  const squire = options.squire ?? owned!;
  try {
    if (providers.includes('kilo')) {
      await verifyKiloAccess({ ...(options.signal ? { signal: options.signal } : {}) });
      notify('Kilo: free Particle-1 access verified; no account or API key required');
      providers = providers.filter(provider => provider !== 'kilo');
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
        dataSharingApproved: approved, notify, ...(options.signal ? { signal: options.signal } : {}) });
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
    const result = await setupProviders(squire, router, { providers, notify, dataSharingApproved: approved });
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
