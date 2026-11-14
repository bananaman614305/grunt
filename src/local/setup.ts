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

const exec = promisify(execFile);
export const FREELLMAPI_IMAGE = 'ghcr.io/tashfeenahmed/freellmapi@sha256:845a4b568a20fffd5112e1b9c0258e7782d9eabbba2430612d2f7c811eee267e';
export const PROVIDERS: Record<string, string> = { groq: 'https://console.groq.com/keys', cerebras: 'https://cloud.cerebras.ai/platform/api-keys', kilo: 'https://app.kilo.ai/profile' };
export type Provider = keyof typeof PROVIDERS;
export const KILO_NEMOTRON = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const savedProviders = ['kilo'] as const;
const providerModels: Record<string, string[]> = { kilo: [KILO_NEMOTRON, 'kilo-auto/free'] };
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
export async function setupProviders(squire: SetupSquire, router: { addGrant(platform: string, grant: { base_url: string; token: string }): Promise<void>; hasKey?(platform: string): Promise<boolean> }, options: { providers?: Provider[]; notify: (line: string) => void } ) {
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
    if (!credential) {
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
  for (const provider of savedProviders) {
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
  constructor(private options: { background?: boolean; signal?: AbortSignal } = {}) {}
  private client = new Client({ name: 'grunt setup', version: '0.1.0' });
  private sessions = new Map<string, string>();
  private handoffs: { url: string; close(): void }[] = [];
  private connection: Promise<void> | undefined;
  private metadata: Promise<Credential[]> | undefined;
  private grants = new Map<string, Promise<{ base_url: string; token: string }>>();
  private verification = new VerificationQueue(items => withTerminal(async () => {
    this.options.signal?.throwIfAborted();
    for (const item of items) console.log(`Complete ${item.service} verification in this browser: ${item.url}`);
    const { confirm, isCancel } = await import('@clack/prompts');
    const done = await confirm({ message: `Finished verification for ${items.map(item => item.service).join(', ')}? Resume setup.`, initialValue: true });
    if (isCancel(done) || !done) throw new Error('Provider verification cancelled');
    this.options.signal?.throwIfAborted();
  }));
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
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000, ...(this.options.signal ? { signal: this.options.signal } : {}) }).catch(error => {
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

  async signup(service: string, url: string, goal: string): Promise<void> {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      this.options.signal?.throwIfAborted();
      const result = await this.drive(service, url, goal);
      if (result.run.state === 'completed') return;
      if (result.run.state !== 'running') throw new Error(`${service}: signup could not be completed`);
    }
    throw new Error(`${service}: signup timed out; rerun setup to resume`);
  }
  private async drive(provider: string, url = PROVIDERS[provider], goal?: string): Promise<Run> {
    const session = this.sessions.get(provider);
    const result = await this.call('operate_drive', {
      ...(session ? { session_id: session } : { url }),
      goal: goal ?? `Use the user's existing ${provider} account or sign up for the free plan. Create one API key for grunt and store it in this user's Squire vault with service ${provider}. Use operate_extract to capture the key directly into the vault; never put its value in your answer.${provider === 'kilo' ? ' Reuse the existing profile API key without resetting it. Capture with api_hosts ["api.kilo.ai", "ai-gateway.kilo.ai"] in that order and auth_shape "bearer"; grunt uses /api/gateway beneath the grant.' : ''} No paid plan, payment method, extra account or account switching. If captcha, passkey or email confirmation needs a human, stop and report the required step so grunt can share this browser. Do not bypass verification. Stop on provider refusal.`,
      facts: { plan: 'free', project_name: 'grunt' }, max_seconds: 45, max_steps: 60
    });
    if (typeof result.session_id === 'string') this.sessions.set(provider, result.session_id);
    const reason = setupReason(result.reason, result.remaining);
    const classification = [result.reason, result.remaining].filter(value => typeof value === 'string').join(' ').replace(/[_-]/g, ' ');
    const refusal = ['refused', 'rejected', 'denied', 'forbidden'].includes(String(result.status)) || /\b(?:refus(?:al|ed|es|ing)?|denied|prohibit(?:ed|s)?|not allowed|not permitted|forbidden|disallowed)\b/i.test(classification);
    if (refusal) throw setupStopped(`Provider refused ${provider} signup; setup stopped`, reason);
    if (result.status === 'complete') {
      this.metadata = undefined; // A browser capture may have added a credential.
      const id = this.sessions.get(provider);
      if (id) { await this.call('operate_finish', { session_id: id, outcome: 'result', summary: 'grunt provider key stored in user vault' }); this.sessions.delete(provider); }
      return { run: { id: provider, state: 'completed' }, decision: 'silent' };
    }
    const humanStep = /\b(?:sms|phone|captcha|passkey|email|e mail|verification|confirm(?:ation)?|human(?: only| input| assistance)?)\b/i.test(`${String(result.field)} ${classification}`);
    if (!humanStep && (result.status === 'budget' || result.status === 'evaluate_timeout')) return { run: { id: provider, state: 'running' }, decision: 'silent' };
    if (humanStep && process.env.MILO_SETUP_NO_HUMAN === '1') throw new Error('Provider signup needs human verification; stopped before handoff');
    if (humanStep && this.sessions.has(provider)) {
      const url = await this.humanHandoff(this.sessions.get(provider)!);
      if (this.options.background) {
        console.log(`Complete ${provider} verification in this browser: ${url}`);
        await delay(5000, undefined, this.options.signal ? { signal: this.options.signal } : {});
        return { run: { id: provider, state: 'running' }, decision: 'silent' };
      }
      await this.verification.wait({ service: provider, url });
      return { run: { id: provider, state: 'running' }, decision: 'silent' };
    }
    this.sessions.delete(provider);
    return { run: { id: provider, state: 'dropped' }, decision: 'drop', reason: reason || 'Signup could not be completed' };
  }
  async humanHandoff(session: string) {
    const share = await this.call('operate_share', { session_id: session });
    if (typeof share.url !== 'string') throw new Error('Squire returned no browser handoff link');
    const proxy = await proxyApproval(share.url); this.handoffs.push(proxy);
    return proxy.url;
  }
  runs = {
    start: async (input: ProvisionInput) => this.drive(input.service as Provider),
    get: async (id: string) => { const result = await this.drive(id as Provider); return { state: result.run.state, ...(result.approval_url ? { approval_url: result.approval_url } : {}), ...(result.reason ? { reason: result.reason } : {}) }; }
  };
  async close() { for (const handoff of this.handoffs) handoff.close(); await this.client.close(); }
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
  async ensureFreeFallbacks() {
    const keys = await this.call('/keys', undefined, 'GET') as { platform: string; label: string; baseUrl?: string }[];
    for (const provider of freeConfig().customProviders) {
      if (!keys.some(key => key.platform === 'custom' && key.baseUrl === provider.baseUrl)) {
        await this.call('/keys/custom', provider);
      }
    }
  }
  async configureChain(excluded: string[] = []) {
    const chain = await this.call('/fallback', undefined, 'GET') as { modelDbId: number; platform: string; modelId: string; priority: number; keyLabel: string | null; enabled?: boolean }[];
    const rows = chain.map(row => {
      const provider = [...Object.keys(PROVIDERS), ...savedProviders].find(provider => row.keyLabel === `Milo ${provider} (Squire)`);
      const fallback = !provider && (row.modelId === 'freebuff' || row.modelId === 'kilo-auto/free');
      const vetted = !provider || !providerModels[provider] || providerModels[provider].includes(row.modelId);
      return { modelDbId: row.modelDbId,
        enabled: fallback || (provider ? row.platform === 'custom' && vetted && !excluded.includes(provider) : row.enabled === true),
        priority: provider === 'kilo' ? (row.modelId === KILO_NEMOTRON ? 999996 : 999997) : row.modelId === 'freebuff' ? 1000000 : row.modelId === 'kilo-auto/free' ? 999999 : row.priority };
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
async function readLocalAdmin(): Promise<LocalAdmin | undefined> {
  let handle;
  try { handle = await open(localAdminPath(), constants.O_RDONLY | constants.O_NOFOLLOW); }
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
export async function setup(notify = console.log, providers: Provider[] = ['groq'], options: { squire?: SetupSquire; signal?: AbortSignal } = {}) {
  const owned = options.squire ? undefined : new BrowserSquire(options.signal ? { signal: options.signal } : {});
  const squire = options.squire ?? owned!;
  const router = new FreeLLMAdmin();
  try {
    await owned?.connect();
    options.signal?.throwIfAborted();
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
      if (!running) await ensureNativeRouter(options.signal);
    }
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      options.signal?.throwIfAborted();
      try { await router.login(admin.password); ready = true; break; } catch { await delay(1000, undefined, options.signal ? { signal: options.signal } : {}); }
    }
    if (!ready) throw new Error('Local FreeLLMAPI did not start; inspect its health before resuming setup');
    await router.ensureFreeFallbacks();
    await router.configureChain();
    const result = await setupProviders(squire, router, { providers, notify });
    const dropped = new Set(result.dropped);
    if (dropped.size) throw new Error(`Provider setup incomplete: ${[...dropped].join(', ')}`);
    await router.configureChain([...dropped]);
    return { key: await router.key() };
  } catch (error) {
    // Child-process and SDK errors may contain request data. Keep those local.
    if (error instanceof SetupPending) throw new Error('Squire approval remains pending; resume usegrunt setup after approval');
    if (error instanceof Error && !('cmd' in error)) throw error;
    throw new Error('FreeLLMAPI installation failed; check Node and npm availability and run npx usegrunt setup again');
  } finally { await owned?.close(); }
}
